import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
  listDatabasesForRoleReleaseSql,
  listLostPhysicalSlotsSql,
  listManagedSlotsSql,
  MANAGED_SLOT_PREFIX,
  managedSlotRetentionSql,
  primaryReplicationStatusSql,
  promoteSql,
  quoteIdentifier,
  quoteLiteral,
  readOnlySessionDefaultSql,
  reconcileDatabaseObjectsSql,
  recreateLostPhysicalSlotSql,
  releaseRoleObjectsSql,
  reloadVerifySql,
  restoreResetSql,
  revokePublicDatabaseAccessSql,
  revokeUnlistedDatabasesSql,
  standbyReplicationStatusSql,
  strongestPrivilege,
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

test("grantDatabaseSql covers privilege levels, resets the old one first and writes only on a difference", () => {
  const owner = grantDatabaseSql("appdb", "app", "owner");
  assertEquals(owner.includes('ALTER DATABASE "appdb" OWNER TO "app"'), true);
  assertEquals(owner.includes("IS DISTINCT FROM"), true);
  const readWrite = grantDatabaseSql("appdb", "app", "read-write");
  assertEquals(
    readWrite.includes(
      'REVOKE ALL ON DATABASE "appdb" FROM "app";\n    GRANT CONNECT, TEMPORARY ON DATABASE "appdb" TO "app";',
    ),
    true,
  );
  const readOnly = grantDatabaseSql("appdb", "app", "read-only");
  assertEquals(
    readOnly.includes('GRANT CONNECT ON DATABASE "appdb" TO "app";'),
    true,
  );
  // One block (no gap for a connected login), guarded by a comparison with
  // what the login already holds.
  for (const sql of [owner, readWrite, readOnly]) {
    assertEquals(sql.startsWith("DO $turbopanel$"), true);
    assertEquals(sql.includes("IS NOT TRUE THEN"), true);
    assertEquals(sql.includes("aclexplode"), true);
  }
});

test("strongestPrivilege picks owner over read-write over read-only and ignores unknown values", () => {
  assertEquals(strongestPrivilege(["read-only", "read-write"]), "read-write");
  assertEquals(
    strongestPrivilege(["read-write", "owner", "read-only"]),
    "owner",
  );
  assertEquals(strongestPrivilege(["nonsense", "read-only"]), "read-only");
  assertEquals(strongestPrivilege(["toString", "constructor"]), null);
  assertEquals(strongestPrivilege([]), null);
});

test("revokePublicDatabaseAccessSql takes CONNECT from PUBLIC only where PUBLIC still holds an entry", () => {
  const sql = revokePublicDatabaseAccessSql();
  assertEquals(sql.includes("datallowconn"), true);
  assertEquals(sql.includes("datacl IS NULL OR EXISTS"), true);
  assertEquals(sql.includes("REVOKE ALL ON DATABASE %I FROM PUBLIC"), true);
});

test("revokeUnlistedDatabasesSql keeps only the listed databases, touches only logins with an entry and validates names", () => {
  const sql = revokeUnlistedDatabasesSql("app", ["appdb", "other"]);
  assertEquals(
    sql.includes("datname <> ALL (ARRAY['appdb', 'other']::text[])"),
    true,
  );
  assertEquals(sql.includes('FROM "app"'), true);
  assertEquals(sql.includes("aclexplode(datacl)"), true);
  assertEquals(
    revokeUnlistedDatabasesSql("app", []).includes("ARRAY[]::text[]"),
    true,
  );
  assertThrows(() => revokeUnlistedDatabasesSql("bad name", []), Error);
  // The builder is safe on its own: a name that is not an identifier never
  // reaches the dollar-quoted body.
  assertThrows(() => revokeUnlistedDatabasesSql("app", ["it's"]), Error);
  assertThrows(
    () => revokeUnlistedDatabasesSql("app", ["x$turbopanel$"]),
    Error,
  );
});

test("the lock-down grants the ProxySQL monitors CONNECT through pg_monitor before it revokes PUBLIC", () => {
  const sql = revokePublicDatabaseAccessSql();
  const grant = sql.indexOf(
    "GRANT CONNECT ON DATABASE postgres TO pg_monitor;",
  );
  assertEquals(grant, 0);
  assertEquals(
    sql.indexOf("REVOKE ALL ON DATABASE %I FROM PUBLIC") > grant,
    true,
  );
});

