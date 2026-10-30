import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  grantBackupPrivileges,
  isBackupCredential,
} from "./grant-databases.ts";
import { grantBackupDatabaseSql as mariadbBackupSql } from "./mariadb-sql.ts";
import {
  grantBackupDatabaseSql as mysqlBackupSql,
  grantBackupGlobalSql,
} from "./mysql-sql.ts";
import { backupLoginAttributesSql } from "./postgres-sql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isBackupCredential needs role user and kind backup", () => {
  assertEquals(isBackupCredential({ role: "user", kind: "backup" }), true);
  assertEquals(isBackupCredential({ role: "user" }), false);
  assertEquals(isBackupCredential({ role: "root", kind: "backup" }), false);
});

test("Postgres backup login: read all data, see past row security, nothing else", () => {
  assertEquals(
    backupLoginAttributesSql("nightly"),
    [
      `ALTER ROLE "nightly" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;`,
      `GRANT pg_read_all_data TO "nightly";`,
    ].join("\n"),
  );
});

test("MySQL backup login grants the dump set per database and revokes the rest", () => {
  const sql = mysqlBackupSql("shop_db", "nightly");
  assertStringIncludes(
    sql,
    "GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON `shop\\_db`.* TO `nightly`@'172.16.0.0/255.240.0.0';",
  );
  // Everything else on the database is taken back, LOCK TABLES included.
  assertStringIncludes(sql, "IF(Lock_tables_priv = 'Y', 'LOCK TABLES', NULL)");
  assertStringIncludes(sql, "IF(Insert_priv = 'Y', 'INSERT', NULL)");
  assertEquals(sql.includes("IF(Select_priv"), false);
  assertEquals(
    grantBackupGlobalSql("nightly", "10.0.0.%"),
    "GRANT SHOW_ROUTINE ON *.* TO `nightly`@'10.0.0.%';",
  );
});

test("MariaDB backup login adds LOCK TABLES and SHOW CREATE ROUTINE per database", () => {
  const sql = mariadbBackupSql("shop", "nightly", "10.0.0.%");
  assertStringIncludes(
    sql,
    "GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, SHOW CREATE ROUTINE ON `shop`.* TO `nightly`@'10.0.0.%';",
  );
  assertEquals(sql.includes("IF(Lock_tables_priv"), false);
  assertStringIncludes(
    sql,
    "IF(Delete_history_priv = 'Y', 'DELETE HISTORY', NULL)",
  );
});

test("grantBackupPrivileges grants every database and the globals for every host, in order", async () => {
  const ran: string[] = [];
  await grantBackupPrivileges({
    databases: ["a", "b", "a"],
    username: "nightly",
    hosts: ["10.0.0.5"],
    grantSql: (database, username, host) =>
      `db ${database} ${username} ${host ?? "net"}`,
    globalSql: (username, host) => `global ${username} ${host ?? "net"}`,
    run: (sql) => {
      ran.push(sql);
      return Promise.resolve();
    },
  });
  assertEquals(ran, [
    "db a nightly net\ndb a nightly 10.0.0.5",
    "db b nightly net\ndb b nightly 10.0.0.5",
    "global nightly net\nglobal nightly 10.0.0.5",
  ]);
  const withoutGlobals: string[] = [];
  await grantBackupPrivileges({
    databases: ["a"],
    username: "nightly",
    hosts: [],
    grantSql: (database) => `db ${database}`,
    run: (sql) => {
      withoutGlobals.push(sql);
      return Promise.resolve();
    },
  });
  assertEquals(withoutGlobals, ["db a"]);
});
