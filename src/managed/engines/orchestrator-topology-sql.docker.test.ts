/**
 * Applies Orchestrator topology SQL against real MySQL/MariaDB images when Docker
 * is available (local dev and CI runners with a reachable dockerd).
 */

import { assertEquals } from "@std/assert";
import { topologyPlaintext } from "../../testing/managed-topology-fixtures.ts";
import { ensureOrchestratorTopologyAccountSql } from "./orchestrator-topology-sql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const USERNAME = "tp_topology_dockertest";
const TOPOLOGY_PASSWORD = topologyPlaintext();
const LOCAL_HOSTS = ["127.0.0.1", "localhost"] as const;

async function dockerDaemonReachable(): Promise<boolean> {
  try {
    const status = await new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    }).spawn().status;
    return status.success;
  } catch {
    return false;
  }
}

async function runDocker(
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const output = await new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

type EngineImage = {
  image: string;
  dialect: "mysql" | "mariadb";
  rootEnv: string;
  client: string;
  replicaStatusSql: string;
};

const ENGINES: EngineImage[] = [
  {
    image: "mysql:8.4",
    dialect: "mysql",
    rootEnv: "MYSQL_ROOT_PASSWORD",
    client: "mysql",
    replicaStatusSql: "SHOW REPLICA STATUS",
  },
  {
    image: "mysql:9.7",
    dialect: "mysql",
    rootEnv: "MYSQL_ROOT_PASSWORD",
    client: "mysql",
    replicaStatusSql: "SHOW REPLICA STATUS",
  },
  {
    image: "mariadb:11.8",
    dialect: "mariadb",
    rootEnv: "MARIADB_ROOT_PASSWORD",
    client: "mariadb",
    replicaStatusSql: "SHOW SLAVE STATUS",
  },
  {
    image: "mariadb:12.3",
    dialect: "mariadb",
    rootEnv: "MARIADB_ROOT_PASSWORD",
    client: "mariadb",
    replicaStatusSql: "SHOW SLAVE STATUS",
  },
];

const ROOT_PASSWORD = ["root", "topology", "fixture"].join("-");

function rootClientArgs(engine: EngineImage): string[] {
  return [
    engine.client,
    "--protocol=tcp",
    "-h127.0.0.1",
    "-uroot",
    `-p${ROOT_PASSWORD}`,
  ];
}

async function withEngineContainer(
  engine: EngineImage,
  fn: (containerName: string) => Promise<void>,
): Promise<void> {
  const containerName = `tp-topology-sql-${engine.dialect}-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const run = await runDocker([
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-e",
    `${engine.rootEnv}=${ROOT_PASSWORD}`,
    engine.image,
  ]);
  if (!run.success) {
    throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const ping = await runDocker([
        "exec",
        containerName,
        ...rootClientArgs(engine),
        "-e",
        "SELECT 1",
      ]);
      if (ping.success) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) {
      throw new Error(`${engine.image} did not accept connections within 60s`);
    }
    await fn(containerName);
  } finally {
    await runDocker(["rm", "-f", containerName]);
  }
}

async function execSqlAsRoot(
  containerName: string,
  engine: EngineImage,
  sql: string,
): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await runDocker([
      "exec",
      containerName,
      ...rootClientArgs(engine),
      "-e",
      sql,
    ]);
    if (result.success) return;
    last = result.stderr || result.stdout;
    if (!/Can't connect|ERROR 2002|ERROR 2003/i.test(last)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`root SQL failed: ${last}`);
}

async function execSqlAsTopology(
  containerName: string,
  engine: EngineImage,
  sql: string,
): Promise<{ success: boolean; stderr: string }> {
  const result = await runDocker([
    "exec",
    containerName,
    engine.client,
    "--protocol=tcp",
    "-h127.0.0.1",
    `-u${USERNAME}`,
    `-p${TOPOLOGY_PASSWORD}`,
    "-e",
    sql,
  ]);
  return { success: result.success, stderr: result.stderr };
}

for (const engine of ENGINES) {
  test(`ensureOrchestratorTopologyAccountSql grants replica monitor on ${engine.image}`, async () => {
    if (!(await dockerDaemonReachable())) return;

    await withEngineContainer(engine, async (containerName) => {
      const sql = ensureOrchestratorTopologyAccountSql(
        USERNAME,
        TOPOLOGY_PASSWORD,
        [...LOCAL_HOSTS],
        engine.dialect,
      );
      await execSqlAsRoot(containerName, engine, sql);

      const status = await execSqlAsTopology(
        containerName,
        engine,
        engine.replicaStatusSql,
      );
      assertEquals(
        status.success,
        true,
        status.stderr,
      );
    });
  });
}
