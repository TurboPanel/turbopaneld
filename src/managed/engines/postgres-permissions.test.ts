import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  PG_PERMISSION_ROWS_PER_CATEGORY,
  postgresDatabaseAclSql,
  postgresLoginsSql,
  postgresSharedAclSql,
  readPostgresPermissions,
} from "./postgres-permissions.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("login SQL follows inherit_option on 16+ and rolinherit on 15", () => {
  const modern = postgresLoginsSql(["u1"], 180006);
  assertStringIncludes(modern, "m.inherit_option AS inh");
  assertStringIncludes(modern, "m.set_option AS set_opt");
  const old = postgresLoginsSql(["u1"], 150019);
  assertStringIncludes(old, "mr.rolinherit AS inh");
  assertStringIncludes(old, "JOIN pg_roles mr ON mr.oid = m.member");
  assertEquals(old.includes("inherit_option"), false);
  // Read only, names only as quoted literals.
  assertEquals(modern.startsWith("BEGIN READ ONLY;"), true);
  assertStringIncludes(
    postgresLoginsSql(["o'brien"], 180006),
    "ARRAY['o''brien']::text[]",
  );
});

test("ACL SQL filters on the grantee oids and skips system schemas", () => {
  const sql = postgresDatabaseAclSql([0, 16384]);
  assertStringIncludes(sql, "a.grantee = ANY(ARRAY[0, 16384]::oid[])");
  assertStringIncludes(
    sql,
    "n.nspname NOT IN ('pg_catalog', 'information_schema')",
  );
  assertStringIncludes(sql, `LIMIT ${PG_PERMISSION_ROWS_PER_CATEGORY + 1}`);
  assertStringIncludes(sql, "pg_get_function_identity_arguments(p.oid)");
  assertThrows(() => postgresDatabaseAclSql([-1]), Error, "not a number");
  assertThrows(() => postgresDatabaseAclSql([1.5]), Error, "not a number");
  assertEquals(
    postgresSharedAclSql([0], 140000).includes("pg_parameter_acl"),
    false,
  );
  assertStringIncludes(postgresSharedAclSql([0], 150000), "pg_parameter_acl");
});

const U1 = 16390;
const GRP = 16386;
const OUTER = 16387;
const READ_ALL = 6181;

const LOGINS = [
  {
    username: "u1",
    oid: U1,
    attributes: {
      superuser: false,
      createdb: false,
      createrole: false,
      replication: false,
      bypassrls: false,
      canLogin: true,
      inherit: true,
      connectionLimit: 5,
    },
    memberships: [
      {
        role: "grp_rw",
        member: "u1",
        admin: false,
        inherit: true,
        set: false,
        grantor: "postgres",
      },
      {
        role: "grp_outer",
        member: "grp_rw",
        admin: false,
        inherit: true,
        set: true,
        grantor: "postgres",
      },
      {
        role: "pg_read_all_data",
        member: "grp_outer",
        admin: false,
        inherit: true,
        set: true,
        grantor: "postgres",
      },
    ],
    inherits: [
      { oid: GRP, name: "grp_rw" },
      { oid: OUTER, name: "grp_outer" },
      { oid: READ_ALL, name: "pg_read_all_data" },
    ],
  },
  {
    username: "nobody",
    oid: null,
    attributes: null,
    memberships: [],
    inherits: [],
  },
];

function acl(
  g: number,
  p: string[],
  extra: Record<string, unknown> = {},
  gp: string[] = [],
) {
  return { g, by: "app_owner", p, gp, ...extra };
}

