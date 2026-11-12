import { forEachSequential } from "../../util/sequential.ts";
import {
  hasGrantWildcard,
  parseDatabaseGrantRows,
  type StoredGrantRow,
  unlistedGrantRows,
} from "./grant-pattern.ts";
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
 * Whether the panel owns this login's database grants: every login but one the
 * site owner manages by hand (the Database admin login is always the panel's).
 */
export function panelManagesGrants(credential: {
  privileges?: readonly string[];
  grantMode?: string;
}): boolean {
  return credential.grantMode !== "self" ||
    (credential.privileges ?? []).includes("admin");
}

/** Connection ids from the batch output of the processlist query. */
export function parseConnectionIds(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) =>
    /^\d+$/.test(line)
  );
}

const FLUSH_SQL = "FLUSH PRIVILEGES;";

function isUnknownThread(err: unknown): boolean {
  return err instanceof Error &&
    /unknown thread id|\b1094\b/i.test(err.message);
}

/**
 * Take back what a login no longer lists, after the grants it keeps are in
 * place. A `GRANT` only adds, so a database taken off the login, a switch from
 * All Databases to picks, or a wildcard row would otherwise stay for good.
 * Reads the login's grant rows, revokes every row on an unlisted schema and,
 * only when it revoked something, flushes and ends that login's open
 * connections: a session keeps the rights of its current database until it
 * runs `USE`, and the shared proxy's pooled backend connections are such
 * sessions. A login whose access did not shrink loses no connection. Returns
 * how many rows it revoked.
 */
export async function revokeUnlistedGrants(options: {
  username: string;
  listed: readonly string[];
  listRowsSql: (username: string) => string;
  revokeRowsSql: (username: string, rows: readonly StoredGrantRow[]) => string;
  listConnectionsSql: (username: string) => string;
  query: (sql: string) => Promise<string>;
  run: (sql: string) => Promise<unknown>;
}): Promise<number> {
  const { username, run, query } = options;
  const rows = unlistedGrantRows(
    parseDatabaseGrantRows(await query(options.listRowsSql(username))),
    options.listed,
  );
  if (rows.length === 0) return 0;
  await run(options.revokeRowsSql(username, rows));
  await run(FLUSH_SQL);
  const ids = parseConnectionIds(
    await query(options.listConnectionsSql(username)),
  );
  await forEachSequential(ids, async (id) => {
    try {
      await run(`KILL CONNECTION ${id};`);
    } catch (err) {
      // The session ended by itself between the read and the kill.
      if (!isUnknownThread(err)) throw err;
    }
  });
  return rows.length;
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
 * The backup login's rights on MySQL and MariaDB: the dialect's read and dump
 * set at global level, for the wildcard account and every client source host,
 * in one statement batch. Global, not per database, so a database made with
 * plain SQL is covered too; the credential's `databases`, `privileges` and
 * `grantMode` play no part. Database-level grants an older daemon wrote are a
 * subset of it and stay.
 */
export function grantBackupPrivileges(options: {
  username: string;
  hosts: readonly string[];
  grantSql: (username: string, host?: string) => string;
  run: (sql: string) => Promise<unknown>;
}): Promise<unknown> {
  const { username, hosts, grantSql, run } = options;
  return run(
    [grantSql(username), ...hosts.map((host) => grantSql(username, host))]
      .join("\n"),
  );
}
