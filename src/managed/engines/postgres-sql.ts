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
    // The public connect default is revoked (`revokePublicDatabaseAccessSql`);
    // the monitor dials the maintenance database, so it gets its own grant.
    grantMonitorConnectSql(username),
  ].join("\n");
}

export function dropRoleSql(username: string): string {
  const ident = quoteIdentifier(username);
  return `DROP ROLE IF EXISTS ${ident};`;
}

/**
 * Databases a role must be released in before it can be dropped: every
 * database that accepts connections and is not a template. Returns no rows
 * when the role is already gone, so a retried delete skips the release step
 * (`REASSIGN OWNED` errors on a missing role).
 */
export function listDatabasesForRoleReleaseSql(username: string): string {
  return [
    `SELECT d.datname`,
    `FROM pg_catalog.pg_database d`,
    `WHERE d.datallowconn AND NOT d.datistemplate`,
    `AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${
      quoteLiteral(username)
    })`,
    `ORDER BY d.datname;`,
  ].join("\n");
}

/**
 * Run inside each database before `DROP ROLE`. `REASSIGN OWNED` first, so a
 * deleted owner's tables and databases pass to the platform admin (data is
 * kept, never dropped); `DROP OWNED` then only removes the privileges and
 * default privileges the role still holds (including on the database itself).
 */
export function releaseRoleObjectsSql(
  username: string,
  newOwner: string,
): string {
  const ident = quoteIdentifier(username);
  return [
    `REASSIGN OWNED BY ${ident} TO ${quoteIdentifier(newOwner)};`,
    `DROP OWNED BY ${ident};`,
  ].join("\n");
}

/**
 * CREATE DATABASE must not run inside a DO/function block (Postgres error
 * "CREATE DATABASE cannot be executed from a function"). Callers check
 * existence first via {@link databaseExistsSql}, then run this top-level.
 */
export function createDatabaseSql(
  name: string,
  owner?: string,
): string {
  const ident = quoteIdentifier(name);
  if (owner === undefined) {
    return `CREATE DATABASE ${ident};`;
  }
  return `CREATE DATABASE ${ident} OWNER ${quoteIdentifier(owner)};`;
}

/** Existence probe (tuples-only friendly) for the apply path. */
export function databaseExistsSql(name: string): string {
  return `SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${
    quoteLiteral(name)
  };`;
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
  // Revoke first so a changed level (read-write to read-only, say) leaves
  // exactly the grant for the new level and nothing from the old one. One
  // transaction, so a login that is already connected to this database (or
  // connecting right now) never sees the gap between the revoke and the grant.
  const reset = `REVOKE ALL ON DATABASE ${db} FROM ${role};`;
  switch (privilege) {
    case "owner":
      return [
        `BEGIN;`,
        `ALTER DATABASE ${db} OWNER TO ${role};`,
        `GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${role};`,
        `COMMIT;`,
      ].join("\n");
    case "read-write":
      return [
        `BEGIN;`,
        reset,
        `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${role};`,
        `COMMIT;`,
      ].join("\n");
    case "read-only":
      return [
        `BEGIN;`,
        reset,
        `GRANT CONNECT ON DATABASE ${db} TO ${role};`,
        `COMMIT;`,
      ].join("\n");
    default: {
      const _exhaustive: never = privilege;
      throw new Error(`unsupported privilege: ${_exhaustive}`);
    }
  }
}

const PRIVILEGE_RANK: Record<ManagedDatabasePrivilege, number> = {
  "read-only": 1,
  "read-write": 2,
  owner: 3,
};

/**
 * The one level a login holds on its databases: the strongest recognised
 * entry of its `privileges` list (owner, then read-write, then read-only).
 * `null` when the list has no recognised entry — the login is granted nothing.
 */
export function strongestPrivilege(
  raw: readonly string[],
): ManagedDatabasePrivilege | null {
  let best: ManagedDatabasePrivilege | null = null;
  for (const value of raw) {
    if (!Object.hasOwn(PRIVILEGE_RANK, value)) continue;
    const level = value as ManagedDatabasePrivilege;
    if (best === null || PRIVILEGE_RANK[level] > PRIVILEGE_RANK[best]) {
      best = level;
    }
  }
  return best;
}

