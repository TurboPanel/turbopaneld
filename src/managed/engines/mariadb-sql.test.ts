import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
  flushPrivilegesLocalSql,
  followReplicationSourceSql,
  grantDatabaseSql,
  grantReplicationSql,
  grantRootSql,
  isWritableSql,
  listNonLocalAccountsSql,
  MANAGED_DOCKER_NETWORK_HOST,
  masterGtidWaitSql,
  parseGlobalPrivAccountRows,
  primaryFinalGtidSetSql,
  promoteSql,
  quoteAccount,
  quoteIdentifier,
  quoteLiteral,
  reassertReplicaPrivilegeGuardSql,
  resetReplicaGtidStateSql,
  revokeReadOnlyAdminFromNetworkAccountsSql,
  revokeReadOnlyAdminSql,
  showReplicaStatusSql,
  versionSql,
  withoutSessionBinlogSql,
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
  for (
    const expected of [
      "CHANGE MASTER TO",
      "  MASTER_HOST = '203.0.113.10',",
      "  MASTER_PORT = 3306,",
      "  MASTER_USER = 'tp_repl',",
      "  MASTER_USE_GTID = slave_pos,",
      "  MASTER_SSL = 1,",
      "  MASTER_SSL_CA = '/etc/mysql/tls/ca.crt',",
      "  MASTER_SSL_VERIFY_SERVER_CERT = 1,",
      "  MASTER_CONNECT_RETRY = 10;",
      "START SLAVE;",
    ]
  ) {
    assertStringIncludes(change, expected);
  }
  assertEquals(change.includes("SOURCE_AUTO_POSITION"), false);
  const follow = followReplicationSourceSql({
    host: "10.100.0.4",
    port: 45001,
  });
  assertEquals(follow.includes("STOP SLAVE"), true);
  assertEquals(follow.includes("MASTER_HOST = '10.100.0.4'"), true);
  assertEquals(follow.includes("MASTER_PORT = 45001"), true);
  assertEquals(follow.includes("MASTER_PASSWORD"), false);
  assertEquals(follow.includes("START SLAVE"), true);
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
  const rootGrant = grantRootSql("root");
  assertEquals(rootGrant.includes("*.*"), true);
  assertEquals(rootGrant.includes("GRANT ALL PRIVILEGES"), true);
  assertEquals(rootGrant.includes("REVOKE READ_ONLY ADMIN"), true);
  assertEquals(
    rootGrant.includes("`root`@'localhost'"),
    false,
  );

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

test("switchover SQL uses MASTER_GTID_WAIT and gtid_current_pos", () => {
  assertEquals(primaryFinalGtidSetSql().includes("gtid_current_pos"), true);
  assertEquals(
    masterGtidWaitSql("0-1-5", 120).includes("MASTER_GTID_WAIT"),
    true,
  );
});

test("network root grant revokes READ_ONLY ADMIN; socket admin keeps ALL", () => {
  const network = grantRootSql("root_abc123xyz", "203.0.113.9");
  assertEquals(network.includes("GRANT ALL PRIVILEGES ON *.*"), true);
  assertEquals(
    network.includes(
      "REVOKE READ_ONLY ADMIN ON *.* FROM `root_abc123xyz`@'203.0.113.9'",
    ),
    true,
  );
  const socket = ensureSocketAdminSql();
  assertEquals(
    socket.includes(
      "GRANT ALL PRIVILEGES ON *.* TO `root`@'localhost' WITH GRANT OPTION",
    ),
    true,
  );
  assertEquals(socket.includes("REVOKE READ_ONLY ADMIN"), false);
});

test("replica strip revokes READ_ONLY ADMIN from non-localhost accounts only", () => {
  const rows = parseGlobalPrivAccountRows(
    "root_abc\t172.16.0.0/255.240.0.0\nroot_abc\tlocalhost\nmysql.sys\t%\napp_user\t203.0.113.9\n",
  );
  assertEquals(rows, [
    { username: "root_abc", host: "172.16.0.0/255.240.0.0" },
    { username: "mysql.sys", host: "%" },
    { username: "app_user", host: "203.0.113.9" },
  ]);
  const sql = revokeReadOnlyAdminFromNetworkAccountsSql(rows);
  assertEquals(
    sql.includes(
      "REVOKE READ_ONLY ADMIN ON *.* FROM `root_abc`@'172.16.0.0/255.240.0.0'",
    ),
    true,
  );
  assertEquals(sql.includes("`app_user`@'203.0.113.9'"), true);
  assertEquals(sql.includes("mysql.sys"), false);
  assertEquals(sql.includes("localhost"), false);
  assertEquals(sql.includes("FLUSH PRIVILEGES"), true);
  assertEquals(
    revokeReadOnlyAdminFromNetworkAccountsSql([]),
    "",
  );
  assertEquals(
    revokeReadOnlyAdminSql("root_abc", MANAGED_DOCKER_NETWORK_HOST).includes(
      MANAGED_DOCKER_NETWORK_HOST,
    ),
    true,
  );
  assertEquals(
    listNonLocalAccountsSql().includes("Host <> 'localhost'"),
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

test("replica-local SQL is wrapped so it cannot mint a replica GTID", () => {
  const wrapped = withoutSessionBinlogSql("FLUSH PRIVILEGES;");
  const off = wrapped.indexOf("SET SESSION sql_log_bin = 0;");
  const flush = wrapped.indexOf("FLUSH PRIVILEGES;");
  const on = wrapped.lastIndexOf("SET SESSION sql_log_bin = 1;");
  assertEquals(off !== -1 && flush !== -1 && on !== -1, true);
  assertEquals(off < flush && flush < on, true);
  const local = flushPrivilegesLocalSql();
  assertEquals(local.includes("SET SESSION sql_log_bin = 0;"), true);
  assertEquals(local.includes("FLUSH PRIVILEGES;"), true);
  assertEquals(local.includes("SET SESSION sql_log_bin = 1;"), true);
  assertEquals(resetReplicaGtidStateSql(), "RESET MASTER;");
  const guardRows = [{ username: "root_abc", host: "203.0.113.9" }];
  const guard = reassertReplicaPrivilegeGuardSql(guardRows);
  const guardOff = guard.indexOf("SET SESSION sql_log_bin = 0;");
  const socketGrant = guard.indexOf("IDENTIFIED VIA unix_socket");
  const revoke = guard.indexOf("REVOKE READ_ONLY ADMIN");
  const guardFlush = guard.lastIndexOf("FLUSH PRIVILEGES;");
  const guardOn = guard.lastIndexOf("SET SESSION sql_log_bin = 1;");
  assertEquals(
    guardOff !== -1 && socketGrant !== -1 && revoke !== -1 &&
      guardFlush !== -1 && guardOn !== -1,
    true,
  );
  assertEquals(
    guardOff < socketGrant && socketGrant < revoke && revoke < guardFlush &&
      guardFlush < guardOn,
    true,
  );
  const guardOnlySocket = reassertReplicaPrivilegeGuardSql([]);
  assertEquals(guardOnlySocket.includes("SET SESSION sql_log_bin = 0;"), true);
  assertEquals(guardOnlySocket.includes("unix_socket"), true);
  assertEquals(guardOnlySocket.includes("REVOKE READ_ONLY ADMIN"), false);
});
