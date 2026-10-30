import { forEachSequential } from "../../util/sequential.ts";
import { hasGrantWildcard } from "./grant-pattern.ts";
import type { ManagedDatabasePrivilege } from "./mysql-sql.ts";

function asPrivilege(value: string): ManagedDatabasePrivilege | null {
  // The Database admin login holds `ALL` on its databases with the grant
  // option and nothing global. It never gets CREATE USER, SET_ANY_DEFINER or
  // SET USER (those are global). The migration login (`owner`) has the same
  // rights without the grant option.
  if (
    value === "admin" || value === "owner" || value === "read-write" ||
    value === "read-only"
  ) {
    return value;
  }
  return null;
}

const LEVEL_RANK: Record<ManagedDatabasePrivilege, number> = {
  "read-only": 0,
  "read-write": 1,
  owner: 2,
  admin: 3,
};

/**
 * The one level a login holds on each database: the strongest it lists. Each
 * level grants its own set and revokes the rest, so two levels written in a
 * row would undo each other.
 */
function strongestPrivilege(
  privileges: readonly string[],
): ManagedDatabasePrivilege | null {
  let best: ManagedDatabasePrivilege | null = null;
  for (const value of privileges) {
    const level = asPrivilege(value);
    if (level && (best === null || LEVEL_RANK[level] > LEVEL_RANK[best])) {
      best = level;
    }
  }
  return best;
}

/**
 * Grant the strongest recognised level on every database, one statement at a
 * time and in order (the first failure stops the run). Each statement is the
 * wildcard-account grant plus one grant per client source host.
 *
 * `revokePlainSql` (optional) removes the plain-name pattern grant older
 * versions wrote for a name holding `_` or `%`. It runs for such a database
 * only after every grant on it succeeded, once per account host, so the login
 * is never without access; a database with no recognised privilege is left
 * alone. Callers pass only databases the panel owns the grants of.
 */
export function grantDatabasePrivileges(options: {
  databases: readonly string[];
  privileges: readonly string[];
  username: string;
  hosts: readonly string[];
  grantSql: (
    database: string,
    username: string,
    privilege: ManagedDatabasePrivilege,
    host?: string,
  ) => string;
  revokePlainSql?: (
    database: string,
    username: string,
    host?: string,
  ) => string;
  run: (sql: string) => Promise<unknown>;
}): Promise<void> {
  const { username, hosts, grantSql, revokePlainSql, run } = options;
  const strongest = strongestPrivilege(options.privileges);
  const known = strongest === null ? [] : [strongest];
  const steps = options.databases.flatMap((database) => [
    ...known.map((privilege) => ({ database, privilege })),
    ...(known.length > 0 && revokePlainSql && hasGrantWildcard(database)
      ? [{ database, privilege: null }]
      : []),
  ]);
  return forEachSequential(steps, async ({ database, privilege }) => {
    if (privilege === null) {
      await run(
        [undefined, ...hosts]
          .map((host) => revokePlainSql!(database, username, host))
          .join("\n"),
      );
      return;
    }
    await run(
      [
        grantSql(database, username, privilege),
        ...hosts.map((host) => grantSql(database, username, privilege, host)),
      ].join("\n"),
    );
  });
}

/**
 * Databases the panel writes grants for. A login the site owner manages by
 * hand gets none, except the Database admin login: its rights are what makes
 * it the admin, so the panel keeps them whatever the mode says.
 */
export function grantableDatabases(credential: {
  databases: readonly string[];
  privileges?: readonly string[];
  grantMode?: string;
}): readonly string[] {
  if (credential.grantMode !== "self") return credential.databases;
  return (credential.privileges ?? []).includes("admin")
    ? credential.databases
    : [];
}

/** The cluster's backup login: an ordinary `user` credential sent with `kind: "backup"`. */
export function isBackupCredential(credential: {
  role: string;
  kind?: string;
}): boolean {
  return credential.role === "user" && credential.kind === "backup";
}

/**
 * The backup login's rights on MySQL and MariaDB: the dialect's backup set on
 * every listed database, then (MySQL) its global rights, each for the
 * wildcard account and every client source host, one statement per step in
 * order. `privileges` and `grantMode` play no part: the rights are fixed.
 */
export function grantBackupPrivileges(options: {
  databases: readonly string[];
  username: string;
  hosts: readonly string[];
  grantSql: (database: string, username: string, host?: string) => string;
  globalSql?: (username: string, host?: string) => string;
  run: (sql: string) => Promise<unknown>;
}): Promise<void> {
  const { username, hosts, grantSql, globalSql, run } = options;
  const forEveryHost = (build: (host?: string) => string) =>
    [build(), ...hosts.map((host) => build(host))].join("\n");
  const steps = [...new Set(options.databases)].map((database) =>
    forEveryHost((host) => grantSql(database, username, host))
  );
  if (globalSql) steps.push(forEveryHost((host) => globalSql(username, host)));
  return forEachSequential(steps, (sql) => run(sql));
}
