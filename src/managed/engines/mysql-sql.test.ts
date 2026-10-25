import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  authSocketPluginPresentSql,
  changeReplicationSourceSql,
  connectionCensusSql,
  createClientAccountSql,
  createDatabaseSql,
  createNetworkAccountSql,
  createOrAlterAccountSql,
  disableReadOnlySql,
  dropAccountSql,
  dropDatabaseSql,
  enforceReadOnlySql,
  ensureProxySqlMonitorAccountSql,
  ensureReplicationAccountSql,
  ensureSocketAdminSql,
  flushPrivilegesLocalSql,
  followReplicationSourceSql,
  grantDatabaseSql,
  grantReplicationSql,
  grantRootSql,
  installAuthSocketPluginSql,
  isWritableSql,
  MANAGED_DOCKER_NETWORK_HOST,
  primaryFinalGtidSetSql,
  promoteSql,
  quoteAccount,
  quoteIdentifier,
  quoteLiteral,
  resetReplicaGtidStateSql,
  seedWindowReadOnlySql,
  showReplicaStatusSql,
  standbyReplicationStatusSql,
  versionSql,
  withoutSessionBinlogSql,
} from "./mysql-sql.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("quoteIdentifier backticks and doubles embedded backticks", () => {
  assertEquals(quoteIdentifier("app_user"), "`app_user`");
  // Identifiers must match SAFE pattern — embedded backticks are rejected, not escaped.
  assertThrows(() => quoteIdentifier("a`b"), Error);
  assertThrows(() => quoteIdentifier("has-dash"), Error);
  assertThrows(() => quoteIdentifier("a".repeat(65)), Error);
});

test("quoteLiteral escapes backslashes and single quotes", () => {
  assertEquals(quoteLiteral("p@ss'word"), String.raw`'p@ss\'word'`);
  assertEquals(quoteLiteral(String.raw`back\slash`), String.raw`'back\\slash'`);
  assertThrows(() => quoteLiteral("bad\npass"), Error);
  assertThrows(() => quoteLiteral("bad\0pass"), Error);
});

test("account and privilege SQL uses managed-network netmask scoping", () => {
  const create = createOrAlterAccountSql(
    "app",
    "s3cret",
    MANAGED_DOCKER_NETWORK_HOST,
  );
  assertEquals(create.includes("`app`@'172.16.0.0/255.240.0.0'"), true);
  assertEquals(create.includes("172.%'"), false);
  assertEquals(create.includes("IDENTIFIED BY"), true);

  const grant = grantDatabaseSql("appdb", "app", "owner");
  assertEquals(grant.includes("ALL PRIVILEGES ON `appdb`.*"), true);
  assertEquals(grant.includes("WITH GRANT OPTION"), false);
  assertEquals(
    grantDatabaseSql("appdb", "app", "admin").includes("WITH GRANT OPTION"),
    true,
  );
  assertEquals(
    grantDatabaseSql("appdb", "app", "read-only").includes("SELECT, SHOW VIEW"),
    true,
  );
  assertEquals(grantRootSql("root").includes("*.*"), true);
  const replGrant = grantReplicationSql("repl", "203.0.113.20");
  assertEquals(replGrant.includes("REPLICATION SLAVE"), true);
  // Server-side TLS enforcement, independent of what the standby requests.
  assertEquals(replGrant.includes("REQUIRE SSL"), true);
});

test("ensureReplicationAccountSql creates one account per peer host", () => {
  const sql = ensureReplicationAccountSql("tp_repl", "s3cret", [
    "203.0.113.20",
    "203.0.113.21",
  ]);
  assertEquals(sql.includes("`tp_repl`@'203.0.113.20'"), true);
  assertEquals(sql.includes("`tp_repl`@'203.0.113.21'"), true);
  assertEquals(sql.includes("REQUIRE SSL"), true);
  assertEquals(sql.includes("FLUSH PRIVILEGES"), true);
});

test("ensureProxySqlMonitorAccountSql is scoped to managed network", () => {
  const sql = ensureProxySqlMonitorAccountSql("tp_monitor", "mon-s3cret");
  assertEquals(sql.includes("`tp_monitor`@'172.16.0.0/255.240.0.0'"), true);
  assertEquals(sql.includes("PROCESS"), true);
  assertEquals(sql.includes("REPLICATION CLIENT"), true);
});

test("dropAccountSql covers managed network and localhost", () => {
  const sql = dropAccountSql("app");
  assertEquals(sql.includes("`app`@'172.16.0.0/255.240.0.0'"), true);
  assertEquals(sql.includes("172.%'"), false);
  assertEquals(sql.includes("`app`@'localhost'"), true);
});

