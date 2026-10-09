import { assertEquals, assertStringIncludes } from "@std/assert";
import { topologyPlaintext } from "../../testing/managed-topology-fixtures.ts";
import {
  ensureOrchestratorTopologyAccountSql,
  grantOrchestratorReplicationTableSql,
} from "./orchestrator-topology-sql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const USERNAME = "tp_topology_abcd12345678";
const TOPOLOGY_PLAIN = topologyPlaintext();

test("ensureOrchestratorTopologyAccountSql scopes hosts like the monitor account", () => {
  const sql = ensureOrchestratorTopologyAccountSql(
    USERNAME,
    TOPOLOGY_PLAIN,
    ["10.100.0.5"],
    "mysql",
  );
  assertStringIncludes(sql, `\`${USERNAME}\`@'172.16.0.0/255.240.0.0'`);
  assertStringIncludes(sql, `\`${USERNAME}\`@'10.100.0.5'`);
  assertStringIncludes(
    sql,
    "GRANT SUPER, PROCESS, REPLICATION CLIENT, RELOAD ON *.*",
  );
  assertStringIncludes(sql, "GRANT SELECT ON `meta`.*");
  assertStringIncludes(sql, "FLUSH PRIVILEGES;");
});

test("ensureOrchestratorTopologyAccountSql re-asserts the password without a drop", () => {
  const sql = ensureOrchestratorTopologyAccountSql(
    USERNAME,
    TOPOLOGY_PLAIN,
    [],
    "mysql",
  );
  assertStringIncludes(sql, "CREATE USER IF NOT EXISTS");
  assertStringIncludes(
    sql,
    `ALTER USER \`${USERNAME}\`@'172.16.0.0/255.240.0.0' IDENTIFIED BY`,
  );
  assertEquals(sql.includes("DROP USER"), false);
});

test("ensureOrchestratorTopologyAccountSql leaves binlogging on so standbys inherit the account", () => {
  const sql = ensureOrchestratorTopologyAccountSql(
    USERNAME,
    TOPOLOGY_PLAIN,
    [],
    "mysql",
  );
  assertEquals(sql.includes("sql_log_bin"), false);
});

test("ensureOrchestratorTopologyAccountSql names no authentication plugin", () => {
  // MySQL 8.4/9.x ship no `mysql_native_password`; the server default
  // (`caching_sha2_password`) must be what the account is minted with.
  for (const dialect of ["mysql", "mariadb"] as const) {
    const sql = ensureOrchestratorTopologyAccountSql(
      USERNAME,
      TOPOLOGY_PLAIN,
      [],
      dialect,
    );
    assertEquals(sql.includes("IDENTIFIED WITH"), false);
    assertEquals(sql.includes("mysql_native_password"), false);
  }
});

test("ensureOrchestratorTopologyAccountSql binds TLS with the MySQL ALTER USER form", () => {
  const sql = ensureOrchestratorTopologyAccountSql(
    USERNAME,
    TOPOLOGY_PLAIN,
    [],
    "mysql",
  );
  assertStringIncludes(
    sql,
    `ALTER USER \`${USERNAME}\`@'172.16.0.0/255.240.0.0' REQUIRE SSL;`,
  );
  assertEquals(sql.includes("GRANT USAGE ON *.*"), false);
});

test("ensureOrchestratorTopologyAccountSql uses MariaDB REQUIRE SSL on GRANT", () => {
  const sql = ensureOrchestratorTopologyAccountSql(
    USERNAME,
    TOPOLOGY_PLAIN,
    [],
    "mariadb",
  );
  assertStringIncludes(
    sql,
    `GRANT USAGE ON *.* TO \`${USERNAME}\`@'172.16.0.0/255.240.0.0' REQUIRE SSL;`,
  );
  // MariaDB keeps `REQUIRE` on `GRANT`; only the password re-assert is an
  // `ALTER USER` here, never the TLS binding.
  assertEquals(/ALTER USER [^\n]*REQUIRE SSL/.test(sql), false);
});

test("grantOrchestratorReplicationTableSql names each engine's own replication table", () => {
  assertStringIncludes(
    grantOrchestratorReplicationTableSql(USERNAME, ["10.100.0.5"], "mysql"),
    "GRANT SELECT ON mysql.slave_master_info TO",
  );
  assertStringIncludes(
    grantOrchestratorReplicationTableSql(USERNAME, [], "mariadb"),
    "GRANT SELECT ON mysql.gtid_slave_pos TO",
  );
});

test("grantOrchestratorReplicationTableSql covers every account host", () => {
  const sql = grantOrchestratorReplicationTableSql(
    USERNAME,
    ["10.100.0.5"],
    "mysql",
  );
  assertStringIncludes(sql, `\`${USERNAME}\`@'172.16.0.0/255.240.0.0'`);
  assertStringIncludes(sql, `\`${USERNAME}\`@'10.100.0.5'`);
});
