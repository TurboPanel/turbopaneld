/**
 * Host-free coverage for the straight-through (`fast_forward=1`) user row of
 * PostgreSQL logins the control plane marks straight through: who gets it, who never does, and that both the
 * cold-start config and the admin statements agree.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildProxySqlAdminStatements,
  type ProxySqlClusterDesired,
  type ProxySqlUserDesired,
  renderProxySqlConfig,
  userUsesFastForward,
} from "./proxysql.ts";

const test = Deno.test.bind(Deno);

function user(
  username: string,
  extra: Partial<ProxySqlUserDesired> = {},
): ProxySqlUserDesired {
  return { username, role: "user", password: "p1", ...extra };
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
    backends: [{
      memberId: "mb1",
      role: "primary",
      readEligible: true,
      address: "e1",
      port: 5432,
      transport: "local",
    }],
    users,
  } as ProxySqlClusterDesired;
}

const CASES: Array<[string, ProxySqlUserDesired, boolean]> = [
  ["straightThrough true", user("mig", { straightThrough: true }), true],
  ["straightThrough false", user("mig", { straightThrough: false }), false],
  ["straightThrough absent", user("mig"), false],
  [
    "true with an empty source list",
    user("mig", { straightThrough: true, allowedSources: [] }),
    false,
  ],
  [
    "true with sources",
    user("mig", { straightThrough: true, allowedSources: ["198.51.100.7"] }),
    false,
  ],
  [
    "true on a root login",
    user("mig", { straightThrough: true, role: "root" }),
    false,
  ],
  [
    "true on a read-only login",
    user("mig", { straightThrough: true, connectionRole: "read-only" }),
    true,
  ],
];

for (const [label, u, expected] of CASES) {
  test(`postgres ${label}: fast_forward=${expected ? 1 : "absent"}`, () => {
    assertEquals(userUsesFastForward("pgsql", u), expected);
    const desired = { bindAddresses: ["0.0.0.0"], clusters: [cluster([u])] };
    const cnf = renderProxySqlConfig(desired);
    const row = cnf.split("\n").find((l) => l.includes('username="mig"'))!;
    assertEquals(row.includes("fast_forward=1"), expected);
    const insert = buildProxySqlAdminStatements(desired).find((s) =>
      s.startsWith("INSERT INTO pgsql_users ")
    )!;
    assertEquals(insert.includes("fast_forward"), expected);
  });
}

test("the admin insert carries the column and value together", () => {
  const insert = buildProxySqlAdminStatements({
    bindAddresses: ["0.0.0.0"],
    clusters: [cluster([user("mig", { straightThrough: true })])],
  }).find((s) => s.startsWith("INSERT INTO pgsql_users "))!;
  assertStringIncludes(
    insert,
    "(username,password,default_hostgroup,active,use_ssl,fast_forward) VALUES ('mig','p1',0,1,0,1)",
  );
});

test("mysql family never gets fast_forward", () => {
  const u = user("mig", { straightThrough: true });
  assertEquals(userUsesFastForward("mysql", u), false);
  const desired = {
    bindAddresses: ["0.0.0.0"],
    clusters: [cluster([u], "mysql")],
  };
  assertEquals(renderProxySqlConfig(desired).includes("fast_forward"), false);
  assertEquals(
    buildProxySqlAdminStatements(desired).some((s) =>
      s.includes("fast_forward")
    ),
    false,
  );
});

test("switching a login's limit off and on changes the next full rewrite", () => {
  // Users are rewritten wholesale on every apply (DELETE + INSERT), so a
  // change in the desired state is what is applied; there is no per-column diff.
  const render = (u: ProxySqlUserDesired) =>
    buildProxySqlAdminStatements({
      bindAddresses: ["0.0.0.0"],
      clusters: [cluster([u])],
    }).filter((s) => s.includes("pgsql_users")).join("\n");
  const free = render(user("mig", { straightThrough: true }));
  const limited = render(
    user("mig", { straightThrough: true, allowedSources: ["198.51.100.7"] }),
  );
  assertStringIncludes(free, "DELETE FROM pgsql_users");
  assertStringIncludes(free, "fast_forward");
  assertEquals(limited.includes("fast_forward"), false);
  assertStringIncludes(limited, "DELETE FROM pgsql_users");
});