const APPDB = {
  db: "appdb",
  database: [
    acl(0, ["TEMPORARY"], { o: "appdb" }),
    acl(GRP, ["CONNECT"], { o: "appdb" }, ["CONNECT"]),
    acl(U1, ["CONNECT", "TEMPORARY"], { o: "appdb" }),
    acl(99999, ["CONNECT"], { o: "appdb" }), // somebody else
  ],
  schemas: [acl(U1, ["CREATE", "USAGE"], { s: "s1" }, ["CREATE", "USAGE"])],
  relations: [
    acl(U1, ["INSERT", "SELECT"], { s: "s1", o: "t1", k: "r" }),
    acl(GRP, ["SELECT"], { s: "s1", o: "v1", k: "v" }),
    acl(U1, ["SELECT", "USAGE"], { s: "s1", o: "seq1", k: "S" }, [
      "SELECT",
      "USAGE",
    ]),
  ],
  columns: [
    acl(U1, ["REFERENCES", "SELECT"], { s: "s1", o: "t1", col: "id", num: 1 }),
    acl(U1, ["SELECT", "UPDATE"], { s: "s1", o: "t1", col: "note", num: 3 }),
    acl(U1, ["REFERENCES", "SELECT"], { s: "s1", o: "t1", col: "ref", num: 4 }),
  ],
  routines: [acl(GRP, ["EXECUTE"], { s: "s1", o: "f1(a integer, b text)" })],
  types: [acl(0, ["USAGE"], { s: "s1", o: "mood" })],
  languages: [acl(U1, ["USAGE"], { o: "sql" })],
  foreign: [acl(GRP, ["USAGE"], { o: "sv1" })],
  largeobjects: [acl(U1, ["SELECT"], { o: "4242" })],
  defaults: [
    acl(U1, ["SELECT"], { cr: "app_owner", s: "s1", k: "r" }),
    acl(GRP, ["EXECUTE"], { cr: "app_owner", s: null, k: "f" }),
  ],
};

const SHARED = {
  tablespaces: [acl(U1, ["CREATE"], { o: "pg_default" })],
  parameters: [acl(U1, ["SET"], { o: "work_mem" })],
};

function fakePsql(perDatabase: Record<string, unknown>) {
  const calls: { database: string; sql: string }[] = [];
  const query = (database: string, sql: string): Promise<string> => {
    calls.push({ database, sql });
    if (sql.includes("server_version_num")) {
      return Promise.resolve('{"num" : 180006, "text" : "18.6"}\n');
    }
    if (sql.includes("WITH RECURSIVE")) {
      return Promise.resolve(JSON.stringify(LOGINS, null, 1));
    }
    if (sql.includes("'tablespaces'")) {
      return Promise.resolve(JSON.stringify(SHARED));
    }
    if (sql.includes("datallowconn")) {
      return Promise.resolve(JSON.stringify(Object.keys(perDatabase)));
    }
    const answer = perDatabase[database];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(JSON.stringify(answer));
  };
  return { calls, query };
}

