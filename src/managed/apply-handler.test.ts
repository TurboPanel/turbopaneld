/**
 * Host-free integration coverage for handleManagedApply.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { handleManagedApply } from "./apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Managed network names are the `network(kind='managed')` row's bare UUID. */
const MANAGED_NETWORK = "00000000-0000-4000-8000-0000000000ee";

function dockerOk(stdout = "", stderr = ""): DockerCliResult {
  return { success: true, stdout, stderr, code: 0 };
}

function dockerFail(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123def456",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    Service: "postgres",
    State: "running",
  },
]);

function basePayload(
  overrides: Partial<ManagedApplyPayload> = {},
): ManagedApplyPayload {
  return {
    managedId: "managed_apply_1",
    environmentId: "env_apply_1",
    engine: "postgres",
    projectName: "tp-managed-pg",
    containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    managedNetwork: MANAGED_NETWORK,
    image: "docker.io/library/postgres:18-alpine",
    containerPort: 5432,
    composeYaml: "services:\n  postgres:\n    image: postgres:18-alpine\n",
    configFiles: [
      {
        path: "postgresql.conf",
        contents: "listen_addresses = '*'\n",
        mode: "0640",
      },
    ],
    volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
    exposure: { enabled: false, protocol: "tcp" },
    credentials: [
      {
        principalId: "p-root",
        username: "postgres",
        role: "root",
        databases: ["postgres"],
        password: "tpdaemon.v1.root.payload",
      },
    ],
    memberId: "00000000-0000-4000-8000-0000000000a1",
    memberRole: "primary",
    memberOrdinal: 1,
    readEligible: false,
    peers: [],
    ...overrides,
  };
}

function decryptOk(
  ciphertexts: string[],
): Promise<(string | null)[]> {
  return Promise.resolve(ciphertexts.map(() => "s3cret-root"));
}

/** Primary apply: ownership normalize, compose up, ps, pg_isready, psql apply + version. */
function primaryPostgresRun(
  args: string[],
  options?: { input?: string },
): Promise<DockerCliResult> {
  if (args[0] === "run" && args.includes("--user") && args.includes("0")) {
    return Promise.resolve(dockerOk());
  }
  if (args[0] === "compose" && args.includes("up")) {
    return Promise.resolve(dockerOk());
  }
  if (args[0] === "compose" && args.includes("ps")) {
    return Promise.resolve(dockerOk(RUNNING_PS));
  }
  if (args[0] === "exec") {
    if (args.includes("pg_isready")) return Promise.resolve(dockerOk());
    if (args.includes("psql")) {
      const sql = options?.input ?? "";
      if (sql.includes("server_version")) {
        return Promise.resolve(dockerOk("18.0\n"));
      }
      return Promise.resolve(dockerOk());
    }
  }
  return Promise.resolve(dockerOk());
}

async function withApplyEnv<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
}

test("handleManagedApply requires decryptSecrets", async () => {
  await withApplyEnv(async () => {
    await assertRejects(
      () =>
        handleManagedApply(
          basePayload(),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runHostPrep: () => Promise.resolve(),
          },
        ),
      Error,
      "requires decryptSecrets",
    );
  });
});

test("handleManagedApply requires a root credential after decrypt", async () => {
  await withApplyEnv(async () => {
    await assertRejects(
      () =>
        handleManagedApply(
          basePayload({
            credentials: [
              {
                principalId: "p-app",
                username: "app_user",
                role: "user",
                databases: ["appdb"],
                password: "tpdaemon.v1.app.payload",
              },
            ],
          }),
          new Date().toISOString(),
          {
            decryptSecrets: decryptOk,
            ensureDocker: () => Promise.resolve(),
            runHostPrep: () => Promise.resolve(),
            runDocker: primaryPostgresRun,
          },
        ),
      Error,
      "requires a root credential",
    );
  });
});

