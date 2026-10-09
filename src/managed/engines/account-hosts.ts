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

export async function dropUserOnEveryHost(
  spec: DropEverywhereSpec,
): Promise<void> {
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
