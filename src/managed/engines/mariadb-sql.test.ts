import { assertEquals, assertThrows } from "@std/assert";
import {
  changeReplicationSourceSql,
  createClientAccountSql,
  createNetworkAccountSql,
  disableReadOnlySql,
  enforceReadOnlySql,
  ensureReplicationAccountSql,
  ensureSocketAdminSql,
  grantDatabaseSql,
  grantReplicationSql,
  isWritableSql,
  MANAGED_DOCKER_NETWORK_HOST,
  promoteSql,
  quoteIdentifier,
  quoteLiteral,
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
  assertEquals(quoteLiteral(String.raw`a\b'c`), String.raw`'a\\b\'c'`);
  assertThrows(() => quoteIdentifier("bad-name"), Error);
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