test("createClientAccountSql covers network and localhost", () => {
  const sql = createClientAccountSql("app", "x");
  assertEquals(sql.includes(MANAGED_DOCKER_NETWORK_HOST), true);
  assertEquals(sql.includes("172.%"), false);
  assertEquals(sql.includes("localhost"), true);
});

test("createNetworkAccountSql is managed-network only", () => {
  const sql = createNetworkAccountSql("root", "x");
  assertEquals(sql.includes(MANAGED_DOCKER_NETWORK_HOST), true);
  assertEquals(sql.includes("localhost"), false);
  assertEquals(sql.includes("IDENTIFIED BY"), true);
});

test("ensureSocketAdminSql installs auth_socket on localhost only", () => {
  const sql = ensureSocketAdminSql();
  assertEquals(sql.includes("auth_socket"), true);
  assertEquals(sql.includes("`root`@'localhost'"), true);
  assertEquals(sql.includes("`mysql`@'localhost'"), true);
  assertEquals(sql.includes("IDENTIFIED BY"), false);
  assertEquals(sql.includes(MANAGED_DOCKER_NETWORK_HOST), false);
  assertEquals(sql.includes("INSTALL PLUGIN"), false);
  assertEquals(sql.includes("IF NOT EXISTS auth_socket"), false);
});

test("installAuthSocketPluginSql is MySQL INSTALL PLUGIN without IF NOT EXISTS", () => {
  const sql = installAuthSocketPluginSql();
  assertEquals(sql.includes("INSTALL PLUGIN auth_socket"), true);
  assertEquals(sql.includes("IF NOT EXISTS"), false);
  assertEquals(
    authSocketPluginPresentSql().includes("INFORMATION_SCHEMA.PLUGINS"),
    true,
  );
});

function assertWrappedInSessionBinlogOff(sql: string, inner: string): void {
  const off = sql.indexOf("SET SESSION sql_log_bin = 0;");
  const body = sql.indexOf(inner);
  const on = sql.lastIndexOf("SET SESSION sql_log_bin = 1;");
  assertEquals(off !== -1 && body !== -1 && on !== -1, true);
  assertEquals(off < body && body < on, true);
}

test("replica-local SQL is wrapped so it cannot mint a replica GTID", () => {
  assertWrappedInSessionBinlogOff(
    withoutSessionBinlogSql("FLUSH PRIVILEGES;"),
    "FLUSH PRIVILEGES;",
  );
  assertWrappedInSessionBinlogOff(
    flushPrivilegesLocalSql(),
    "FLUSH PRIVILEGES;",
  );
  assertWrappedInSessionBinlogOff(
    installAuthSocketPluginSql(),
    "INSTALL PLUGIN auth_socket",
  );
  assertEquals(resetReplicaGtidStateSql(), "RESET BINARY LOGS AND GTIDS;");
  assertEquals(resetReplicaGtidStateSql().includes("RESET MASTER"), false);
});

test("databases use utf8mb4", () => {
  assertEquals(
    createDatabaseSql("appdb").includes("utf8mb4"),
    true,
  );
  assertEquals(
    dropDatabaseSql("appdb").includes("DROP DATABASE IF EXISTS"),
    true,
  );
});

test("dumpArgv rejects system schemas and validates identifiers", () => {
  const backup = mysqlManagedEngineRuntime.backup;
  if (!backup) throw new TypeError("expected backup runtime");
  const ctx = {
    containerId: "c",
    composeServiceName: "mysql",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
  };
  const argv = backup.dumpArgv(ctx, { database: "appdb" });
  assertEquals(argv[0], "mysqldump");
  assertEquals(argv.includes("appdb"), true);
  assertEquals(argv.includes("--set-gtid-purged=OFF"), true);
  assertEquals(argv.includes("--set-gtid-purged=ON"), false);
  assertThrows(() => backup.dumpArgv(ctx, { database: "mysql" }), Error);
  assertThrows(
    () => backup.dumpArgv(ctx, { database: "information_schema" }),
    Error,
  );
  assertThrows(() => backup.dumpArgv(ctx, { database: "has-dash" }), Error);
});

test("quoteIdentifier rejects empty identifiers", () => {
  assertThrows(() => quoteIdentifier(""), Error);
});

test("quoteAccount uses account max length", () => {
  assertEquals(quoteAccount("app_user"), "`app_user`");
  assertThrows(() => quoteAccount("a".repeat(33)), Error);
});

