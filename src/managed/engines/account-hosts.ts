/**
 * Dropping a MySQL-family login on every host it exists for.
 *
 * Per-member accounts (monitor, client, root) exist once per member host
 * address, and those addresses change as members come and go. The hosts are
 * read back from `mysql.user` so none is left behind. MySQL and MariaDB
 * differ only in their client and quoting, which the caller supplies.
 */

export type DropEverywhereSpec = {
  username: string;
  /** Hosts every managed account may have regardless of members. */
  fixedHosts: readonly string[];
  quoteLiteral: (value: string) => string;
  query: (sql: string) => Promise<string>;
  run: (sql: string) => Promise<void>;
  dropAccountSql: (username: string, hosts: string[]) => string;
};

/** Thrown when the login is still the definer of views; carries their names. */
export class LoginOwnsViewsError extends Error {
  constructor(readonly username: string, readonly views: string[]) {
    super(
      `Cannot delete the SQL login "${username}": it is the definer of ${
        views.length === 1 ? "this view" : "these views"
      }: ${
        views.join(", ")
      }. A view whose definer is gone breaks every later ` +
        `backup. Drop the view or recreate it under another login (for ` +
        `example with SQL SECURITY INVOKER or a different DEFINER), then ` +
        `delete the login again.`,
    );
    this.name = "LoginOwnsViewsError";
  }
}

const MAX_NAMED_VIEWS = 10;

/** Refuses when `username` is the DEFINER of any view (MySQL error 1356 later). */
export async function assertNoViewsDefinedBy(
  spec: Pick<DropEverywhereSpec, "username" | "quoteLiteral" | "query">,
): Promise<void> {
  const stdout = await spec.query(
    `SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.VIEWS WHERE ` +
      `SUBSTRING_INDEX(DEFINER, '@', 1) = ${
        spec.quoteLiteral(spec.username)
      } ` +
      `ORDER BY TABLE_SCHEMA, TABLE_NAME;`,
  );
  const views = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").join("."));
  if (views.length === 0) return;
  const shown = views.slice(0, MAX_NAMED_VIEWS);
  if (views.length > shown.length) {
    shown.push(`and ${views.length - shown.length} more`);
  }
  throw new LoginOwnsViewsError(spec.username, shown);
}

export async function dropUserOnEveryHost(
  spec: DropEverywhereSpec,
): Promise<void> {
  await assertNoViewsDefinedBy(spec);
  const stdout = await spec.query(
    `SELECT host FROM mysql.user WHERE user = ${
      spec.quoteLiteral(spec.username)
    };`,
  );
  const existing = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  await spec.run(
    spec.dropAccountSql(spec.username, [...spec.fixedHosts, ...existing]),
  );
}
