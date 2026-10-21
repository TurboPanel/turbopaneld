import { assertEquals, assertRejects } from "@std/assert";
import {
  accountsSql,
  grantsFromStatement,
  parseAccountRows,
  parseShowGrantsLine,
  readMysqlFamilyPermissions,
  showGrantsBatchSql,
  splitShowGrantsBatch,
  statementLimitSql,
  unescapeBatchField,
  unescapeWildcards,
} from "./mysql-permissions.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function grantsOf(line: string, host = "%") {
  const statement = parseShowGrantsLine(line);
  if (statement?.kind !== "privileges") {
    throw new TypeError(`not a privilege grant: ${line}`);
  }
  return grantsFromStatement(statement, { host });
}

test("ALL PRIVILEGES is kept as written, with an escaped database name", () => {
  assertEquals(
    grantsOf(
      String.raw`GRANT ALL PRIVILEGES ON ` + "`app\\_db2`.*" +
        " TO `u1`@`%` WITH GRANT OPTION",
    ),
    [{
      host: "%",
      level: "database",
      database: "app_db2",
      privileges: ["ALL PRIVILEGES", "GRANT OPTION"],
      grantable: ["ALL PRIVILEGES"],
    }],
  );
});

test("a percent wildcard escape is undone at database level", () => {
  assertEquals(
    grantsOf("GRANT SELECT ON `shop\\%x`.* TO `u1`@`%`")[0]?.database,
    "shop%x",
  );
});

test("column lists keep their commas and share an item per column set", () => {
  assertEquals(
    grantsOf(
      "GRANT SELECT (`id`, `note`), UPDATE (`note`), DELETE, INSERT (`id`, `note`) ON `appdb`.`t1` TO `u1`@`%`",
    ),
    [
      {
        host: "%",
        database: "appdb",
        object: "t1",
        level: "table",
        privileges: ["DELETE"],
      },
      {
        host: "%",
        database: "appdb",
        object: "t1",
        level: "column",
        columns: ["id", "note"],
        privileges: ["SELECT", "INSERT"],
      },
      {
        host: "%",
        database: "appdb",
        object: "t1",
        level: "column",
        columns: ["note"],
        privileges: ["UPDATE"],
      },
    ],
  );
});

test("MariaDB's bare column names parse too", () => {
  assertEquals(
    grantsOf("GRANT SELECT (note, id) ON `appdb`.`t1` TO `u1`@`%`")[0]?.columns,
    ["note", "id"],
  );
});

test("doubled backticks in a table name are undone", () => {
  assertEquals(
    grantsOf("GRANT SELECT ON `appdb`.`we``ird` TO `u1`@`%`")[0]?.object,
    "we`ird",
  );
});

test("dynamic and multi-word privileges at global level", () => {
  assertEquals(
    grantsOf(
      "GRANT APPLICATION_PASSWORD_ADMIN,AUDIT_ABORT_EXEMPT,SYSTEM_VARIABLES_ADMIN ON *.* TO `u1`@`%`",
    )[0]?.privileges,
    [
      "APPLICATION_PASSWORD_ADMIN",
      "AUDIT_ABORT_EXEMPT",
      "SYSTEM_VARIABLES_ADMIN",
    ],
  );
  assertEquals(
    grantsOf(
      "GRANT PROCESS, BINLOG ADMIN, CREATE TEMPORARY TABLES, SHOW CREATE ROUTINE ON *.* TO `u1`@`%`",
    )[0],
    {
      host: "%",
      level: "global",
      privileges: [
        "PROCESS",
        "BINLOG ADMIN",
        "CREATE TEMPORARY TABLES",
        "SHOW CREATE ROUTINE",
      ],
    },
  );
});