test("read-write grants data changes only and revokes the rest", () => {
  const sql = grantDatabaseSql("appdb", "app", "read-write");
  const [grant, ...rest] = sql.split("\n");
  assertEquals(
    grant.startsWith(
      "GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, LOCK TABLES, " +
        "CREATE TEMPORARY TABLES, SHOW VIEW ON `appdb`.* TO ",
    ),
    true,
  );
  assertEquals(grant.includes("WITH GRANT OPTION"), false);
  const revoke = rest.join("\n");
  for (
    const [name, column] of [
      ["CREATE", "Create_priv"],
      ["DROP", "Drop_priv"],
      ["INDEX", "Index_priv"],
      ["ALTER", "Alter_priv"],
      ["CREATE VIEW", "Create_view_priv"],
      ["CREATE ROUTINE", "Create_routine_priv"],
      ["ALTER ROUTINE", "Alter_routine_priv"],
      ["EVENT", "Event_priv"],
      ["TRIGGER", "Trigger_priv"],
      ["REFERENCES", "References_priv"],
    ]
  ) {
    const kept = grant.slice(6, grant.indexOf(" ON ")).split(", ");
    assertEquals(kept.includes(name), false, name);
    assertEquals(
      revoke.includes(`IF(${column} = 'Y'`) && revoke.includes(`'${name}'`),
      true,
      name,
    );
  }
  // What it keeps is never in the revoke list.
  assertEquals(revoke.includes("Select_priv"), false);
  assertEquals(revoke.includes("Execute_priv"), false);
  assertEquals(revoke.includes("Grant_priv = 'Y', 'GRANT OPTION'"), true);
  assertEquals(revoke.includes("DO 0"), true);
  // A login that still defines a trigger keeps TRIGGER: the trigger would
  // otherwise fail every write to its table (error 1142).
  assertStringIncludes(
    revoke,
    "IF(Trigger_priv = 'Y' AND NOT EXISTS (SELECT 1 FROM information_schema.TRIGGERS " +
      "WHERE TRIGGER_SCHEMA = 'appdb' AND DEFINER = 'app@",
  );
});

test("read-only grants SELECT and SHOW VIEW and no EXECUTE", () => {
  const [grant, ...rest] = grantDatabaseSql("appdb", "ro", "read-only")
    .split("\n");
  assertEquals(
    grant.startsWith("GRANT SELECT, SHOW VIEW ON `appdb`.* TO "),
    true,
  );
  const revoke = rest.join("\n");
  assertEquals(revoke.includes("Execute_priv"), true);
  assertEquals(revoke.includes("Insert_priv"), true);
  assertEquals(revoke.includes("Select_priv"), false);
});

test("owner (migration) grants everything in the database without the grant option", () => {
  const sql = grantDatabaseSql("appdb", "mig", "owner");
  assertEquals(sql.includes("GRANT ALL PRIVILEGES ON `appdb`.* TO "), true);
  assertEquals(sql.includes("WITH GRANT OPTION"), false);
  assertEquals(sql.includes("Grant_priv = 'Y', 'GRANT OPTION'"), true);
  assertEquals(sql.includes("Create_priv"), false);
});

test("admin keeps the grant option", () => {
  const sql = grantDatabaseSql("appdb", "adm", "admin");
  assertEquals(sql.endsWith("WITH GRANT OPTION;"), true);
  assertEquals(sql.includes("REVOKE"), false);
});

test("ensureReplicationAccountSql falls back to managed network when peers empty", () => {
  const sql = ensureReplicationAccountSql("tp_repl", "s3cret", []);
  assertEquals(sql.includes("`tp_repl`@'172.16.0.0/255.240.0.0'"), true);
  assertEquals(sql.includes("REQUIRE SSL"), true);
  assertEquals(sql.includes("FLUSH PRIVILEGES"), true);
});

test("replication and status SQL builders", () => {
  assertEquals(promoteSql().includes("STOP REPLICA"), true);
  assertEquals(isWritableSql().includes("read_only"), true);
  assertEquals(showReplicaStatusSql(), "SHOW REPLICA STATUS;");
  assertEquals(versionSql(), "SELECT VERSION();");
  const standby = standbyReplicationStatusSql();
  assertEquals(standby.includes("Replica_IO_Running"), true);
  assertEquals(standby.includes("lag_seconds"), true);
  const change = changeReplicationSourceSql({
    host: "203.0.113.50",
    port: 3306,
    username: "repl",
    password: "s3cret",
  });
  for (
    const expected of [
      "CHANGE REPLICATION SOURCE TO",
      "  SOURCE_HOST = '203.0.113.50',",
      "  SOURCE_PORT = 3306,",
      "  SOURCE_USER = 'repl',",
      "  SOURCE_AUTO_POSITION = 1,",
      "  SOURCE_SSL = 1,",
      "  SOURCE_SSL_CA = '/etc/mysql/tls/ca.crt',",
      "  SOURCE_SSL_VERIFY_SERVER_CERT = 1,",
      "  SOURCE_CONNECT_RETRY = 10,",
      "  SOURCE_RETRY_COUNT = 60480;",
      "START REPLICA;",
    ]
  ) {
    assertStringIncludes(change, expected);
  }
  const follow = followReplicationSourceSql({
    host: "10.100.0.4",
    port: 45001,
  });
  assertEquals(follow.includes("STOP REPLICA"), true);
  assertEquals(follow.includes("SOURCE_HOST = '10.100.0.4'"), true);
  assertEquals(follow.includes("SOURCE_PORT = 45001"), true);
  assertEquals(follow.includes("SOURCE_PASSWORD"), false);
  assertEquals(follow.includes("START REPLICA"), true);
});