test("handleManagedApply primary path composes up and applies credentials", async () => {
  await withApplyEnv(async () => {
    const result = await handleManagedApply(
      basePayload({
        databases: [{ action: "create", name: "appdb" }],
        dropUsers: ["orphan_user"],
      }),
      new Date().toISOString(),
      {
        decryptSecrets: decryptOk,
        ensureDocker: () => Promise.resolve(),
        runHostPrep: () => Promise.resolve(),
        runDocker: primaryPostgresRun,
      },
    );

    assertEquals(result.host, "127.0.0.1");
    assertEquals(result.port, 5432);
    assertEquals(result.appliedUsers?.includes("postgres"), true);
    assertEquals(result.appliedDatabases, ["appdb"]);
    assertEquals(result.engineVersion, "18.0");
    assertEquals(result.summary, "managed postgres applied");
    assertEquals(result.containers?.length, 1);
    assertEquals(result.member?.status, "ready");
  });
});

test("handleManagedApply creates the managed network before any compose up", async () => {
  // Regression: the engine's compose document references the managed network
  // as `external: true`. Creating it only inside `applyManagedEngineState`
  // (which runs after `composeUpManagedEngine`) makes the very first apply on
  // a fresh host fail with "network ... declared as external, but could not
  // be found".
  await withApplyEnv(async () => {
    const argv: string[][] = [];
    await handleManagedApply(
      basePayload(),
      new Date().toISOString(),
      {
        decryptSecrets: decryptOk,
        ensureDocker: () => Promise.resolve(),
        runHostPrep: () => Promise.resolve(),
        runDocker: (args, options) => {
          argv.push([...args]);
          if (args[0] === "network" && args[1] === "inspect") {
            return Promise.resolve(dockerFail("no such network"));
          }
          return primaryPostgresRun(args, options);
        },
      },
    );

    const inspectIndex = argv.findIndex((args) =>
      args[0] === "network" && args[1] === "inspect" &&
      args[2] === MANAGED_NETWORK
    );
    const createIndex = argv.findIndex((args) =>
      args[0] === "network" && args[1] === "create" &&
      args[2] === MANAGED_NETWORK
    );
    const composeUpIndex = argv.findIndex((args) =>
      args[0] === "compose" && args.includes("up")
    );

    assertEquals(inspectIndex >= 0, true);
    assertEquals(createIndex >= 0, true);
    assertEquals(composeUpIndex >= 0, true);
    assertEquals(inspectIndex < createIndex, true);
    assertEquals(createIndex < composeUpIndex, true);
  });
});

test("handleManagedApply uses the payload's managed network, never a constant", async () => {
  await withApplyEnv(async () => {
    const other = "11111111-1111-4111-8111-111111111111";
    const argv: string[][] = [];
    await handleManagedApply(
      basePayload({ managedNetwork: other }),
      new Date().toISOString(),
      {
        decryptSecrets: decryptOk,
        ensureDocker: () => Promise.resolve(),
        runHostPrep: () => Promise.resolve(),
        runDocker: (args, options) => {
          argv.push([...args]);
          return primaryPostgresRun(args, options);
        },
      },
    );

    assertEquals(
      argv.some((args) =>
        args[0] === "network" && args[1] === "inspect" && args[2] === other
      ),
      true,
    );
    assertEquals(
      argv.some((args) => args[0] === "network" && args[2] === MANAGED_NETWORK),
      false,
    );
  });
});

test("handleManagedApply ensures ProxySQL monitor role after host prep seeds monitor.cnf", async () => {
  await withApplyEnv(async () => {
    const sql: string[] = [];
    let hostPrepCalls = 0;
    await handleManagedApply(
      basePayload(),
      new Date().toISOString(),
      {
        decryptSecrets: decryptOk,
        ensureDocker: () => Promise.resolve(),
        runHostPrep: async () => {
          hostPrepCalls += 1;
          const layout = resolveLayout(Deno.env.toObject());
          await Deno.mkdir(`${layout.configDir}/proxysql`, { recursive: true });
          await Deno.writeTextFile(
            `${layout.configDir}/proxysql/admin.cnf`,
            "[client]\nuser=admin\npassword=admin-secret\n",
          );
          await Deno.writeTextFile(
            `${layout.configDir}/proxysql/monitor.cnf`,
            "[client]\nuser=tp_monitor\npassword=mon-s3cret\n",
          );
        },
        runDocker: (args, options) => {
          if (args[0] === "exec" && args.includes("psql") && options?.input) {
            sql.push(options.input);
          }
          return primaryPostgresRun(args, options);
        },
      },
    );
    assertEquals(hostPrepCalls, 1);
    assertEquals(sql.some((part) => part.includes("tp_monitor")), true);
    assertEquals(sql.some((part) => part.includes("GRANT pg_monitor")), true);
  });
});

