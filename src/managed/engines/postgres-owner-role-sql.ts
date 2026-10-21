/**
 * Pure Postgres SQL builders for databases that use an owner role.
 *
 * A database made with `ownerRole` gets three roles that cannot log in:
 *
 * - `tp_<db>_owner` owns the database and everything created in it,
 * - `tp_<db>_rw` may read and write what the owner role creates,
 * - `tp_<db>_ro` may only read it.
 *
 * Default privileges are set once, for objects the owner role creates, so a
 * table made by a migrations login (which works as the owner role) is usable
 * by the read-write and read-only logins at once. The roles are the panel's:
 * the `tp_` prefix is reserved, so no login can collide with them.
 *
 * Nothing here converts an existing database or reassigns ownership.
 */

import {
  closePublicSchemaSql,
  quoteIdentifier,
  quoteLiteral,
} from "./postgres-sql.ts";

/** What a login can be on an owner-role database. */
export type OwnerRoleLoginLevel =
  | "owner"
  | "read-write"
  | "read-only"
  | "admin";

export type OwnerRoleNames = { owner: string; rw: string; ro: string };

/** Postgres cuts identifiers at 63 bytes; `tp_` + name + `_owner` must fit. */
export const OWNER_ROLE_MAX_DATABASE_NAME = 54;

/** The three role names for a database; throws when they would not fit. */
export function ownerRoleNames(database: string): OwnerRoleNames {
  const names = {
    owner: `tp_${database}_owner`,
    rw: `tp_${database}_rw`,
    ro: `tp_${database}_ro`,
  };
  for (const name of Object.values(names)) quoteIdentifier(name);
  return names;
}

/** Existence/owner probe: one row with the owner's role name, or none. */
export function databaseOwnerSql(name: string): string {
  return `SELECT r.rolname FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid = d.datdba WHERE d.datname = ${
    quoteLiteral(name)
  };`;
}

/**
 * Of the named databases, those that really belong to their owner role (the
 * database exists and its owner is `tp_<name>_owner`). Tuples-only friendly.
 */
export function ownerRoleDatabasesAmongSql(
  names: readonly string[],
  ownerLogins: Readonly<Record<string, string>> = {},
  platformRoles: readonly string[] = [],
): string {
  const list = names.map((name) => quoteLiteral(name)).join(", ");
  // A database whose owner is a login the customer chose is still the
  // panel's: only that exact login, recorded for that exact database, counts.
  const chosen = Object.entries(ownerLogins)
    .filter(([database]) => names.includes(database))
    .map(([database, login]) =>
      `(${quoteLiteral(database)}, ${quoteLiteral(login)})`
    );
  // A database that has its owner role and is owned by a login is the
  // panel's whichever login that is, so an apply that leaves the choice out
  // can never send it down the path for ordinary databases.
  const notPlatform = [
    "'postgres'",
    ...platformRoles.map((r) => quoteLiteral(r)),
  ]
    .join(", ");
  const byLogin =
    `(EXISTS (SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname = 'tp_' || d.datname || '_owner') AND r.rolname NOT IN (${notPlatform}))`;
  const owner = chosen.length === 0
    ? `(r.rolname = 'tp_' || d.datname || '_owner' OR ${byLogin})`
    : `(r.rolname = 'tp_' || d.datname || '_owner' OR (d.datname, r.rolname) IN (${
      chosen.join(", ")
    }) OR ${byLogin})`;
  return [
    `SELECT d.datname FROM pg_catalog.pg_database d`,
    `JOIN pg_catalog.pg_roles r ON r.oid = d.datdba`,
    `WHERE d.datname IN (${list})`,
    `AND ${owner}`,
    `ORDER BY d.datname;`,
  ].join(" ");
}

/**
 * Run connected to the database: one row, `t` when it holds nothing a person
 * made (no tables, views, sequences, extra schemas, functions, types or
 * extensions beyond the engine's own). Only such a database is ever handed to
 * its owner role or chosen owner from the platform admin that initdb made it
 * for.
 */
export function databaseIsEmptySql(): string {
  const userSchema =
    `n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`;
  return [
    `SELECT (NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c`,
    `JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${userSchema})`,
    `AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE ${userSchema}`,
    `AND n.nspname <> 'public')`,
    `AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p`,
    `JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE p.oid >= 16384 AND ${userSchema})`,
    `AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type t WHERE t.oid >= 16384`,
    `AND t.typtype IN ('e', 'd', 'r', 'm'))`,
    `AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname <> 'plpgsql')`,
    `AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata)`,
    `AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication)`,
    `AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger)`,
    `AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_foreign_server))::text;`,
  ].join(" ");
}

