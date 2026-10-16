import { forEachSequential } from "../../util/sequential.ts";
import type { ManagedDatabasePrivilege } from "./mysql-sql.ts";

function asPrivilege(value: string): ManagedDatabasePrivilege | null {
  // The Database admin login holds `ALL` on its databases with the grant
  // option and nothing global: exactly what `owner` grants here. It never
  // gets CREATE USER, SET_ANY_DEFINER or SET USER (those are global).
  if (value === "admin") return "owner";
  if (value === "owner" || value === "read-write" || value === "read-only") {
    return value;
  }
  return null;
}

/**
 * Grant every recognised privilege on every database, one statement at a
 * time and in order (the first failure stops the run). Each statement is the
 * wildcard-account grant plus one grant per client source host.
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
  run: (sql: string) => Promise<unknown>;
}): Promise<void> {
  const { username, hosts, grantSql, run } = options;
  const steps = options.databases.flatMap((database) =>
    options.privileges.map((raw) => ({ database, raw }))
  );
  return forEachSequential(steps, async ({ database, raw }) => {
    const privilege = asPrivilege(raw);
    if (privilege === null) return;
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