test("handleManagedApply throws when compose up fails", async () => {
  await withApplyEnv(async () => {
    await assertRejects(
      () =>
        handleManagedApply(
          basePayload(),
          new Date().toISOString(),
          {
            decryptSecrets: decryptOk,
            ensureDocker: () => Promise.resolve(),
            runHostPrep: () => Promise.resolve(),
            runDocker: (args) => {
              if (args[0] === "compose" && args.includes("up")) {
                return Promise.resolve(dockerFail("compose up denied"));
              }
              if (args[0] === "run" && args.includes("0")) {
                return Promise.resolve(dockerOk());
              }
              return Promise.resolve(dockerOk());
            },
          },
        ),
      Error,
      "compose up denied",
    );
  });
});

test("handleManagedApply retries compose up after docker-setup on socket permission denied", async () => {
  await withApplyEnv(async () => {
    let composeUpCalls = 0;
    let dockerSetupCalls = 0;
    const result = await handleManagedApply(
      basePayload(),
      new Date().toISOString(),
      {
        decryptSecrets: decryptOk,
        ensureDocker: () => Promise.resolve(),
        runHostPrep: () => Promise.resolve(),
        runDockerSetup: () => {
          dockerSetupCalls += 1;
          return Promise.resolve();
        },
        runDocker: (args, options) => {
          if (args[0] === "compose" && args.includes("up")) {
            composeUpCalls += 1;
            if (composeUpCalls === 1) {
              return Promise.resolve(
                dockerFail(
                  "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
                ),
              );
            }
          }
          return primaryPostgresRun(args, options);
        },
      },
    );
    assertEquals(composeUpCalls, 2);
    assertEquals(dockerSetupCalls, 1);
    assertEquals(result.member?.status, "ready");
  });
});

test("handleManagedApply standby needs_resync returns early without compose up", async () => {
  await withApplyEnv(async () => {
    let sawComposeUp = false;
    const result = await handleManagedApply(
      basePayload({
        memberRole: "replica",
        replication: {
          role: "standby",
          username: "tp_repl",
          primary: {
            host: "managed-primary-id",
            hostaddr: "203.0.113.10",
            port: 15432,
          },
        },
        credentials: [
          {
            principalId: "p-root",
            username: "postgres",
            role: "root",
            databases: ["postgres"],
            password: "tpdaemon.v1.root.payload",
          },
          {
            principalId: "p-repl",
            username: "tp_repl",
            role: "replication",
            databases: [],
            password: "tpdaemon.v1.repl.payload",
          },
        ],
      }),
      new Date().toISOString(),
      {
        decryptSecrets: (ciphertexts) =>
          Promise.resolve(ciphertexts.map(() => "repl-s3cret")),
        ensureDocker: () => Promise.resolve(),
        runHostPrep: () => Promise.resolve(),
        runDocker: (args) => {
          if (args[0] === "compose" && args.includes("up")) {
            sawComposeUp = true;
          }
          if (args[0] === "run" && args.includes("0")) {
            return Promise.resolve(dockerOk());
          }
          if (
            args[0] === "run" &&
            args.some((part) => part.includes("PG_VERSION"))
          ) {
            return Promise.resolve({ ...dockerOk(), stdout: "present" });
          }
          if (
            args[0] === "run" &&
            args.some((part) => part.includes("standby.signal"))
          ) {
            return Promise.resolve({ ...dockerOk(), stdout: "absent" });
          }
          if (args[0] === "compose" && args.includes("stop")) {
            return Promise.resolve(dockerOk());
          }
          return Promise.resolve(dockerOk());
        },
      },
    );

    assertEquals(sawComposeUp, false);
    assertEquals(result.member?.status, "needs_resync");
    assertEquals(result.member?.replication?.state, "needs_resync");
    assertEquals(result.appliedUsers, []);
  });
});

