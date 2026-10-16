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
  /** Database-level privileges only this dialect has: [name, `mysql.db` column]. */
  extraPrivileges?: ReadonlyArray<readonly [string, string]>;
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

/**
 * Every privilege a database-level grant can hold on both engines, with the
 * `mysql.db` column that records it. A level grants its own set, then revokes
 * the rest, so a login made under an older, wider recipe is tightened by its
 * next apply (a `GRANT` alone only ever adds).
 */
const DATABASE_PRIVILEGES: ReadonlyArray<readonly [string, string]> = [
  ["SELECT", "Select_priv"],
  ["INSERT", "Insert_priv"],
  ["UPDATE", "Update_priv"],
  ["DELETE", "Delete_priv"],
  ["CREATE", "Create_priv"],
  ["DROP", "Drop_priv"],
  ["REFERENCES", "References_priv"],
  ["INDEX", "Index_priv"],
  ["ALTER", "Alter_priv"],
  ["CREATE TEMPORARY TABLES", "Create_tmp_table_priv"],
  ["LOCK TABLES", "Lock_tables_priv"],
  ["EXECUTE", "Execute_priv"],
  ["CREATE VIEW", "Create_view_priv"],
  ["SHOW VIEW", "Show_view_priv"],
  ["CREATE ROUTINE", "Create_routine_priv"],
  ["ALTER ROUTINE", "Alter_routine_priv"],
  ["EVENT", "Event_priv"],
  ["TRIGGER", "Trigger_priv"],
];

/**
 * What each level may do inside its one database.
 *
 * - `read-only`: read rows and view definitions. No `EXECUTE`: a stored
 *   routine runs with its definer's rights, so a login allowed to call one
 *   could change data through it.
 * - `read-write`: change rows, and what ordinary app queries need: `EXECUTE`
 *   (call routines the migration login made), `LOCK TABLES` and
 *   `CREATE TEMPORARY TABLES` (private to the session, gone when it ends).
 *   Nothing that creates, changes or drops a table, index, view, routine,
 *   trigger or event.
 * - `owner` (the migration login): everything inside its database, and no
 *   `GRANT OPTION`.
 * - `admin` (the Database admin login): the same, with `GRANT OPTION`.
 */
const LEVEL_PRIVILEGES: Record<
  "read-write" | "read-only",
  readonly string[]
> = {
  "read-only": ["SELECT", "SHOW VIEW"],
  "read-write": [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "EXECUTE",
    "LOCK TABLES",
    "CREATE TEMPORARY TABLES",
    "SHOW VIEW",
  ],
};

/**
 * Revokes, from one account on one database, the privileges in `revoked` that
 * the grant row actually holds (and `GRANT OPTION` when `withGrantOption`).
 * MySQL refuses a `REVOKE` that names a privilege the row lacks (error 1141),
 * so the list is built from `mysql.db` at run time and nothing runs when the
 * row holds none of them: a repeat apply is a no-op. The caller grants first,
 * so the row exists and the login never has less than its level in between.
 */
function revokeExcessSql(
  quoting: GrantQuoting,
  schema: string,
  database: string,
  username: string,
  host: string,
  revoked: ReadonlyArray<readonly [string, string]>,
  withGrantOption: boolean,
): string {
  const { quoteLiteral } = quoting;
  const row = `FROM mysql.db WHERE Db = ${quoteLiteral(schema)} AND User = ${
    quoteLiteral(username)
  } AND Host = ${quoteLiteral(host)}`;
  const tail = ` ON \`${schema}\`.* FROM ${quoting.accountAt(username, host)}`;
  // A trigger or a scheduled event runs with its definer's rights and stops
  // working (a trigger with error 1142 on every write to its table) once the
  // definer has lost TRIGGER or EVENT. So each stays on a login that still
  // defines one in this database; it goes when those are recreated by the
  // migration login.
  const definer = quoteLiteral(username + "@" + host);
  const schemaName = quoteLiteral(database);
  const definedBy: Record<string, string> = {
    Trigger_priv:
      `SELECT 1 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ${schemaName} AND DEFINER = ${definer}`,
    Event_priv:
      `SELECT 1 FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${schemaName} AND DEFINER = ${definer}`,
  };
  const held = (name: string, column: string): string => {
    const lookup = definedBy[column];
    const test = lookup === undefined
      ? `${column} = 'Y'`
      : `${column} = 'Y' AND NOT EXISTS (${lookup})`;
    return `IF(${test}, ${quoteLiteral(name)}, NULL)`;
  };
  const statements: string[] = [];
  const addRevokeStep = (variable: string, list: string, prefix: string) => {
    statements.push(
      `SET @${variable} = (SELECT ${list} ${row});`,
      `SET @${variable}_sql = IF(@${variable} IS NULL OR @${variable} = '', 'DO 0', CONCAT(${
        quoteLiteral(prefix)
      }, @${variable}, ${quoteLiteral(tail)}));`,
      `PREPARE ${variable} FROM @${variable}_sql;`,
      `EXECUTE ${variable};`,
      `DEALLOCATE PREPARE ${variable};`,
    );
  };
  if (revoked.length > 0) {
    addRevokeStep(
      "tp_excess",
      "CONCAT_WS(', ', " + revoked.map(([n, c]) => held(n, c)).join(", ") +
        ")",
      "REVOKE ",
    );
  }
  if (withGrantOption) {
    addRevokeStep(
      "tp_excess_option",
      "IF(Grant_priv = 'Y', 'GRANT OPTION', NULL)",
      "REVOKE ",
    );
  }
  return statements.join("\n");
}

/**
 * The `GRANT` for one privilege level on one database, for one account,
 * followed by the revokes that take back what the level does not hold.
 */
export function grantOnDatabaseSql(
  quoting: GrantQuoting,
  database: string,
  username: string,
  privilege: ManagedDatabasePrivilege,
  host: string,
): string {
  const db = quoteGrantSchema(quoting, database);
  const account = quoting.accountAt(username, host);
  // The name as `mysql.db` stores it: wildcards escaped, no backticks.
  const schema = db.slice(1, -1);
  const revokeFrom = (
    held: readonly string[],
  ) =>
    revokeExcessSql(
      quoting,
      schema,
      database,
      username,
      host,
      [
        ...DATABASE_PRIVILEGES,
        ...(quoting.extraPrivileges ?? []),
      ].filter(([name]) => !held.includes(name)),
      true,
    );
  switch (privilege) {
    case "admin":
      return `GRANT ALL PRIVILEGES ON ${db}.* TO ${account} WITH GRANT OPTION;`;
    case "owner":
      return [
        `GRANT ALL PRIVILEGES ON ${db}.* TO ${account};`,
        revokeExcessSql(quoting, schema, database, username, host, [], true),
      ].join("\n");
    case "read-write":
    case "read-only": {
      const held = LEVEL_PRIVILEGES[privilege];
      return [
        `GRANT ${held.join(", ")} ON ${db}.* TO ${account};`,
        revokeFrom(held),
      ].join("\n");
    }
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