/**
 * Take the "everyone may connect" default away from every database that
 * accepts connections (templates and the maintenance database included).
 * A login then reaches only the databases it was explicitly granted. Safe to
 * repeat; run on every apply so databases created by hand or by an older
 * version are covered too. Superusers are unaffected.
 */
export function revokePublicDatabaseAccessSql(): string {
  return [
    `DO $turbopanel$`,
    `DECLARE d record;`,
    `BEGIN`,
    `  FOR d IN SELECT datname FROM pg_catalog.pg_database WHERE datallowconn LOOP`,
    `    EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM PUBLIC', d.datname);`,
    `  END LOOP;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/**
 * Remove whatever access a login still holds on databases that are not in its
 * list (a database taken off the login, or granted by an older version). The
 * owner of a database keeps what ownership implies.
 */
export function revokeUnlistedDatabasesSql(
  username: string,
  keep: readonly string[],
): string {
  const role = quoteIdentifier(username);
  const keepArray = keep.length === 0
    ? `ARRAY[]::text[]`
    : `ARRAY[${keep.map((name) => quoteLiteral(name)).join(", ")}]::text[]`;
  return [
    `DO $turbopanel$`,
    `DECLARE d record;`,
    `BEGIN`,
    `  FOR d IN SELECT datname FROM pg_catalog.pg_database`,
    `           WHERE datallowconn AND datname <> ALL (${keepArray}) LOOP`,
    `    EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM ${role}', d.datname);`,
    `  END LOOP;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/**
 * The maintenance database accepts the ProxySQL health-check login only; the
 * public default is gone, so grant it explicitly.
 */
export function grantMonitorConnectSql(username: string): string {
  return `GRANT CONNECT ON DATABASE postgres TO ${quoteIdentifier(username)};`;
}

/**
 * A read-only login also starts every session in this database read-only.
 * Table privileges are the real wall (SELECT only); this stops an accidental
 * write from even beginning a transaction. Scoped to the database so the
 * same login stays writable where it holds a higher level.
 */
export function readOnlySessionDefaultSql(
  database: string,
  username: string,
  readOnly: boolean,
): string {
  const db = quoteIdentifier(database);
  const role = quoteIdentifier(username);
  return readOnly
    ? `ALTER ROLE ${role} IN DATABASE ${db} SET default_transaction_read_only = on;`
    : `ALTER ROLE ${role} IN DATABASE ${db} RESET default_transaction_read_only;`;
}

export type DatabaseObjectAccess = {
  /**
   * Roles whose future tables, sequences and schemas the others must reach:
   * the platform admin (restores run as it), the exposed root login, and
   * every owner or read-write login on the database.
   */
  creators: readonly string[];
  /** Owner and read-write logins: read, write and create. */
  writers: readonly string[];
  /** Read-only logins: read and nothing else. */
  readers: readonly string[];
};

function defaultPrivilegeSql(
  creator: string,
  writers: readonly string[],
  readers: readonly string[],
): string[] {
  const owner = quoteIdentifier(creator);
  const lines: string[] = [];
  for (const name of writers) {
    if (name === creator) continue;
    const role = quoteIdentifier(name);
    lines.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT ALL ON TABLES TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT ALL ON SEQUENCES TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT USAGE, CREATE ON SCHEMAS TO ${role};`,
    );
  }
  for (const name of readers) {
    if (name === creator) continue;
    const role = quoteIdentifier(name);
    lines.push(
      // Wipe a former read-write default before the read-only one.
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE ALL ON TABLES FROM ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE ALL ON SEQUENCES FROM ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE ALL ON SCHEMAS FROM ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT SELECT ON TABLES TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT SELECT ON SEQUENCES TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT USAGE ON SCHEMAS TO ${role};`,
    );
  }
  return lines;
}

/** One statement run per schema inside the loop; `%I` is the schema name. */
function perSchema(statement: string, role: string): string {
  return `    EXECUTE pg_catalog.format('${statement} ${
    quoteIdentifier(role)
  }', s.nspname);`;
}

function existingObjectSql(
  writers: readonly string[],
  readers: readonly string[],
): string[] {
  const lines: string[] = [];
  for (const name of writers) {
    lines.push(
      perSchema(`GRANT USAGE, CREATE ON SCHEMA %I TO`, name),
      perSchema(`GRANT ALL ON ALL TABLES IN SCHEMA %I TO`, name),
      perSchema(`GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO`, name),
    );
  }
  for (const name of readers) {
    lines.push(
      perSchema(`REVOKE CREATE ON SCHEMA %I FROM`, name),
      perSchema(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA %I FROM`,
        name,
      ),
      perSchema(
        `REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA %I FROM`,
        name,
      ),
      perSchema(`GRANT USAGE ON SCHEMA %I TO`, name),
      perSchema(`GRANT SELECT ON ALL TABLES IN SCHEMA %I TO`, name),
      perSchema(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO`, name),
    );
  }
  return lines;
}

/**
 * Table-level access inside ONE database; run connected to that database
 * (privileges on tables and the default privileges for future ones live in
 * each database's own catalog). Covers every schema that is not a system
 * schema, existing objects now and objects made later by any creator.
 *
 * - writers (owner, read-write): everything on tables and sequences, plus
 *   use and create on schemas.
 * - readers (read-only): SELECT on tables and sequences, USAGE on schemas.
 *
 * Postgres only lets an object's owner alter or drop it, so a read-write
 * login can read and write every table but only alter or drop what it made
 * itself; the owner login does the rest.
 */
export function reconcileDatabaseObjectsSql(
  access: DatabaseObjectAccess,
): string {
  const lines = [
    // Postgres 14 and older let everyone create in `public`; 15+ already
    // does not. Same end state on every series.
    `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
  ];
  const existing = existingObjectSql(access.writers, access.readers);
  if (existing.length > 0) {
    lines.push(
      `DO $turbopanel$`,
      `DECLARE s record;`,
      `BEGIN`,
      `  FOR s IN SELECT nspname FROM pg_catalog.pg_namespace`,
      `           WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' LOOP`,
      ...existing,
      `  END LOOP;`,
      `END`,
      `$turbopanel$;`,
    );
  }
  for (const creator of access.creators) {
    lines.push(
      ...defaultPrivilegeSql(creator, access.writers, access.readers),
    );
  }
  return lines.join("\n");
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
  // A "standby" that is NOT in recovery has diverged into a standalone
  // primary (lost/initdb'd data dir) — surface that as needs_resync, never
  // an opaque 'unknown'.
  return [
    `SELECT`,
    `  CASE`,
    `    WHEN NOT pg_catalog.pg_is_in_recovery() THEN 'needs_resync'`,
    `    WHEN r.status IS NULL THEN 'stopped'`,
    `    WHEN r.status = 'streaming' THEN 'streaming'`,
    `    ELSE COALESCE(r.status, 'unknown')`,
    `  END AS state,`,
    `  CASE`,
    // `received_lsn` was renamed to `flushed_lsn` in PostgreSQL 13.
    `    WHEN r.status = 'streaming' AND r.flushed_lsn IS NOT NULL`,
    `    THEN COALESCE(pg_catalog.pg_wal_lsn_diff(r.flushed_lsn, pg_catalog.pg_last_wal_replay_lsn()), 0)`,
    `    ELSE NULL`,
    `  END AS lag_bytes,`,
    `  CASE`,
    `    WHEN r.status = 'streaming' AND pg_catalog.pg_last_xact_replay_timestamp() IS NOT NULL`,
    `    THEN EXTRACT(EPOCH FROM (now() - pg_catalog.pg_last_xact_replay_timestamp()))`,
    `    ELSE NULL`,
    `  END AS lag_seconds,`,
    // Both stay readable after the WAL receiver exits (primary gone): the
    // last position received and flushed, and the last position replayed.
    // NULL (empty) when streaming never started since the server started.
    `  pg_catalog.pg_last_wal_receive_lsn()::text AS received_lsn,`,
    `  pg_catalog.pg_last_wal_replay_lsn()::text AS replay_lsn,`,
    // How far the received WAL trails the primary's last reported WAL end,
    // from the standby's own receiver state (no primary query, no clock).
    `  CASE`,
    `    WHEN r.status = 'streaming' AND r.latest_end_lsn IS NOT NULL AND r.flushed_lsn IS NOT NULL`,
    `    THEN GREATEST(pg_catalog.pg_wal_lsn_diff(r.latest_end_lsn, r.flushed_lsn), 0)`,
    `    ELSE NULL`,
    `  END AS receive_lag_bytes,`,
    // Seconds since the receiver last heard from the primary, on this host's
    // clock. After a silent link drop the receiver stays 'streaming' until
    // wal_receiver_timeout; this exposes it.
    `  CASE`,
    `    WHEN r.status = 'streaming' AND r.last_msg_receipt_time IS NOT NULL`,
    `    THEN GREATEST(EXTRACT(EPOCH FROM (now() - r.last_msg_receipt_time)), 0)`,
    `    ELSE NULL`,
    `  END AS receipt_age_seconds`,
    `FROM (SELECT 1) AS _dummy`,
    `LEFT JOIN pg_catalog.pg_stat_wal_receiver r ON true;`,
  ].join("\n");
}

