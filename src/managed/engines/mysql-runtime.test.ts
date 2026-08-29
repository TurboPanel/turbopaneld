/**
 * Host-free unit coverage for MySQL standby health parsing and seed script.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ManagedApplyCredential } from "../../instance/commands/contracts.ts";
import {
  BINLOG_EXPIRE_LOGS_SECONDS,
  buildMysqlStandbySeedScript,
  mysqlManagedEngineRuntime,
  parseShowReplicaStatus,
  resolveMysqlPrimaryConnectHost,
} from "./mysql.ts";
import { changeReplicationSourceSql } from "./mysql-sql.ts";
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

const HEALTHY_VERTICAL = `
*************************** 1. row ***************************
             Replica_IO_Running: Yes
            Replica_SQL_Running: Yes
          Seconds_Behind_Source: 3
`;

const UNHEALTHY_VERTICAL = `
*************************** 1. row ***************************
             Replica_IO_Running: No
            Replica_SQL_Running: No
          Seconds_Behind_Source: NULL
`;

test("parseShowReplicaStatus reports streaming + lag from vertical SHOW REPLICA STATUS", () => {
  const healthy = parseShowReplicaStatus(HEALTHY_VERTICAL);
  assertEquals(healthy.state, "streaming");
  assertEquals(healthy.lagSeconds, 3);

  const stopped = parseShowReplicaStatus(UNHEALTHY_VERTICAL);
  assertEquals(stopped.state, "stopped");
  assertEquals(stopped.lagSeconds, undefined);
});

test("resolveMysqlPrimaryConnectHost prefers hostaddr for remote private listener", () => {
  assertEquals(
    resolveMysqlPrimaryConnectHost({
      host: "managed-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      hostaddr: "203.0.113.50",
    }),
    "203.0.113.50",
  );
  assertEquals(
    resolveMysqlPrimaryConnectHost({ host: "svc-1" }),
    "svc-1",
  );

  const sql = changeReplicationSourceSql({
    host: resolveMysqlPrimaryConnectHost({
      host: "managed-id",
      hostaddr: "203.0.113.50",
    }),
    port: 45001,
    username: "tp_repl",
    password: "s3cret",
  });
  assertEquals(sql.includes("SOURCE_HOST = '203.0.113.50'"), true);
  assertEquals(sql.includes("SOURCE_SSL_VERIFY_SERVER_CERT = 1"), true);
});

test("buildMysqlStandbySeedScript registers trap before writing credentials", () => {
  const script = buildMysqlStandbySeedScript();
  const trapIdx = script.indexOf("trap ");
  const catIdx = script.indexOf('cat > "$tmp"');
  assertEquals(trapIdx !== -1, true);
  assertEquals(catIdx !== -1, true);
  assertEquals(trapIdx < catIdx, true);
  assertEquals(script.includes("pipefail"), true);
  assertEquals(script.includes("mysqldump --defaults-extra-file="), true);
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
    composeServiceName: "mysql",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec,
  };
}

test("mysql waitReady succeeds on first mysqladmin ping", async () => {
  const { exec, calls } = recordingExec();
  await mysqlManagedEngineRuntime.waitReady(buildContext(exec));
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.argv.includes("mysqladmin"), true);
  assertEquals(calls[0]!.argv.includes("ping"), true);
});

test("mysql waitReady retries mysqladmin ping via defaults-extra-file after 1045", async () => {
  const calls: RecordedExec[] = [];
  let n = 0;
  const exec: ManagedEngineExec = (argv, input) => {
    calls.push({ argv: [...argv], input });
    n += 1;
    if (n === 1) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr:
          "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await mysqlManagedEngineRuntime.waitReady({
    ...buildContext(exec),
    socketPassword: "root-pass",
  });
  assertEquals(calls.length, 2);
  assertEquals(calls[1]!.argv[0], "sh");
  assertEquals(calls[1]!.argv.includes("mysqladmin"), true);
  assertEquals(calls[1]!.input?.includes("[client]"), true);
  assertEquals(calls[1]!.input?.includes("password=root-pass"), true);
});

test("mysql waitReady retries ping when mysqladmin exits 0 on 1045", async () => {
  const calls: RecordedExec[] = [];
  let n = 0;
  const exec: ManagedEngineExec = (argv, input) => {
    calls.push({ argv: [...argv], input });
    n += 1;
    if (n === 1) {
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr:
          "mysqladmin: connect to server at 'localhost' failed\nerror: 'Access denied for user 'root'@'localhost' (using password: NO)'",
      });
    }
    return Promise.resolve({
      success: true,
      stdout: "mysqld is alive",
      stderr: "",
    });
  };
  await mysqlManagedEngineRuntime.waitReady({
    ...buildContext(exec),
    socketPassword: "root-pass",
  });
  assertEquals(calls.length, 2);
  assertEquals(calls[1]!.argv[0], "sh");
  assertEquals(calls[1]!.input?.includes("password=root-pass"), true);
});

test("mysql applyCredentials creates root and app users via socket mysql", async () => {
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
  const applied = await mysqlManagedEngineRuntime.applyCredentials(
    buildContext(exec),
    credentials,
  );
  assertEquals(applied, ["root", "app_user"]);
  assertEquals(calls.every((c) => c.argv.includes("--protocol=socket")), true);
  assertEquals(calls.some((c) => c.input?.includes("app_user")), true);
  const rootSql =
    calls.find((c) => c.input?.includes("IDENTIFIED WITH auth_socket"))
      ?.input ?? "";
  assertEquals(rootSql.includes("IDENTIFIED WITH auth_socket"), true);
  assertEquals(rootSql.includes("INSTALL PLUGIN"), false);
  assertEquals(
    /ALTER USER `root`@'localhost' IDENTIFIED BY/.test(rootSql),
    false,
  );
});

test("mysql dropUsers skips the platform root username", async () => {
  const { exec, calls } = recordingExec();
  if (!mysqlManagedEngineRuntime.dropUsers) {
    throw new TypeError("expected mysql dropUsers support");
  }
  const dropped = await mysqlManagedEngineRuntime.dropUsers(
    buildContext(exec),
    ["root", "orphan"],
  );
  assertEquals(dropped, ["orphan"]);
  assertEquals(calls.some((c) => c.input?.includes("orphan")), true);
  assertEquals(calls.some((c) => c.input?.includes("'root'")), false);
});

const STANDBY_MARKER = ".turbopanel-standby";

test("mysql bootstrapStandby returns needs_resync when datadir exists without marker", async () => {
  if (!mysqlManagedEngineRuntime.replication?.bootstrapStandby) {
    throw new TypeError("expected mysql bootstrapStandby");
  }
  const boot = await mysqlManagedEngineRuntime.replication.bootstrapStandby(
    {
      managedId: "mysql-boot",
      managedNetwork: MANAGED_NETWORK,
      image: "mysql:8",
      volumes: [{ name: "vol", target: "/var/lib/mysql" }],
      stateDir: "/tmp/mysql",
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
            stdout: "present",
            stderr: "",
            code: 0,
          });
        }
        if (
          joined.includes("test") && joined.includes("-f") &&
          joined.includes(STANDBY_MARKER)
        ) {
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
    {
      username: "tp_repl",
      password: "repl",
      primary: { host: "primary", hostaddr: "203.0.113.50", port: 3306 },
      slotName: "tp_member_2",
    },
  );
  assertEquals(boot, "needs_resync");
});

test("mysql backup refuses system schema identifiers", () => {
  if (!mysqlManagedEngineRuntime.backup) {
    throw new TypeError("expected mysql backup support");
  }
  const ctx = buildContext(recordingExec().exec);
  assertThrows(
    () =>
      mysqlManagedEngineRuntime.backup!.dumpArgv(ctx, { database: "mysql" }),
    Error,
    "refusing mysql system schema",
  );
});

test("mysql readHealth returns primary state for primary role", async () => {
  if (!mysqlManagedEngineRuntime.replication?.readHealth) {
    throw new TypeError("expected mysql readHealth");
  }
  const health = await mysqlManagedEngineRuntime.replication.readHealth(
    buildContext(recordingExec().exec),
    "primary",
  );
  assertEquals(health.state, "primary");
});

function standbyReplicationSpec() {
  return {
    username: "tp_repl",
    password: "repl-pass",
    primary: { host: "primary", hostaddr: "203.0.113.50", port: 3306 },
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
        success: true,
        stdout: datadirExists ? "present" : "absent",
        stderr: "",
        code: 0,
      });
    }
    if (
      joined.includes("test") && joined.includes("-f") &&
      joined.includes(STANDBY_MARKER)
    ) {
      return Promise.resolve({
        success: true,
        stdout: markerExists ? "present" : "absent",
        stderr: "",
        code: 0,
      });
    }
    return Promise.resolve({ success: false, stdout: "", stderr: "", code: 1 });
  };
}

test("mysql bootstrapStandby returns seeded when datadir is empty", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected mysql bootstrapStandby");
  }
  const boot = await replication.bootstrapStandby(
    {
      managedId: "mysql-boot",
      managedNetwork: MANAGED_NETWORK,
      image: "mysql:8",
      volumes: [{ name: "vol", target: "/var/lib/mysql" }],
      stateDir: "/tmp/mysql",
      containerUser: "mysql",
      containerGroup: "mysql",
      runDocker: bootstrapRunDocker(false, false),
    },
    standbyReplicationSpec(),
  );
  assertEquals(boot, "seeded");
});

test("mysql bootstrapStandby returns already_standby when marker exists", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected mysql bootstrapStandby");
  }
  const boot = await replication.bootstrapStandby(
    {
      managedId: "mysql-boot",
      managedNetwork: MANAGED_NETWORK,
      image: "mysql:8",
      volumes: [{ name: "vol", target: "/var/lib/mysql" }],
      stateDir: "/tmp/mysql",
      containerUser: "mysql",
      containerGroup: "mysql",
      runDocker: bootstrapRunDocker(true, true),
    },
    standbyReplicationSpec(),
  );
  assertEquals(boot, "already_standby");
});

test("mysql configureStandby skips when standby marker already exists", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mysql configureStandby");
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

test("mysql configureStandby seeds replication and writes marker", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mysql configureStandby");
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
  assertEquals(calls.some((c) => c.input?.includes("203.0.113.50")), true);
  assertEquals(
    calls.some((c) => c.argv.some((part) => part.includes("touch"))),
    true,
  );
});

test("mysql configureStandby throws when seed script fails", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mysql configureStandby");
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

test("mysql promote clears read-only and returns when writable", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.promote) {
    throw new TypeError("expected mysql promote");
  }
  let writableChecks = 0;
  const exec: ManagedEngineExec = (argv, input) => {
    if (input?.includes("RESET") || input?.includes("SOURCE")) {
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

test("mysql readHealth parses standby replica status", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected mysql readHealth");
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
  assertEquals(health.lagSeconds, 3);
});

test("mysql readHealth returns unknown when replica status is empty", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected mysql readHealth");
  }
  const exec: ManagedEngineExec = (argv) => {
    if (argv.includes("-E")) {
      return Promise.resolve({ success: true, stdout: "   \n", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const health = await replication.readHealth(buildContext(exec), "standby");
  assertEquals(health.state, "unknown");
});

test("mysql waitReady retries until mysqladmin ping succeeds", async () => {
  let attempts = 0;
  const exec: ManagedEngineExec = (argv) => {
    if (argv.includes("mysqladmin")) {
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
  await mysqlManagedEngineRuntime.waitReady(buildContext(exec));
  assertEquals(attempts, 2);
});

test("mysql waitReady throws after the readiness deadline", async () => {
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
      () => mysqlManagedEngineRuntime.waitReady(buildContext(exec)),
      Error,
      "managed mysql not ready within",
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("mysql promote throws when the instance stays read-only", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.promote) {
    throw new TypeError("expected mysql promote");
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
    if (input?.includes("RESET") || input?.includes("SOURCE")) {
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
      "mysql promote did not become writable within 60s",
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("mysql configureStandby throws when marker write fails", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mysql configureStandby");
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

test("mysql applyDatabases drops databases and ensures ProxySQL monitor", async () => {
  const { exec, calls } = recordingExec();
  const dropped = await mysqlManagedEngineRuntime.applyDatabases!(
    buildContext(exec),
    [{ action: "drop", name: "legacydb" }],
  );
  assertEquals(dropped, ["legacydb"]);
  assertEquals(calls.some((c) => c.input?.includes("DROP DATABASE")), true);

  await mysqlManagedEngineRuntime.ensureProxySqlMonitor!(
    buildContext(exec),
    { user: "tp_monitor", password: "mon-pass" },
  );
  assertEquals(calls.some((c) => c.input?.includes("tp_monitor")), true);
});

test("mysql readVersion returns undefined when version query fails", async () => {
  const exec: ManagedEngineExec = () =>
    Promise.resolve({ success: false, stdout: "", stderr: "denied" });
  const version = await mysqlManagedEngineRuntime.readVersion(
    buildContext(exec),
  );
  assertEquals(version, undefined);
});

test("mysql readHealth returns unknown when status query throws", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.readHealth) {
    throw new TypeError("expected mysql readHealth");
  }
  const exec: ManagedEngineExec = () =>
    Promise.reject(new TypeError("exec unavailable"));
  const health = await replication.readHealth(buildContext(exec), "standby");
  assertEquals(health.state, "unknown");
});

test("mysql ensurePrimary provisions replication account", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.ensurePrimary) {
    throw new TypeError("expected mysql ensurePrimary");
  }
  const { exec, calls } = recordingExec();
  await replication.ensurePrimary(buildContext(exec), {
    username: "tp_repl",
    password: "repl-pass",
    desiredSlots: [],
    peerAddresses: ["203.0.113.10"],
  });
  assertEquals(calls.some((c) => c.input?.includes("tp_repl")), true);
});

const DENIED_NO_PASSWORD =
  "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)";

function deniedThenOk(): { exec: ManagedEngineExec; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  let n = 0;
  const exec: ManagedEngineExec = (argv, input) => {
    calls.push({ argv: [...argv], input });
    n += 1;
    if (n === 1) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: DENIED_NO_PASSWORD,
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { exec, calls };
}

test("mysql waitReady does not use defaults-extra-file without a socket password", async () => {
  const { exec, calls } = deniedThenOk();
  await mysqlManagedEngineRuntime.waitReady(buildContext(exec));
  assertEquals(calls.length, 2);
  assertEquals(calls.every((c) => c.argv.includes("mysqladmin")), true);
  assertEquals(calls.some((c) => c.argv[0] === "sh"), false);
});

test("mysql applyDatabases retries SQL via defaults-extra-file after 1045", async () => {
  const { exec, calls } = deniedThenOk();
  const applied = await mysqlManagedEngineRuntime.applyDatabases!(
    { ...buildContext(exec), socketPassword: "root-pass" },
    [{ action: "create", name: "appdb" }],
  );
  assertEquals(applied, ["appdb"]);
  assertEquals(calls[1]!.argv[0], "sh");
  assertEquals(calls[1]!.input?.includes("__TP_SQL__"), true);
  assertEquals(calls[1]!.input?.includes("password=root-pass"), true);
  assertEquals(calls[1]!.input?.includes("CREATE DATABASE"), true);
});

test("mysql applyCredentials skips plugin install when auth_socket is already loaded", async () => {
  const { exec, calls } = recordingExec();
  const pluginPresent: ManagedEngineExec = (argv, input) => {
    if (argv.includes("-e")) {
      const sql = argv[argv.indexOf("-e") + 1] ?? "";
      if (sql.includes("PLUGIN_NAME")) {
        return Promise.resolve({
          success: true,
          stdout: "auth_socket\n",
          stderr: "",
        });
      }
    }
    return exec(argv, input);
  };
  const applied = await mysqlManagedEngineRuntime.applyCredentials(
    buildContext(pluginPresent),
    [{
      principalId: "p-root",
      username: "root",
      role: "root",
      databases: ["appdb"],
      password: "root-pass",
    }],
  );
  assertEquals(applied, ["root"]);
  assertEquals(
    calls.some((c) => c.input?.includes("INSTALL PLUGIN")),
    false,
  );
});

test("mysql applyCredentials treats plugin install already-exists as success", async () => {
  const calls: RecordedExec[] = [];
  const exec: ManagedEngineExec = (argv, input) => {
    calls.push({ argv: [...argv], input });
    if (input?.includes("INSTALL PLUGIN")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "ERROR 1125: Function 'auth_socket' already exists",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const applied = await mysqlManagedEngineRuntime.applyCredentials(
    buildContext(exec),
    [{
      principalId: "p-root",
      username: "root",
      role: "root",
      databases: ["appdb"],
      password: "root-pass",
    }],
  );
  assertEquals(applied, ["root"]);
  assertEquals(calls.some((c) => c.input?.includes("INSTALL PLUGIN")), true);
});

test("mysql applyCredentials throws when plugin install fails", async () => {
  const exec: ManagedEngineExec = (_argv, input) => {
    if (input?.includes("INSTALL PLUGIN")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "plugin load denied",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      mysqlManagedEngineRuntime.applyCredentials(buildContext(exec), [{
        principalId: "p-root",
        username: "root",
        role: "root",
        databases: ["appdb"],
        password: "root-pass",
      }]),
    Error,
    "mysql failed",
  );
});

test("mysql applyCredentials creates a replication role and skips unknown privileges", async () => {
  const { exec, calls } = recordingExec();
  const applied = await mysqlManagedEngineRuntime.applyCredentials(
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
  assertEquals(calls.some((c) => c.input?.includes("tp_repl")), true);
  assertEquals(calls.some((c) => c.input?.includes("GRANT")), true);
});

test("mysql applyDatabases throws when mysql fails", async () => {
  const exec: ManagedEngineExec = () =>
    Promise.resolve({ success: false, stdout: "", stderr: "disk full" });
  await assertRejects(
    () =>
      mysqlManagedEngineRuntime.applyDatabases!(buildContext(exec), [{
        action: "create",
        name: "appdb",
      }]),
    Error,
    "mysql failed",
  );
});

test("mysql backup dump/restore argv target the app database", () => {
  if (!mysqlManagedEngineRuntime.backup) {
    throw new TypeError("expected mysql backup support");
  }
  const ctx = buildContext(recordingExec().exec);
  assertEquals(
    mysqlManagedEngineRuntime.backup.dumpArgv(ctx, { database: "appdb" })
      .includes("appdb"),
    true,
  );
  assertEquals(
    mysqlManagedEngineRuntime.backup.restoreArgv(ctx, { database: "appdb" }),
    ["mysql", "--protocol=socket", "appdb"],
  );
  assertEquals(BINLOG_EXPIRE_LOGS_SECONDS, 7 * 24 * 60 * 60);
  assertThrows(
    () =>
      mysqlManagedEngineRuntime.backup!.dumpArgv(ctx, {
        database: "information_schema",
      }),
    Error,
    "refusing mysql system schema",
  );
});

test("mysql readVersion returns a trimmed version or undefined when empty", async () => {
  const version = await mysqlManagedEngineRuntime.readVersion(
    buildContext(() =>
      Promise.resolve({ success: true, stdout: "  8.4.0\n", stderr: "" })
    ),
  );
  assertEquals(version, "8.4.0");
  const empty = await mysqlManagedEngineRuntime.readVersion(
    buildContext(() =>
      Promise.resolve({ success: true, stdout: "   \n", stderr: "" })
    ),
  );
  assertEquals(empty, undefined);
});

test("parseShowReplicaStatus reports reconnecting from mixed IO/SQL and Slave_* aliases", () => {
  const mixed = parseShowReplicaStatus(`
             Slave_IO_Running: Yes
            Slave_SQL_Running: No
         Seconds_Behind_Master: not-a-number
`);
  assertEquals(mixed.state, "reconnecting");
  assertEquals(mixed.lagSeconds, undefined);
});

test("mysql bootstrapStandby defaults the data root when volumes are empty", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.bootstrapStandby) {
    throw new TypeError("expected mysql bootstrapStandby");
  }
  const probes: string[] = [];
  const boot = await replication.bootstrapStandby(
    {
      managedId: "mysql-boot",
      managedNetwork: MANAGED_NETWORK,
      image: "mysql:8",
      volumes: [],
      stateDir: "/tmp/mysql",
      containerUser: "mysql",
      containerGroup: "mysql",
      runDocker: (args) => {
        probes.push(args.join(" "));
        return Promise.resolve({
          success: true,
          stdout: "absent",
          stderr: "",
          code: 0,
        });
      },
    },
    standbyReplicationSpec(),
  );
  assertEquals(boot, "seeded");
  assertEquals(
    probes.some((joined) => joined.includes("/var/lib/mysql/mysql")),
    true,
  );
});

test("mysql configureStandby dials the DNS SAN when hostaddr is omitted", async () => {
  const replication = mysqlManagedEngineRuntime.replication;
  if (!replication?.configureStandby) {
    throw new TypeError("expected mysql configureStandby");
  }
  const { exec, calls } = recordingExec();
  const missingMarker: ManagedEngineExec = async (argv, input) => {
    if (argv[0] === "test" && argv.includes("-f")) {
      return { success: false, stdout: "", stderr: "" };
    }
    return await exec(argv, input);
  };
  await replication.configureStandby(buildContext(missingMarker), {
    username: "tp_repl",
    password: "repl-pass",
    primary: { host: "svc-primary", port: 3306 },
    slotName: "tp_member_2",
  });
  assertEquals(calls.some((c) => c.input?.includes("host=svc-primary")), true);
  // The seed import needs a writable window (standby my.cnf boots
  // super_read_only) and read-only must be re-enforced afterwards.
  const inputs = calls.map((c) => c.input ?? "");
  const disableIdx = inputs.findIndex((i) =>
    i.includes("SET GLOBAL super_read_only = OFF;")
  );
  const enforceIdx = inputs.findIndex((i) =>
    i.includes("SET GLOBAL super_read_only = ON;")
  );
  assertEquals(disableIdx >= 0, true);
  assertEquals(enforceIdx > disableIdx, true);
});