test("handleManagedApply redacts decrypted secrets from thrown errors", async () => {
  await withApplyEnv(async () => {
    await assertRejects(
      () =>
        handleManagedApply(
          basePayload(),
          new Date().toISOString(),
          {
            decryptSecrets: decryptOk,
            ensureDocker: () => Promise.resolve(),
            runHostPrep: () => Promise.resolve(),
            runDocker: (args, _options) => {
              if (args[0] === "compose" && args.includes("up")) {
                return Promise.resolve(dockerOk());
              }
              if (args[0] === "compose" && args.includes("ps")) {
                return Promise.resolve(dockerOk(RUNNING_PS));
              }
              if (args[0] === "run" && args.includes("0")) {
                return Promise.resolve(dockerOk());
              }
              if (args[0] === "exec" && args.includes("pg_isready")) {
                return Promise.resolve(dockerOk());
              }
              if (args[0] === "exec" && args.includes("psql")) {
                return Promise.resolve(
                  dockerFail("password authentication failed for s3cret-root"),
                );
              }
              return Promise.resolve(dockerOk());
            },
          },
        ),
      Error,
      "***",
    );
  });
});

const MYSQL_RUNNING_PS = JSON.stringify([
  {
    ID: "mysql123def456",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    Service: "mysql",
    State: "running",
  },
]);

function primaryMysqlRun(
  args: string[],
  options?: { input?: string },
): Promise<DockerCliResult> {
  if (args[0] === "run" && args.includes("--user") && args.includes("0")) {
    return Promise.resolve(dockerOk());
  }
  if (args[0] === "compose" && args.includes("up")) {
    return Promise.resolve(dockerOk());
  }
  if (args[0] === "compose" && args.includes("ps")) {
    return Promise.resolve(dockerOk(MYSQL_RUNNING_PS));
  }
  if (args[0] === "exec") {
    if (args.includes("mysqladmin")) return Promise.resolve(dockerOk());
    if (args.includes("mysql")) {
      const eIdx = args.indexOf("-e");
      const sql = eIdx >= 0 ? (args[eIdx + 1] ?? "") : (options?.input ?? "");
      if (sql.includes("VERSION")) {
        return Promise.resolve(dockerOk("8.4.0\n"));
      }
      return Promise.resolve(dockerOk());
    }
  }
  return Promise.resolve(dockerOk());
}

test("handleManagedApply primary mysql path composes up and applies credentials", async () => {
  await withApplyEnv(async () => {
    const result = await handleManagedApply(
      basePayload({
        engine: "mysql",
        image: "docker.io/library/mysql:8.4",
        containerPort: 3306,
        composeYaml: "services:\n  mysql:\n    image: mysql:8.4\n",
        credentials: [
          {
            principalId: "p-root",
            username: "root",
            role: "root",
            databases: ["appdb"],
            password: "tpdaemon.v1.root.payload",
          },
        ],
        databases: [{ action: "create", name: "appdb" }],
      }),
      new Date().toISOString(),
      {
        decryptSecrets: decryptOk,
        ensureDocker: () => Promise.resolve(),
        runHostPrep: () => Promise.resolve(),
        runDocker: primaryMysqlRun,
      },
    );

    assertEquals(result.appliedUsers?.includes("root"), true);
    assertEquals(result.appliedDatabases, ["appdb"]);
    assertEquals(result.engineVersion, "8.4.0");
    assertEquals(result.summary, "managed mysql applied");
  });
});

test("handleManagedApply standby mysql requires replication credential", async () => {
  await withApplyEnv(async () => {
    await assertRejects(
      () =>
        handleManagedApply(
          basePayload({
            engine: "mysql",
            image: "docker.io/library/mysql:8.4",
            containerPort: 3306,
            composeYaml: "services:\n  mysql:\n    image: mysql:8.4\n",
            memberRole: "replica",
            replication: {
              role: "standby",
              username: "tp_repl",
              primary: {
                host: "managed-primary-id",
                hostaddr: "203.0.113.10",
                port: 13306,
              },
            },
            credentials: [
              {
                principalId: "p-root",
                username: "root",
                role: "root",
                databases: ["appdb"],
                password: "tpdaemon.v1.root.payload",
              },
            ],
          }),
          new Date().toISOString(),
          {
            decryptSecrets: decryptOk,
            ensureDocker: () => Promise.resolve(),
            runHostPrep: () => Promise.resolve(),
            runDocker: primaryMysqlRun,
          },
        ),
      Error,
      "requires a replication credential",
    );
  });
});