/**
 * `pg_file_settings` rows that mean "restart required", not "broken file".
 * PostgreSQL words it two ways:
 * - `setting could not be applied`: a restart-required parameter is SET in the
 *   file to a value the running server does not have yet.
 * - `... cannot be changed without restarting the server`: a restart-required
 *   parameter was REMOVED from the file (or lowered back to its default) and
 *   would revert on restart. That row has no file or line (`sourcefile` is
 *   NULL) and, left counted as an error, failed every later apply until the
 *   engine was restarted.
 * Real syntax or unknown-parameter errors (`unrecognized configuration
 * parameter ...`) match neither and stay errors.
 */
const RESTART_PENDING_PREDICATE = "(error = 'setting could not be applied' " +
  "OR error LIKE '%cannot be changed without restarting the server%')";

/**
 * Post-reload verification: both views re-read the config files from disk at
 * query time, so an unreadable or syntactically broken file surfaces here
 * even though `pg_reload_conf()` itself returned true (the postmaster only
 * logs reload failures — it never reports them to the caller).
 *
 * Restart-required rows (see {@link RESTART_PENDING_PREDICATE}, e.g.
 * `max_replication_slots` growing with the member count, or an operator
 * removing `max_connections`) are excluded from the error count: that is
 * expected on reload, not a broken file. Their count is returned separately
 * so the caller can log the pending restart.
 */