test("readOnlySessionDefaultSql sets or clears the read-only default per database", () => {
  assertEquals(
    readOnlySessionDefaultSql("appdb", "ro", true),
    'ALTER ROLE "ro" IN DATABASE "appdb" SET default_transaction_read_only = on;',
  );
  assertEquals(
    readOnlySessionDefaultSql("appdb", "rw", false),
    'ALTER ROLE "rw" IN DATABASE "appdb" RESET default_transaction_read_only;',
  );
});

test("reconcileDatabaseObjectsSql gives writers exactly five table privileges and readers only SELECT, now and for later tables", () => {
  const sql = reconcileDatabaseObjectsSql({
    creators: ["postgres", "own", "rw"],
    owners: ["own"],
    writers: ["own", "rw"],
    readers: ["ro"],
  });
  // Existing objects, every non-system schema.
  assertEquals(sql.includes("nspname !~ '^pg_'"), true);
  assertEquals(
    sql.includes(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON TABLE %s TO "rw"`,
    ),
    true,
  );
  assertEquals(
    sql.includes(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE %s TO "rw"`),
    true,
  );
  assertEquals(sql.includes(`GRANT SELECT ON TABLE %s TO "ro"`), true);
  assertEquals(sql.includes(`GRANT SELECT ON SEQUENCE %s TO "ro"`), true);
  // Only objects that differ are written, and a writer's own objects are left.
  assertEquals(sql.includes("NOT (COALESCE("), true);
  assertEquals(sql.includes("o.relowner IS DISTINCT FROM"), true);
  // Later objects, from every creator, to everyone else.
  assertEquals(
    sql.includes(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "own" GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON TABLES TO "rw";',
    ),
    true,
  );
  assertEquals(
    sql.includes(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" GRANT SELECT ON TABLES TO "ro";',
    ),
    true,
  );
  assertEquals(
    sql.includes(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "rw" GRANT SELECT ON SEQUENCES TO "ro";',
    ),
    true,
  );
  // An earlier, wider default is wiped before the exact one is set.
  assertEquals(
    sql.indexOf('FOR ROLE "own" REVOKE ALL ON TABLES FROM "rw"') <
      sql.indexOf('FOR ROLE "own" GRANT SELECT, INSERT'),
    true,
  );
  // A creator is never granted its own defaults.
  assertEquals(
    sql.includes(
      'FOR ROLE "own" GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON TABLES TO "own"',
    ),
    false,
  );
  // No writer statement says ALL on tables or sequences (ALL carries TRIGGER
  // and, on 17+, MAINTAIN), and none names TRIGGER at all except
  // the wipe of an old grant.
  assertEquals(/GRANT ALL[^;]*(TABLE|SEQUENCE)/.test(sql), false);
  assertEquals(/GRANT[^;]*(TRIGGER|MAINTAIN)/.test(sql), false);
  // Schema CREATE: the owner login only; a read-write login gets USAGE alone
  // (it creates in its own schema, which it owns), now and for later schemas.
  assertEquals(sql.includes('GRANT USAGE, CREATE ON SCHEMA %s TO "own"'), true);
  assertEquals(sql.includes('GRANT USAGE ON SCHEMA %s TO "rw"'), true);
  assertEquals(sql.includes('GRANT USAGE, CREATE ON SCHEMA %s TO "rw"'), false);
  assertEquals(
    sql.includes(
      'FOR ROLE "postgres" GRANT USAGE, CREATE ON SCHEMAS TO "own";',
    ),
    true,
  );
  assertEquals(
    sql.includes('FOR ROLE "postgres" GRANT USAGE ON SCHEMAS TO "rw";'),
    true,
  );
  assertEquals(/GRANT[^;\n]*CREATE ON SCHEMAS TO "rw"/.test(sql), false);
  // Nothing in the read-only path grants a write.
  const readerLines = sql.split("\n").filter((line) => line.includes('"ro"'));
  assertEquals(
    readerLines.some((line) =>
      /GRANT (ALL|INSERT|UPDATE|DELETE|TRUNCATE|CREATE|USAGE, CREATE)/.test(
        line,
      )
    ),
    false,
  );
});

test("reconcileDatabaseObjectsSql with no logins only closes the public schema", () => {
  const sql = reconcileDatabaseObjectsSql({
    creators: ["postgres"],
    owners: [],
    writers: [],
    readers: [],
  });
  assertEquals(
    sql.includes("REVOKE CREATE ON SCHEMA public FROM PUBLIC;"),
    true,
  );
  assertEquals(sql.includes("GRANT"), false);
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
  // A slot a replica is attached to is skipped, not an error.
  assertEquals(dropSlot.includes("AND NOT active"), true);

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
  assertEquals(standbySql.includes("pg_last_wal_receive_lsn()"), true);
  assertEquals(standbySql.includes("pg_last_wal_replay_lsn()"), true);
  assertEquals(standbySql.includes("r.latest_end_lsn, r.flushed_lsn"), true);
  assertEquals(standbySql.includes("r.last_msg_receipt_time"), true);
  assertEquals(promoteSql().includes("pg_promote"), true);
});