test("report attributes ACL rows to the login, its inherited roles and PUBLIC", async () => {
  const psql = fakePsql({
    appdb: APPDB,
    dropped: new Error(
      'psql failed: connection to server on socket failed: FATAL:  database "dropped" does not exist',
    ),
    closed: new Error(
      'psql failed: FATAL:  database "closed" is not currently accepting connections',
    ),
    broken: new Error("psql failed: ERROR:  out of shared memory"),
  });
  const report = await readPostgresPermissions(
    {
      logins: ["u1", "nobody"],
      databases: ["appdb", "dropped", "closed", "broken", "missing"],
    },
    "postgres",
    psql.query,
  );
  assertEquals(report.serverVersion, "18.6");
  assertEquals(report.databasesRead, ["appdb"]);
  // A database that fails for another reason is named, never "no grants".
  assertEquals(report.databasesFailed, ["broken"]);
  const [u1, nobody] = report.logins;
  assertEquals(nobody, {
    username: "nobody",
    exists: false,
    memberships: [],
    grants: [],
    defaults: [],
  });
  assertEquals(u1?.attributes?.connectionLimit, 5);
  assertEquals(u1?.memberships, [
    {
      role: "grp_rw",
      inherit: true,
      set: false,
      admin: false,
      grantor: "postgres",
    },
    {
      role: "grp_outer",
      inherit: true,
      set: true,
      admin: false,
      grantor: "postgres",
      via: "grp_rw",
    },
    {
      role: "pg_read_all_data",
      inherit: true,
      set: true,
      admin: false,
      grantor: "postgres",
      via: "grp_outer",
    },
  ]);
  const summary = u1?.grants.map((g) =>
    [
      g.level,
      g.database ?? "-",
      g.schema ?? "-",
      g.object ?? "-",
      g.via ?? "self",
    ]
      .join(" ")
  );
  assertEquals(summary, [
    "tablespace - - pg_default self",
    "parameter - - work_mem self",
    "database appdb - - PUBLIC",
    "database appdb - - grp_rw",
    "database appdb - - self",
    "schema appdb s1 - self",
    "table appdb s1 t1 self",
    "table appdb s1 v1 grp_rw",
    "sequence appdb s1 seq1 self",
    "column appdb s1 t1 self",
    "column appdb s1 t1 self",
    "routine appdb s1 f1(a integer, b text) grp_rw",
    "type appdb s1 mood PUBLIC",
    "language appdb - sql self",
    "foreign appdb - sv1 grp_rw",
    "largeobject appdb - 4242 self",
  ]);
  // Columns of one table with the same privileges share one item.
  const columns = u1?.grants.filter((g) => g.level === "column");
  assertEquals(columns?.map((g) => [g.columns, g.privileges]), [
    [["id", "ref"], ["REFERENCES", "SELECT"]],
    [["note"], ["SELECT", "UPDATE"]],
  ]);
  const sequence = u1?.grants.find((g) => g.level === "sequence");
  assertEquals(sequence?.grantable, ["SELECT", "USAGE"]);
  assertEquals(sequence?.grantor, "app_owner");
  assertEquals(u1?.defaults, [
    {
      database: "appdb",
      creator: "app_owner",
      objectType: "r",
      privileges: ["SELECT"],
      schema: "s1",
    },
    {
      database: "appdb",
      creator: "app_owner",
      objectType: "f",
      privileges: ["EXECUTE"],
      via: "grp_rw",
    },
  ]);
  assertEquals(u1?.truncated, true);
  // The per-database query ran in the database itself, for every grantee.
  const perDb = psql.calls.find((c) => c.database === "appdb");
  assertStringIncludes(
    perDb?.sql ?? "",
    `ARRAY[${U1}, ${GRP}, ${OUTER}, ${READ_ALL}, 0]::oid[]`,
  );
});

test("a category over the row limit marks the logins truncated", async () => {
  const many = Array.from(
    { length: PG_PERMISSION_ROWS_PER_CATEGORY + 1 },
    (_, i) => acl(U1, ["SELECT"], { s: "s1", o: `t${i}`, k: "r" }),
  );
  const psql = fakePsql({ appdb: { ...APPDB, relations: many } });
  const report = await readPostgresPermissions(
    { logins: ["u1"], databases: ["appdb"] },
    "postgres",
    psql.query,
  );
  assertEquals(report.logins[0]?.truncated, true);
});

test("no existing login skips every ACL read", async () => {
  const psql = fakePsql({ appdb: APPDB });
  const report = await readPostgresPermissions(
    { logins: ["nobody"], databases: ["appdb"] },
    "postgres",
    psql.query,
  );
  assertEquals(report.databasesRead, []);
  assertEquals(psql.calls.length, 2);
});

test("names that fail the identifier check are refused before any SQL", async () => {
  const psql = fakePsql({});
  await assertRejects(
    () =>
      readPostgresPermissions(
        { logins: ["u1"], databases: ["host=elsewhere"] },
        "postgres",
        psql.query,
      ),
    Error,
    "not a valid Postgres name",
  );
  await assertRejects(
    () =>
      readPostgresPermissions(
        { logins: ["bad name"], databases: [] },
        "postgres",
        psql.query,
      ),
    Error,
    "not a valid Postgres name",
  );
  assertEquals(psql.calls, []);
});