test("procedure, function and package scopes are routines", () => {
  assertEquals(
    grantsOf("GRANT EXECUTE ON PROCEDURE `appdb`.`p1` TO `u1`@`%`")[0],
    {
      host: "%",
      level: "routine",
      database: "appdb",
      object: "p1",
      privileges: ["EXECUTE"],
    },
  );
  assertEquals(
    grantsOf(
      "GRANT EXECUTE, ALTER ROUTINE ON FUNCTION `appdb`.`f1` TO `u1`@`%`",
    )[0]?.privileges,
    ["EXECUTE", "ALTER ROUTINE"],
  );
  assertEquals(
    grantsOf("GRANT EXECUTE ON PACKAGE BODY `appdb`.`pk` TO `u1`@`%`")[0]
      ?.object,
    "pk",
  );
  assertEquals(
    grantsOf("GRANT EXECUTE ON PACKAGE `appdb`.`pk` TO `u1`@`%`")[0]?.level,
    "routine",
  );
});

test("PROXY is a global privilege, with its grant option", () => {
  assertEquals(grantsOf("GRANT PROXY ON `u2`@`%` TO `u1`@`%`"), [{
    host: "%",
    level: "global",
    privileges: ["PROXY"],
  }]);
  assertEquals(
    grantsOf("GRANT PROXY ON ''@'' TO 'root'@'localhost' WITH GRANT OPTION")[0],
    {
      host: "%",
      level: "global",
      privileges: ["PROXY", "GRANT OPTION"],
      grantable: ["PROXY"],
    },
  );
});

test("role grants are memberships, MySQL with a host and MariaDB without", () => {
  assertEquals(
    parseShowGrantsLine(
      "GRANT `r_read`@`%`,`r2`@`localhost` TO `u1`@`%` WITH ADMIN OPTION",
    ),
    {
      kind: "roles",
      grantee: { name: "u1", host: "%" },
      roles: [{ name: "r_read", host: "%" }, { name: "r2", host: "localhost" }],
      admin: true,
    },
  );
  assertEquals(parseShowGrantsLine("GRANT `r_outer` TO `r_read`"), {
    kind: "roles",
    grantee: { name: "r_read" },
    roles: [{ name: "r_outer" }],
    admin: false,
  });
});

test("nothing after TO is kept: MariaDB password hash, REQUIRE and limits", () => {
  const line =
    "GRANT USAGE ON *.* TO `u2`@`%` IDENTIFIED BY PASSWORD '*p1' REQUIRE SSL WITH MAX_QUERIES_PER_HOUR 10";
  const statement = parseShowGrantsLine(line);
  assertEquals(JSON.stringify(statement).includes("p1"), false);
  assertEquals(grantsOf(line), [{
    host: "%",
    level: "global",
    privileges: ["USAGE"],
  }]);
  // A grant option after the password text is still seen.
  assertEquals(
    grantsOf(
      "GRANT SELECT ON *.* TO `u2`@`%` IDENTIFIED BY PASSWORD '*p1' WITH GRANT OPTION",
    )[0]?.grantable,
    ["SELECT"],
  );
});

test("a quoted name containing TO or ON does not confuse the parser", () => {
  assertEquals(
    grantsOf("GRANT SELECT ON `a TO b`.`x ON y` TO `u1`@`%`")[0],
    {
      host: "%",
      level: "table",
      database: "a TO b",
      object: "x ON y",
      privileges: ["SELECT"],
    },
  );
});

test("REVOKE lines, default-role lines and junk are not grants", () => {
  assertEquals(
    parseShowGrantsLine("REVOKE INSERT ON `mysql`.* FROM `u1`@`%`"),
    null,
  );
  assertEquals(
    parseShowGrantsLine("SET DEFAULT ROLE `r1` FOR `u1`@`%`"),
    null,
  );
  assertEquals(parseShowGrantsLine("GRANT ON *.* TO `u1`@`%`"), null);
  assertEquals(parseShowGrantsLine("GRANT SELECT ON nonsense TO x"), null);
  assertEquals(parseShowGrantsLine(""), null);
});

