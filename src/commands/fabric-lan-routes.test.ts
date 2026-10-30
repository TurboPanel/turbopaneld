import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  connectedDevFor,
  fabricLanRoutesPolicyError,
  lanRoutePlanIsEmpty,
  lanRoutePrefixes,
  planLanRoutes,
} from "./fabric-lan-routes.ts";
import { parseRouteShow } from "./fabric-routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// Sample LAN and container addresses for these fixtures, not reachable hosts.
const LAN_SUBNET = "10.0.0.0/24 dev eth1 proto kernel scope link src 10.0.0.11"; // NOSONAR typescript:S1313 — sample LAN for this test fixture, not a reachable host
const NEIGHBOUR = "10.0.0.12"; // NOSONAR typescript:S1313 — sample LAN neighbour for this test fixture, not a reachable host
const BRIDGE = "10.192.11.0/24";
const REMOTE = "10.193.5.0/24";

function table(...lines: string[]) {
  return parseRouteShow(lines.join("\n"), 4);
}

const base = {
  address: "10.250.0.11/32",
  prefix: "10.250.0.0/16",
  peers: [] as { allowedIPs: string[] }[],
};

test("LAN route policy follows the AllowedIPs private-range rules", () => {
  assertEquals(
    fabricLanRoutesPolicyError({
      ...base,
      lanRoutes: [{ cidr: REMOTE, via: NEIGHBOUR }],
    }),
    null,
  );
  for (
    const [cidr, message] of [
      ["0.0.0.0/0", "too broad"],
      ["203.0.113.0/24", "not a private range"], // NOSONAR typescript:S1313 — documentation range for this test fixture, not a reachable host
      ["10.250.1.0/24", "own fabric range"],
    ]
  ) {
    const error = fabricLanRoutesPolicyError({
      ...base,
      lanRoutes: [{ cidr, via: NEIGHBOUR }],
    });
    assertStringIncludes(error ?? "", message);
    assertStringIncludes(error ?? "", "TurboFabric refused a LAN route");
  }
  assertStringIncludes(
    fabricLanRoutesPolicyError({
      ...base,
      peers: [{ allowedIPs: [REMOTE] }],
      lanRoutes: [{ cidr: REMOTE, via: NEIGHBOUR }],
    }) ?? "",
    "tunnel peer's range",
  );
  assertStringIncludes(
    fabricLanRoutesPolicyError({
      ...base,
      lanRoutes: [
        { cidr: "10.193.0.0/16", via: NEIGHBOUR },
        { cidr: REMOTE, via: NEIGHBOUR },
      ],
    }) ?? "",
    "overlaps another LAN route",
  );
  // A tunnel-less payload has no address of its own.
  assertEquals(
    fabricLanRoutesPolicyError({
      prefix: base.prefix,
      peers: [],
      lanRoutes: [{ cidr: REMOTE, via: NEIGHBOUR }],
    }),
    null,
  );
});

test("connectedDevFor picks the interface whose connected subnet holds the next hop", () => {
  const routes = table(
    "default via 10.0.0.1 dev eth0", // NOSONAR typescript:S1313 — sample gateway for this test fixture, not a reachable host
    "10.0.0.0/16 dev eth0 proto kernel scope link src 10.0.3.3", // NOSONAR typescript:S1313 — sample LAN for this test fixture, not a reachable host
    LAN_SUBNET,
    `${BRIDGE} dev br-1 proto kernel scope link src 10.192.11.1`,
    "10.9.0.0/24 dev eth2 proto kernel scope link linkdown",
    "10.250.0.0/16 dev tp0 proto kernel scope link",
  );
  assertEquals(connectedDevFor(NEIGHBOUR, routes), "eth1");
  assertEquals(connectedDevFor("10.0.9.9", routes), "eth0");
  assertEquals(connectedDevFor("10.9.0.5", routes), null);
  assertEquals(connectedDevFor("10.250.0.12", routes), null);
  assertEquals(connectedDevFor("10.192.11.5", routes, [BRIDGE]), null);
  assertEquals(connectedDevFor("172.16.0.1", routes), null);
  const v6 = parseRouteShow(
    "fd00:9::/64 dev eth1 proto kernel metric 256 pref medium",
    6,
  );
  assertEquals(connectedDevFor("fd00:9::12", v6), "eth1");
});

test("planLanRoutes adds, keeps and removes only its own routes", () => {
  const empty = planLanRoutes({
    desired: [{ cidr: REMOTE, via: NEIGHBOUR }],
    table: table(LAN_SUBNET),
    bridgeSubnets: [BRIDGE],
    installed: [],
  });
  assertEquals(empty.add, [{ cidr: REMOTE, via: NEIGHBOUR, dev: "eth1" }]);
  assertEquals(lanRoutePlanIsEmpty(empty), false);

  const installed = [{ cidr: REMOTE, via: NEIGHBOUR, dev: "eth1" }];
  const present = table(LAN_SUBNET, `${REMOTE} via ${NEIGHBOUR} dev eth1`);
  const kept = planLanRoutes({
    desired: [{ cidr: REMOTE, via: NEIGHBOUR }],
    table: present,
    bridgeSubnets: [BRIDGE],
    installed,
  });
  assertEquals(kept.keep, installed);
  assertEquals(lanRoutePlanIsEmpty(kept), true);

  const gone = planLanRoutes({
    desired: [],
    table: present,
    bridgeSubnets: [BRIDGE],
    installed: [
      ...installed,
      // Recorded but no longer in the table: nothing to remove.
      { cidr: "10.193.6.0/24", via: NEIGHBOUR, dev: "eth1" },
    ],
  });
  assertEquals(gone.remove, installed);

  // An operator's own route for the same range is never ours to remove.
  const foreign = planLanRoutes({
    desired: [],
    table: present,
    bridgeSubnets: [],
    installed: [],
  });
  assertEquals(foreign.remove, []);
});

