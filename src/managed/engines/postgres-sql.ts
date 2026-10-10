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
 * Empties every user schema in the connected database so a restore returns it
 * to exactly the backup's state (rows, tables and schemas created after the
 * backup are gone). Every schema is dropped. `public` is the only one the dump
 * does not create itself, so it is recreated with the same owner and the same
 * privileges; the dump brings back the others with their own privileges. The
 * roles bound to the database keep their access. Role-level settings, the database itself (owner, connect rights) and
 * the cluster's roles are not touched.
 *
 * Meant to run inside the same transaction as the restore, after
 * `BEGIN;`: a failed restore then rolls everything back. `lock_timeout`
 * makes a busy application connection fail the restore cleanly instead of
 * waiting forever on a table lock.
 */
/**
 * `pg_restore -f -` replays session `SET lock_timeout` / `SET statement_timeout`
 * (usually `= 0`) that override an earlier `SET LOCAL lock_timeout` in the same
 * transaction. Strip only those directives before `psql` sees them.
 */
const PG_RESTORE_TIMEOUT_SET_LINE_RE =
  /^\s*SET\s+(?:lock_timeout|statement_timeout)\s*=/i;

export function stripPgRestoreTimeoutSetLines(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !PG_RESTORE_TIMEOUT_SET_LINE_RE.test(line))
    .join("\n");
}

/** GNU `sed -E` delete pattern; kept in sync with {@link stripPgRestoreTimeoutSetLines}. */
export const PG_RESTORE_TIMEOUT_SET_LINE_SED =
  "/^[[:space:]]*SET[[:space:]]+(lock_timeout|statement_timeout)[[:space:]]*=/I";

export function restoreResetSql(): string {
  return [
    "SET LOCAL lock_timeout = '30s';",
    "DO $tp_reset$",
    "DECLARE",
    "  s record;",
    "  a record;",
    "BEGIN",
    "  FOR s IN",
    "    SELECT n.nspname AS name,",
    "           n.nspowner::pg_catalog.regrole::pg_catalog.text AS owner,",
    "           n.nspacl AS acl",
    "      FROM pg_catalog.pg_namespace n",
    "     WHERE n.nspname !~ '^pg_'",
    "       AND n.nspname <> 'information_schema'",
    "  LOOP",
    "    EXECUTE pg_catalog.format('DROP SCHEMA %I CASCADE', s.name);",
    "    IF s.name = 'public' THEN",
    "      EXECUTE pg_catalog.format('CREATE SCHEMA %I', s.name);",
    "      EXECUTE pg_catalog.format('ALTER SCHEMA %I OWNER TO %s', s.name, s.owner);",
    "      IF s.acl IS NOT NULL THEN",
    "        FOR a IN",
    "          SELECT e.grantee, e.privilege_type, e.is_grantable",
    "            FROM pg_catalog.aclexplode(s.acl) e",
    "           WHERE e.grantee <> (SELECT n2.nspowner FROM pg_catalog.pg_namespace n2 WHERE n2.nspname = s.name)",
    "        LOOP",
    "          EXECUTE pg_catalog.format(",
    "            'GRANT %s ON SCHEMA %I TO %s%s',",
    "            a.privilege_type, s.name,",
    "            CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::pg_catalog.text END,",
    "            CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END",
    "          );",
    "        END LOOP;",
    "      END IF;",
    "    END IF;",
    "  END LOOP;",
    "END",
    "$tp_reset$;",
  ].join("\n");
}

/**
 * Recreate per-login schemas for every read-write platform login on the
 * connected database. The schema reset drops them; the dump does not contain
 * logins created after the backup. Idempotent — run after `pg_restore` in the
 * same transaction, before `COMMIT`.
 */
