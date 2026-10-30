import { assertEquals } from "@std/assert";
import {
  desiredFabricRoutes,
  fabricRoute,
  fabricRoutePlanIsEmpty,
  parseRouteShow,
  planFabricRoutes,
} from "./fabric-routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function cidrs(routes: readonly { cidr: string }[]): string[] {
  return routes.map((route) => route.cidr);
}

test("fabricRoute clears host bits and writes IPv6 in full", () => {
  assertEquals(fabricRoute("10.193.5.7/16")?.cidr, "10.193.0.0/16");
  assertEquals(fabricRoute("fd00:1::/48")?.cidr, "fd00:1:0:0:0:0:0:0/48");
  assertEquals(fabricRoute("10.0.0.1"), null);
  assertEquals(fabricRoute("nonsense/8"), null);
});

test("desiredFabricRoutes dedupes ranges and leaves out this server's address", () => {
  const routes = desiredFabricRoutes({
    address: "10.250.0.11/32",
    peers: [
      { allowedIPs: ["10.250.0.12/32", "10.193.0.0/16"] },
      { allowedIPs: ["10.193.0.0/16", "10.250.0.11/32", "fd00:1::/48"] },
    ],
  });
  assertEquals(cidrs(routes), [
    "10.250.0.12/32",
    "10.193.0.0/16",
    "fd00:1:0:0:0:0:0:0/48",
  ]);
});

test("parseRouteShow reads host routes without a prefix and skips non-unicast lines", () => {
  const routes = parseRouteShow(
    [
      "default via 192.0.2.1 dev eth0 proto dhcp",
      "10.250.0.12 dev tp0 scope link",
      "10.193.0.0/16 dev tp0 scope link",
      "10.0.0.0/24 dev eth1 proto kernel scope link src 10.0.0.5",
      "unreachable 10.9.0.0/16",
      "",
    ].join("\n"),
    4,
  );
  assertEquals(
    routes.map((route) => [route.cidr, route.dev, route.kernel]),
    [
      ["10.250.0.12/32", "tp0", false],
      ["10.193.0.0/16", "tp0", false],
      ["10.0.0.0/24", "eth1", true],
    ],
  );
  assertEquals(
    cidrs(parseRouteShow("fd00:1::5 dev tp0 metric 1024", 6)),
    ["fd00:1:0:0:0:0:0:5/128"],
  );
});

test("planFabricRoutes removes only managed tp0 routes no peer wants", () => {
  const table = [
    ...parseRouteShow(
      [
        "10.250.0.12 dev tp0 scope link",
        "10.199.0.0/16 dev tp0 proto static scope link",
        "10.250.0.0/16 dev tp0 proto kernel scope link src 10.250.0.11",
        "169.254.10.0/24 dev tp0 scope link",
        "10.198.0.0/16 dev eth0 proto static",
      ].join("\n"),
      4,
    ),
    ...parseRouteShow("fe80::/64 dev tp0 metric 256", 6),
  ];
  const desired = desiredFabricRoutes({
    address: "10.250.0.11/32",
    peers: [{ allowedIPs: ["10.250.0.12/32", "10.193.0.0/16"] }],
  });
  const plan = planFabricRoutes(desired, table);
  assertEquals(plan.add, ["10.193.0.0/16"]);
  assertEquals(plan.remove, ["10.199.0.0/16"]);
  assertEquals(plan.skipped, []);
  assertEquals(fabricRoutePlanIsEmpty(plan), false);
});

test("planFabricRoutes skips a range another interface routes and drops it from tp0", () => {
  const table = parseRouteShow(
    [
      "10.193.0.0/16 dev tp0 scope link",
      "10.193.0.0/16 dev eth1 proto kernel scope link src 10.193.0.5",
      "10.194.0.0/16 dev eth2 proto static",
      "10.250.0.12 dev tp0 scope link",
    ].join("\n"),
    4,
  );
  const desired = desiredFabricRoutes({
    address: "10.250.0.11/32",
    peers: [{
      allowedIPs: ["10.250.0.12/32", "10.193.4.0/24", "10.194.0.0/16"],
    }],
  });
  const plan = planFabricRoutes(desired, table);
  assertEquals(plan.add, []);
  assertEquals(plan.remove, ["10.193.0.0/16"]);
  assertEquals(plan.skipped, [
    { cidr: "10.193.4.0/24", dev: "eth1" },
    { cidr: "10.194.0.0/16", dev: "eth2" },
  ]);
});

test("planFabricRoutes is empty when tp0 already matches", () => {
  const desired = desiredFabricRoutes({
    address: "10.250.0.11/32",
    peers: [{ allowedIPs: ["10.250.0.12/32"] }],
  });
  const table = parseRouteShow("10.250.0.12 dev tp0 scope link", 4);
  assertEquals(fabricRoutePlanIsEmpty(planFabricRoutes(desired, table)), true);
});