test("planLanRoutes moves its own route to a new next hop", () => {
  const plan = planLanRoutes({
    desired: [{ cidr: REMOTE, via: "10.0.0.13" }],
    table: table(LAN_SUBNET, `${REMOTE} via ${NEIGHBOUR} dev eth1`),
    bridgeSubnets: [],
    installed: [{ cidr: REMOTE, via: NEIGHBOUR, dev: "eth1" }],
  });
  assertEquals(plan.add, [{ cidr: REMOTE, via: "10.0.0.13", dev: "eth1" }]);
  assertEquals(plan.remove, []);
  assertEquals(plan.skipped, []);
});

test("planLanRoutes skips what it cannot route safely", () => {
  const plan = planLanRoutes({
    desired: [
      { cidr: "10.193.7.0/24", via: "10.5.0.12" },
      { cidr: "10.193.8.0/24", via: NEIGHBOUR },
      { cidr: "10.0.0.128/25", via: NEIGHBOUR },
      { cidr: "10.192.11.128/25", via: NEIGHBOUR },
      { cidr: "fd00:7::/64", via: "fd00:9::12" },
    ],
    table: table(
      LAN_SUBNET,
      "10.193.8.0/24 via 10.0.0.1 dev eth1", // NOSONAR typescript:S1313 — sample operator route for this test fixture, not a reachable host
    ),
    bridgeSubnets: [BRIDGE],
    installed: [],
  });
  assertEquals(plan.add, []);
  const reasons = plan.skipped.map((skip) => `${skip.cidr}: ${skip.reason}`);
  assertStringIncludes(reasons[0] ?? "", "no connected subnet holds 10.5.0.12");
  assertStringIncludes(reasons[1] ?? "", "eth1 already routes it");
  assertStringIncludes(reasons[2] ?? "", "eth1 already routes it");
  assertStringIncludes(reasons[3] ?? "", "local bridge subnet");
  assertStringIncludes(reasons[4] ?? "", "IPv6");
});

test("lanRoutePrefixes takes installed IPv4 routes in canonical form, with their interface", () => {
  assertEquals(
    lanRoutePrefixes([
      { cidr: "10.193.5.7/24", via: NEIGHBOUR, dev: "eth1" },
      { cidr: REMOTE, via: NEIGHBOUR, dev: "eth1" },
      { cidr: "fd00:7::/64", via: "fd00:9::12", dev: "eth1" },
    ]),
    [{ cidr: REMOTE, dev: "eth1" }],
  );
  assertEquals(lanRoutePrefixes(undefined), []);
});

test("connectedDevFor skips container-side interfaces and a subnet's network or broadcast address", () => {
  const routes = table(
    "172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1", // NOSONAR typescript:S1313 — docker0's usual subnet, test fixture only
    "10.30.0.0/24 dev br-0123 proto kernel scope link src 10.30.0.1",
    "10.31.0.0/24 dev veth9 proto kernel scope link",
    "10.32.0.0/24 dev tpn-a proto kernel scope link",
    LAN_SUBNET,
    "10.0.5.0/31 dev eth3 proto kernel scope link src 10.0.5.0", // NOSONAR typescript:S1313 — sample point-to-point link, test fixture only
  );
  for (const via of ["172.17.0.5", "10.30.0.5", "10.31.0.5", "10.32.0.5"]) { // NOSONAR typescript:S1313 — container-side samples, test fixture only
    assertEquals(connectedDevFor(via, routes), null, via);
  }
  assertEquals(connectedDevFor("10.0.0.0", routes), null); // NOSONAR typescript:S1313 — network address, test fixture only
  assertEquals(connectedDevFor("10.0.0.255", routes), null); // NOSONAR typescript:S1313 — broadcast address, test fixture only
  assertEquals(connectedDevFor("10.0.0.254", routes), "eth1"); // NOSONAR typescript:S1313 — sample LAN neighbour, test fixture only
  assertEquals(connectedDevFor("10.0.5.1", routes), "eth3"); // NOSONAR typescript:S1313 — a /31 has no network or broadcast address
});

test("planLanRoutes skips a range that contains a connected subnet and names a refused interface", () => {
  const plan = planLanRoutes({
    desired: [
      { cidr: "10.0.0.0/16", via: NEIGHBOUR },
      { cidr: REMOTE, via: "172.17.0.5" }, // NOSONAR typescript:S1313 — on docker0, test fixture only
    ],
    table: table(
      LAN_SUBNET,
      "172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1", // NOSONAR typescript:S1313 — docker0's usual subnet, test fixture only
    ),
    bridgeSubnets: [],
    installed: [],
  });
  assertEquals(plan.add, []);
  const reasons = plan.skipped.map((skip) => skip.reason);
  assertStringIncludes(reasons[0] ?? "", "eth1 already routes it");
  assertStringIncludes(reasons[1] ?? "", "docker0");
});