/** Hand the database to `owner`; a no-op when it already belongs to it. */
export function moveDatabaseOwnerSql(database: string, owner: string): string {
  return [
    `DO $turbopanel$`,
    `BEGIN`,
    `  IF (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = ${
      quoteLiteral(database)
    }) IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${
      quoteLiteral(owner)
    }) THEN`,
    `    ALTER DATABASE ${quoteIdentifier(database)} OWNER TO ${
      quoteIdentifier(owner)
    };`,
    `  END IF;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/**
 * Run before a login is dropped: every database the login owns that has an
 * owner role goes back to that owner role, so dropping the login never hands
 * a database to the platform admin.
 */
export function ownerLoginReturnSql(login: string): string {
  return [
    `DO $turbopanel$`,
    `DECLARE r record;`,
    `BEGIN`,
    `  FOR r IN SELECT d.datname FROM pg_catalog.pg_database d`,
    `           JOIN pg_catalog.pg_roles w ON w.oid = d.datdba`,
    `           WHERE w.rolname = ${quoteLiteral(login)}`,
    `           AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname = 'tp_' || d.datname || '_owner') LOOP`,
    `    EXECUTE pg_catalog.format('ALTER DATABASE %I OWNER TO %I', r.datname, 'tp_' || r.datname || '_owner');`,
    `  END LOOP;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/** Create the three NOLOGIN roles when missing. Safe to repeat. */
export function ensureOwnerRolesSql(database: string): string {
  const names = ownerRoleNames(database);
  const lines = [`DO $turbopanel$`, `BEGIN`];
  for (const name of [names.owner, names.rw, names.ro]) {
    lines.push(
      `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${
        quoteLiteral(name)
      }) THEN`,
      `    CREATE ROLE ${
        quoteIdentifier(name)
      } NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
      `  END IF;`,
    );
  }
  lines.push(`END`, `$turbopanel$;`);
  return lines.join("\n");
}

/**
 * Remove the three roles after the database is gone. A role that cannot be
 * dropped (something still depends on it) is left in place; dropping a
 * database must never fail on this.
 */
export function dropOwnerRolesSql(database: string): string {
  const names = ownerRoleNames(database);
  const lines = [`DO $turbopanel$`, `BEGIN`];
  for (const name of [names.rw, names.ro, names.owner]) {
    lines.push(
      `  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${
        quoteLiteral(name)
      }) THEN`,
      `    BEGIN`,
      `      DROP ROLE ${quoteIdentifier(name)};`,
      `    EXCEPTION WHEN OTHERS THEN`,
      `      RAISE NOTICE 'role % left in place: %', ${
        quoteLiteral(name)
      }, SQLERRM;`,
      `    END;`,
      `  END IF;`,
    );
  }
  lines.push(`END`, `$turbopanel$;`);
  return lines.join("\n");
}

/** Read-write group: data changes only. TRUNCATE and REFERENCES stay with the owner role. */
const WRITER_TABLE_LIST = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const WRITER_REVOKED_LIST = ["TRUNCATE", "REFERENCES"] as const;
const WRITER_REVOKED = WRITER_REVOKED_LIST.join(", ");
const WRITER_SEQUENCE_LIST = ["USAGE", "SELECT", "UPDATE"] as const;
const WRITER_TABLE = WRITER_TABLE_LIST.join(", ");
const WRITER_SEQUENCE = WRITER_SEQUENCE_LIST.join(", ");

/** `has_*_privilege` is true for ANY listed privilege, so test each one. */
function holdsAllSql(
  fn: "has_table_privilege" | "has_sequence_privilege",
  role: string,
  privileges: readonly string[],
): string {
  return privileges
    .map((p) => `pg_catalog.${fn}(${quoteLiteral(role)}, c.oid, '${p}')`)
    .join(" AND ");
}

/** SQL expression: role name of the connected database's owner. */
export const DATABASE_OWNER_SQL =
  "(SELECT r.rolname FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid = d.datdba WHERE d.datname = pg_catalog.current_database())";

/**
 * Hand objects the platform admin (or another platform creator) owns in the
 * connected database to the database's owner role. A restore replays the dump
 * with `--no-owner`, so everything it creates belongs to the admin running it;
 * the owner role (and so a migrations login working as it) would then be
 * refused on its own tables. Run again on every apply it also repairs
 * databases restored by an earlier release.
 *
 * `ownerSql` is a SQL expression for the new owner's role name and `fromSql`
 * one for a text[] of the roles to take objects from; nothing is moved when
 * the owner is one of those roles. Schemas, tables, views, materialized views,
 * foreign tables, standalone sequences, routines and types are covered; the
 * rest (indexes, owned sequences, table row types) follow their table, and
 * objects an extension owns stay with the extension.
 */
export function handOverPlatformObjectsSql(
  ownerSql: string,
  fromSql: string,
): string {
  const user = `n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`;
  const mine = (owner: string) =>
    `pg_catalog.pg_get_userbyid(${owner}) = ANY (f)`;
  const notExtension = (classId: string, oid: string) =>
    `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = '${classId}'::pg_catalog.regclass AND d.objid = ${oid} AND d.deptype = 'e')`;
  return [
    `DO $tp_handover$`,
    `DECLARE o text := ${ownerSql}; f text[] := ${fromSql}; r record;`,
    `BEGIN`,
    `  IF o IS NULL OR o = ANY (f) THEN RETURN; END IF;`,
    `  FOR r IN SELECT n.nspname AS obj FROM pg_catalog.pg_namespace n`,
    `           WHERE ${user} AND ${mine("n.nspowner")}`,
    `           AND ${notExtension("pg_namespace", "n.oid")} LOOP`,
    `    EXECUTE pg_catalog.format('ALTER SCHEMA %I OWNER TO %I', r.obj, o);`,
    `  END LOOP;`,
    `  FOR r IN SELECT c.oid::pg_catalog.regclass::text AS obj, c.relkind AS kind`,
    `           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    `           WHERE ${user} AND ${mine("c.relowner")}`,
    `           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c')`,
    `           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_class'::pg_catalog.regclass`,
    `                           AND d.objid = c.oid AND (d.deptype = 'e' OR (c.relkind = 'S' AND d.deptype IN ('a', 'i')))) LOOP`,
    `    EXECUTE pg_catalog.format(CASE r.kind WHEN 'S' THEN 'ALTER SEQUENCE %s OWNER TO %I' WHEN 'c' THEN 'ALTER TYPE %s OWNER TO %I' ELSE 'ALTER TABLE %s OWNER TO %I' END, r.obj, o);`,
    `  END LOOP;`,
    `  FOR r IN SELECT p.oid::pg_catalog.regprocedure::text AS obj FROM pg_catalog.pg_proc p`,
    `           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace`,
    `           WHERE ${user} AND ${mine("p.proowner")} AND ${
      notExtension("pg_proc", "p.oid")
    } LOOP`,
    `    EXECUTE pg_catalog.format('ALTER ROUTINE %s OWNER TO %I', r.obj, o);`,
    `  END LOOP;`,
    `  FOR r IN SELECT t.oid::pg_catalog.regtype::text AS obj, t.typtype AS kind FROM pg_catalog.pg_type t`,
    `           JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace`,
    `           WHERE ${user} AND ${
      mine("t.typowner")
    } AND t.typtype IN ('e', 'd', 'r')`,
    `           AND ${notExtension("pg_type", "t.oid")} LOOP`,
    `    EXECUTE pg_catalog.format(CASE r.kind WHEN 'd' THEN 'ALTER DOMAIN %s OWNER TO %I' ELSE 'ALTER TYPE %s OWNER TO %I' END, r.obj, o);`,
    `  END LOOP;`,
    `END`,
    `$tp_handover$;`,
  ].join("\n");
}

