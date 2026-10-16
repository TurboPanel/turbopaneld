/**
 * Host-free coverage for per-login source limits and connection caps on app
 * logins: rule shape, ordering against read-split rules, the rule budget and
 * the user-row column.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  LOGIN_GUARD_ERROR_MESSAGE,
  ROOT_GUARD_ERROR_MESSAGE,
} from "./proxysql-root-guard.ts";
import {
  buildProxySqlAdminStatements,
  type ProxySqlClusterDesired,
  type ProxySqlUserDesired,
} from "./proxysql.ts";

const test = Deno.test.bind(Deno);

const PW = "p1";

function user(
  username: string,
  extra: Partial<ProxySqlUserDesired> = {},
): ProxySqlUserDesired {
  return { username, role: "user", password: PW, ...extra };
}

function cluster(
  users: ProxySqlUserDesired[],
  family: "mysql" | "postgres" = "postgres",
): ProxySqlClusterDesired {
  return {
    managedId: "m1",
    engine: family,
    protocolPort: family === "postgres" ? 15432 : 13306,
    writerHostgroup: 0,
    readerHostgroup: 1,
    autoReadSplit: true,
    backends: [
      {
        memberId: "mb1",
        role: "primary",
        readEligible: true,
        address: "e1",
        port: 5432,
        transport: "local",
      },
      {
        memberId: "mb2",
        role: "replica",
        readEligible: true,
        address: "e2",
        port: 5432,
        transport: "local",
      },
    ],
    users,
  } as ProxySqlClusterDesired;
}

function build(c: ProxySqlClusterDesired, local = ["127.0.0.1", "172.19.%"]) {
  return buildProxySqlAdminStatements(
    { bindAddresses: ["0.0.0.0"], clusters: [c] },
    { localRootSources: local },
  );
}

const rulesOf = (s: string[], table: string) =>
  s.filter((x) => x.startsWith(`INSERT INTO ${table} `));

for (const family of ["postgres", "mysql"] as const) {
  const table = family === "postgres"
    ? "pgsql_query_rules"
    : "mysql_query_rules";
  test(`${family}: a limited login gets pass rules then a catch-all, ahead of read-split rules`, () => {
    const rules = rulesOf(
      build(cluster([
        user("app"),
        user("hl_a", { allowedSources: ["198.51.100.7", "203.0.113.%"] }),
      ], family)),
      table,
    );
    // 2 sources x (reader rule + pass rule) + catch-all, then app's split rule.
    assertEquals(rules.length, 2 * 2 + 1 + 1);
    assertStringIncludes(
      rules[0]!,
      "(1,1,'hl_a','198.51.100.7','^SELECT',1,1)",
    );
    assertStringIncludes(rules[1]!, "(2,1,'hl_a','198.51.100.7',1)");
    assertStringIncludes(rules[3]!, "'203.0.113.%',1)");
    assertStringIncludes(rules[4]!, "error_msg");
    assertStringIncludes(rules[4]!, LOGIN_GUARD_ERROR_MESSAGE);
    assertStringIncludes(rules[5]!, "(6,1,'app','^SELECT',1,1)");
  });
}

test("allowLocalSources adds loopback and Docker networks; without it they are refused", () => {
  const withLocal = rulesOf(
    build(cluster([
      user("hl_in", { allowedSources: [], allowLocalSources: true }),
    ])),
    "pgsql_query_rules",
  );
  assertEquals(withLocal.length, 2 * 2 + 1);
  const without = rulesOf(
    build(cluster([user("hl_out", { allowedSources: ["198.51.100.7"] })])),
    "pgsql_query_rules",
  );
  assertEquals(without.some((r) => r.includes("127.0.0.1")), false);
  assertEquals(without.some((r) => r.includes("172.19.%")), false);
});

test("read-only and tool logins get pass rules without a reader rule", () => {
  const rules = rulesOf(
    build(cluster([
      user("hl_ro", {
        allowedSources: ["198.51.100.7"],
        connectionRole: "read-only",
      }),
      user("hl_tool", { allowedSources: ["198.51.100.7"], tool: true }),
    ])),
    "pgsql_query_rules",
  );
  assertEquals(rules.length, 4);
  assertEquals(rules.some((r) => r.includes("match_pattern")), false);
});

test("an absent allowedSources leaves the login without rules", () => {
  const rules = rulesOf(
    build(cluster([user("hl_free", { maxConnections: 5 })])),
    "pgsql_query_rules",
  );
  assertEquals(rules.filter((r) => r.includes("hl_free")).length, 1);
  assertStringIncludes(rules[0]!, "'^SELECT'");
});

test("root keeps its own message and sits with the app guards in one id sequence", () => {
  const rules = rulesOf(
    build(cluster([
      user("pg_root", { role: "root", allowedSources: [] }),
      user("hl_a", { allowedSources: ["198.51.100.7"] }),
    ])),
    "pgsql_query_rules",
  );
  assertEquals(
    rules.filter((r) => r.includes(ROOT_GUARD_ERROR_MESSAGE)).length,
    1,
  );
  assertEquals(
    rules.filter((r) => r.includes(LOGIN_GUARD_ERROR_MESSAGE)).length,
    1,
  );
});

test("50 restricted logins keep rule ids unique and below every read-split rule", () => {
  const users = [user("app")];
  for (let i = 0; i < 50; i++) {
    users.push(user(`hl_${String(i).padStart(2, "0")}`, {
      allowedSources: Array.from({ length: 20 }, (_, n) => `198.51.100.${n}`),
      allowLocalSources: true,
    }));
  }
  const rules = rulesOf(build(cluster(users)), "pgsql_query_rules");
  const ids = rules.map((r) => Number(/VALUES \((\d+),/.exec(r)![1]));
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(ids, ids.toSorted((a, b) => a - b));
  // 22 sources (20 + loopback + one Docker prefix), 2 rules each, plus catch-all.
  assertEquals(rules.length, 50 * (22 * 2 + 1) + 1);
  assertStringIncludes(rules.at(-1)!, "'app','^SELECT'");
  assertEquals(ids.at(-1), rules.length);
});

test("a hand-added rule is wiped: the rule table is always cleared first", () => {
  const s = build(
    cluster([user("hl_a", { allowedSources: ["198.51.100.7"] })]),
  );
  assertEquals(s.includes("DELETE FROM pgsql_query_rules"), true);
  assertEquals(s.includes("DELETE FROM mysql_query_rules"), true);
  assertEquals(s.some((x) => x.includes("fast_forward")), false);
});

test("maxConnections lands in the user row for both families and only when set", () => {
  const pg = build(cluster([user("hl_a", { maxConnections: 7 }), user("b")]));
  const rows = rulesOf(pg, "pgsql_users");
  assertStringIncludes(
    rows.find((r) => r.includes("'hl_a'"))!,
    "max_connections",
  );
  assertStringIncludes(rows.find((r) => r.includes("'hl_a'"))!, ",7)");
  assertEquals(
    rows.find((r) => r.includes("'b'"))!.includes("max_connections"),
    false,
  );
  const my = build(cluster([user("hl_m", { maxConnections: 3 })], "mysql"));
  assertStringIncludes(
    rulesOf(my, "mysql_users").find((r) => r.includes("'hl_m'"))!,
    "max_connections",
  );
});