export function reloadVerifySql(): string {
  return [
    "SELECT",
    "  (SELECT count(*) FROM pg_catalog.pg_file_settings",
    `   WHERE error IS NOT NULL AND NOT ${RESTART_PENDING_PREDICATE}) AS config_errors,`,
    "  (SELECT count(*) FROM pg_catalog.pg_hba_file_rules WHERE error IS NOT NULL) AS hba_errors,",
    "  (SELECT count(*) FROM pg_catalog.pg_file_settings",
    `   WHERE ${RESTART_PENDING_PREDICATE}) AS restart_pending;`,
  ].join("\n");
}

/**
 * Metrics census: client backends open now, and the configured ceiling.
 * One row, two integer cells, for `psql -t -A -F '\t'`.
 */
export function connectionCensusSql(): string {
  return [
    `SELECT (SELECT count(*) FROM pg_catalog.pg_stat_activity`,
    `        WHERE backend_type = 'client backend')::int,`,
    `       current_setting('max_connections')::int;`,
  ].join("\n");
}

export function promoteSql(): string {
  return "SELECT pg_catalog.pg_promote(true, 60);";
}

export function isInRecoverySql(): string {
  return "SELECT pg_catalog.pg_is_in_recovery();";
}

export { MANAGED_SLOT_PREFIX };