test("account rows map the lock flag per host", () => {
  const rows = parseAccountRows("u1\t%\tN\nu1\tlocalhost\tY\nu2\t%\t\n");
  assertEquals(rows.get("u1"), [
    { host: "%", locked: false },
    { host: "localhost", locked: true },
  ]);
  assertEquals(rows.get("u2"), [{ host: "%" }]);
});

test("account SQL quotes names as literals and leaves MariaDB roles out", () => {
  assertEquals(
    accountsSql("mysql", ["u1", "u2"]),
    "SELECT User, Host, account_locked FROM mysql.user WHERE User IN ('u1', 'u2') ORDER BY User, Host;",
  );
  const maria = accountsSql("mariadb", ["u1"]);
  assertEquals(maria.includes("mysql.global_priv"), true);
  assertEquals(maria.includes("is_role"), true);
});

test("batch output splits back per account", () => {
  const sql = showGrantsBatchSql(["`u1`@'%'", "`u1`@'localhost'"]);
  assertEquals(
    sql,
    "SELECT 'tp-permissions-account 0'; SHOW GRANTS FOR `u1`@'%';\n" +
      "SELECT 'tp-permissions-account 1'; SHOW GRANTS FOR `u1`@'localhost';",
  );
  assertEquals(
    splitShowGrantsBatch(
      "tp-permissions-account 0\nGRANT A\nGRANT B\ntp-permissions-account 1\nGRANT C\n",
      2,
    ),
    [["GRANT A", "GRANT B"], ["GRANT C"]],
  );
});

/** A fake engine: answers by SQL text, records what it was asked. */
function fakeEngine(grants: Record<string, string[]>, accounts: string) {
  const asked: string[] = [];
  const query = (script: string): Promise<string> => {
    // Every script opens with the per-statement limit.
    const [limit, ...rest] = script.split("\n");
    if (!limit?.startsWith("SET SESSION max_")) {
      return Promise.reject(new Error(`no statement limit: ${script}`));
    }
    const sql = rest.join("\n");
    asked.push(sql);
    if (sql === "SELECT VERSION();") return Promise.resolve("11.8.9-MariaDB\n");
    if (sql.includes("FROM mysql.")) return Promise.resolve(accounts);
    const out: string[] = [];
    for (const part of sql.split("\n")) {
      const match =
        /^SELECT '(tp-permissions-account \d+)'; SHOW GRANTS FOR (.+);$/
          .exec(part);
      if (!match) return Promise.reject(new Error(`unexpected SQL ${part}`));
      const lines = grants[match[2]!];
      if (!lines) return Promise.reject(new Error("There is no such grant"));
      out.push(match[1]!, ...lines);
    }
    return Promise.resolve(out.join("\n") + "\n");
  };
  return { asked, query };
}

