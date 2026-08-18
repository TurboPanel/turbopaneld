import { assertEquals, assertThrows } from "@std/assert";
import {
  changeReplicationSourceSql,
  createClientAccountSql,
  createDatabaseSql,
  createOrAlterAccountSql,
  dropAccountSql,
  dropDatabaseSql,
  ensureProxySqlMonitorAccountSql,
  ensureReplicationAccountSql,
  grantDatabaseSql,
  grantReplicationSql,
  grantRootSql,
  isWritableSql,
  MANAGED_DOCKER_NETWORK_HOST,
  promoteSql,
  quoteAccount,
  quoteIdentifier,
  quoteLiteral,
  showReplicaStatusSql,
  standbyReplicationStatusSql,
  versionSql,
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
  assertEquals(grant.includes("WITH GRANT OPTION"), true);
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
  assertEquals(argv.includes("--set-gtid-purged=ON"), true);
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

test("grantDatabaseSql covers read-write privilege", () => {
  const grant = grantDatabaseSql("appdb", "app", "read-write");
  assertEquals(grant.includes("CREATE TEMPORARY TABLES"), true);
  assertEquals(grant.includes("ALTER ROUTINE"), true);
  assertEquals(grant.includes("WITH GRANT OPTION"), false);
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
  assertEquals(change.includes("SOURCE_SSL = 1"), true);
  assertEquals(change.includes("START REPLICA"), true);
});

test("runtime defaultDatabase is a non-system application schema", () => {
  assertEquals(mysqlManagedEngineRuntime.defaultDatabase, "appdb");
});
