import { assertEquals, assertThrows } from "@std/assert";
import {
  connectionCensusSql,
  createDatabaseSql,
  createOrAlterRoleSql,
  createPhysicalSlotSql,
  createReplicationRoleSql,
  databaseExistsSql,
  dropDatabaseSql,
  dropPhysicalSlotSql,
  dropRoleSql,
  ensureProxySqlMonitorRoleSql,
  grantDatabaseSql,
  isInRecoverySql,
  listManagedSlotsSql,
  MANAGED_SLOT_PREFIX,
  primaryReplicationStatusSql,
  promoteSql,
  quoteIdentifier,
  quoteLiteral,
  reloadVerifySql,
  standbyReplicationStatusSql,
} from "./postgres-sql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("quoteIdentifier doubles embedded quotes and rejects injection", () => {
  assertEquals(quoteIdentifier("app_user"), '"app_user"');
  assertEquals(quoteIdentifier("a_b"), '"a_b"');
  assertThrows(() => quoteIdentifier('evil"; DROP TABLE'), Error);
  assertThrows(() => quoteIdentifier("has-dash"), Error);
  assertThrows(() => quoteIdentifier(""), Error);
  assertThrows(() => quoteIdentifier("a".repeat(64)), Error);
});

test("quoteLiteral doubles single quotes and rejects control chars", () => {
  assertEquals(quoteLiteral("p@ss'word"), "'p@ss''word'");
  assertEquals(quoteLiteral(String.raw`back\slash`), String.raw`'back\slash'`);
  assertThrows(() => quoteLiteral("bad\npass"), Error);
  assertThrows(() => quoteLiteral("bad\0pass"), Error);
});

test("createOrAlterRoleSql is idempotent via pg_roles check", () => {
  const sql = createOrAlterRoleSql("app", "s3cret");
  assertEquals(sql.includes("IF NOT EXISTS"), true);
  assertEquals(sql.includes("pg_catalog.pg_roles"), true);
  assertEquals(sql.includes('CREATE ROLE "app"'), true);
  assertEquals(sql.includes('ALTER ROLE "app"'), true);
  assertEquals(sql.includes("'s3cret'"), true);
  assertEquals(sql.includes("; DROP"), false);
  assertEquals(sql.includes("LOGIN"), true);
  assertEquals(sql.includes("NOSUPERUSER"), true);

  const nologin = createOrAlterRoleSql("app", "s3cret", {
    login: false,
    superuser: true,
  });
  assertEquals(nologin.includes("NOLOGIN"), true);
  assertEquals(nologin.includes("SUPERUSER"), true);
});

test("ensureProxySqlMonitorRoleSql grants pg_monitor without superuser", () => {
  const sql = ensureProxySqlMonitorRoleSql("tp_monitor", "mon-s3cret");
  assertEquals(sql.includes('CREATE ROLE "tp_monitor"'), true);
  assertEquals(sql.includes('GRANT pg_monitor TO "tp_monitor"'), true);
  assertEquals(sql.includes("NOSUPERUSER"), true);
  assertEquals(/\bSUPERUSER\b/.test(sql), false);
});

test("createDatabaseSql and dropDatabaseSql", () => {
  // Top-level only — CREATE DATABASE is illegal inside DO/function blocks.
  const create = createDatabaseSql("appdb", "app");
  assertEquals(create.includes("DO $"), false);
  assertEquals(create.includes('CREATE DATABASE "appdb" OWNER "app"'), true);
  assertEquals(createDatabaseSql("appdb"), 'CREATE DATABASE "appdb";');
  assertEquals(
    databaseExistsSql("appdb").includes("pg_catalog.pg_database"),
    true,
  );
  const drop = dropDatabaseSql("appdb");
  assertEquals(drop.includes('DROP DATABASE IF EXISTS "appdb"'), true);
  assertEquals(dropRoleSql("app").includes('DROP ROLE IF EXISTS "app"'), true);
});

test("grantDatabaseSql covers privilege levels", () => {
  assertEquals(
    grantDatabaseSql("appdb", "app", "owner").includes(
      'ALTER DATABASE "appdb" OWNER TO "app"',
    ),
    true,
  );
  assertEquals(
    grantDatabaseSql("appdb", "app", "read-write").includes("CREATE"),
    true,
  );
  assertEquals(
    grantDatabaseSql("appdb", "app", "read-only"),
    'GRANT CONNECT ON DATABASE "appdb" TO "app";',
  );
});

test("replication SQL builders use quoted identifiers and managed slot prefix", () => {
  const roleSql = createReplicationRoleSql("tp_repl", "s3cret");
  assertEquals(roleSql.includes("REPLICATION"), true);
  assertEquals(roleSql.includes('"tp_repl"'), true);

  const createSlot = createPhysicalSlotSql("tp_member_2");
  assertEquals(
    createSlot.includes("pg_create_physical_replication_slot"),
    true,
  );
  assertEquals(createSlot.includes("'tp_member_2'"), true);
  assertThrows(() => createPhysicalSlotSql("bad-slot"), Error);

  const dropSlot = dropPhysicalSlotSql("tp_member_2");
  assertEquals(dropSlot.includes("pg_drop_replication_slot"), true);

  assertEquals(listManagedSlotsSql().includes("tp_member_"), true);
  assertEquals(
    primaryReplicationStatusSql().includes("pg_stat_replication"),
    true,
  );
  const standbySql = standbyReplicationStatusSql();
  assertEquals(standbySql.includes("pg_is_in_recovery"), true);
  assertEquals(standbySql.includes("pg_stat_wal_receiver"), true);
  assertEquals(standbySql.includes("status = 'streaming'"), true);
  assertEquals(standbySql.includes("'stopped'"), true);
  assertEquals(promoteSql().includes("pg_promote"), true);
});

test("reload, census, recovery, and slot-prefix SQL stay catalog-qualified", () => {
  const reload = reloadVerifySql();
  assertEquals(reload.includes("pg_file_settings"), true);
  assertEquals(reload.includes("pg_hba_file_rules"), true);
  assertEquals(reload.includes("restart_pending"), true);

  const census = connectionCensusSql();
  assertEquals(census.includes("pg_stat_activity"), true);
  assertEquals(census.includes("max_connections"), true);

  assertEquals(isInRecoverySql(), "SELECT pg_catalog.pg_is_in_recovery();");
  assertEquals(MANAGED_SLOT_PREFIX, "tp_member_");
});

test("standbyReplicationStatusSql does not report streaming solely from recovery", () => {
  const sql = standbyReplicationStatusSql();
  // The old check set streaming whenever pg_is_in_recovery() was true — forbid that.
  assertEquals(
    /THEN 'streaming' ELSE/.test(sql.replaceAll("\n", " ")) &&
      !sql.includes("pg_stat_wal_receiver"),
    false,
  );
  assertEquals(sql.includes("r.status = 'streaming' THEN 'streaming'"), true);
});
