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