/** Grant the groups what they miss on objects that already exist. */
function healExistingObjectsSql(names: OwnerRoleNames): string {
  const rwLit = quoteLiteral(names.rw);
  const roLit = quoteLiteral(names.ro);
  const rw = quoteIdentifier(names.rw);
  const ro = quoteIdentifier(names.ro);
  const tableOk = `${
    holdsAllSql("has_table_privilege", names.rw, WRITER_TABLE_LIST)
  } AND ${holdsAllSql("has_table_privilege", names.ro, ["SELECT"])}`;
  const sequenceOk = `${
    holdsAllSql("has_sequence_privilege", names.rw, WRITER_SEQUENCE_LIST)
  } AND ${holdsAllSql("has_sequence_privilege", names.ro, ["SELECT"])}`;
  return [
    `DO $turbopanel$`,
    `DECLARE r record;`,
    `BEGIN`,
    `  FOR r IN SELECT n.nspname AS name FROM pg_catalog.pg_namespace n`,
    `           WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`,
    `           AND NOT (pg_catalog.has_schema_privilege(${rwLit}, n.oid, 'USAGE')`,
    `                    AND pg_catalog.has_schema_privilege(${roLit}, n.oid, 'USAGE')) LOOP`,
    `    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO ${rw}, ${ro}', r.name);`,
    `  END LOOP;`,
    `  FOR r IN SELECT c.oid::pg_catalog.regclass::text AS obj`,
    `           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    `           WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`,
    `           AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT (${tableOk}) LOOP`,
    `    EXECUTE pg_catalog.format('GRANT ${WRITER_TABLE} ON TABLE %s TO ${rw}', r.obj);`,
    `    EXECUTE pg_catalog.format('GRANT SELECT ON TABLE %s TO ${ro}', r.obj);`,
    `  END LOOP;`,
    `  FOR r IN SELECT c.oid::pg_catalog.regclass::text AS obj`,
    `           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    `           WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`,
    `           AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (${
      WRITER_REVOKED_LIST.map((p) =>
        `pg_catalog.has_table_privilege(${rwLit}, c.oid, '${p}')`
      ).join(" OR ")
    }) LOOP`,
    `    EXECUTE pg_catalog.format('REVOKE ${WRITER_REVOKED} ON TABLE %s FROM ${rw}', r.obj);`,
    `  END LOOP;`,
    `  FOR r IN SELECT c.oid::pg_catalog.regclass::text AS obj`,
    `           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    `           WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`,
    `           AND c.relkind = 'S' AND NOT (${sequenceOk}) LOOP`,
    `    EXECUTE pg_catalog.format('GRANT ${WRITER_SEQUENCE} ON SEQUENCE %s TO ${rw}', r.obj);`,
    `    EXECUTE pg_catalog.format('GRANT SELECT ON SEQUENCE %s TO ${ro}', r.obj);`,
    `  END LOOP;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

/**
 * Everything inside the database itself; run connected to it (default
 * privileges and schema rights live in each database's own catalog).
 *
 * - The owner role keeps USAGE and CREATE on `public`; the groups get USAGE.
 *   `public` stays closed to everyone else (Postgres 15 and later already
 *   close it; the revoke only writes while PUBLIC still holds CREATE).
 * - Default privileges for objects the owner role creates, and for the
 *   platform admin and the exposed root login (restores run as them), give
 *   the read-write group data access and the read-only group SELECT.
 * - Objects that already exist are brought in line, writing only what is
 *   missing.
 */
export function ownerRoleDatabaseSql(
  database: string,
  platformCreators: readonly string[],
  ownerLogin?: string,
): string {
  const names = ownerRoleNames(database);
  const owner = quoteIdentifier(names.owner);
  const rw = quoteIdentifier(names.rw);
  const ro = quoteIdentifier(names.ro);
  const creators = [
    ...new Set([
      names.owner,
      ...(ownerLogin === undefined ? [] : [ownerLogin]),
      ...platformCreators,
    ]),
  ];
  const lines = [
    closePublicSchemaSql(),
    `GRANT USAGE, CREATE ON SCHEMA public TO ${owner};`,
    `GRANT USAGE ON SCHEMA public TO ${rw}, ${ro};`,
  ];
  for (const creator of creators) {
    const from = `ALTER DEFAULT PRIVILEGES FOR ROLE ${
      quoteIdentifier(creator)
    }`;
    lines.push(
      // Wipe an earlier default that carried TRUNCATE and REFERENCES.
      `${from} REVOKE ${WRITER_REVOKED} ON TABLES FROM ${rw};`,
      `${from} GRANT ${WRITER_TABLE} ON TABLES TO ${rw};`,
      `${from} GRANT ${WRITER_SEQUENCE} ON SEQUENCES TO ${rw};`,
      `${from} GRANT USAGE ON SCHEMAS TO ${rw};`,
      `${from} GRANT SELECT ON TABLES TO ${ro};`,
      `${from} GRANT SELECT ON SEQUENCES TO ${ro};`,
      `${from} GRANT USAGE ON SCHEMAS TO ${ro};`,
    );
  }
  lines.push(
    handOverPlatformObjectsSql(
      DATABASE_OWNER_SQL,
      `ARRAY[${
        platformCreators.map((c) => quoteLiteral(c)).join(", ")
      }]::text[]`,
    ),
    healExistingObjectsSql(names),
  );
  return lines.join("\n");
}

/** Boolean SQL: this login is a member of this role (any grantor). */
function isMemberSql(role: string, login: string): string {
  return `EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${
    quoteLiteral(role)
  }) AND m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${
    quoteLiteral(login)
  })`;
}

/**
 * Membership of `login` in `role`, or its absence.
 *
 * On Postgres 16 and later the options are exact (`INHERIT`, `SET`). On 15 a
 * membership has no options: the grant is plain, and a login that must not
 * carry the role's rights during normal traffic gets the role-wide NOINHERIT
 * attribute instead (documented as the fallback for older clusters). The
 * Postgres 16 grant is dynamic SQL so the block still parses on 15.
 */
function membershipSql(
  role: string,
  login: string,
  want: { inherit: boolean; set: boolean } | null,
): string {
  const r = quoteIdentifier(role);
  const l = quoteIdentifier(login);
  const member = isMemberSql(role, login);
  if (want === null) {
    return [
      `DO $turbopanel$`,
      `BEGIN`,
      `  IF ${member}) THEN`,
      `    REVOKE ${r} FROM ${l};`,
      `  END IF;`,
      `END`,
      `$turbopanel$;`,
    ].join("\n");
  }
  const inherit = want.inherit ? "TRUE" : "FALSE";
  const set = want.set ? "TRUE" : "FALSE";
  return [
    `DO $turbopanel$`,
    `BEGIN`,
    `  IF pg_catalog.current_setting('server_version_num')::int >= 160000 THEN`,
    `    IF NOT ${member} AND m.inherit_option = ${inherit} AND m.set_option = ${set}) THEN`,
    `      EXECUTE 'GRANT ${r} TO ${l} WITH INHERIT ${inherit}, SET ${set}';`,
    `    END IF;`,
    `  ELSE`,
    `    IF NOT ${member}) THEN`,
    `      GRANT ${r} TO ${l};`,
    `    END IF;`,
    // Role-wide on 15: keep the attribute in step with the wanted level.
    `    IF ${
      want.inherit ? "NOT " : ""
    }(SELECT rolinherit FROM pg_catalog.pg_roles WHERE rolname = ${
      quoteLiteral(login)
    }) THEN`,
    `      ALTER ROLE ${l} ${want.inherit ? "INHERIT" : "NOINHERIT"};`,
    `    END IF;`,
    `  END IF;`,
    `END`,
    `$turbopanel$;`,
  ].join("\n");
}

function ownerMembershipFor(
  level: OwnerRoleLoginLevel | null,
): { inherit: boolean; set: boolean } | null {
  if (level === "owner") return { inherit: false, set: true };
  if (level === "admin") return { inherit: true, set: true };
  return null;
}

/**
 * What one login is on one owner-role database, as SQL (`level` null = it is
 * not on this database, so every membership and the session default go).
 *
 * - owner (the migrations login): member of the owner role with `INHERIT
 *   FALSE, SET TRUE`, plus the session default `role = owner role` for this
 *   database, so a session from any tool creates tables as the owner role.
 * - read-write / read-only: member of the matching group, rights inherited.
 * - admin (the Database admin login): member of the owner role with `INHERIT
 *   TRUE, SET TRUE`: it holds the owner role's rights directly, so it can
 *   grant on everything the owner role owns. It has no other rights. It also
 *   works as the owner role by session default, so tables made from a tool
 *   belong to the owner role and the other logins can use them at once.
 *
 * Without the session default, a login that stops being a migrations login
 * could not connect any more ("permission denied to set role"), so every
 * other level resets it.
 */
export function ownerRoleLoginSql(
  database: string,
  login: string,
  level: OwnerRoleLoginLevel | null,
): string {
  const names = ownerRoleNames(database);
  const db = quoteIdentifier(database);
  const l = quoteIdentifier(login);
  const asOwner = level === "owner" || level === "admin";
  const sessionRole = asOwner
    ? `ALTER ROLE ${l} IN DATABASE ${db} SET role = ${
      quoteLiteral(names.owner)
    };`
    : `ALTER ROLE ${l} IN DATABASE ${db} RESET role;`;
  const ownerMembership = ownerMembershipFor(level);
  const memberships = [
    membershipSql(names.owner, login, ownerMembership),
    membershipSql(
      names.rw,
      login,
      level === "read-write" ? { inherit: true, set: false } : null,
    ),
    membershipSql(
      names.ro,
      login,
      level === "read-only" ? { inherit: true, set: false } : null,
    ),
  ];
  // The session default needs the membership to exist (grant first); a login
  // losing the role must lose the default first, or it cannot connect.
  const lines = asOwner
    ? [...memberships, sessionRole]
    : [sessionRole, ...memberships];
  return lines.join("\n");
}

/**
 * The Database admin login is a tool login: it may not hold any attribute
 * that reaches beyond the databases it is listed on.
 */
export function databaseAdminAttributesSql(login: string): string {
  return `ALTER ROLE ${
    quoteIdentifier(login)
  } NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`;
}
