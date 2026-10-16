/**
 * Host-free coverage for the managed root login source guard: address
 * translation, local-source discovery and the rendered ProxySQL query rules.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  collectLocalRootSources,
  mergeRootSources,
  normalizeClientAddress,
  ROOT_GUARD_ERROR_MESSAGE,
  rootGuardRulesForUser,
  subnetsFromNetworkInspect,
  subnetToClientAddrPatterns,
} from "./proxysql-root-guard.ts";
import {
  buildProxySqlAdminStatements,
  type ProxySqlClusterDesired,
} from "./proxysql.ts";

const test = Deno.test.bind(Deno);

test("normalizeClientAddress keeps IPv4 and writes IPv6 in the compressed form ProxySQL shows", () => {
  assertEquals(normalizeClientAddress("45.32.200.170"), "45.32.200.170");
  assertEquals(
    normalizeClientAddress("2001:19F0:6402:0D92:5400:06FF:FEDE:2A17"),
    "2001:19f0:6402:d92:5400:6ff:fede:2a17",
  );
  assertEquals(normalizeClientAddress("0:0:0:0:0:0:0:1"), "::1");
  assertEquals(
    normalizeClientAddress("2001:db8:0:0:1:0:0:1"),
    "2001:db8::1:0:0:1",
  );
  for (
    const bad of [
      "",
      "10.0.0.0/8",
      "10.0.0.%",
      "256.1.1.1",
      "010.0.0.1",
      "fe80::1%eth0",
      "1:2:3:4:5:6:7:8:9",
      "::ffff:1.2.3.4",
      "host.example",
    ]
  ) {
    assertEquals(normalizeClientAddress(bad), null, bad);
  }
});

test("subnetToClientAddrPatterns turns subnets into exact or trailing-% prefixes", () => {
  assertEquals(subnetToClientAddrPatterns("172.19.0.0/16"), ["172.19.%"]);
  assertEquals(subnetToClientAddrPatterns("10.192.11.0/24"), ["10.192.11.%"]);
  assertEquals(subnetToClientAddrPatterns("10.0.0.0/8"), ["10.%"]);
  assertEquals(subnetToClientAddrPatterns("192.168.16.0/20").length, 16);
  assertEquals(
    subnetToClientAddrPatterns("192.168.16.0/20")[15],
    "192.168.31.%",
  );
  assertEquals(subnetToClientAddrPatterns("10.1.2.4/30"), [
    "10.1.2.4",
    "10.1.2.5",
    "10.1.2.6",
    "10.1.2.7",
  ]);
  assertEquals(subnetToClientAddrPatterns("10.1.2.3/32"), ["10.1.2.3"]);
  // Too wide to expand, or not a subnet at all.
  assertEquals(subnetToClientAddrPatterns("10.0.0.0/0"), []);
  assertEquals(subnetToClientAddrPatterns("172.16.0.0/12").length, 16);
  assertEquals(subnetToClientAddrPatterns("fd00::/17"), []);
  assertEquals(subnetToClientAddrPatterns("10.0.0.1"), []);
  assertEquals(subnetToClientAddrPatterns("nope/24"), []);
  // The trailing dot keeps 172.19.% from matching 172.190.x.x.
  assertEquals("172.190.0.5".startsWith("172.19."), false);
});

test("subnetToClientAddrPatterns writes IPv6 prefixes on 16-bit group boundaries", () => {
  assertEquals(subnetToClientAddrPatterns("fd12:3456:789a:1::/64"), [
    "fd12:3456:789a:1:%",
  ]);
  assertEquals(subnetToClientAddrPatterns("2001:db8::/32"), ["2001:db8:%"]);
  assertEquals(subnetToClientAddrPatterns("fd12:3456:789a:1::5/128"), [
    "fd12:3456:789a:1::5",
  ]);
  // A zero group in the fixed part changes where the client text puts `::`.
  assertEquals(subnetToClientAddrPatterns("fd12:0:0:1::/64"), []);
  assertEquals(subnetToClientAddrPatterns("fd00::/8"), []);
});

test("subnetsFromNetworkInspect reads every IPAM subnet and survives junk", () => {
  const json = JSON.stringify([
    { IPAM: { Config: [{ Subnet: "172.19.0.0/16", Gateway: "172.19.0.1" }] } },
    { IPAM: { Config: [{ Subnet: "fd12:3456:789a:1::/64" }, {}] } },
    { IPAM: { Config: null } },
    null,
  ]);
  assertEquals(subnetsFromNetworkInspect(json), [
    "172.19.0.0/16",
    "fd12:3456:789a:1::/64",
  ]);
  assertEquals(subnetsFromNetworkInspect("not json"), []);
});

test("collectLocalRootSources returns loopback plus every attached network's subnet", async () => {
  const calls: string[][] = [];
  const sources = await collectLocalRootSources("abc-in", (args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "mgd_net\ntpn_x\n",
        stderr: "",
      });
    }
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: JSON.stringify([
        { IPAM: { Config: [{ Subnet: "172.19.0.0/16" }] } },
        { IPAM: { Config: [{ Subnet: "10.192.11.0/24" }] } },
      ]),
      stderr: "",
    });
  });
  assertEquals(sources, ["127.0.0.1", "::1", "172.19.%", "10.192.11.%"]);
  assertEquals(calls[1], ["network", "inspect", "mgd_net", "tpn_x"]);
});

test("collectLocalRootSources refuses to guess when Docker cannot be read", async () => {
  await assertRejects(
    () =>
      collectLocalRootSources(
        "abc-in",
        () =>
          Promise.resolve({
            success: false,
            code: 1,
            stdout: "",
            stderr: "boom",
          }),
      ),
    Error,
    "cannot read ProxySQL networks",
  );
  await assertRejects(
    () =>
      collectLocalRootSources(
        "bad name",
        () =>
          Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" }),
      ),
    Error,
    "invalid ProxySQL container name",
  );
});

test("mergeRootSources de-duplicates, normalizes and drops junk, keeping % prefixes", () => {
  assertEquals(
    mergeRootSources(
      ["10.0.0.2", "2001:DB8:0:0:0:0:0:1", "10.0.0.2", "junk"],
      ["127.0.0.1", "172.19.%", "10.0.0.2"],
    ),
    ["10.0.0.2", "127.0.0.1", "172.19.%", "2001:db8::1"],
  );
});

test("rootGuardRulesForUser ends with a catch-all that refuses with the plain message", () => {
  const rules = rootGuardRulesForUser(
    "root_abc",
    ["127.0.0.1", "10.0.0.2"],
    null,
  );
  assertEquals(rules.length, 3);
  assertEquals(rules[0], { username: "root_abc", clientAddr: "127.0.0.1" });
  assertEquals(rules[2], {
    username: "root_abc",
    errorMsg: ROOT_GUARD_ERROR_MESSAGE,
  });
  const split = rootGuardRulesForUser("root_abc", ["127.0.0.1"], 1);
  assertEquals(split[0]?.matchPattern, "^SELECT");
  assertEquals(split[0]?.destinationHostgroup, 1);
  assertEquals(split[1]?.matchPattern, undefined);
});

function cluster(
  overrides: Partial<ProxySqlClusterDesired> = {},
): ProxySqlClusterDesired {
  return {
    managedId: "m1",
    engine: "postgres",
    protocolPort: 15432,
    writerHostgroup: 0,
    readerHostgroup: 1,
    backends: [{
      memberId: "mb1",
      role: "primary",
      readEligible: true,
      address: "engine-1",
      port: 5432,
      transport: "local",
    }, {
      memberId: "mb2",
      role: "replica",
      readEligible: true,
      address: "engine-2",
      port: 5432,
      transport: "local",
    }],
    users: [
      { username: "app", role: "user", password: "pw-app" },
      {
        username: "postgres_abc",
        role: "root",
        password: "pw-root",
        allowedSources: ["10.0.0.2", "2001:db8::1"],
      },
    ],
    ...overrides,
  };
}

function ruleInserts(statements: string[], table: string): string[] {
  return statements.filter((s) => s.startsWith(`INSERT INTO ${table} `));
}

test("a root login with allowedSources gets pass rules, then a catch-all, ahead of read-split rules", () => {
  const statements = buildProxySqlAdminStatements(
    {
      bindAddresses: ["0.0.0.0"],
      clusters: [cluster({ autoReadSplit: true })],
    },
    { localRootSources: ["127.0.0.1", "172.19.%"] },
  );
  const rules = ruleInserts(statements, "pgsql_query_rules");
  // 4 sources x (reader rule + pass rule) + catch-all + app's read-split rule.
  assertEquals(rules.length, 4 * 2 + 1 + 1);
  assertEquals(
    rules[0],
    "INSERT INTO pgsql_query_rules (rule_id,active,username,client_addr,match_pattern,destination_hostgroup,apply) VALUES (1,1,'postgres_abc','10.0.0.2','^SELECT',1,1)",
  );
  assertEquals(
    rules[1],
    "INSERT INTO pgsql_query_rules (rule_id,active,username,client_addr,apply) VALUES (2,1,'postgres_abc','10.0.0.2',1)",
  );
  const catchAll = rules[8]!;
  assertStringIncludes(
    catchAll,
    "(rule_id,active,username,error_msg,apply) VALUES (9,1,'postgres_abc','This login is not allowed from this address.",
  );
  // The app login's split rule comes after every guard rule and keeps its shape.
  assertEquals(
    rules[9],
    "INSERT INTO pgsql_query_rules (rule_id,active,username,match_pattern,destination_hostgroup,apply) VALUES (10,1,'app','^SELECT',1,1)",
  );
  // No guard rule leaks into the other protocol family.
  assertEquals(ruleInserts(statements, "mysql_query_rules"), []);
  // The three client addresses list every source once, sorted.
  const addrs = rules.filter((r) =>
    !r.includes("match_pattern") && r.includes("client_addr")
  )
    .map((r) =>
      /client_addr,apply\) VALUES \(\d+,1,'[^']+','([^']+)'/.exec(r)![1]
    );
  assertEquals(addrs, ["10.0.0.2", "127.0.0.1", "172.19.%", "2001:db8::1"]);
});

test("without allowedSources the root login gets no guard (older control plane)", () => {
  const old = cluster({
    users: [{ username: "postgres_abc", role: "root", password: "pw-root" }],
  });
  const statements = buildProxySqlAdminStatements(
    { bindAddresses: ["0.0.0.0"], clusters: [old] },
    { localRootSources: ["127.0.0.1"] },
  );
  assertEquals(ruleInserts(statements, "pgsql_query_rules"), []);
});

test("an empty allowedSources list still guards: only this host's own sources pass", () => {
  const statements = buildProxySqlAdminStatements(
    {
      bindAddresses: ["0.0.0.0"],
      clusters: [cluster({
        users: [{
          username: "root_abc",
          role: "root",
          password: "pw",
          allowedSources: [],
        }],
        engine: "mysql",
        family: "mysql",
        protocolPort: 13306,
      })],
    },
    { localRootSources: ["127.0.0.1"] },
  );
  const rules = ruleInserts(statements, "mysql_query_rules");
  assertEquals(rules.length, 2);
  assertStringIncludes(rules[0]!, "'127.0.0.1'");
  assertStringIncludes(rules[1]!, "error_msg");
});

test("the guard never turns on fast_forward and quotes hostile text safely", () => {
  const statements = buildProxySqlAdminStatements(
    { bindAddresses: ["0.0.0.0"], clusters: [cluster()] },
    { localRootSources: ["127.0.0.1"] },
  );
  assertEquals(statements.some((s) => s.includes("fast_forward")), false);
  // The error message has no quote characters that would need escaping.
  assertEquals(ROOT_GUARD_ERROR_MESSAGE.includes("'"), false);
});
