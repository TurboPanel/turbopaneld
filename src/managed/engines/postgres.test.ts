/**
 * Postgres managed-engine runtime — admin-role stability regression coverage.
 *
 * The instance may resolve a *suffixed* user-facing root principal username
 * (e.g. `postgres_a1b2c3d4`) when two managed Postgres clusters in the same
 * server-owning organization would otherwise collide on the default
 * `postgres` login (see `resolveAvailableManagedRootUsername` in the
 * instance repo). `turbopanel/src/lib/managed/postgres.ts` deliberately keeps
 * the container's bootstrap superuser (`POSTGRES_USER`) pinned to the stable
 * platform admin role regardless of that suffix — these tests assert the
 * daemon-side half of that contract: every admin operation connects as the
 * engine spec's static `rootUsername`, and the credential-apply path creates
 * the (possibly suffixed) user-facing root as a *separate* role rather than
 * assuming it is the connection identity.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ManagedApplyCredential } from "../../instance/commands/contracts.ts";
import { getManagedEngineRuntime } from "./index.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type { ManagedEngineContext, ManagedEngineExec } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Managed network names are the `network(kind='managed')` row's bare UUID. */
const MANAGED_NETWORK = "00000000-0000-4000-8000-0000000000ee";

type RecordedExec = { argv: string[]; input?: string };

