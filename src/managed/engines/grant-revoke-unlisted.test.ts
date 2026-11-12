/**
 * A login must lose what it no longer lists. On MySQL and MariaDB a `GRANT`
 * only adds, so the apply reads the login's grant rows and revokes the rest,
 * then ends that login's open connections (only when something was revoked).
 * On Postgres, sessions that lost `CONNECT` are terminated after the revokes.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { parseConnectionIds, revokeUnlistedGrants } from "./grant-databases.ts";
import {
  parseDatabaseGrantRows,
  type StoredGrantRow,
  unlistedGrantRows,
} from "./grant-pattern.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import { listGrantRowsSql, revokeRowsSql } from "./mysql-sql.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";
import { terminateSessionsWithoutConnectSql } from "./postgres-sql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type { ManagedEngineContext, ManagedEngineRuntime } from "./types.ts";

const test = Deno.test.bind(Deno);

const hex = (value: string) =>
  [...new TextEncoder().encode(value)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("").toUpperCase();

function rowsOutput(rows: StoredGrantRow[]): string {
  return rows.map((row) => `${hex(row.host)}\t${hex(row.db)}`).join("\n");
}

const row = (db: string, host = "%"): StoredGrantRow => ({ host, db });

test("the grant rows are read back from hex output", () => {
  const out = rowsOutput([
    row("a"),
    row("wp\\_site", "172.16.0.0/255.240.0.0"),
  ]);
  assertEquals(parseDatabaseGrantRows(`${out}\nnoise line\n`), [
    row("a"),
    row("wp\\_site", "172.16.0.0/255.240.0.0"),
  ]);
  assertStringIncludes(
    listGrantRowsSql("u1"),
    "FROM mysql.db WHERE User = 'u1'",
  );
});

test("All Databases to picks: every row off the pick list is planned for revoke", () => {
  const held = ["a", "b", "c", "d"].map((db) => row(db));
  assertEquals(unlistedGrantRows(held, ["b"]), [row("a"), row("c"), row("d")]);
});

test("picks shrinking: only the dropped database is planned", () => {
  const held = [row("a"), row("b"), row("a", "10.0.0.1")];
  assertEquals(unlistedGrantRows(held, ["b"]), [
    row("a"),
    row("a", "10.0.0.1"),
  ]);
});

test("the switch going off: nothing listed revokes every row, wildcard included", () => {
  const held = [row("a"), row("%"), row("wp\\_site")];
  assertEquals(unlistedGrantRows(held, []), held);
});

test("no change: rows on listed names (escaped or plain) and system schemas are kept", () => {
  const held = [row("a"), row("wp\\_site"), row("wp_site"), row("mysql")];
  assertEquals(unlistedGrantRows(held, ["a", "wp_site"]), []);
});

test("the revoke is guarded, escaped and quoted per stored row and host", () => {
  const sql = revokeRowsSql("u1", [row("wp\\_site", "10.0.0.1"), row("a`b")]);
  assertStringIncludes(
    sql,
    "REVOKE ALL PRIVILEGES ON `wp\\\\_site`.* FROM `u1`@\\'10.0.0.1\\'",
  );
  assertStringIncludes(
    sql,
    "REVOKE GRANT OPTION ON `a``b`.* FROM `u1`@\\'%\\'",
  );
  assertStringIncludes(sql, "FROM mysql.db WHERE Db = 'wp\\\\_site'");
});

test("connection ids are read from the processlist output", () => {
  assertEquals(parseConnectionIds("12\n 7 \nx\n\n"), ["12", "7"]);
});

function harness(rows: StoredGrantRow[], ids: string[]) {
  const ran: string[] = [];
  const done = revokeUnlistedGrants({
    username: "u1",
    listed: ["b"],
    listRowsSql: (u) => `ROWS ${u}`,
    revokeRowsSql: (_u, r) => `REVOKE ${r.map((x) => x.db).join(",")}`,
    listConnectionsSql: (u) => `IDS ${u}`,
    query: (sql) =>
      Promise.resolve(
        sql.startsWith("ROWS") ? rowsOutput(rows) : ids.join("\n"),
      ),
    run: (sql) => {
      ran.push(sql);
      return Promise.resolve();
    },
  });
  return { ran, done };
}

test("a shrunk login is revoked, flushed and its connections killed", async () => {
  const { ran, done } = harness([row("a"), row("b")], ["5", "9"]);
  assertEquals(await done, 1);
  assertEquals(ran, [
    "REVOKE a",
    "FLUSH PRIVILEGES;",
    "KILL CONNECTION 5;",
    "KILL CONNECTION 9;",
  ]);
});

test("an unchanged login runs nothing and loses no connection", async () => {
  const { ran, done } = harness([row("b")], ["5"]);
  assertEquals(await done, 0);
  assertEquals(ran, []);
});

test("a connection that already ended does not fail the apply", async () => {
  const ran: string[] = [];
  const count = await revokeUnlistedGrants({
    username: "u1",
    listed: [],
    listRowsSql: () => "ROWS",
    revokeRowsSql: () => "REVOKE",
    listConnectionsSql: () => "IDS",
    query: (sql) =>
      Promise.resolve(sql === "ROWS" ? rowsOutput([row("a")]) : "5\n6"),
    run: (sql) => {
      ran.push(sql);
      return sql === "KILL CONNECTION 5;"
        ? Promise.reject(new Error("ERROR 1094 (HY000): Unknown thread id: 5"))
        : Promise.resolve();
    },
  });
  assertEquals(count, 1);
  assertEquals(ran.at(-1), "KILL CONNECTION 6;");
});

function creds(
  extra: Partial<ManagedApplyCredential>,
): ManagedApplyCredential[] {
  return [{
    principalId: "p1",
    username: "ro_user",
    role: "user",
    databases: ["b"],
    privileges: ["read-only"],
    password: "pw",
    ...extra,
  }];
}

async function runEngine(
  engine: ManagedEngineRuntime,
  credentials: ManagedApplyCredential[],
): Promise<{ inputs: string[]; queries: string[] }> {
  const inputs: string[] = [];
  const queries: string[] = [];
  const ctx: ManagedEngineContext = {
    containerId: "c1",
    composeServiceName: "svc",
    rootUsername: "root",
    defaultDatabase: "b",
    exec: (argv, input) => {
      if (input !== undefined) inputs.push(input);
      const q = argv.at(-1) ?? "";
      if (argv.includes("-e")) queries.push(q);
      const stdout = q.includes("FROM mysql.db")
        ? rowsOutput([row("a"), row("b")])
        : q.includes("PROCESSLIST")
        ? "41"
        : "";
      return Promise.resolve({ success: true, stdout, stderr: "" });
    },
  };
  await engine.applyCredentials(ctx, credentials);
  return { inputs, queries };
}

for (
  const [name, engine] of [
    ["mysql", mysqlManagedEngineRuntime],
    ["mariadb", mariadbManagedEngineRuntime],
  ] as const
) {
  test(`${name}: a preset login loses its unlisted database and its connections`, async () => {
    const { inputs, queries } = await runEngine(engine, creds({}));
    const all = inputs.join("\n");
    assertStringIncludes(all, "REVOKE ALL PRIVILEGES ON `a`.* FROM `ro_user`");
    assertEquals(
      all.includes("REVOKE ALL PRIVILEGES ON `b`.* FROM `ro_user`@'%'"),
      false,
    );
    assertStringIncludes(all, "KILL CONNECTION 41;");
    assertEquals(queries.some((q) => q.includes("PROCESSLIST")), true);
  });

  test(`${name}: a hand-managed login is never revoked or killed`, async () => {
    const { inputs, queries } = await runEngine(
      engine,
      creds({ grantMode: "self" }),
    );
    assertEquals(inputs.join("\n").includes("KILL"), false);
    assertEquals(queries.some((q) => q.includes("mysql.db")), false);
  });
}

test("postgres: only sessions without CONNECT are ended, after the public revoke", async () => {
  const sql = terminateSessionsWithoutConnectSql();
  assertStringIncludes(sql, "pg_terminate_backend");
  assertStringIncludes(
    sql,
    "NOT pg_catalog.has_database_privilege(a.usesysid, a.datid, 'CONNECT')",
  );
  assertStringIncludes(sql, "a.backend_type = 'client backend'");
  const inputs: string[] = [];
  await postgresManagedEngineRuntime.applyCredentials({
    containerId: "c1",
    composeServiceName: "svc",
    rootUsername: "root",
    defaultDatabase: "b",
    exec: (_argv, input) => {
      inputs.push(input ?? "");
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  }, creds({}));
  const publicIdx = inputs.findIndex((s) => s.includes("FROM PUBLIC"));
  const killIdx = inputs.findIndex((s) => s.includes("pg_terminate_backend"));
  assertEquals(publicIdx >= 0 && killIdx > publicIdx, true);
});
