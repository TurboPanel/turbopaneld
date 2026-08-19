/**
 * Host-free unit coverage for MariaDB standby health parsing and seed script.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ManagedApplyCredential } from "../../instance/commands/contracts.ts";
import {
  buildMariadbStandbySeedScript,
  mariadbManagedEngineRuntime,
  parseShowSlaveStatus,
  resolveMariadbPrimaryConnectHost,
} from "./mariadb.ts";
import { changeReplicationSourceSql } from "./mariadb-sql.ts";
import type { ManagedEngineContext, ManagedEngineExec } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HEALTHY_VERTICAL = `
*************************** 1. row ***************************
               Slave_IO_Running: Yes
              Slave_SQL_Running: Yes
        Seconds_Behind_Master: 7
`;

const UNHEALTHY_VERTICAL = `
*************************** 1. row ***************************
               Slave_IO_Running: Connecting
              Slave_SQL_Running: Yes
        Seconds_Behind_Master: NULL
`;

test("parseShowSlaveStatus reports streaming + lag from vertical SHOW SLAVE STATUS", () => {
  const healthy = parseShowSlaveStatus(HEALTHY_VERTICAL);
  assertEquals(healthy.state, "streaming");
  assertEquals(healthy.lagSeconds, 7);

  const reconnecting = parseShowSlaveStatus(UNHEALTHY_VERTICAL);
  assertEquals(reconnecting.state, "reconnecting");
  assertEquals(reconnecting.lagSeconds, undefined);
});

test("resolveMariadbPrimaryConnectHost prefers hostaddr for remote private listener", () => {
  assertEquals(
    resolveMariadbPrimaryConnectHost({
      host: "managed-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      hostaddr: "203.0.113.60",
    }),
    "203.0.113.60",
  );
  const sql = changeReplicationSourceSql({
    host: resolveMariadbPrimaryConnectHost({
      host: "managed-id",
      hostaddr: "203.0.113.60",
    }),
    port: 13306,
    username: "tp_repl",
    password: "s3cret",
  });
  assertEquals(sql.includes("MASTER_HOST = '203.0.113.60'"), true);
  assertEquals(sql.includes("MASTER_SSL_VERIFY_SERVER_CERT = 1"), true);
});

test("buildMariadbStandbySeedScript registers trap before writing credentials", () => {
  const script = buildMariadbStandbySeedScript();
  const trapIdx = script.indexOf("trap ");
  const catIdx = script.indexOf('cat > "$tmp"');
  assertEquals(trapIdx !== -1 && catIdx !== -1 && trapIdx < catIdx, true);
  assertEquals(script.includes("mariadb-dump --defaults-extra-file="), true);
});

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
    composeServiceName: "mariadb",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec,
  };
}

const STANDBY_MARKER = ".turbopanel-standby";

test("mariadb waitReady succeeds on first mariadb-admin ping", async () => {
  const { exec, calls } = recordingExec();
  await mariadbManagedEngineRuntime.waitReady(buildContext(exec));
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.argv.includes("mariadb-admin"), true);
  assertEquals(calls[0]!.argv.includes("ping"), true);
});

test("mariadb applyCredentials creates root and app users via socket", async () => {
  const { exec, calls } = recordingExec();
  const credentials: ManagedApplyCredential[] = [
    {
      principalId: "p-root",
      username: "root",
      role: "root",
      databases: ["appdb"],
      password: "root-pass",
    },
    {
      principalId: "p-app",
      username: "app_user",
      role: "user",
      databases: ["appdb"],
      privileges: ["read-write"],
      password: "app-pass",
    },
  ];
  const applied = await mariadbManagedEngineRuntime.applyCredentials(
    buildContext(exec),
    credentials,
  );
  assertEquals(applied, ["root", "app_user"]);
  assertEquals(calls.every((c) => c.argv.includes("--protocol=socket")), true);
});

test("mariadb dropUsers skips the platform root username", async () => {
  const { exec, calls } = recordingExec();
  if (!mariadbManagedEngineRuntime.dropUsers) {
    throw new TypeError("expected mariadb dropUsers support");
  }
  const dropped = await mariadbManagedEngineRuntime.dropUsers(
    buildContext(exec),
    ["root", "orphan"],
  );
  assertEquals(dropped, ["orphan"]);
  assertEquals(calls.some((c) => c.input?.includes("orphan")), true);
});

test("mariadb bootstrapStandby returns needs_resync when datadir exists without marker", async () => {
  if (!mariadbManagedEngineRuntime.replication?.bootstrapStandby) {
    throw new TypeError("expected mariadb bootstrapStandby");
  }
  const boot = await mariadbManagedEngineRuntime.replication.bootstrapStandby(
    {
      managedId: "mariadb-boot",
      image: "mariadb:11",
      volumes: [{ name: "vol", target: "/var/lib/mysql" }],
      stateDir: "/tmp/mariadb",
      containerUser: "mysql",
      containerGroup: "mysql",
      runDocker: (args) => {
        const joined = args.join(" ");
        if (
          joined.includes("test") && joined.includes("-d") &&
          joined.includes("/mysql")
        ) {
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        }
        if (
          joined.includes("test") && joined.includes("-f") &&
          joined.includes(STANDBY_MARKER)
        ) {
          return Promise.resolve({
            success: false,
            stdout: "",
            stderr: "",
            code: 1,
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
    {
      username: "tp_repl",
      password: "repl",
      primary: { host: "primary", hostaddr: "203.0.113.60", port: 3306 },
      slotName: "tp_member_2",
    },
  );
  assertEquals(boot, "needs_resync");
});

test("mariadb backup refuses system schema identifiers", () => {
  if (!mariadbManagedEngineRuntime.backup) {
    throw new TypeError("expected mariadb backup support");
  }
  const ctx = buildContext(recordingExec().exec);
  assertThrows(
    () =>
      mariadbManagedEngineRuntime.backup!.dumpArgv(ctx, { database: "mysql" }),
    Error,
    "refusing mariadb system schema",
  );
});

test("mariadb readHealth returns primary state for primary role", async () => {
  if (!mariadbManagedEngineRuntime.replication?.readHealth) {
    throw new TypeError("expected mariadb readHealth");
  }
  const health = await mariadbManagedEngineRuntime.replication.readHealth(
    buildContext(recordingExec().exec),
    "primary",
  );
  assertEquals(health.state, "primary");
});

function standbyReplicationSpec() {
  return {
    username: "tp_repl",
    password: "repl-pass",
    primary: { host: "primary", hostaddr: "203.0.113.60", port: 3306 },
    slotName: "tp_member_2",
  };
}

function bootstrapRunDocker(
  datadirExists: boolean,
  markerExists: boolean,
): (
  args: string[],
) => Promise<
  { success: boolean; stdout: string; stderr: string; code: number }
> {
  return (args) => {
    const joined = args.join(" ");
    if (
      joined.includes("test") && joined.includes("-d") &&
      joined.includes("/mysql")
    ) {
      return Promise.resolve({
        success: datadirExists,
        stdout: "",
        stderr: "",
        code: datadirExists ? 0 : 1,
      });
    }
    if (
      joined.includes("test") && joined.includes("-f") &&
      joined.includes(STANDBY_MARKER)
    ) {
      return Promise.resolve({
        success: markerExists,
        stdout: "",
        stderr: "",
        code: markerExists ? 0 : 1,
      });
    }
    return Promise.resolve({ success: false, stdout: "", stderr: "", code: 1 });
  };
}

test("mariadb bootstrapStandby returns seeded when datadir is empty", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected mariadb bootstrapStandby");
  }
  const boot = await replication.bootstrapStandby(
    {
      managedId: "mariadb-boot",
      image: "mariadb:11",
      volumes: [{ name: "vol", target: "/var/lib/mysql" }],
      stateDir: "/tmp/mariadb",
      containerUser: "mysql",
      containerGroup: "mysql",
      runDocker: bootstrapRunDocker(false, false),
    },
    standbyReplicationSpec(),
  );
  assertEquals(boot, "seeded");
});

test("mariadb bootstrapStandby returns already_standby when marker exists", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected mariadb bootstrapStandby");
  }
  const boot = await replication.bootstrapStandby(
    {
      managedId: "mariadb-boot",
      image: "mariadb:11",
      volumes: [{ name: "vol", target: "/var/lib/mysql" }],
      stateDir: "/tmp/mariadb",
      containerUser: "mysql",
      containerGroup: "mysql",
      runDocker: bootstrapRunDocker(true, true),
    },
    standbyReplicationSpec(),
  );
  assertEquals(boot, "already_standby");
});

test("mariadb configureStandby skips when standby marker already exists", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mariadb configureStandby");
  }
  let execCalls = 0;
  const exec: ManagedEngineExec = (argv) => {
    execCalls++;
    if (argv[0] === "test" && argv.includes("-f")) {
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }
    return Promise.reject(new TypeError("unexpected exec when marker present"));
  };
  await replication.configureStandby(
    buildContext(exec),
    standbyReplicationSpec(),
  );
  assertEquals(execCalls, 1);
});

test("mariadb configureStandby seeds replication and writes marker", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mariadb configureStandby");
  }
  const { exec, calls } = recordingExec();
  const failingMarker = async (argv: string[], input?: string) => {
    if (argv[0] === "test" && argv.includes("-f")) {
      return { success: false, stdout: "", stderr: "" };
    }
    return (await exec(argv, input));
  };
  await replication.configureStandby(
    buildContext(failingMarker),
    standbyReplicationSpec(),
  );
  assertEquals(calls.some((c) => c.argv[0] === "sh"), true);
  assertEquals(calls.some((c) => c.input?.includes("203.0.113.60")), true);
  assertEquals(
    calls.some((c) => c.argv.some((part) => part.includes("touch"))),
    true,
  );
});

test("mariadb configureStandby throws when seed script fails", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mariadb configureStandby");
  }
  const exec: ManagedEngineExec = (argv) => {
    if (argv[0] === "test" && argv.includes("-f")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (argv[0] === "sh") {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "seed boom",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      replication.configureStandby!(
        buildContext(exec),
        standbyReplicationSpec(),
      ),
    Error,
    "configureStandby seed failed",
  );
});

test("mariadb promote clears read-only and returns when writable", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.promote) {
    throw new TypeError("expected mariadb promote");
  }
  let writableChecks = 0;
  const exec: ManagedEngineExec = (argv, input) => {
    if (input?.includes("RESET SLAVE")) {
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }
    if (argv.includes("-e")) {
      writableChecks++;
      const stdout = writableChecks >= 2 ? "0\t0\n" : "1\t1\n";
      return Promise.resolve({ success: true, stdout, stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await replication.promote(buildContext(exec));
  assertEquals(writableChecks >= 2, true);
});

test("mariadb readHealth parses standby slave status", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected mariadb readHealth");
  }
  const exec: ManagedEngineExec = (argv) => {
    if (argv.includes("-E")) {
      return Promise.resolve({
        success: true,
        stdout: HEALTHY_VERTICAL,
        stderr: "",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const health = await replication.readHealth(buildContext(exec), "standby");
  assertEquals(health.state, "streaming");
  assertEquals(health.lagSeconds, 7);
});

test("mariadb readHealth returns unknown when status query fails", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected mariadb readHealth");
  }
  const exec: ManagedEngineExec = (argv) => {
    if (argv.includes("-E")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "denied" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const health = await replication.readHealth(buildContext(exec), "standby");
  assertEquals(health.state, "unknown");
});

test("mariadb waitReady retries until mariadb-admin ping succeeds", async () => {
  let attempts = 0;
  const exec: ManagedEngineExec = (argv) => {
    if (argv.includes("mariadb-admin")) {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "not ready",
        });
      }
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await mariadbManagedEngineRuntime.waitReady(buildContext(exec));
  assertEquals(attempts, 2);
});

test("mariadb waitReady throws after the readiness deadline", async () => {
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
      () => mariadbManagedEngineRuntime.waitReady(buildContext(exec)),
      Error,
      "managed mariadb not ready within",
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("mariadb promote throws when the instance stays read-only", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.promote) {
    throw new TypeError("expected mariadb promote");
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
  const exec: ManagedEngineExec = (argv, input) => {
    if (input?.includes("RESET SLAVE")) {
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }
    if (argv.includes("-e")) {
      return Promise.resolve({ success: true, stdout: "1\t1\n", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  try {
    await assertRejects(
      () => replication.promote!(buildContext(exec)),
      Error,
      "mariadb promote did not become writable within 60s",
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("mariadb configureStandby throws when marker write fails", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mariadb configureStandby");
  }
  const exec: ManagedEngineExec = (argv) => {
    if (argv[0] === "test" && argv.includes("-f")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (
      argv[0] === "sh" &&
      argv.some((part) => part.includes(".turbopanel-standby"))
    ) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "touch denied",
      });
    }
    if (argv[0] === "sh") {
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      replication.configureStandby!(
        buildContext(exec),
        standbyReplicationSpec(),
      ),
    Error,
    "configureStandby marker failed",
  );
});

test("mariadb applyDatabases drops databases and ensures ProxySQL monitor", async () => {
  const { exec, calls } = recordingExec();
  const dropped = await mariadbManagedEngineRuntime.applyDatabases!(
    buildContext(exec),
    [{ action: "drop", name: "legacydb" }],
  );
  assertEquals(dropped, ["legacydb"]);
  assertEquals(calls.some((c) => c.input?.includes("DROP DATABASE")), true);

  await mariadbManagedEngineRuntime.ensureProxySqlMonitor!(
    buildContext(exec),
    { user: "tp_monitor", password: "mon-pass" },
  );
  assertEquals(calls.some((c) => c.input?.includes("tp_monitor")), true);
});

test("mariadb readVersion returns undefined when version query fails", async () => {
  const exec: ManagedEngineExec = () =>
    Promise.resolve({ success: false, stdout: "", stderr: "denied" });
  const version = await mariadbManagedEngineRuntime.readVersion(
    buildContext(exec),
  );
  assertEquals(version, undefined);
});

test("mariadb readHealth returns unknown when status query throws", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected mariadb readHealth");
  }
  const exec: ManagedEngineExec = () =>
    Promise.reject(new TypeError("exec unavailable"));
  const health = await replication.readHealth(buildContext(exec), "standby");
  assertEquals(health.state, "unknown");
});

test("mariadb ensurePrimary provisions replication account", async () => {
  const replication = mariadbManagedEngineRuntime.replication;
  if (!replication?.ensurePrimary) {
    throw new TypeError("expected mariadb ensurePrimary");
  }
  const { exec, calls } = recordingExec();
  await replication.ensurePrimary(buildContext(exec), {
    username: "tp_repl",
    password: "repl-pass",
    desiredSlots: [],
    peerAddresses: ["203.0.113.60"],
  });
  assertEquals(calls.some((c) => c.input?.includes("tp_repl")), true);
});
