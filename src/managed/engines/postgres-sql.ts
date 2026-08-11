/**
 * Pure Postgres SQL builders for managed credential/database ops.
 *
 * No string interpolation of unquoted identifiers. Callers feed the result to
 * `psql` via stdin.
 */

const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
const MAX_IDENTIFIER_LENGTH = 63;
// deno-lint-ignore no-control-regex -- intentional control-char reject list
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

export type ManagedDatabasePrivilege = "owner" | "read-write" | "read-only";

export function quoteIdentifier(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_RE.test(value)
  ) {
    throw new Error(`invalid postgres identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error("postgres literal contains control characters");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** Create role if missing, then set password (covers rotations on existing roles). */
export function createOrAlterRoleSql(
  username: string,
  password: string,
  options?: { login?: boolean; superuser?: boolean },
): string {
  const ident = quoteIdentifier(username);
  const lit = quoteLiteral(password);
  const login = options?.login === false ? "NOLOGIN" : "LOGIN";
  const superuser = options?.superuser ? "SUPERUSER" : "NOSUPERUSER";
  return [
    `DO $turbopanel$`,
    `BEGIN`,
    `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${
      quoteLiteral(username)
    }) THEN`,
    `    CREATE ROLE ${ident} WITH ${login} ${superuser} PASSWORD ${lit};`,
    `  ELSE`,
    `    ALTER ROLE ${ident} WITH ${login} ${superuser} PASSWORD ${lit};`,
    `  END IF;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/**
 * ProxySQL backend monitor principal — LOGIN + {@link pg_monitor} (not
 * superuser). Same host-wide username on every primary; replicas receive the
 * role via physical WAL.
 */
export function ensureProxySqlMonitorRoleSql(
  username: string,
  password: string,
): string {
  return [
    createOrAlterRoleSql(username, password, {
      login: true,
      superuser: false,
    }),
    `GRANT pg_monitor TO ${quoteIdentifier(username)};`,
  ].join("\n");
}

export function dropRoleSql(username: string): string {
  const ident = quoteIdentifier(username);
  return `DROP ROLE IF EXISTS ${ident};`;
}

export function createDatabaseSql(
  name: string,
  owner?: string,
): string {
  // Re-validate via quote helpers; format(%I) keeps EXECUTE injection-safe.
  quoteIdentifier(name);
  if (owner !== undefined) quoteIdentifier(owner);
  const dbLit = quoteLiteral(name);
  const createExpr = owner === undefined
    ? `format('CREATE DATABASE %I', ${dbLit})`
    : `format('CREATE DATABASE %I OWNER %I', ${dbLit}, ${quoteLiteral(owner)})`;
  return [
    `DO $turbopanel$`,
    `BEGIN`,
    `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${dbLit}) THEN`,
    `    EXECUTE ${createExpr};`,
    `  END IF;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

export function dropDatabaseSql(name: string): string {
  const ident = quoteIdentifier(name);
  return [
    `SELECT pg_catalog.pg_terminate_backend(pid)`,
    `FROM pg_catalog.pg_stat_activity`,
    `WHERE datname = ${
      quoteLiteral(name)
    } AND pid <> pg_catalog.pg_backend_pid();`,
    `DROP DATABASE IF EXISTS ${ident};`,
  ].join("\n");
}

export function grantDatabaseSql(
  database: string,
  username: string,
  privilege: ManagedDatabasePrivilege,
): string {
  const db = quoteIdentifier(database);
  const role = quoteIdentifier(username);
  switch (privilege) {
    case "owner":
      return [
        `ALTER DATABASE ${db} OWNER TO ${role};`,
        `GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${role};`,
      ].join("\n");
    case "read-write":
      return [
        `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${role};`,
      ].join("\n");
    case "read-only":
      return [`GRANT CONNECT ON DATABASE ${db} TO ${role};`].join("\n");
    default: {
      const _exhaustive: never = privilege;
      throw new Error(`unsupported privilege: ${_exhaustive}`);
    }
  }
}

const MANAGED_SLOT_PREFIX = "tp_member_";

export function createReplicationRoleSql(
  username: string,
  password: string,
): string {
  const ident = quoteIdentifier(username);
  const lit = quoteLiteral(password);
  return [
    `DO $turbopanel$`,
    `BEGIN`,
    `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${
      quoteLiteral(username)
    }) THEN`,
    `    CREATE ROLE ${ident} WITH LOGIN REPLICATION PASSWORD ${lit};`,
    `  ELSE`,
    `    ALTER ROLE ${ident} WITH LOGIN REPLICATION PASSWORD ${lit};`,
    `  END IF;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

export function createPhysicalSlotSql(slotName: string): string {
  quoteIdentifier(slotName);
  return [
    `SELECT pg_catalog.pg_create_physical_replication_slot(${
      quoteLiteral(slotName)
    }, true, false)`,
    `WHERE NOT EXISTS (`,
    `  SELECT 1 FROM pg_catalog.pg_replication_slots WHERE slot_name = ${
      quoteLiteral(slotName)
    }`,
    `);`,
  ].join("\n");
}

export function dropPhysicalSlotSql(slotName: string): string {
  quoteIdentifier(slotName);
  return [
    `SELECT pg_catalog.pg_drop_replication_slot(slot_name)`,
    `FROM pg_catalog.pg_replication_slots`,
    `WHERE slot_name = ${quoteLiteral(slotName)};`,
  ].join("\n");
}

/** List physical slots owned by the managed prefix (`tp_member_`). */
export function listManagedSlotsSql(): string {
  const managedSlotPattern = `${MANAGED_SLOT_PREFIX}%`;
  return [
    `SELECT slot_name FROM pg_catalog.pg_replication_slots`,
    `WHERE slot_name LIKE ${quoteLiteral(managedSlotPattern)}`,
    `  AND slot_type = 'physical';`,
  ].join("\n");
}

export function primaryReplicationStatusSql(): string {
  return [
    `SELECT COALESCE(state, 'unknown') AS state,`,
    `  COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0) AS lag_bytes`,
    `FROM pg_catalog.pg_stat_replication`,
    `ORDER BY backend_start ASC NULLS LAST`,
    `LIMIT 1;`,
  ].join("\n");
}

export function standbyReplicationStatusSql(): string {
  // Only report `streaming` when a live WAL receiver is active. A disconnected
  // hot standby remains in recovery but must not look promote-ready.
  return [
    `SELECT`,
    `  CASE`,
    `    WHEN NOT pg_catalog.pg_is_in_recovery() THEN 'unknown'`,
    `    WHEN r.status IS NULL THEN 'stopped'`,
    `    WHEN r.status = 'streaming' THEN 'streaming'`,
    `    ELSE COALESCE(r.status, 'unknown')`,
    `  END AS state,`,
    `  CASE`,
    `    WHEN r.status = 'streaming' AND r.received_lsn IS NOT NULL`,
    `    THEN COALESCE(pg_catalog.pg_wal_lsn_diff(r.received_lsn, pg_catalog.pg_last_wal_replay_lsn()), 0)`,
    `    ELSE NULL`,
    `  END AS lag_bytes,`,
    `  CASE`,
    `    WHEN r.status = 'streaming' AND pg_catalog.pg_last_xact_replay_timestamp() IS NOT NULL`,
    `    THEN EXTRACT(EPOCH FROM (now() - pg_catalog.pg_last_xact_replay_timestamp()))`,
    `    ELSE NULL`,
    `  END AS lag_seconds`,
    `FROM (SELECT 1) AS _dummy`,
    `LEFT JOIN pg_catalog.pg_stat_wal_receiver r ON true;`,
  ].join("\n");
}

export function promoteSql(): string {
  return "SELECT pg_catalog.pg_promote(true, 60);";
}

export function isInRecoverySql(): string {
  return "SELECT pg_catalog.pg_is_in_recovery();";
}

export { MANAGED_SLOT_PREFIX };