test("reload verify SQL treats both restart-required texts as pending, not errors", () => {
  const reload = reloadVerifySql();
  const pending = "(error = 'setting could not be applied' " +
    "OR error LIKE '%cannot be changed without restarting the server%')";
  // Counted as pending ...
  assertEquals(
    reload.includes(`WHERE ${pending}) AS restart_pending`),
    true,
  );
  // ... and excluded from the error count, which still sees everything else.
  assertEquals(
    reload.includes(
      `WHERE error IS NOT NULL AND NOT ${pending}) AS config_errors`,
    ),
    true,
  );
  // Unknown-parameter and syntax errors are not whitelisted by name.
  assertEquals(reload.includes("unrecognized"), false);
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

test("releaseRoleObjectsSql reassigns before dropping owned objects", () => {
  const sql = releaseRoleObjectsSql("app_user", "postgres");
  assertEquals(sql.split("\n"), [
    'REASSIGN OWNED BY "app_user" TO "postgres";',
    'DROP OWNED BY "app_user";',
  ]);
  assertThrows(() => releaseRoleObjectsSql("app user", "postgres"));
  assertThrows(() => releaseRoleObjectsSql("app_user", "post;gres"));
});

test("listDatabasesForRoleReleaseSql covers connectable non-template databases only when the role exists", () => {
  const sql = listDatabasesForRoleReleaseSql("app_user");
  assertEquals(sql.includes("d.datallowconn AND NOT d.datistemplate"), true);
  assertEquals(
    sql.includes(
      "FROM pg_catalog.pg_roles WHERE rolname = 'app_user'",
    ),
    true,
  );
  assertThrows(() => listDatabasesForRoleReleaseSql("bad\nname"));
});

test("listLostPhysicalSlotsSql and recreateLostPhysicalSlotSql only touch inactive, lost, managed slots", () => {
  const list = listLostPhysicalSlotsSql();
  assertEquals(list.includes("starts_with(slot_name, 'tp_member_')"), true);
  assertEquals(list.includes("wal_status = 'lost'"), true);
  assertEquals(list.includes("NOT active"), true);
  const recreate = recreateLostPhysicalSlotSql("tp_member_2");
  assertEquals(recreate.includes("pg_drop_replication_slot"), true);
  assertEquals(recreate.includes("wal_status = 'lost' AND NOT active"), true);
  // Replaced by a slot that keeps no WAL until its replica is re-seeded.
  assertEquals(recreate.includes("'tp_member_2', false, false"), true);
  assertEquals(
    createPhysicalSlotSql("tp_member_2").includes("true, false"),
    true,
  );
  assertThrows(() => recreateLostPhysicalSlotSql("bad name"), Error);
});

test("slot queries match the managed prefix literally (no LIKE wildcard)", () => {
  for (const sql of [listManagedSlotsSql(), managedSlotRetentionSql()]) {
    assertEquals(sql.includes("starts_with(slot_name, 'tp_member_')"), true);
    assertEquals(sql.includes("LIKE"), false);
  }
});

test("managedSlotRetentionSql reads retained bytes and safe size per managed slot", () => {
  const sql = managedSlotRetentionSql();
  assertEquals(sql.includes("wal_status"), true);
  assertEquals(sql.includes("safe_wal_size"), true);
  assertEquals(sql.includes("pg_current_wal_lsn()"), true);
  assertEquals(sql.includes("starts_with(slot_name, 'tp_member_')"), true);
});

test("restoreResetSql drops every user schema and recreates only public with its owner and privileges", () => {
  const sql = restoreResetSql();
  assertStringIncludes(sql, "SET LOCAL lock_timeout");
  assertStringIncludes(sql, "DROP SCHEMA %I CASCADE");
  // System schemas are never touched.
  assertStringIncludes(sql, "n.nspname !~ '^pg_'");
  assertStringIncludes(sql, "n.nspname <> 'information_schema'");
  // Only `public` is recreated: the dump creates every other schema itself.
  assertStringIncludes(sql, "IF s.name = 'public' THEN");
  assertStringIncludes(sql, "ALTER SCHEMA %I OWNER TO %s");
  assertStringIncludes(sql, "aclexplode");
});