test("MariaDB report: accounts, roles of roles, and only the role's own lines", async () => {
  const engine = fakeEngine({
    "`u1`@'%'": [
      "GRANT `r_read` TO `u1`@`%` WITH ADMIN OPTION",
      "GRANT USAGE ON *.* TO `u1`@`%` IDENTIFIED BY PASSWORD '*p1'",
      "GRANT SELECT ON `appdb`.* TO `u1`@`%`",
    ],
    "`u1`@'localhost'": [
      "GRANT BINLOG MONITOR ON *.* TO `u1`@`localhost` IDENTIFIED BY PASSWORD '*p1'",
    ],
    // MariaDB prints the held role's grants under the role it was asked for.
    "`r_read`": [
      "GRANT `r_outer` TO `r_read`",
      "GRANT USAGE ON *.* TO `r_read`",
      "GRANT SELECT ON `appdb`.* TO `r_read`",
      "GRANT USAGE ON *.* TO `r_outer`",
      "GRANT SHOW VIEW ON `appdb`.* TO `r_outer`",
    ],
    "`r_outer`": [
      "GRANT USAGE ON *.* TO `r_outer`",
      "GRANT SHOW VIEW ON `appdb`.* TO `r_outer`",
    ],
  }, "u1\t%\tN\nu1\tlocalhost\tY\n");
  const report = await readMysqlFamilyPermissions(
    "mariadb",
    { logins: ["u1", "gone"], databases: ["ignored"] },
    engine.query,
  );
  assertEquals(report.serverVersion, "11.8.9-MariaDB");
  assertEquals(JSON.stringify(report).includes("p1"), false);
  const [u1, gone] = report.logins;
  assertEquals(gone, {
    username: "gone",
    exists: false,
    memberships: [],
    grants: [],
    defaults: [],
  });
  assertEquals(u1?.accounts, [
    { host: "%", locked: false },
    { host: "localhost", locked: true },
  ]);
  assertEquals(u1?.memberships, [
    { role: "r_read", admin: true, host: "%" },
    { role: "r_outer", host: "%", via: "r_read" },
  ]);
  assertEquals(
    u1?.grants.map((g) => [g.host, g.via, g.level, g.privileges.join("+")]),
    [
      ["%", undefined, "global", "USAGE"],
      ["%", undefined, "database", "SELECT"],
      ["%", "r_read", "global", "USAGE"],
      ["%", "r_read", "database", "SELECT"],
      ["%", "r_outer", "global", "USAGE"],
      ["%", "r_outer", "database", "SHOW VIEW"],
      ["localhost", undefined, "global", "BINLOG MONITOR"],
    ],
  );
});

test("MySQL roles carry a host and an account read alone after a failed batch", async () => {
  const engine = fakeEngine({
    "`u1`@'%'": [
      "GRANT USAGE ON *.* TO `u1`@`%`",
      "GRANT `r1`@`%` TO `u1`@`%`",
    ],
    "`r1`@'%'": ["GRANT SELECT ON `appdb`.* TO `r1`@`%`"],
  }, "u1\t%\tN\nu1\tvanished\tN\n");
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1"], databases: [] },
    engine.query,
  );
  // The batch failed on the vanished account; each was then read alone.
  assertEquals(
    engine.asked.filter((sql) => sql.includes("SHOW GRANTS")).length,
    4,
  );
  assertEquals(report.logins[0]?.memberships, [{
    role: "r1",
    admin: false,
    host: "%",
  }]);
  assertEquals(report.logins[0]?.grants.at(-1), {
    via: "r1",
    level: "database",
    database: "appdb",
    privileges: ["SELECT"],
    host: "%",
  });
});

test("no logins reads only the version; a bad login name is refused", async () => {
  const engine = fakeEngine({}, "");
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: [], databases: [] },
    engine.query,
  );
  assertEquals(report.logins, []);
  assertEquals(engine.asked, ["SELECT VERSION();"]);
  await assertRejects(
    () =>
      readMysqlFamilyPermissions(
        "mysql",
        { logins: ["bad'name"], databases: [] },
        engine.query,
      ),
    Error,
    "not a valid account name",
  );
});

test("MySQL and MariaDB runtimes read escaped batch output as the socket root", async () => {
  const { mysqlManagedEngineRuntime } = await import("./mysql.ts");
  const { mariadbManagedEngineRuntime } = await import("./mariadb.ts");
  for (
    const [runtime, client] of [
      [mysqlManagedEngineRuntime, "mysql"],
      [mariadbManagedEngineRuntime, "mariadb"],
    ] as const
  ) {
    const calls: string[][] = [];
    const ctx = {
      containerId: "c1",
      composeServiceName: "db",
      rootUsername: "root",
      defaultDatabase: "",
      exec: (argv: string[]) => {
        calls.push(argv);
        return Promise.resolve({
          success: true,
          stdout: "9.7.2\n",
          stderr: "",
        });
      },
    };
    const report = await runtime.readPermissions!(ctx, {
      logins: [],
      databases: [],
    });
    assertEquals(report, { logins: [], serverVersion: "9.7.2" });
    assertEquals(calls[0], [
      client,
      "--protocol=socket",
      "-u",
      "root",
      "-N",
      "-B",
      "-e",
      `${statementLimitSql(client)}\nSELECT VERSION();`,
    ]);
  }
});