test("runtime defaultDatabase is a non-system application schema", () => {
  assertEquals(mysqlManagedEngineRuntime.defaultDatabase, "appdb");
});

test("standby seed window and census SQL stay credential-free", () => {
  assertEquals(disableReadOnlySql().includes("super_read_only = OFF"), true);
  assertEquals(enforceReadOnlySql().includes("super_read_only = ON"), true);
  assertEquals(promoteSql().includes("super_read_only = OFF"), true);
  assertEquals(grantRootSql("root").includes("REVOKE"), false);
  assertEquals(grantRootSql("root").includes("READ_ONLY ADMIN"), false);
  assertEquals(
    connectionCensusSql(),
    "SHOW GLOBAL STATUS LIKE 'Threads_connected'; SELECT @@max_connections;",
  );
  assertEquals(
    dropAccountSql("app", ["203.0.113.4"]).includes("`app`@'203.0.113.4'"),
    true,
  );
  assertEquals(
    grantRootSql("root", "203.0.113.4").includes("'203.0.113.4'"),
    true,
  );
  assertEquals(
    createNetworkAccountSql("root", "x", ["203.0.113.4"]).includes(
      "'203.0.113.4'",
    ),
    true,
  );
  assertEquals(
    ensureSocketAdminSql("mysqladmin").includes("`mysqladmin`@'localhost'"),
    true,
  );
});

test("account builders scope cross-host client sources per host", () => {
  const monitor = ensureProxySqlMonitorAccountSql("tp_monitor_ab", "mon", [
    "10.10.1.171",
  ]);
  assertEquals(monitor.includes("'172.16.0.0/255.240.0.0'"), true);
  assertEquals(monitor.includes("'10.10.1.171'"), true);
  assertEquals(
    monitor.includes("GRANT USAGE, PROCESS, REPLICATION CLIENT"),
    true,
  );

  const client = createClientAccountSql("appuser", "pw", ["10.10.1.171"]);
  assertEquals(client.includes("'10.10.1.171'"), true);
  assertEquals(client.includes("'localhost'"), true);
});

test("grantReplicationSql keeps REQUIRE SSL out of GRANT (removed in MySQL 8)", () => {
  const sql = ensureReplicationAccountSql("tp_repl", "pw", ["203.0.113.20"]);
  // TLS binding must ride ALTER USER — `GRANT … REQUIRE SSL` is a 1064
  // syntax error on MySQL 8+.
  assertEquals(/GRANT [^;]*REQUIRE SSL/.test(sql), false);
  assertEquals(
    sql.includes("ALTER USER `tp_repl`@'203.0.113.20' REQUIRE SSL;"),
    true,
  );
  // Seed privileges ride the same grant (mysqldump needs RELOAD et al.).
  assertEquals(
    sql.includes(
      "GRANT SELECT, RELOAD, PROCESS, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER, REPLICATION SLAVE, REPLICATION CLIENT ON *.*",
    ),
    true,
  );
});

test("ensureSocketAdminSql drops the image's root@'%' network account", () => {
  const sql = ensureSocketAdminSql();
  assertEquals(sql.includes("DROP USER IF EXISTS `root`@'%';"), true);
  // Dropped before the socket admin is (re)granted, never the localhost one.
  assertEquals(sql.includes("DROP USER IF EXISTS `root`@'localhost'"), false);
});

test("primaryFinalGtidSetSql strips the newline between UUIDs in SQL", () => {
  const sql = primaryFinalGtidSetSql();
  assertStringIncludes(sql, "REPLACE(@@GLOBAL.gtid_executed, CHAR(10), '')");
});

test("seedWindowReadOnlySql keeps read_only on and lifts only super_read_only", () => {
  const sql = seedWindowReadOnlySql();
  assertStringIncludes(sql, "SET GLOBAL read_only = ON;");
  assertStringIncludes(sql, "SET GLOBAL super_read_only = OFF;");
  assertEquals(
    sql.includes("read_only = OFF"),
    sql.includes("super_read_only = OFF"),
  );
});