function recordingExec(): { exec: ManagedEngineExec; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const exec: ManagedEngineExec = (argv, input) => {
    calls.push({ argv: [...argv], input });
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { exec, calls };
}

function buildContext(exec: ManagedEngineExec): ManagedEngineContext {
  return {
    containerId: "c1",
    composeServiceName: "postgres",
    // Always the stable platform admin — never the (possibly suffixed)
    // user-facing root principal. See module doc above.
    rootUsername: "postgres",
    defaultDatabase: "postgres",
    exec,
  };
}

test("applyCredentials connects as the stable platform admin even for a suffixed root credential", async () => {
  const engine = getManagedEngineRuntime("postgres");
  const { exec, calls } = recordingExec();
  const ctx = buildContext(exec);

  // Simulates the second of two Postgres clusters in the same server-owning
  // org, where `resolveAvailableManagedRootUsername` suffixed the preferred
  // "postgres" root login to avoid a ProxySQL-namespace collision.
  const suffixedRootCredential: ManagedApplyCredential = {
    principalId: "p-root",
    username: "postgres_a1b2c3d4",
    role: "root",
    databases: ["appdb"],
    password: "s3cret-root",
  };

  const applied = await engine.applyCredentials(ctx, [suffixedRootCredential]);
  assertEquals(applied, ["postgres_a1b2c3d4"]);

  assertEquals(calls.length, 1);
  const [call] = calls;
  // Connection identity is the stable admin, not the suffixed credential.
  assertEquals(call!.argv.includes("-U"), true);
  assertEquals(call!.argv[call!.argv.indexOf("-U") + 1], "postgres");
  // The SQL body creates/alters a *separate* superuser role named after the
  // suffixed credential — never reusing the connection identity.
  assertEquals(call!.input?.includes('"postgres_a1b2c3d4"'), true);
  assertEquals(call!.input?.includes("SUPERUSER"), true);
  assertEquals(call!.input?.includes('"postgres"'), false);
});

test("applyCredentials grants non-root credentials without superuser regardless of naming overlap", async () => {
  const engine = getManagedEngineRuntime("postgres");
  const { exec, calls } = recordingExec();
  const ctx = buildContext(exec);

  const appCredential: ManagedApplyCredential = {
    principalId: "p-app",
    username: "app_user",
    role: "user",
    databases: ["appdb"],
    privileges: ["read-write"],
    password: "s3cret-app",
  };

  await engine.applyCredentials(ctx, [appCredential]);

  const createCall = calls.find((c) => c.input?.includes("app_user"));
  if (!createCall) {
    throw new TypeError("expected a create-role call for app_user");
  }
  assertEquals(createCall.input?.includes("NOSUPERUSER"), true);
  assertEquals(createCall.argv[createCall.argv.indexOf("-U") + 1], "postgres");
});

test("dropUsers never drops the stable platform admin, even when it matches a stored username", async () => {
  const engine = getManagedEngineRuntime("postgres");
  const { exec, calls } = recordingExec();
  const ctx = buildContext(exec);

  if (!engine.dropUsers) {
    throw new TypeError("expected postgres dropUsers support");
  }
  const dropped = await engine.dropUsers(ctx, ["postgres", "orphaned_user"]);

  assertEquals(dropped, ["orphaned_user"]);
  assertEquals(calls.some((c) => c.input?.includes('"postgres"')), false);
  assertEquals(calls.some((c) => c.input?.includes('"orphaned_user"')), true);
});

test("waitReady and readVersion always target the stable platform admin", async () => {
  const engine = getManagedEngineRuntime("postgres");
  const { exec, calls } = recordingExec();
  const ctx = buildContext(exec);

  await engine.waitReady(ctx);
  await engine.readVersion(ctx);

  for (const call of calls) {
    const idx = call.argv.indexOf("-U");
    assertEquals(idx >= 0, true);
    assertEquals(call.argv[idx + 1], "postgres");
  }
});

test("backup dump/restore argv always target the stable platform admin regardless of ctx construction order", () => {
  const engine = getManagedEngineRuntime("postgres");
  if (!engine.backup) throw new TypeError("expected postgres backup support");
  const ctx = buildContext(recordingExec().exec);

  const dumpArgv = engine.backup.dumpArgv(ctx, { database: "appdb" });
  const restoreArgv = engine.backup.restoreArgv(ctx, { database: "appdb" });

  assertEquals(dumpArgv, ["pg_dump", "-Fc", "-U", "postgres", "-d", "appdb"]);
  assertEquals(restoreArgv.includes("-U"), true);
  assertEquals(restoreArgv[restoreArgv.indexOf("-U") + 1], "postgres");
});

function standbyReplicationSpec() {
  return {
    username: "tp_repl",
    password: "repl-pass",
    primary: {
      host: "managed-00000000-0000-4000-8000-000000000001",
      hostaddr: "203.0.113.10",
      port: 5432,
    },
    slotName: "tp_member_1",
  };
}

test("postgres ensurePrimary creates slots and drops unmanaged ones", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.ensurePrimary) {
    throw new TypeError("expected postgres ensurePrimary");
  }
  const { exec, calls } = recordingExec();
  const slotLister: ManagedEngineExec = async (argv, input) => {
    if (
      input?.includes("SELECT slot_name FROM pg_catalog.pg_replication_slots")
    ) {
      return {
        success: true,
        stdout: "tp_member_1\tphysical\norphan_slot\tphysical\n",
        stderr: "",
      };
    }
    return (await exec(argv, input));
  };
  await replication.ensurePrimary(buildContext(slotLister), {
    username: "tp_repl",
    password: "repl-pass",
    desiredSlots: ["tp_member_1"],
  });
  assertEquals(calls.some((c) => c.input?.includes("orphan_slot")), true);
});

