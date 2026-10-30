import { assertEquals } from "@std/assert";
import {
  grantBackupPrivileges,
  isBackupCredential,
} from "./grant-databases.ts";
import { grantBackupSql as mariadbBackupSql } from "./mariadb-sql.ts";
import { grantBackupSql as mysqlBackupSql } from "./mysql-sql.ts";
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

test("MySQL backup login reads every database at global level, nothing else", () => {
  assertEquals(
    mysqlBackupSql("nightly"),
    "GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, SHOW_ROUTINE ON *.* TO `nightly`@'172.16.0.0/255.240.0.0';",
  );
  assertEquals(
    mysqlBackupSql("nightly", "10.0.0.%"),
    "GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, SHOW_ROUTINE ON *.* TO `nightly`@'10.0.0.%';",
  );
});

test("MariaDB backup login adds LOCK TABLES and SHOW CREATE ROUTINE at global level", () => {
  assertEquals(
    mariadbBackupSql("nightly", "10.0.0.%"),
    "GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, SHOW CREATE ROUTINE ON *.* TO `nightly`@'10.0.0.%';",
  );
});

test("grantBackupPrivileges grants the wildcard account and every host in one batch", async () => {
  const ran: string[] = [];
  await grantBackupPrivileges({
    username: "nightly",
    hosts: ["10.0.0.5", "10.0.0.6"],
    grantSql: (username, host) => `grant ${username} ${host ?? "net"}`,
    run: (sql) => {
      ran.push(sql);
      return Promise.resolve();
    },
  });
  assertEquals(ran, [
    "grant nightly net\ngrant nightly 10.0.0.5\ngrant nightly 10.0.0.6",
  ]);
});