export function restoreReadWriteLoginSchemasSql(): string {
  return [
    "DO $tp_rw_schemas$",
    "DECLARE r record;",
    "BEGIN",
    "  FOR r IN",
    "    SELECT rol.rolname",
    "      FROM pg_catalog.pg_roles rol",
    "     WHERE rol.rolcanlogin",
    "       AND NOT rol.rolsuper",
    "       AND pg_catalog.has_database_privilege(",
    "             rol.oid, pg_catalog.current_database(), 'CONNECT')",
    "       AND pg_catalog.has_database_privilege(",
    "             rol.oid, pg_catalog.current_database(), 'TEMPORARY')",
    "       AND NOT pg_catalog.has_database_privilege(",
    "             rol.oid, pg_catalog.current_database(), 'CREATE')",
    "  LOOP",
    "    IF NOT EXISTS (",
    "      SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = r.rolname",
    "    ) THEN",
    "      EXECUTE pg_catalog.format(",
    "        'CREATE SCHEMA %I AUTHORIZATION %I', r.rolname, r.rolname",
    "      );",
    "    END IF;",
    "  END LOOP;",
    "END",
    "$tp_rw_schemas$;",
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

/** Privilege lists, as Postgres spells them in `aclexplode`. */
const DATABASE_PRIVILEGES = ["CONNECT", "CREATE", "TEMPORARY"] as const;
const READ_WRITE_DATABASE_PRIVILEGES = ["CONNECT", "TEMPORARY"] as const;
const READ_ONLY_DATABASE_PRIVILEGES = ["CONNECT"] as const;
const WRITER_TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
] as const;
const WRITER_SEQUENCE_PRIVILEGES = ["USAGE", "SELECT", "UPDATE"] as const;
const OWNER_SCHEMA_PRIVILEGES = ["USAGE", "CREATE"] as const;
const WRITER_SCHEMA_PRIVILEGES = ["USAGE"] as const;
const READER_TABLE_PRIVILEGES = ["SELECT"] as const;
const READER_SEQUENCE_PRIVILEGES = ["SELECT"] as const;
const READER_SCHEMA_PRIVILEGES = ["USAGE"] as const;

function textArray(values: readonly string[]): string {
  return `ARRAY[${
    values.map((value) => quoteLiteral(value)).join(", ")
  }]::text[]`;
}

/** Subquery: the oid of a role by name (NULL when it does not exist). */
function roleOidSql(username: string): string {
  return `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${
    quoteLiteral(username)
  })`;
}

/**
 * Boolean SQL: the role's own entry in an ACL holds exactly `want` and nothing
 * else (order does not matter). `acl` is the catalog column, `defaultAcl` the
 * `acldefault(...)` it stands for while the column is NULL.
 */
function aclEntryIsExactlySql(
  acl: string,
  defaultAcl: string,
  username: string,
  want: readonly string[],
): string {
  const have =
    `COALESCE((SELECT pg_catalog.array_agg(a.privilege_type::text) FROM pg_catalog.aclexplode(COALESCE(${acl}, ${defaultAcl})) a WHERE a.grantee = ${
      roleOidSql(username)
    }), ARRAY[]::text[])`;
  const wanted = textArray(want);
  return `(${have} @> ${wanted} AND ${have} <@ ${wanted})`;
}

/**
 * Give a login exactly this level on one database. The old level is revoked
 * first so a changed level (read-write to read-only, say) leaves nothing from
 * the old one, in one block so a login that is connected to this database (or
 * connecting right now) never sees the gap. Nothing is written when the login
 * already holds exactly this, so a repeated apply does not rewrite the ACL.
 */

function databasePrivilegesFor(
  privilege: string,
): readonly string[] {
  if (privilege === "read-only") return READ_ONLY_DATABASE_PRIVILEGES;
  if (privilege === "read-write") return READ_WRITE_DATABASE_PRIVILEGES;
  return DATABASE_PRIVILEGES;
}

export function grantDatabaseSql(
  database: string,
  username: string,
  privilege: ManagedDatabasePrivilege,
): string {
  const db = quoteIdentifier(database);
  const role = quoteIdentifier(username);
  const want = databasePrivilegesFor(privilege);
  const upToDate = aclEntryIsExactlySql(
    "d.datacl",
    "pg_catalog.acldefault('d', d.datdba)",
    username,
    want,
  );
  const lines = [`DO $turbopanel$`, `BEGIN`];
  if (privilege === "owner") {
    lines.push(
      `  IF (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = ${
        quoteLiteral(database)
      }) IS DISTINCT FROM ${roleOidSql(username)} THEN`,
      `    ALTER DATABASE ${db} OWNER TO ${role};`,
      `  END IF;`,
    );
  }
  lines.push(
    `  IF (SELECT ${upToDate} FROM pg_catalog.pg_database d WHERE d.datname = ${
      quoteLiteral(database)
    }) IS NOT TRUE THEN`,
    `    REVOKE ALL ON DATABASE ${db} FROM ${role};`,
    `    GRANT ${want.join(", ")} ON DATABASE ${db} TO ${role};`,
    `  END IF;`,
    `END`,
    `$turbopanel$;`,
  );
  return lines.join("\n");
}

/**
 * Create a per-login schema where read-write logins can create objects.
 * The schema is owned by the login and they have full CREATE rights within it.
 * Run inside the database where the read-write login needs CREATE capability.
 */
export function ensureReadWriteLoginSchemaSql(username: string): string {
  const ident = quoteIdentifier(username);
  return [
    `DO $turbopanel$`,
    `BEGIN`,
    `  IF NOT EXISTS (`,
    `    SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${
      quoteLiteral(username)
    }`,
    `  ) THEN`,
    `    CREATE SCHEMA ${ident} AUTHORIZATION ${ident};`,
    `  END IF;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
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
 * version are covered too, and only a database that still carries a PUBLIC
 * entry is written. The monitor grant comes first so a ProxySQL health check
 * never meets the locked maintenance database without it. Superusers are
 * unaffected.
 */
export function revokePublicDatabaseAccessSql(): string {
  return [
    grantMonitorConnectSql(),
    `DO $turbopanel$`,
    `DECLARE d record;`,
    `BEGIN`,
    `  FOR d IN SELECT datname FROM pg_catalog.pg_database`,
    `           WHERE datallowconn AND (datacl IS NULL OR EXISTS (`,
    `             SELECT 1 FROM pg_catalog.aclexplode(datacl) a WHERE a.grantee = 0)) LOOP`,
    `    EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM PUBLIC', d.datname);`,
    `  END LOOP;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/**
 * Remove whatever access a login still holds on databases that are not in its
 * list (a database taken off the login, or granted by an older version). Only
 * databases where the login still has an entry are written.
 */
export function revokeUnlistedDatabasesSql(
  username: string,
  keep: readonly string[],
): string {
  const role = quoteIdentifier(username);
  for (const name of keep) quoteIdentifier(name);
  const keepArray = textArray(keep);
  return [
    `DO $turbopanel$`,
    `DECLARE d record;`,
    `BEGIN`,
    `  FOR d IN SELECT datname FROM pg_catalog.pg_database`,
    `           WHERE datallowconn AND datname <> ALL (${keepArray})`,
    `           AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(datacl) a`,
    `                       WHERE a.grantee = ${roleOidSql(username)}) LOOP`,
    `    EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM ${role}', d.datname);`,
    `  END LOOP;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/**
 * ProxySQL's health checks dial the maintenance database as a login that is a
 * member of `pg_monitor`. With the public default gone, give that predefined
 * role the connect right: every such login (one per fronting server) inherits
 * it, including ones this apply does not name.
 */
export function grantMonitorConnectSql(): string {
  return `GRANT CONNECT ON DATABASE postgres TO pg_monitor;`;
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
  /** Owner logins: the only logins that may create in `public` and in other logins' schemas. */
  owners: readonly string[];
  /** Owner and read-write logins: read and write (create only for owners, and in a login's own schema). */
  writers: readonly string[];
  /** Read-only logins: read and nothing else. */
  readers: readonly string[];
};

function defaultPrivilegeSql(
  creator: string,
  owners: readonly string[],
  writers: readonly string[],
  readers: readonly string[],
): string[] {
  const owner = quoteIdentifier(creator);
  const lines: string[] = [];
  for (const name of writers) {
    if (name === creator) continue;
    const role = quoteIdentifier(name);
    lines.push(
      // Wipe an earlier, wider default (one that included TRIGGER) first.
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE ALL ON TABLES FROM ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE ALL ON SEQUENCES FROM ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT ${
        WRITER_TABLE_PRIVILEGES.join(", ")
      } ON TABLES TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT ${
        WRITER_SEQUENCE_PRIVILEGES.join(", ")
      } ON SEQUENCES TO ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE ALL ON SCHEMAS FROM ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT ${
        (owners.includes(name)
          ? OWNER_SCHEMA_PRIVILEGES
          : WRITER_SCHEMA_PRIVILEGES).join(", ")
      } ON SCHEMAS TO ${role};`,
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

type AclTarget = {
  /** `r` (tables, views), `s` (sequences) or `n` (schemas): acldefault kind. */
  acl: "r" | "s" | "n";
  /** GRANT/REVOKE object word, and how the loop names the object. */
  noun: "TABLE" | "SEQUENCE" | "SCHEMA";
};

/**
 * One DO block that makes a login hold exactly `want` on every object of one
 * kind outside the system schemas, and writes only the objects where it does
 * not already (a repeated apply rewrites no ACL). `REVOKE ALL` then `GRANT`
 * sit in the same block, so a connected login never sees the gap. An object
 * the login owns keeps its owner rights when `skipOwned` is set (writers).
 *
 * Never `GRANT ALL` for a login that is not the owner: ALL includes TRIGGER
 * (which would let a read-write login run code as whoever writes the table)
 * and, on newer series, MAINTAIN.
 */
function exactObjectAclSql(
  target: AclTarget,
  username: string,
  want: readonly string[],
  skipOwned: boolean,
): string {
  const role = quoteIdentifier(username);
  const isSchema = target.acl === "n";
  const relation = isSchema
    ? "pg_catalog.pg_namespace o"
    : "pg_catalog.pg_class o";
  const owner = isSchema ? "o.nspowner" : "o.relowner";
  const aclColumn = isSchema ? "o.nspacl" : "o.relacl";
  const nameColumn = isSchema ? "o.nspname" : "o.relname";
  const schemaColumn = isSchema ? "o.nspname" : "n.nspname";
  const kindFilter = {
    r: `o.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    s: `o.relkind = 'S'`,
    n: `true`,
  }[target.acl];
  const join = isSchema
    ? ""
    : ` JOIN pg_catalog.pg_namespace n ON n.oid = o.relnamespace`;
  const upToDate = aclEntryIsExactlySql(
    aclColumn,
    `pg_catalog.acldefault('${target.acl}', ${owner})`,
    username,
    want,
  );
  const objectName = isSchema
    ? `pg_catalog.quote_ident(${nameColumn})`
    : `o.oid::pg_catalog.regclass::text`;
  const conditions = [
    `${schemaColumn} <> 'information_schema'`,
    `${schemaColumn} !~ '^pg_'`,
    kindFilter,
    `NOT ${upToDate}`,
  ];
  if (skipOwned) {
    conditions.push(`${owner} IS DISTINCT FROM ${roleOidSql(username)}`);
  }
  return [
    `DO $turbopanel$`,
    `DECLARE r record;`,
    `BEGIN`,
    `  FOR r IN SELECT ${objectName} AS obj FROM ${relation}${join}`,
    `           WHERE ${conditions.join(" AND ")} LOOP`,
    `    EXECUTE pg_catalog.format('REVOKE ALL ON ${target.noun} %s FROM ${role}', r.obj);`,
    `    EXECUTE pg_catalog.format('GRANT ${
      want.join(", ")
    } ON ${target.noun} %s TO ${role}', r.obj);`,
    `  END LOOP;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

function existingObjectSql(
  owners: readonly string[],
  writers: readonly string[],
  readers: readonly string[],
): string[] {
  const lines: string[] = [];
  const table: AclTarget = { acl: "r", noun: "TABLE" };
  const sequence: AclTarget = { acl: "s", noun: "SEQUENCE" };
  const schema: AclTarget = { acl: "n", noun: "SCHEMA" };
  for (const name of writers) {
    lines.push(
      exactObjectAclSql(
        schema,
        name,
        owners.includes(name)
          ? OWNER_SCHEMA_PRIVILEGES
          : WRITER_SCHEMA_PRIVILEGES,
        true,
      ),
      exactObjectAclSql(table, name, WRITER_TABLE_PRIVILEGES, true),
      exactObjectAclSql(sequence, name, WRITER_SEQUENCE_PRIVILEGES, true),
    );
  }
  for (const name of readers) {
    lines.push(
      exactObjectAclSql(schema, name, READER_SCHEMA_PRIVILEGES, false),
      exactObjectAclSql(table, name, READER_TABLE_PRIVILEGES, false),
      exactObjectAclSql(sequence, name, READER_SEQUENCE_PRIVILEGES, false),
    );
  }
  return lines;
}

/**
 * Close CREATE on `public` to everyone (Postgres 14 and older open it; 15+
 * already does not): same end state on every series. Writes only while the
 * PUBLIC entry still holds CREATE.
 */
function closePublicSchemaSql(): string {
  return [
    `DO $turbopanel$`,
    `BEGIN`,
    `  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,`,
    `             pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a`,
    `             WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') THEN`,
    `    REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
    `  END IF;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/**
 * Table-level access inside ONE database; run connected to that database
 * (privileges on tables and the default privileges for future ones live in
 * each database's own catalog). Covers every schema that is not a system
 * schema, existing objects now and objects made later by any creator.
 *
 * - writers (owner, read-write): SELECT, INSERT, UPDATE, DELETE, TRUNCATE and
 *   REFERENCES on tables (REFERENCES lets a migration add a foreign key to a
 *   table another login owns; it cannot run code); USAGE, SELECT and UPDATE on
 *   sequences; USAGE and CREATE on schemas. Never TRIGGER or MAINTAIN: a login that may add a
 *   trigger to a table runs code as whoever writes that table, the owner
 *   login included. Version-neutral (no privilege is named for revoking), so
 *   it applies unchanged on every supported Postgres series.
 * - readers (read-only): SELECT on tables and sequences, USAGE on schemas.
 *
 * Postgres only lets an object's owner alter or drop it, so a read-write
 * login can read and write every table but only alter or drop what it made
 * itself; the owner login does the rest (and for a table a read-write login
 * made, the platform admin or `REASSIGN OWNED`).
 */
export function reconcileDatabaseObjectsSql(
  access: DatabaseObjectAccess,
): string {
  const lines = [closePublicSchemaSql()];
  lines.push(
    ...existingObjectSql(access.owners, access.writers, access.readers),
  );
  for (const creator of access.creators) {
    lines.push(
      ...defaultPrivilegeSql(
        creator,
        access.owners,
        access.writers,
        access.readers,
      ),
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

/**
 * Create a managed physical slot unless it exists. Reserved at once by
 * default, so a replica that has not connected yet already has its WAL kept.
 * `reserve: false` makes a slot that keeps no WAL until a replica first
 * connects (what a Resync does): used for a slot that replaces a cut-off one,
 * so the stale replica cannot make the primary hold WAL again before it is
 * re-seeded.
 */
export function createPhysicalSlotSql(
  slotName: string,
  options?: { reserve?: boolean },
): string {
  quoteIdentifier(slotName);
  const reserve = options?.reserve === false ? "false" : "true";
  return [
    `SELECT pg_catalog.pg_create_physical_replication_slot(${
      quoteLiteral(slotName)
    }, ${reserve}, false)`,
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
    // A slot a replica is still attached to cannot be dropped (Postgres
    // refuses); leave it for the next apply instead of failing this one.
    `WHERE slot_name = ${quoteLiteral(slotName)} AND NOT active;`,
  ].join("\n");
}

/** List physical slots owned by the managed prefix (`tp_member_`). */
export function listManagedSlotsSql(): string {
  return [
    `SELECT slot_name FROM pg_catalog.pg_replication_slots`,
    `WHERE ${managedSlotPrefixSql()}`,
    `  AND slot_type = 'physical';`,
  ].join("\n");
}

/**
 * `starts_with` instead of `LIKE`: `_` is a LIKE wildcard, so `tp_member_%`
 * would also match names such as `tp-member-x`.
 */
function managedSlotPrefixSql(): string {
  return `starts_with(slot_name, ${quoteLiteral(MANAGED_SLOT_PREFIX)})`;
}

/**
 * Managed slots the primary has already given up on (`wal_status = 'lost'`:
 * their WAL is gone, a replica can no longer stream from them) and that no
 * replica is attached to. A lost slot cannot be reused, not even by a fresh
 * `pg_basebackup -S`, so the apply replaces it (see
 * `recreateLostPhysicalSlotSql`). In-use slots are never listed.
 */
export function listLostPhysicalSlotsSql(): string {
  return [
    `SELECT slot_name FROM pg_catalog.pg_replication_slots`,
    `WHERE ${managedSlotPrefixSql()}`,
    `  AND slot_type = 'physical' AND wal_status = 'lost' AND NOT active`,
    `ORDER BY slot_name;`,
  ].join("\n");
}

/**
 * Replace a lost slot with one that keeps no WAL until its replica connects
 * again. The replacement is deliberately left unreserved: health reports an
 * inactive slot with no `wal_status` as "waiting for a Resync" (critical), so
 * the cut-off stays visible on every later apply until the replica has been
 * re-seeded (the re-seed reserves the slot), and the stale replica does not
 * make the primary hold WAL again in the meantime.
 */
export function recreateLostPhysicalSlotSql(slotName: string): string {
  quoteIdentifier(slotName);
  return [
    `SELECT pg_catalog.pg_drop_replication_slot(slot_name)`,
    `FROM pg_catalog.pg_replication_slots`,
    `WHERE slot_name = ${
      quoteLiteral(slotName)
    } AND wal_status = 'lost' AND NOT active;`,
    createPhysicalSlotSql(slotName, { reserve: false }),
  ].join("\n");
}

/**
 * How much WAL each managed slot is holding back, one row per slot:
 * name, whether a replica is attached, `wal_status` (empty for a slot that
 * has no WAL reserved), bytes between the primary's WAL position and what
 * the slot still needs, and the bytes left before the `max_slot_wal_keep_size`
 * cap invalidates it (-1 with no cap). Primary only (`pg_current_wal_lsn()`
 * does not run on a standby).
 */
export function managedSlotRetentionSql(): string {
  return [
    `SELECT slot_name, active::text, COALESCE(wal_status, ''),`,
    `  COALESCE(pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), restart_lsn), 0)::bigint,`,
    `  COALESCE(safe_wal_size, -1)::bigint`,
    `FROM pg_catalog.pg_replication_slots`,
    `WHERE ${managedSlotPrefixSql()}`,
    `  AND slot_type = 'physical'`,
    `ORDER BY slot_name;`,
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
    // Clock-from-last-replay is apply delay only while the replica is behind.
    // An idle primary sends no new xacts, so that timestamp stays put and
    // `now() - pg_last_xact_replay_timestamp()` would grow without bound
    // even when flushed/replayed WAL already matches the primary's last
    // reported end (`latest_end_lsn`). Caught-up idle replicas report 0. The
    // zero needs a reported end: just after the receiver starts, before the
    // first message, `latest_end_lsn` is NULL and the clock branch applies.
    `  CASE`,
    `    WHEN r.status = 'streaming'`,
    `      AND r.latest_end_lsn IS NOT NULL`,
    `      AND pg_catalog.pg_last_wal_replay_lsn() IS NOT NULL`,
    `      AND pg_catalog.pg_wal_lsn_diff(`,
    `        r.latest_end_lsn,`,
    `        pg_catalog.pg_last_wal_replay_lsn()`,
    `      ) <= 0`,
    `    THEN 0`,
    `    WHEN r.status = 'streaming' AND pg_catalog.pg_last_xact_replay_timestamp() IS NOT NULL`,
    `    THEN GREATEST(EXTRACT(EPOCH FROM (now() - pg_catalog.pg_last_xact_replay_timestamp())), 0)`,
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

/**
 * Undo the demoted fence's persisted `default_transaction_read_only` (an
 * `ALTER SYSTEM` setting in `postgresql.auto.conf` on the data volume) once
 * the member is a primary again. A no-op when it was never set.
 */
export function resetFencedReadOnlyDefaultSql(): string {
  return [
    "ALTER SYSTEM RESET default_transaction_read_only;",
    "SELECT pg_catalog.pg_reload_conf();",
  ].join("\n");
}

export function currentPrimaryConninfoSql(): string {
  return "SELECT pg_catalog.current_setting('primary_conninfo', true);";
}

function conninfoValueNeedsQuotes(value: string): boolean {
  return value.length === 0 || /\s/.test(value) || value.includes("'") ||
    value.includes("\\");
}

export function formatConninfoValue(value: string): string {
  if (!conninfoValueNeedsQuotes(value)) return value;
  return `'${
    value.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`)
  }'`;
}

/** Read a single-quoted conninfo value starting after the opening quote. */
function readQuotedConninfoValue(
  text: string,
  start: number,
): { value: string; next: number } {
  let value = "";
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
    } else if (ch === "'") {
      return { value, next: i + 1 };
    } else {
      value += ch;
      i += 1;
    }
  }
  return { value, next: i };
}

/** Read an unquoted conninfo value up to the next space. */
function readBareConninfoValue(
  text: string,
  start: number,
): { value: string; next: number } {
  let i = start;
  while (i < text.length && text[i] !== " ") i += 1;
  return { value: text.slice(start, i), next: i };
}

function parseConninfoEntries(current: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  let i = 0;
  while (i < current.length) {
    while (i < current.length && current[i] === " ") i += 1;
    const eq = current.indexOf("=", i);
    if (i >= current.length || eq === -1) break;
    const key = current.slice(i, eq);
    const valueStart = eq + 1;
    const read = current[valueStart] === "'"
      ? readQuotedConninfoValue(current, valueStart + 1)
      : readBareConninfoValue(current, valueStart);
    entries.push([key, read.value]);
    i = read.next;
  }
  return entries;
}

/**
 * Replace `host` / `port` (and `hostaddr` when supplied) in a libpq
 * `primary_conninfo` string, leaving user, password, and TLS keys.
 * When the new dial has no `hostaddr`, drop the old key — libpq requires a
 * numeric IP there, never a container name.
 */
export function rewritePrimaryConninfo(
  current: string,
  primary: { host: string; hostaddr?: string; port: number },
): string {
  const entries = parseConninfoEntries(current);
  const byKey = new Map(entries);
  byKey.set("host", primary.host);
  byKey.set("port", String(primary.port));
  if (primary.hostaddr) {
    byKey.set("hostaddr", primary.hostaddr);
  } else {
    byKey.delete("hostaddr");
  }
  // Map keeps first-insertion order: existing keys first, new ones after.
  return [...byKey]
    .map(([key, value]) => `${key}=${formatConninfoValue(value)}`)
    .join(" ");
}

/** Persist a rewritten `primary_conninfo` and restart the WAL receiver. */
export function applyFollowedPrimaryConninfoSql(conninfo: string): string {
  return [
    `ALTER SYSTEM SET primary_conninfo = ${quoteLiteral(conninfo)};`,
    "SELECT pg_catalog.pg_reload_conf();",
    "SELECT pg_catalog.pg_terminate_backend(pid)",
    "  FROM pg_catalog.pg_stat_activity",
    "  WHERE backend_type = 'walreceiver';",
  ].join("\n");
}

export function isInRecoverySql(): string {
  return "SELECT pg_catalog.pg_is_in_recovery();";
}

/** True when this instance is a writable primary (not standby recovery). */
export function isWritablePrimarySql(): string {
  return "SELECT NOT pg_catalog.pg_is_in_recovery();";
}

/**
 * Best-effort quiesce for a fenced former primary still running, as far as
 * Postgres allows against superusers:
 *
 * 1. `ALTER SYSTEM SET default_transaction_read_only = on` + reload, so every
 *    new session (superusers included) starts read-only;
 * 2. then `pg_terminate_backend` every other client backend, so no session
 *    opened before the reload keeps a read-write default (WAL senders are
 *    not client backends and are never touched);
 * 3. this session itself is set read-only.
 *
 * A superuser can still `SET default_transaction_read_only = off` or
 * `SET TRANSACTION READ WRITE` in a new session, or `ALTER SYSTEM` it back:
 * Postgres has no read-only mode a superuser cannot leave. Stopping the
 * container (the guard does, right after this) is the real fence, and
 * `standby.signal` on the volume keeps the next start in recovery. Each
 * statement runs on its own (psql reads stdin, no single transaction), as
 * `ALTER SYSTEM` refuses a transaction block.
 */
export function enforceFencedFormerPrimarySql(): string {
  return [
    "ALTER SYSTEM SET default_transaction_read_only = on;",
    "SELECT pg_catalog.pg_reload_conf();",
    "SELECT pg_catalog.pg_terminate_backend(pid)",
    "  FROM pg_catalog.pg_stat_activity",
    "  WHERE pid <> pg_catalog.pg_backend_pid()",
    "    AND backend_type = 'client backend'",
    "    AND pid NOT IN (",
    "      SELECT active_pid FROM pg_catalog.pg_replication_slots",
    "      WHERE active_pid IS NOT NULL);",
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;",
  ].join("\n");
}

/** Undo demoted-fence SQL and promote after a switchover abort reactivation. */
export function reactivateFormerPrimaryAfterSwitchoverAbortSql(): string {
  return [
    "ALTER SYSTEM RESET default_transaction_read_only;",
    "SELECT pg_catalog.pg_reload_conf();",
    "SELECT pg_catalog.pg_promote(true, 60);",
  ].join("\n");
}

export { MANAGED_SLOT_PREFIX };
