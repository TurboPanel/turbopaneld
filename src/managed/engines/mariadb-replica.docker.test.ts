/**
 * Drives the MariaDB replica runtime against two real throwaway containers
 * (a primary and a replica) when Docker is available: restart, deliberate
 * stop, promote, and demote. Containers and the network are removed
 * afterwards.
 */

import { assertEquals } from "@std/assert";
import { waitFor } from "../../testing/wait-for.ts";
import {
  mariadbManagedEngineRuntime,
  resumeExistingMariadbStandby,
} from "./mariadb.ts";
import type { ManagedEngineContext } from "./types.ts";

const test = Deno.test.bind(Deno);

const ROOT_PASSWORD = ["replica", "root", "fixture"].join("-");
const REPL_PASSWORD = ["replica", "link", "fixture"].join("-");
const IMAGES = ["mariadb:11.8", "mariadb:12.3"];
const MARKER = "/var/lib/mysql/.turbopanel-standby";

type Result = { success: boolean; stdout: string; stderr: string };

async function docker(args: string[], input?: string): Promise<Result> {
  const child = new Deno.Command("docker", {
    args,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const out = await child.output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    success: out.success,
    stdout: decode(out.stdout),
    stderr: decode(out.stderr),
  };
}

async function dockerReachable(): Promise<boolean> {
  try {
    return (await docker(["info"])).success;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = await dockerReachable();
if (!DOCKER_AVAILABLE) {
  console.warn(
    "SKIPPED mariadb-replica.docker.test.ts: Docker is not reachable, so the real MariaDB replica check did not run.",
  );
}

function sql(name: string, statement: string): Promise<Result> {
  return docker([
    "exec",
    name,
    "mariadb",
    "--protocol=tcp",
    "-h127.0.0.1",
    "-uroot",
    `-p${ROOT_PASSWORD}`,
    "-N",
    "-B",
    "-e",
    statement,
  ]);
}

async function mustSql(name: string, statement: string): Promise<string> {
  const result = await sql(name, statement);
  if (!result.success) throw new Error(`${name}: ${result.stderr}`);
  return result.stdout.trim();
}

async function startServer(
  image: string,
  name: string,
  network: string,
  serverId: number,
): Promise<void> {
  const run = await docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    "-e",
    `MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`,
    image,
    `--server-id=${serverId}`,
    "--log-bin=mysql-bin",
    "--log-slave-updates",
    "--skip-slave-start",
  ]);
  if (!run.success) throw new Error(`docker run failed: ${run.stderr}`);
  await waitForSql(name);
}

async function waitForSql(name: string): Promise<void> {
  await waitFor(
    `${name} to accept TCP logins`,
    async () => (await sql(name, "SELECT 1")).success,
    { timeoutMs: 120_000, intervalMs: 500 },
  );
}

function contextFor(name: string): ManagedEngineContext {
  return {
    containerId: name,
    composeServiceName: name,
    rootUsername: "root",
    defaultDatabase: "appdb",
    socketPassword: ROOT_PASSWORD,
    exec: (argv: string[], input?: string) =>
      docker(["exec", "-i", name, ...argv], input),
  };
}

function replicate(host: string, usePosition: string): string {
  return `CHANGE MASTER TO MASTER_HOST='${host}', MASTER_PORT=3306, ` +
    `MASTER_USER='repl', MASTER_PASSWORD='${REPL_PASSWORD}', ` +
    `MASTER_USE_GTID=${usePosition}, MASTER_CONNECT_RETRY=1; START SLAVE;`;
}

for (const image of IMAGES) {
  test({
    name:
      `mariadb replica runtime survives restart, deliberate stop, promote and demote on ${image}`,
    ignore: !DOCKER_AVAILABLE,
    fn: async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const network = `tp-repl-net-${suffix}`;
      const primary = `tp-repl-primary-${suffix}`;
      const replica = `tp-repl-replica-${suffix}`;
      const replication = mariadbManagedEngineRuntime.replication!;
      const spec = {
        username: "repl",
        password: REPL_PASSWORD,
        primary: { host: primary, port: 3306 },
        slotName: "tp_member_2",
      };
      const health = async (name: string) =>
        (await replication.readHealth(contextFor(name), "standby")).state;
      const waitStreaming = (name: string) =>
        waitFor(
          `${name} to stream`,
          async () => await health(name) === "streaming",
          {
            timeoutMs: 60_000,
            intervalMs: 500,
          },
        );
      await docker(["network", "create", network]);
      try {
        await startServer(image, primary, network, 1);
        await startServer(image, replica, network, 2);
        await mustSql(
          primary,
          "CREATE DATABASE shop; CREATE TABLE shop.t (id INT PRIMARY KEY); " +
            `CREATE USER 'repl'@'%' IDENTIFIED BY '${REPL_PASSWORD}'; ` +
            "GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%'; " +
            "INSERT INTO shop.t VALUES (1);",
        );
        await mustSql(replica, replicate(primary, "slave_pos"));
        await docker(["exec", replica, "touch", MARKER]);
        await waitStreaming(replica);
        assertEquals(
          await mustSql(replica, "SELECT COUNT(*) FROM shop.t"),
          "1",
        );

        // Container restart: skip_slave_start leaves the threads down.
        await docker(["restart", replica]);
        await waitForSql(replica);
        assertEquals(await health(replica), "stopped");
        await replication.configureStandby!(contextFor(replica), spec);
        await waitStreaming(replica);

        // Deliberate stop on an older server: configureStandby leaves it.
        await mustSql(replica, "STOP SLAVE");
        assertEquals(
          await resumeExistingMariadbStandby(contextFor(replica), {
            maxUptimeSeconds: 0,
          }),
          "left_stopped",
        );
        assertEquals(await health(replica), "stopped");
        await mustSql(replica, "START SLAVE");
        await waitStreaming(replica);

        // Promote: replica config is gone but the marker stays; the apply
        // that follows must not try START SLAVE (ERROR 1200).
        await replication.promote!(contextFor(replica));
        assertEquals(await replication.isStandby(contextFor(replica)), false);
        await replication.configureStandby!(contextFor(replica), {
          ...spec,
          primary: { host: replica, port: 3306 },
        });
        await mustSql(replica, "INSERT INTO shop.t VALUES (2)");

        // Demote the old primary under the promoted member and repoint it.
        await mustSql(primary, "SET GLOBAL read_only=ON");
        await mustSql(primary, replicate(replica, "current_pos"));
        await docker(["exec", primary, "touch", MARKER]);
        await waitStreaming(primary);
        await replication.configureStandby!(contextFor(primary), {
          ...spec,
          primary: { host: replica, port: 3306 },
        });
        assertEquals(await health(primary), "streaming");
        await replication.followPrimary!(contextFor(primary), {
          primary: { host: replica, port: 3306 },
        });
        await waitStreaming(primary);
        await waitFor(
          "the promoted member's row to reach the old primary",
          async () =>
            await mustSql(primary, "SELECT COUNT(*) FROM shop.t") === "2",
          { timeoutMs: 60_000, intervalMs: 500 },
        );
      } finally {
        await docker(["rm", "-f", "-v", primary, replica]);
        await docker(["network", "rm", network]);
      }
    },
  });
}