test("unreadable psql output is an error, not an empty report", async () => {
  await assertRejects(
    () =>
      readPostgresPermissions(
        { logins: ["u1"], databases: [] },
        "postgres",
        () => Promise.resolve("not json"),
      ),
    Error,
    "unreadable version",
  );
});

test("the runtime runs each script through psql on stdin, read only", async () => {
  const { postgresManagedEngineRuntime } = await import("./postgres.ts");
  const calls: { argv: string[]; input?: string }[] = [];
  const ctx = {
    containerId: "c1",
    composeServiceName: "db",
    rootUsername: "postgres",
    defaultDatabase: "postgres",
    exec: (argv: string[], input?: string) => {
      calls.push({ argv, input });
      if (input?.includes("server_version_num")) {
        return Promise.resolve({
          success: true,
          stdout: '{"num" : 170002, "text" : "17.2"}',
          stderr: "",
        });
      }
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "psql: error: connection refused",
      });
    },
  };
  await assertRejects(
    () =>
      postgresManagedEngineRuntime.readPermissions!(ctx, {
        logins: ["u1"],
        databases: [],
      }),
    Error,
    "psql failed: psql: error: connection refused",
  );
  assertEquals(calls[0]?.argv, [
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-t",
    "-A",
    "-X",
    "-q",
  ]);
  assertEquals(
    calls.every((call) => call.input?.startsWith("BEGIN READ ONLY;")),
    true,
  );
});

test("the time budget stops before the next database and names the rest", async () => {
  let ms = 0;
  const psql = fakePsql({
    appdb: APPDB,
    second: { ...APPDB, db: "second" },
    third: { ...APPDB, db: "third" },
  });
  const query = (database: string, sql: string) => {
    ms += 4000; // every query takes 4 s on this fake clock
    return psql.query(database, sql);
  };
  const report = await readPostgresPermissions(
    { logins: ["u1"], databases: ["appdb", "second", "third"] },
    "postgres",
    query,
    { now: () => ms, budgetMs: 10_000 },
  );
  // Version and logins use 8 s; 2 s left is no room for a 3 s query, so the
  // shared ACLs, the database list and every database are left unread.
  assertEquals(report.databasesRead, []);
  assertEquals(report.databasesFailed, ["appdb", "second", "third"]);
  assertEquals(report.logins[0]?.truncated, true);
  assertEquals(psql.calls.length, 2);

  ms = 0;
  const roomy = await readPostgresPermissions(
    { logins: ["u1"], databases: ["appdb", "second", "third"] },
    "postgres",
    query,
    { now: () => ms, budgetMs: 21_000 },
  );
  // 16 s through the list, appdb starts with 5 s left, second with 1 s.
  assertEquals(roomy.databasesRead, ["appdb"]);
  assertEquals(roomy.databasesFailed, ["second", "third"]);
});

test("only the database's own name means it is gone", async () => {
  const psql = fakePsql({
    appdb: APPDB,
    other: new Error(
      'psql failed: ERROR:  cross-database reference: database "appdb" does not exist',
    ),
  });
  const report = await readPostgresPermissions(
    { logins: ["u1"], databases: ["appdb", "other"] },
    "postgres",
    psql.query,
  );
  assertEquals(report.databasesRead, ["appdb"]);
  assertEquals(report.databasesFailed, ["other"]);
});

test("a database read killed by the budget is failed, not gone", async () => {
  const { PermissionsBudgetError } = await import("./types.ts");
  const psql = fakePsql({ appdb: new PermissionsBudgetError() });
  const report = await readPostgresPermissions(
    { logins: ["u1"], databases: ["appdb"] },
    "postgres",
    psql.query,
  );
  assertEquals(report.databasesFailed, ["appdb"]);
  assertEquals(report.logins[0]?.truncated, true);
});

test("a clean read of every database is not truncated", async () => {
  const report = await readPostgresPermissions(
    { logins: ["u1"], databases: ["appdb"] },
    "postgres",
    fakePsql({ appdb: APPDB }).query,
  );
  assertEquals(report.databasesFailed, undefined);
  assertEquals(report.logins[0]?.truncated, undefined);
});
