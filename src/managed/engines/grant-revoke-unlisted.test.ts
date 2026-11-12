/**
 * A login must lose what it no longer lists. On MySQL and MariaDB a `GRANT`
 * only adds, so the apply reads the login's grant rows and revokes the rest,
 * then ends that login's open connections (only when something was revoked).
 * On Postgres, sessions that lost `CONNECT` are terminated after the revokes.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { parseConnectionIds, revokeUnlistedGrants } from "./grant-databases.ts";
import {
  parseDatabaseGrantRows,
  type StoredGrantRow,
  unlistedGrantRows,
} from "./grant-pattern.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import { listConnectionsSql as mariadbListConnectionsSql } from "./mariadb-sql.ts";
import {
  listConnectionsSql,
  listGrantRowsSql,
  revokeRowsSql,
} from "./mysql-sql.ts";
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

function harness(
  held: StoredGrantRow[],
  ids: string[],
  sessionEnds?: Parameters<typeof revokeUnlistedGrants>[0]["sessionEnds"],
  failQuery?: string,
) {
  const ran: string[] = [];
  let rows = held;
  const done = () =>
    revokeUnlistedGrants({
      username: "u1",
      listed: ["b"],
      listRowsSql: (u) => `ROWS ${u}`,
      revokeRowsSql: (_u, r) => `REVOKE ${r.map((x) => x.db).join(",")}`,
      listConnectionsSql: (u) => `IDS ${u}`,
      sessionEnds,
      query: (sql) => {
        if (failQuery !== undefined && sql.startsWith(failQuery)) {
          return Promise.reject(new Error("processlist read failed"));
        }
        return Promise.resolve(
          sql.startsWith("ROWS") ? rowsOutput(rows) : ids.join("\n"),
        );
      },
      run: (sql) => {
        ran.push(sql);
        if (sql.startsWith("REVOKE")) rows = rows.filter((r) => r.db === "b");
        return Promise.resolve();
      },
    });
  return { ran, done };
}

test("a shrunk login is revoked, flushed and its connections killed", async () => {
  const { ran, done } = harness([row("a"), row("b")], ["5", "9"]);
  assertEquals(await done(), 1);
  assertEquals(ran, [
    "REVOKE a",
    "FLUSH PRIVILEGES;",
    "KILL CONNECTION 5;",
    "KILL CONNECTION 9;",
  ]);
});

test("an unchanged login runs nothing and loses no connection", async () => {
  const { ran, done } = harness([row("b")], ["5"]);
  assertEquals(await done(), 0);
  assertEquals(ran, []);
});

test("a row that is still there after the revoke fails the apply and kills nothing", async () => {
  const ran: string[] = [];
  await assertRejects(
    () =>
      revokeUnlistedGrants({
        username: "u1",
        listed: [],
        listRowsSql: () => "ROWS",
        revokeRowsSql: () => "REVOKE",
        listConnectionsSql: () => "IDS",
        query: () => Promise.resolve(rowsOutput([row("caf\u00e9")])),
        run: (sql) => {
          ran.push(sql);
          return Promise.resolve();
        },
      }),
    Error,
    "could not be revoked",
  );
  assertEquals(ran, ["REVOKE"]);
});

function memoryMarker(initial: string[] = []) {
  const names = new Set(initial);
  return {
    names,
    pending: () => Promise.resolve([...names]),
    add: (u: string) => {
      names.add(u);
      return Promise.resolve();
    },
    done: (u: string) => {
      names.delete(u);
      return Promise.resolve();
    },
  };
}

test("a failure after the revoke is finished by the next apply", async () => {
  const marker = memoryMarker();
  const first = harness([row("a"), row("b")], ["5"], marker, "IDS");
  await assertRejects(() => first.done(), Error, "processlist read failed");
  assertEquals([...marker.names], ["u1"]);
  // The next apply finds no row left to revoke, but the marker is still set.
  const second = harness([row("b")], ["5"], marker);
  assertEquals(await second.done(), 0);
  assertEquals(second.ran, ["FLUSH PRIVILEGES;", "KILL CONNECTION 5;"]);
  assertEquals([...marker.names], []);
  // And once cleared a further apply does nothing.
  const third = harness([row("b")], ["5"], marker);
  await third.done();
  assertEquals(third.ran, []);
});

test("an unrevokable row leaves no record, so later applies kill nothing", async () => {
  const marker = memoryMarker();
  const stuck = [row("caf\u00e9")];
  const apply = () => {
    const ran: string[] = [];
    const done = revokeUnlistedGrants({
      username: "u1",
      listed: [],
      listRowsSql: () => "ROWS",
      revokeRowsSql: () => "REVOKE",
      listConnectionsSql: () => "IDS",
      sessionEnds: marker,
      query: (sql) => Promise.resolve(sql === "ROWS" ? rowsOutput(stuck) : "5"),
      run: (sql) => {
        ran.push(sql);
        return Promise.resolve();
      },
    });
    return { ran, done };
  };
  for (let i = 0; i < 2; i++) {
    const { ran, done } = apply();
    await assertRejects(() => done, Error, "could not be revoked");
    assertEquals(ran, ["REVOKE"]);
    assertEquals([...marker.names], []);
  }
});

test("a login whose access did not shrink is never recorded", async () => {
  const marker = memoryMarker();
  await harness([row("b")], ["5"], marker).done();
  assertEquals([...marker.names], []);
});

test("a non-ASCII schema name is revoked as utf8mb4", () => {
  const out = rowsOutput([row("caf\u00e9"), row("b")]);
  const rows = unlistedGrantRows(parseDatabaseGrantRows(out), ["b"]);
  assertEquals(rows, [row("caf\u00e9")]);
  const sql = revokeRowsSql("u1", rows);
  assertEquals(sql.startsWith("SET NAMES utf8mb4;\n"), true);
  assertStringIncludes(sql, "REVOKE ALL PRIVILEGES ON `caf\u00e9`.*");
  assertStringIncludes(sql, "WHERE Db = 'caf\u00e9'");
});

test("a name with a control character is left out of the plan", () => {
  const out = `${hex("a")}\t${hex("x\u0001y")}\n${hex("%")}\t${hex("ok")}`;
  assertEquals(parseDatabaseGrantRows(out), [{ host: "%", db: "ok" }]);
});

test("each dialect reads its own processlist table", () => {
  assertStringIncludes(
    listConnectionsSql("u1"),
    "FROM performance_schema.processlist WHERE USER = 'u1'",
  );
  assertStringIncludes(
    mariadbListConnectionsSql("u1"),
    "FROM information_schema.PROCESSLIST WHERE USER = 'u1'",
  );
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
  let revoked = false;
  const ctx: ManagedEngineContext = {
    containerId: "c1",
    composeServiceName: "svc",
    rootUsername: "root",
    defaultDatabase: "b",
    exec: (argv, input) => {
      if (input !== undefined) inputs.push(input);
      if (input?.includes("REVOKE ALL PRIVILEGES ON `a`")) revoked = true;
      const q = argv.at(-1) ?? "";
      if (argv.includes("-e")) queries.push(q);
      const stdout = q.includes("FROM mysql.db")
        ? rowsOutput(revoked ? [row("b")] : [row("a"), row("b")])
        : /processlist/i.test(q)
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
    assertEquals(queries.some((q) => /processlist/i.test(q)), true);
  });

  test(`${name}: a failed kill is finished by the next apply through applyCredentials`, async () => {
    const names = new Set<string>();
    const sessionEnds = {
      pending: () => Promise.resolve([...names]),
      add: (u: string) => {
        names.add(u);
        return Promise.resolve();
      },
      done: (u: string) => {
        names.delete(u);
        return Promise.resolve();
      },
    };
    let revoked = false;
    let failProcesslist = true;
    const kills: string[] = [];
    const ctx: ManagedEngineContext = {
      containerId: "c1",
      composeServiceName: "svc",
      rootUsername: "root",
      defaultDatabase: "b",
      sessionEnds,
      exec: (argv, input) => {
        if (input?.includes("REVOKE ALL PRIVILEGES ON `a`")) revoked = true;
        if (input?.includes("KILL CONNECTION")) kills.push(input);
        const q = argv.at(-1) ?? "";
        if (argv.includes("-e") && /processlist/i.test(q)) {
          if (failProcesslist) {
            return Promise.resolve({
              success: false,
              stdout: "",
              stderr: "boom",
            });
          }
          return Promise.resolve({ success: true, stdout: "41", stderr: "" });
        }
        const stdout = argv.includes("-e") && q.includes("FROM mysql.db")
          ? rowsOutput(revoked ? [row("b")] : [row("a"), row("b")])
          : "";
        return Promise.resolve({ success: true, stdout, stderr: "" });
      },
    };
    await assertRejects(() => engine.applyCredentials(ctx, creds({})), Error);
    assertEquals([...names], ["ro_user"]);
    failProcesslist = false;
    await engine.applyCredentials(ctx, creds({}));
    assertEquals(kills.length, 1);
    assertEquals([...names], []);
    await engine.applyCredentials(ctx, creds({}));
    assertEquals(kills.length, 1);
  });

  test(`${name}: root and backup logins are untouched end to end`, async () => {
    const { inputs, queries } = await runEngine(engine, [
      {
        principalId: "p-root",
        username: "rootlogin",
        role: "root",
        databases: [],
        password: "pw",
      },
      {
        principalId: "p-backup",
        username: "backup_login",
        role: "user",
        kind: "backup",
        databases: [],
        privileges: [],
        password: "pw",
      },
    ]);
    assertEquals(inputs.join("\n").includes("KILL"), false);
    assertEquals(inputs.join("\n").includes("REVOKE ALL PRIVILEGES ON"), false);
    assertEquals(queries.some((q) => q.includes("mysql.db")), false);
    assertEquals(queries.some((q) => /processlist/i.test(q)), false);
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

test("postgres: only sessions without CONNECT are ended, after every other statement", async () => {
  const sql = terminateSessionsWithoutConnectSql();
  assertStringIncludes(sql, "pg_terminate_backend");
  assertStringIncludes(
    sql,
    "NOT pg_catalog.has_database_privilege(a.usesysid, a.datid, 'CONNECT')",
  );
  assertStringIncludes(sql, "a.backend_type = 'client backend'");
  const inputs: string[] = [];
  await postgresManagedEngineRuntime.applyCredentials(
    {
      containerId: "c1",
      composeServiceName: "svc",
      rootUsername: "root",
      defaultDatabase: "b",
      exec: (_argv, input) => {
        inputs.push(input ?? "");
        // The probe for owner-role databases answers: `b` is one.
        const stdout = (input ?? "").startsWith("SELECT d.datname")
          ? "b\n"
          : "";
        return Promise.resolve({ success: true, stdout, stderr: "" });
      },
    },
    creds({}),
    { ownerRoleDatabases: ["b"] },
  );
  const publicIdx = inputs.findIndex((s) => s.includes("FROM PUBLIC"));
  const ownerIdx = inputs.findLastIndex((s) => s.includes("_owner"));
  const killIdx = inputs.findIndex((s) => s.includes("pg_terminate_backend"));
  assertEquals(ownerIdx > publicIdx && publicIdx >= 0, true);
  assertEquals(killIdx, inputs.length - 1);
  assertEquals(killIdx > ownerIdx, true);
});
