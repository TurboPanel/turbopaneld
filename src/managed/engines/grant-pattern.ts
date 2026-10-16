/**
 * MySQL and MariaDB read a database name in a database-level `GRANT` as a
 * pattern: `_` matches any one character and `%` any run. A grant on `wp_site`
 * written plain therefore also reaches `wpXsite`. The panel grants on exact
 * names, so it writes the name with those characters escaped, and removes the
 * plain (pattern) grant that earlier versions left behind.
 */

/** The name with `\`, `_` and `%` escaped, for use inside a quoted schema. */
export function escapeGrantSchemaPattern(name: string): string {
  return name.replace(/[\\_%]/g, (ch) => `\\${ch}`);
}

/** Whether the plain form of the name would be read as a pattern. */
export function hasGrantWildcard(name: string): boolean {
  return /[_%]/.test(name);
}

import type { ManagedDatabasePrivilege } from "./mysql-sql.ts";

/** Longest schema the grant tables hold. */
const GRANT_SCHEMA_MAX_LENGTH = 64;

/** The quoting helpers of one dialect file (`mysql-sql.ts` / `mariadb-sql.ts`). */
export type GrantQuoting = {
  quoteIdentifier: (value: string) => string;
  quoteLiteral: (value: string) => string;
  accountAt: (username: string, host: string) => string;
};

/** The database name as a schema in a grant: exact, wildcards escaped. */
export function quoteGrantSchema(quoting: GrantQuoting, name: string): string {
  quoting.quoteIdentifier(name); // validates the name
  const escaped = escapeGrantSchemaPattern(name);
  // The grant table keeps a schema in 64 characters; each escape adds one.
  if (escaped.length > GRANT_SCHEMA_MAX_LENGTH) {
    throw new Error(
      `database name too long to grant on once escaped: ${name}`,
    );
  }
  return `\`${escaped}\``;
}

/**
 * Removes the plain (unescaped) database-level grant of one account on one
 * database, only when that exact grant row exists (a `REVOKE` of a grant that
 * is not there is an error). Touches nothing but that row: the escaped grant,
 * grants on other databases and the account itself stay. The caller runs it
 * only after the escaped grant is in place, so the login never loses access.
 */
function revokePlainPatternGrantSql(
  quoting: GrantQuoting,
  database: string,
  username: string,
  host: string,
): string {
  const { quoteLiteral } = quoting;
  const target = `${quoting.quoteIdentifier(database)}.* FROM ${
    quoting.accountAt(username, host)
  }`;
  // `ALL PRIVILEGES, GRANT OPTION` does not parse with an `ON` clause, so the
  // two revokes are separate, and each re-checks that the row is still there
  // (a `REVOKE` of a grant that is gone is an error).
  return [
    `REVOKE ALL PRIVILEGES ON ${target}`,
    `REVOKE GRANT OPTION ON ${target}`,
  ].map((revoke) =>
    [
      `SET @tp_plain_grant = (SELECT COUNT(*) FROM mysql.db WHERE Db = ${
        quoteLiteral(database)
      } AND User = ${quoteLiteral(username)} AND Host = ${
        quoteLiteral(host)
      });`,
      `SET @tp_plain_revoke = IF(@tp_plain_grant > 0, ${
        quoteLiteral(revoke)
      }, 'DO 0');`,
      "PREPARE tp_plain_revoke FROM @tp_plain_revoke;",
      "EXECUTE tp_plain_revoke;",
      "DEALLOCATE PREPARE tp_plain_revoke;",
    ].join("\n")
  ).join("\n");
}

/** The `GRANT` for one privilege level on one database, for one account. */
export function grantOnDatabaseSql(
  quoting: GrantQuoting,
  database: string,
  username: string,
  privilege: ManagedDatabasePrivilege,
  host: string,
): string {
  const db = quoteGrantSchema(quoting, database);
  const account = quoting.accountAt(username, host);
  switch (privilege) {
    case "owner":
      return `GRANT ALL PRIVILEGES ON ${db}.* TO ${account} WITH GRANT OPTION;`;
    case "read-write":
      return (
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, ` +
        `CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, ` +
        `CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER ON ${db}.* TO ${account};`
      );
    case "read-only":
      return `GRANT SELECT, SHOW VIEW ON ${db}.* TO ${account};`;
    default: {
      const _exhaustive: never = privilege;
      throw new Error(`unsupported privilege: ${_exhaustive}`);
    }
  }
}

/** Both grant builders bound to one dialect's quoting and default host. */
export function grantSqlFor(quoting: GrantQuoting, defaultHost: string): {
  grantDatabaseSql: (
    database: string,
    username: string,
    privilege: ManagedDatabasePrivilege,
    host?: string,
  ) => string;
  revokePlainDatabaseGrantSql: (
    database: string,
    username: string,
    host?: string,
  ) => string;
} {
  return {
    grantDatabaseSql: (database, username, privilege, host = defaultHost) =>
      grantOnDatabaseSql(quoting, database, username, privilege, host),
    revokePlainDatabaseGrantSql: (database, username, host = defaultHost) =>
      revokePlainPatternGrantSql(quoting, database, username, host),
  };
}
