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

/** The quoting helpers of one dialect file (`mysql-sql.ts` / `mariadb-sql.ts`). */
export type GrantQuoting = {
  quoteIdentifier: (value: string) => string;
  quoteLiteral: (value: string) => string;
  accountAt: (username: string, host: string) => string;
};

/** The database name as a schema in a grant: exact, wildcards escaped. */
export function quoteGrantSchema(quoting: GrantQuoting, name: string): string {
  quoting.quoteIdentifier(name); // validates the name
  return `\`${escapeGrantSchemaPattern(name)}\``;
}

/**
 * Removes the plain (unescaped) database-level grant of one account on one
 * database, only when that exact grant row exists (a `REVOKE` of a grant that
 * is not there is an error). Touches nothing but that row: the escaped grant,
 * grants on other databases and the account itself stay. The caller runs it
 * only after the escaped grant is in place, so the login never loses access.
 */
export function revokePlainPatternGrantSql(
  quoting: GrantQuoting,
  database: string,
  username: string,
  host: string,
): string {
  const { quoteLiteral } = quoting;
  const revoke = `REVOKE ALL PRIVILEGES, GRANT OPTION ON ${
    quoting.quoteIdentifier(database)
  }.* FROM ${quoting.accountAt(username, host)}`;
  return [
    `SET @tp_plain_grant = (SELECT COUNT(*) FROM mysql.db WHERE Db = ${
      quoteLiteral(database)
    } AND User = ${quoteLiteral(username)} AND Host = ${quoteLiteral(host)});`,
    `SET @tp_plain_revoke = IF(@tp_plain_grant > 0, ${
      quoteLiteral(revoke)
    }, 'DO 0');`,
    "PREPARE tp_plain_revoke FROM @tp_plain_revoke;",
    "EXECUTE tp_plain_revoke;",
    "DEALLOCATE PREPARE tp_plain_revoke;",
  ].join("\n");
}
