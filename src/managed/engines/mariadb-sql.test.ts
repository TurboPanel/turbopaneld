import { assertEquals, assertThrows } from "@std/assert";
import {
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
  versionSql,
} from "./mariadb-sql.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("quoteIdentifier and quoteLiteral match MySQL family escaping", () => {
  assertEquals(quoteIdentifier("app"), "`app`");
  assertEquals(quoteAccount("app_user"), "`app_user`");
  assertEquals(quoteLiteral(String.raw`a\b'c`), String.raw`'a\\b\'c'`);
  assertThrows(() => quoteIdentifier("bad-name"), Error);
  assertThrows(() => quoteIdentifier(""), Error);
  assertThrows(() => quoteIdentifier("a".repeat(65)), Error);
  assertThrows(() => quoteAccount("a".repeat(33)), Error);
  assertThrows(() => quoteLiteral("bad\npass"), Error);
});

test("privilege and replication dialect is MariaDB-shaped", () => {
  assertEquals(
    grantDatabaseSql("db", "u", "read-write").includes(
      "INSERT, UPDATE, DELETE",
    ),
    true,
  );
  const repl = ensureReplicationAccountSql("tp_repl", "x", ["203.0.113.5"]);
  assertEquals(repl.includes("`tp_repl`@'203.0.113.5'"), true);
  // Server-side TLS enforcement, independent of what the standby requests.
  assertEquals(repl.includes("REQUIRE SSL"), true);
  const replGrant = grantReplicationSql("tp_repl", "203.0.113.5");
  assertEquals(replGrant.includes("REPLICATION SLAVE"), true);
  assertEquals(replGrant.includes("REQUIRE SSL"), true);

  const change = changeReplicationSourceSql({
    host: "203.0.113.10",
    port: 3306,
    username: "tp_repl",
    password: "s3cret",
  });
  assertEquals(change.includes("CHANGE MASTER TO"), true);
  assertEquals(change.includes("MASTER_USE_GTID = slave_pos"), true);
  assertEquals(change.includes("START SLAVE"), true);
  assertEquals(change.includes("SOURCE_AUTO_POSITION"), false);
});

test("createClientAccountSql and dumpArgv system-schema rejection", () => {
  const clientSql = createClientAccountSql("app", "x");
  assertEquals(clientSql.includes("172.16.0.0/255.240.0.0"), true);
  assertEquals(clientSql.includes("172.%"), false);
  const backup = mariadbManagedEngineRuntime.backup;
  if (!backup) throw new TypeError("expected backup");
  const ctx = {
    containerId: "c",
    composeServiceName: "mariadb",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
  };
  const argv = backup.dumpArgv(ctx, { database: "appdb" });
  assertEquals(argv[0], "mariadb-dump");
  assertEquals(argv.includes("--gtid"), true);
  assertThrows(() => backup.dumpArgv(ctx, { database: "sys" }), Error);
});

test("createNetworkAccountSql is managed-network only", () => {
  const sql = createNetworkAccountSql("root", "x");
  assertEquals(sql.includes(MANAGED_DOCKER_NETWORK_HOST), true);
  assertEquals(sql.includes("localhost"), false);
  assertEquals(sql.includes("IDENTIFIED BY"), true);
});

test("ensureSocketAdminSql uses unix_socket on localhost only", () => {
  const sql = ensureSocketAdminSql();
  assertEquals(sql.includes("IDENTIFIED VIA unix_socket"), true);
  assertEquals(sql.includes("`root`@'localhost'"), true);
  assertEquals(sql.includes("`mysql`@'localhost'"), true);
  assertEquals(sql.includes("IDENTIFIED BY"), false);
  assertEquals(sql.includes(MANAGED_DOCKER_NETWORK_HOST), false);
  assertEquals(sql.includes("INSTALL PLUGIN"), false);
});

test("runtime defaultDatabase is a non-system application schema", () => {
  assertEquals(mariadbManagedEngineRuntime.defaultDatabase, "appdb");
});

test("account, privilege, and census SQL builders cover MariaDB hosts", () => {
  const create = createOrAlterAccountSql(
    "app",
    "s3cret",
    MANAGED_DOCKER_NETWORK_HOST,
  );
  assertEquals(create.includes("`app`@'172.16.0.0/255.240.0.0'"), true);
  assertEquals(create.includes("CREATE USER IF NOT EXISTS"), true);

  assertEquals(
    grantDatabaseSql("appdb", "app", "owner").includes("WITH GRANT OPTION"),
    true,
  );
  assertEquals(
    grantDatabaseSql("appdb", "app", "read-only").includes("SELECT, SHOW VIEW"),
    true,
  );
  assertEquals(grantRootSql("root").includes("*.*"), true);

  const dropped = dropAccountSql("app");
  assertEquals(dropped.includes("`app`@'localhost'"), true);
  assertEquals(dropped.includes(MANAGED_DOCKER_NETWORK_HOST), true);

  const monitor = ensureProxySqlMonitorAccountSql("tp_monitor", "mon", [
    "203.0.113.9",
  ]);
  assertEquals(monitor.includes("'203.0.113.9'"), true);
  assertEquals(monitor.includes("REPLICATION CLIENT"), true);

  const emptyPeers = ensureReplicationAccountSql("tp_repl", "x", []);
  assertEquals(emptyPeers.includes(MANAGED_DOCKER_NETWORK_HOST), true);
  assertEquals(emptyPeers.includes("FLUSH PRIVILEGES"), true);

  const extraClient = createClientAccountSql("app", "x", ["203.0.113.8"]);
  assertEquals(extraClient.includes("'203.0.113.8'"), true);
  assertEquals(extraClient.includes("'localhost'"), true);

  const extraNet = createNetworkAccountSql("root", "x", ["203.0.113.7"]);
  assertEquals(extraNet.includes("'203.0.113.7'"), true);
  assertEquals(extraNet.includes("localhost"), false);

  assertEquals(
    createDatabaseSql("appdb").includes("utf8mb4_unicode_ci"),
    true,
  );
  assertEquals(
    dropDatabaseSql("appdb").includes("DROP DATABASE IF EXISTS `appdb`"),
    true,
  );
  assertEquals(showReplicaStatusSql(), "SHOW SLAVE STATUS;");
  assertEquals(versionSql(), "SELECT VERSION();");
  assertEquals(
    connectionCensusSql().includes("Threads_connected"),
    true,
  );
  assertEquals(
    ensureSocketAdminSql("mariadb").includes("`mariadb`@'localhost'"),
    true,
  );
});

test("mariadb dialect never references super_read_only (MySQL-only variable)", () => {
  // An unknown variable in my.cnf kills mariadbd at startup; in SQL it
  // errors. MariaDB has no super_read_only (MDEV-18441).
  for (
    const sql of [
      disableReadOnlySql(),
      enforceReadOnlySql(),
      promoteSql(),
      isWritableSql(),
    ]
  ) {
    assertEquals(sql.includes("super_read_only"), false);
  }
});