test("a bare _ or % in a database-level name is a wildcard pattern", () => {
  assertEquals(unescapeWildcards("shop_1"), { name: "shop_1", pattern: true });
  assertEquals(unescapeWildcards("shop%"), { name: "shop%", pattern: true });
  assertEquals(unescapeWildcards(String.raw`shop\_1`), {
    name: "shop_1",
    pattern: false,
  });
  assertEquals(unescapeWildcards(String.raw`a\_b_c`), {
    name: "a_b_c",
    pattern: true,
  });
  assertEquals(grantsOf("GRANT SELECT ON `shop_1`.* TO `u1`@`%`")[0], {
    host: "%",
    level: "database",
    database: "shop_1",
    privileges: ["SELECT"],
    pattern: true,
  });
  // Table-level names are never patterns.
  assertEquals(
    grantsOf("GRANT SELECT ON `shop_1`.`t_1` TO `u1`@`%`")[0]?.pattern,
    undefined,
  );
});

test("batch escapes are undone per field", () => {
  assertEquals(unescapeBatchField("plain"), "plain");
  assertEquals(
    unescapeBatchField(String.raw`a\nb\tc\\d\0e`),
    "a\nb\tc\\d\0e",
  );
  // The server's own `\_` arrives doubled and comes back as `\_`.
  assertEquals(unescapeBatchField(String.raw`app\\_db2`), String.raw`app\_db2`);
  assertEquals(unescapeBatchField("odd\\q end\\"), "odd\\q end\\");
});

test("a table name holding a newline cannot fake a grant line", async () => {
  // What `mysql -N -B` prints for a table named "x<newline>GRANT ALL
  // PRIVILEGES ON *.* TO `u1`@`%`": one line, the newline escaped.
  const escaped = "GRANT SELECT ON `appdb`.`x" + String.raw`\n` +
    "GRANT ALL PRIVILEGES ON *.* TO ``u1``@``%``` TO `u1`@`%`";
  const engine = fakeEngine({ "`u1`@'%'": [escaped] }, "u1\t%\tN\n");
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1"], databases: [] },
    engine.query,
  );
  assertEquals(report.logins[0]?.grants, [{
    host: "%",
    level: "table",
    database: "appdb",
    object: "x\nGRANT ALL PRIVILEGES ON *.* TO `u1`@`%`",
    privileges: ["SELECT"],
  }]);
});

test("REVOKE lines (partial revokes) mark the login truncated", async () => {
  const engine = fakeEngine({
    "`u1`@'%'": [
      "GRANT SELECT, INSERT ON *.* TO `u1`@`%`",
      "REVOKE INSERT ON `mysql`.* FROM `u1`@`%`",
    ],
  }, "u1\t%\tN\n");
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1"], databases: [] },
    engine.query,
  );
  assertEquals(report.logins[0]?.grants.length, 1);
  assertEquals(report.logins[0]?.truncated, true);
});

test("an account host that cannot be quoted is skipped, not fatal", async () => {
  const engine = fakeEngine(
    {
      "`u1`@'%'": ["GRANT USAGE ON *.* TO `u1`@`%`"],
      "`u2`@'%'": ["GRANT USAGE ON *.* TO `u2`@`%`"],
    },
    "u1\t%\tN\nu1\tbad\u0001host\tN\nu2\t%\tN\n",
  );
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1", "u2"], databases: [] },
    engine.query,
  );
  const [u1, u2] = report.logins;
  assertEquals(u1?.accounts?.length, 2);
  assertEquals(u1?.grants.length, 1);
  assertEquals(u1?.truncated, true);
  assertEquals(u2?.grants.length, 1);
  assertEquals(u2?.truncated, undefined);
});