test("postgres bootstrapStandby forceResync wipes and re-seeds an initialized standby", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected postgres bootstrapStandby");
  }
  const stateDir = await Deno.makeTempDir({ prefix: "pg-boot-force-" });
  try {
    const dockerCalls: string[][] = [];
    const boot = await replication.bootstrapStandby(
      {
        managedId: "pg-boot",
        managedNetwork: MANAGED_NETWORK,
        image: "postgres:18-alpine",
        volumes: [{ name: "vol", target: "/var/lib/postgresql" }],
        stateDir,
        containerUser: "postgres",
        containerGroup: "postgres",
        runDocker: (args) => {
          dockerCalls.push([...args]);
          const joined = args.join(" ");
          if (joined.includes("PG_VERSION")) {
            // Would report an initialized standby — force must never ask.
            return Promise.resolve({
              success: true,
              stdout: "present",
              stderr: "",
              code: 0,
            });
          }
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
      },
      { ...standbyReplicationSpec(), forceResync: true },
    );
    assertEquals(boot, "seeded");
    // Probes skipped entirely; cleanup + basebackup ran.
    assertEquals(
      dockerCalls.some((args) => args.join(" ").includes("PG_VERSION")),
      false,
    );
    assertEquals(
      dockerCalls.some((args) => args.join(" ").includes("rm -rf")),
      true,
    );
    assertEquals(
      dockerCalls.some((args) => args.includes("pg_basebackup")),
      true,
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("postgres bootstrapStandby returns already_standby when signal exists", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected postgres bootstrapStandby");
  }
  const boot = await replication.bootstrapStandby(
    {
      managedId: "pg-boot",
      managedNetwork: MANAGED_NETWORK,
      image: "postgres:18-alpine",
      volumes: [{ name: "vol", target: "/var/lib/postgresql" }],
      stateDir: "/tmp/pg",
      containerUser: "postgres",
      containerGroup: "postgres",
      runDocker: (args) => {
        const joined = args.join(" ");
        if (joined.includes("PG_VERSION")) {
          return Promise.resolve({
            success: true,
            stdout: "present",
            stderr: "",
            code: 0,
          });
        }
        if (joined.includes("standby.signal")) {
          return Promise.resolve({
            success: true,
            stdout: "present",
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "",
          code: 1,
        });
      },
    },
    standbyReplicationSpec(),
  );
  assertEquals(boot, "already_standby");
});

test("postgres bootstrapStandby returns needs_resync without standby signal", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected postgres bootstrapStandby");
  }
  const boot = await replication.bootstrapStandby(
    {
      managedId: "pg-boot",
      managedNetwork: MANAGED_NETWORK,
      image: "postgres:18-alpine",
      volumes: [{ name: "vol", target: "/var/lib/postgresql" }],
      stateDir: "/tmp/pg",
      containerUser: "postgres",
      containerGroup: "postgres",
      runDocker: (args) => {
        const joined = args.join(" ");
        if (joined.includes("PG_VERSION")) {
          return Promise.resolve({
            success: true,
            stdout: "present",
            stderr: "",
            code: 0,
          });
        }
        if (joined.includes("standby.signal")) {
          return Promise.resolve({
            success: true,
            stdout: "absent",
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "",
          code: 1,
        });
      },
    },
    standbyReplicationSpec(),
  );
  assertEquals(boot, "needs_resync");
});

test("postgres bootstrapStandby seeds empty volume via pg_basebackup", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected postgres bootstrapStandby");
  }
  const stateDir = await Deno.makeTempDir({ prefix: "pg-boot-" });
  try {
    const dockerCalls: string[][] = [];
    const boot = await replication.bootstrapStandby(
      {
        managedId: "pg-boot",
        managedNetwork: MANAGED_NETWORK,
        image: "postgres:18-alpine",
        volumes: [{ name: "vol", target: "/var/lib/postgresql" }],
        stateDir,
        containerUser: "postgres",
        containerGroup: "postgres",
        runDocker: (args) => {
          dockerCalls.push([...args]);
          const joined = args.join(" ");
          if (joined.includes("PG_VERSION")) {
            return Promise.resolve({
              success: true,
              stdout: "absent",
              stderr: "",
              code: 0,
            });
          }
          if (joined.includes("pg_basebackup")) {
            return Promise.resolve({
              success: true,
              stdout: "",
              stderr: "",
              code: 0,
            });
          }
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
      },
      standbyReplicationSpec(),
    );
    assertEquals(boot, "seeded");
    const basebackup = dockerCalls.find((args) =>
      args.includes("pg_basebackup")
    );
    assertEquals(basebackup !== undefined, true);
    // The bootstrap container must join the organization's managed network
    // from the context, never a hardcoded platform-wide name.
    assertEquals(
      basebackup![basebackup!.indexOf("--network") + 1],
      MANAGED_NETWORK,
    );
    const envExists = await Deno.stat(`${stateDir}/.basebackup-env`).then(() =>
      false
    ).catch(
      () => true,
    );
    assertEquals(envExists, true);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("postgres bootstrapStandby throws when pg_basebackup fails", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected postgres bootstrapStandby");
  }
  const stateDir = await Deno.makeTempDir({ prefix: "pg-boot-fail-" });
  try {
    await assertRejects(
      () =>
        replication.bootstrapStandby!(
          {
            managedId: "pg-boot",
            managedNetwork: MANAGED_NETWORK,
            image: "postgres:18-alpine",
            volumes: [{ name: "vol", target: "/var/lib/postgresql" }],
            stateDir,
            containerUser: "postgres",
            containerGroup: "postgres",
            runDocker: (args) => {
              const joined = args.join(" ");
              if (joined.includes("PG_VERSION")) {
                return Promise.resolve({
                  success: true,
                  stdout: "absent",
                  stderr: "",
                  code: 0,
                });
              }
              if (joined.includes("pg_basebackup")) {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "basebackup failed",
                  code: 1,
                });
              }
              return Promise.resolve({
                success: true,
                stdout: "",
                stderr: "",
                code: 0,
              });
            },
          },
          standbyReplicationSpec(),
        ),
      Error,
      "pg_basebackup failed",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("postgres promote leaves recovery on first writable check", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.promote) {
    throw new TypeError("expected postgres promote");
  }
  let recoveryChecks = 0;
  const exec: ManagedEngineExec = (_argv, input) => {
    if (input?.includes("pg_promote")) {
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }
    if (input?.includes("pg_is_in_recovery")) {
      recoveryChecks++;
      const stdout = recoveryChecks >= 2 ? "f\n" : "t\n";
      return Promise.resolve({ success: true, stdout, stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await replication.promote(buildContext(exec));
  assertEquals(recoveryChecks >= 2, true);
});

test("postgres readHealth reports primary replication rows", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected postgres readHealth");
  }
  const exec: ManagedEngineExec = (_argv, input) => {
    if (input?.includes("pg_stat_replication")) {
      return Promise.resolve({
        success: true,
        stdout: "streaming\t8192\n",
        stderr: "",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const health = await replication.readHealth(buildContext(exec), "primary");
  assertEquals(health.state, "streaming");
  assertEquals(health.lagBytes, 8192);
});

test("postgres readHealth reports standby lag fields", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected postgres readHealth");
  }
  const exec: ManagedEngineExec = (_argv, input) => {
    if (input?.includes("pg_stat_wal_receiver")) {
      return Promise.resolve({
        success: true,
        stdout: "streaming\t4096\t2\n",
        stderr: "",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const health = await replication.readHealth(buildContext(exec), "standby");
  assertEquals(health.state, "streaming");
  assertEquals(health.lagBytes, 4096);
  assertEquals(health.lagSeconds, 2);
});

test("postgres applyCredentials creates a replication role and skips unknown privileges", async () => {
  const { exec, calls } = recordingExec();
  const applied = await postgresManagedEngineRuntime.applyCredentials(
    buildContext(exec),
    [
      {
        principalId: "p-repl",
        username: "tp_repl",
        role: "replication",
        databases: [],
        password: "repl-pass",
      },
      {
        principalId: "p-app",
        username: "app_user",
        role: "user",
        databases: ["appdb"],
        privileges: ["not-a-privilege", "read-only"],
        password: "app-pass",
      },
    ],
  );
  assertEquals(applied, ["tp_repl", "app_user"]);
  assertEquals(calls.some((c) => c.input?.includes("REPLICATION")), true);
  assertEquals(calls.some((c) => c.input?.includes("GRANT CONNECT")), true);
});

test("postgres applyCredentials throws when psql fails", async () => {
  const exec: ManagedEngineExec = () =>
    Promise.resolve({ success: false, stdout: "", stderr: "role exists" });
  await assertRejects(
    () =>
      postgresManagedEngineRuntime.applyCredentials(buildContext(exec), [{
        principalId: "p-app",
        username: "app_user",
        role: "user",
        databases: ["appdb"],
        password: "app-pass",
      }]),
    Error,
    "psql failed",
  );
});

test("postgres waitReady retries until pg_isready succeeds", async () => {
  let attempts = 0;
  const exec: ManagedEngineExec = (argv) => {
    if (argv.includes("pg_isready")) {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve({
          success: false,
          stdout: "accepting connections soon",
          stderr: "",
        });
      }
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await postgresManagedEngineRuntime.waitReady(buildContext(exec));
  assertEquals(attempts, 2);
});

test("postgres waitReady throws after the readiness deadline", async () => {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let nowCalls = 0;
  Date.now = () => {
    nowCalls++;
    if (nowCalls === 1) return 0;
    if (nowCalls === 2) return 1;
    return 130_000;
  };
  globalThis.setTimeout = ((handler: () => void) => {
    queueMicrotask(handler);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    const exec: ManagedEngineExec = () =>
      Promise.resolve({ success: false, stdout: "", stderr: "still booting" });
    await assertRejects(
      () => postgresManagedEngineRuntime.waitReady(buildContext(exec)),
      Error,
      "managed postgres not ready within",
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("postgres reloadConfig issues pg_reload_conf via psql", async () => {
  if (!postgresManagedEngineRuntime.reloadConfig) {
    throw new TypeError("expected postgres reloadConfig");
  }
  const { exec, calls } = recordingExec();
  await postgresManagedEngineRuntime.reloadConfig(buildContext(exec));
  assertEquals(
    calls.some((c) => c.input?.includes("pg_reload_conf()")),
    true,
  );
});

test("postgres reloadConfig tolerates restart-pending settings but rejects file errors", async () => {
  const reload = postgresManagedEngineRuntime.reloadConfig;
  if (!reload) throw new TypeError("expected postgres reloadConfig");

  const verifyingExec = (row: string): ManagedEngineExec => (_argv, input) => {
    if (input?.includes("pg_file_settings")) {
      return Promise.resolve({ success: true, stdout: `${row}\n`, stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };

  // Restart-required GUCs (e.g. max_replication_slots growth) must not fail.
  await reload(buildContext(verifyingExec("0\t0\t3")));

  // A genuine postgresql.conf error must fail the apply loudly.
  let threw = false;
  try {
    await reload(buildContext(verifyingExec("1\t0\t0")));
  } catch (err) {
    threw = true;
    assertEquals(
      (err as Error).message.includes("postgres config reload failed"),
      true,
    );
  }
  assertEquals(threw, true);
});

test("postgres readVersion returns undefined when the query fails or is empty", async () => {
  const failed = await postgresManagedEngineRuntime.readVersion(
    buildContext(() =>
      Promise.resolve({ success: false, stdout: "", stderr: "denied" })
    ),
  );
  assertEquals(failed, undefined);
  const empty = await postgresManagedEngineRuntime.readVersion(
    buildContext(() =>
      Promise.resolve({ success: true, stdout: "   \n", stderr: "" })
    ),
  );
  assertEquals(empty, undefined);
  const version = await postgresManagedEngineRuntime.readVersion(
    buildContext(() =>
      Promise.resolve({ success: true, stdout: "18.0\n", stderr: "" })
    ),
  );
  assertEquals(version, "18.0");
});

test("postgres applyDatabases creates missing databases, skips existing, and drops", async () => {
  const { exec, calls } = recordingExec();
  const existingThenCreate: ManagedEngineExec = async (argv, input) => {
    if (input?.includes("pg_database") && input.includes("appdb")) {
      return { success: true, stdout: "", stderr: "" };
    }
    if (input?.includes("pg_database") && input.includes("legacy")) {
      return { success: true, stdout: "1\n", stderr: "" };
    }
    return await exec(argv, input);
  };
  const applied = await postgresManagedEngineRuntime.applyDatabases!(
    buildContext(existingThenCreate),
    [
      { action: "create", name: "appdb" },
      { action: "create", name: "legacy" },
      { action: "drop", name: "gone" },
    ],
  );
  assertEquals(applied, ["appdb", "legacy", "gone"]);
  assertEquals(calls.some((c) => c.input?.includes("CREATE DATABASE")), true);
  assertEquals(calls.some((c) => c.input?.includes('"legacy"')), false);
  assertEquals(calls.some((c) => c.input?.includes("DROP DATABASE")), true);
});

test("postgres applyDatabases throws when the existence probe fails", async () => {
  const exec: ManagedEngineExec = (_argv, input) => {
    if (input?.includes("pg_database")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "catalog unavailable",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      postgresManagedEngineRuntime.applyDatabases!(buildContext(exec), [{
        action: "create",
        name: "appdb",
      }]),
    Error,
    "psql failed",
  );
});

test("postgres ensureProxySqlMonitor creates the health-check role", async () => {
  const { exec, calls } = recordingExec();
  await postgresManagedEngineRuntime.ensureProxySqlMonitor!(
    buildContext(exec),
    { user: "tp_monitor", password: "mon-pass" },
  );
  assertEquals(calls.some((c) => c.input?.includes("tp_monitor")), true);
});

test("postgres promote throws when recovery does not clear", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.promote) {
    throw new TypeError("expected postgres promote");
  }
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let nowCalls = 0;
  Date.now = () => {
    nowCalls++;
    if (nowCalls === 1) return 0;
    if (nowCalls <= 5) return 1_000;
    return 70_000;
  };
  globalThis.setTimeout = ((handler: () => void) => {
    queueMicrotask(handler);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const exec: ManagedEngineExec = (_argv, input) => {
    if (input?.includes("pg_is_in_recovery")) {
      return Promise.resolve({ success: true, stdout: "t\n", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  try {
    await assertRejects(
      () => replication.promote!(buildContext(exec)),
      Error,
      "pg_promote did not leave recovery within 60s",
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("postgres readHealth reports unknown when there are no rows or lag is not numeric", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected postgres readHealth");
  }
  const emptyPrimary = await replication.readHealth(
    buildContext(() =>
      Promise.resolve({ success: true, stdout: "", stderr: "" })
    ),
    "primary",
  );
  assertEquals(emptyPrimary.state, "unknown");
  assertEquals(emptyPrimary.lagBytes, undefined);

  const emptyStandby = await replication.readHealth(
    buildContext(() =>
      Promise.resolve({ success: true, stdout: "\n", stderr: "" })
    ),
    "standby",
  );
  assertEquals(emptyStandby.state, "unknown");

  const nonFinite = await replication.readHealth(
    buildContext(() =>
      Promise.resolve({
        success: true,
        stdout: "streaming\tnot-a-number\tbad\n",
        stderr: "",
      })
    ),
    "standby",
  );
  assertEquals(nonFinite.state, "streaming");
  assertEquals(nonFinite.lagBytes, undefined);
  assertEquals(nonFinite.lagSeconds, undefined);
});

test("postgres bootstrapStandby defaults the data root when volumes are empty", async () => {
  const replication = postgresManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected postgres bootstrapStandby");
  }
  const probes: string[] = [];
  const boot = await replication.bootstrapStandby(
    {
      managedId: "pg-boot",
      managedNetwork: MANAGED_NETWORK,
      image: "postgres:18-alpine",
      volumes: [],
      stateDir: "/tmp/pg",
      containerUser: "postgres",
      containerGroup: "postgres",
      runDocker: (args) => {
        probes.push(args.join(" "));
        return Promise.resolve({
          success: true,
          stdout: "present",
          stderr: "",
          code: 0,
        });
      },
    },
    standbyReplicationSpec(),
  );
  assertEquals(boot, "already_standby");
  assertEquals(
    probes.some((joined) =>
      joined.includes("/var/lib/postgresql/data/PG_VERSION")
    ),
    true,
  );
});

test("postgres backup dump argv rejects an unsafe database identifier", () => {
  if (!postgresManagedEngineRuntime.backup) {
    throw new TypeError("expected postgres backup support");
  }
  const ctx = buildContext(recordingExec().exec);
  assertThrows(
    () =>
      postgresManagedEngineRuntime.backup!.dumpArgv(ctx, {
        database: "has space",
      }),
    Error,
    "invalid postgres identifier",
  );
});
