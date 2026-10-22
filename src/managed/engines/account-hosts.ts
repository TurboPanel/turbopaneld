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

/**
 * Things that name a login as their DEFINER: views, triggers, routines and
 * events. Once the login is gone they stop working, and a view with a missing
 * definer breaks every later backup (error 1356).
 */
export function definerObjectsSql(
  usernames: readonly string[],
  quoteLiteral: (value: string) => string,
): string {
  const list = usernames.map((name) => quoteLiteral(name)).join(", ");
  const owner = "SUBSTRING_INDEX(DEFINER, '@', 1)";
  const pick = (kind: string, schema: string, name: string, table: string) =>
    `SELECT ${owner} AS u, '${kind}' AS k, ${schema} AS s, ${name} AS n ` +
    `FROM information_schema.${table} WHERE ${owner} IN (${list})`;
  return [
    pick("view", "TABLE_SCHEMA", "TABLE_NAME", "VIEWS"),
    pick("trigger", "TRIGGER_SCHEMA", "TRIGGER_NAME", "TRIGGERS"),
    pick("routine", "ROUTINE_SCHEMA", "ROUTINE_NAME", "ROUTINES"),
    pick("event", "EVENT_SCHEMA", "EVENT_NAME", "EVENTS"),
  ].join(" UNION ALL ") + " ORDER BY 1, 2, 3, 4;";
}

const MAX_NAMED_OBJECTS = 10;

/** Group the rows of {@link definerObjectsSql} by login: `view shop.orders_v`. */
export function parseDefinerObjects(stdout: string): Map<string, string[]> {
  const byLogin = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const [user, kind, schema, name] = line.trim().split("\t");
    if (!user || !kind || !schema || !name) continue;
    const list = byLogin.get(user) ?? [];
    list.push(`${kind} ${schema}.${name}`);
    byLogin.set(user, list);
  }
  return byLogin;
}

/** The first few names, with a count of the rest, for an error or a report. */
export function capDefinerObjects(objects: readonly string[]): string[] {
  const shown = objects.slice(0, MAX_NAMED_OBJECTS);
  if (objects.length > shown.length) {
    shown.push(`and ${objects.length - shown.length} more`);
  }
  return shown;
}

/** Thrown when the login is still the definer of views, triggers, routines or events. */
export class LoginOwnsObjectsError extends Error {
  constructor(readonly username: string, readonly objects: string[]) {
    super(
      `The SQL login "${username}" still owns views, routines, triggers or events (${
        objects.map((object) => `'${object}'`).join(", ")
      }). Move or drop them first, then delete the login.`,
    );
    this.name = "LoginOwnsObjectsError";
  }
}

/** Refuses when `username` is the DEFINER of any view, trigger, routine or event. */
export async function assertNoObjectsDefinedBy(
  spec: Pick<DropEverywhereSpec, "username" | "quoteLiteral" | "query">,
): Promise<void> {
  const found = parseDefinerObjects(
    await spec.query(definerObjectsSql([spec.username], spec.quoteLiteral)),
  ).get(spec.username);
  if (found && found.length > 0) {
    throw new LoginOwnsObjectsError(spec.username, capDefinerObjects(found));
  }
}

export async function dropUserOnEveryHost(
  spec: DropEverywhereSpec,
): Promise<void> {
  await assertNoObjectsDefinedBy(spec);
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