test("the role limits cut the report honestly", async () => {
  // r0 → r1 → … → r5: deeper than the four levels followed.
  const grants: Record<string, string[]> = {
    "`u1`@'%'": ["GRANT `r0`@`%` TO `u1`@`%`"],
  };
  for (let i = 0; i < 6; i += 1) {
    grants[`\`r${i}\`@'%'`] = [`GRANT \`r${i + 1}\`@\`%\` TO \`r${i}\`@\`%\``];
  }
  const engine = fakeEngine(grants, "u1\t%\tN\n");
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1"], databases: [] },
    engine.query,
  );
  assertEquals(report.logins[0]?.truncated, true);
  assertEquals(report.logins[0]?.memberships.map((m) => m.role), [
    "r0",
    "r1",
    "r2",
    "r3",
    "r4",
  ]);

  const shallow = fakeEngine({
    "`u1`@'%'": ["GRANT `r0`@`%` TO `u1`@`%`"],
    "`r0`@'%'": ["GRANT SELECT ON `appdb`.* TO `r0`@`%`"],
  }, "u1\t%\tN\n");
  const whole = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1"], databases: [] },
    shallow.query,
  );
  assertEquals(whole.logins[0]?.truncated, undefined);
});

test("past the time budget accounts are left unread and marked", async () => {
  let ms = 0;
  const engine = fakeEngine({
    "`u1`@'%'": ["GRANT USAGE ON *.* TO `u1`@`%`"],
    "`u2`@'%'": ["GRANT USAGE ON *.* TO `u2`@`%`"],
  }, "u1\t%\tN\nu1\tgone\tN\nu2\t%\tN\n");
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1", "u2"], databases: [] },
    (sql) => {
      ms += 4000;
      return engine.query(sql);
    },
    { now: () => ms, budgetMs: 10_000 },
  );
  // Version and accounts use 8 s; 2 s left is no room for a 3 s query.
  const [u1, u2] = report.logins;
  assertEquals(u1?.grants, []);
  assertEquals(u1?.truncated, true);
  assertEquals(u2?.grants, []);
  assertEquals(u2?.truncated, true);
  assertEquals(engine.asked.length, 2);
});

test("each script bounds its statements on the server", () => {
  assertEquals(
    statementLimitSql("mysql"),
    "SET SESSION max_execution_time = 3000;",
  );
  assertEquals(
    statementLimitSql("mariadb"),
    "SET SESSION max_statement_time = 3;",
  );
});

test("a login's views, triggers, routines and events are listed on its report", async () => {
  const engine = fakeEngine({
    "`u1`@'%'": ["GRANT USAGE ON *.* TO `u1`@`%`"],
  }, "u1\t%\tN\n");
  const query = (sql: string) =>
    sql.includes("information_schema.VIEWS")
      ? Promise.resolve("u1\tview\tshop\torders_v\nu1\tevent\tshop\tnightly\n")
      : engine.query(sql);
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1", "gone"], databases: [] },
    query,
  );
  assertEquals(report.logins[0]?.definesObjects, [
    "view shop.orders_v",
    "event shop.nightly",
  ]);
  assertEquals(report.logins[1]?.definesObjects, undefined);
});

test("a failed definer query leaves the report without the field", async () => {
  const engine = fakeEngine({
    "`u1`@'%'": ["GRANT USAGE ON *.* TO `u1`@`%`"],
  }, "u1\t%\tN\n");
  const query = (sql: string) =>
    sql.includes("information_schema.VIEWS")
      ? Promise.reject(new Error("boom"))
      : engine.query(sql);
  const report = await readMysqlFamilyPermissions(
    "mysql",
    { logins: ["u1"], databases: [] },
    query,
  );
  assertEquals(report.logins[0]?.definesObjects, undefined);
});
