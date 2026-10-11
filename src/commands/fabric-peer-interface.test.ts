import { assertEquals } from "@std/assert";
import {
  endpointHost,
  localInterfaceForEndpoint,
  stampObservedPeerInterfaces,
} from "./fabric-peer-interface.ts";
import type { ServerReportedIp } from "../contracts/server-reported-ip.ts";
import { parseFabricReconcileResult } from "../contracts/commands-contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const LAN: ServerReportedIp = {
  address: "192.168.1.10",
  version: 4,
  scope: "private",
  cidr: "192.168.1.10/24",
  interface: "eno1",
  preferred: true,
};
const BACKHAUL: ServerReportedIp = {
  address: "10.9.0.10",
  version: 4,
  scope: "private",
  cidr: "10.9.0.10/24",
  interface: "eno2",
};
const V6: ServerReportedIp = {
  address: "fd00:9::10",
  version: 6,
  scope: "private",
  cidr: "fd00:9::10/64",
  interface: "eno2",
};

test("endpointHost reads IPv4 and bracketed IPv6 endpoints", () => {
  assertEquals(endpointHost("10.9.0.20:51820"), "10.9.0.20");
  assertEquals(endpointHost("[fd00:9::20]:51820"), "fd00:9::20");
  assertEquals(endpointHost("nonsense"), undefined);
  assertEquals(endpointHost("[]:1"), undefined);
});

test("the backhaul subnet maps to the backhaul NIC, the LAN subnet to the LAN NIC", () => {
  const ips = [LAN, BACKHAUL, V6];
  assertEquals(localInterfaceForEndpoint("10.9.0.20:51820", ips), "eno2");
  assertEquals(localInterfaceForEndpoint("192.168.1.20:51820", ips), "eno1");
  assertEquals(localInterfaceForEndpoint("[fd00:9::20]:51820", ips), "eno2");
});

test("an endpoint on no connected subnet is left unmatched (default route)", () => {
  assertEquals(
    localInterfaceForEndpoint("203.0.113.5:51820", [LAN, BACKHAUL]),
    undefined,
  );
});

test("the most specific connected subnet wins when two overlap", () => {
  const wide: ServerReportedIp = {
    ...LAN,
    cidr: "10.0.0.5/8",
    interface: "eno1",
  };
  assertEquals(
    localInterfaceForEndpoint("10.9.0.20:51820", [wide, BACKHAUL]),
    "eno2",
  );
});

test("addresses without a CIDR or interface name are ignored", () => {
  const noCidr: ServerReportedIp = { ...BACKHAUL, cidr: undefined };
  const noNic: ServerReportedIp = { ...BACKHAUL, interface: undefined };
  assertEquals(
    localInterfaceForEndpoint("10.9.0.20:51820", [noCidr, noNic]),
    undefined,
  );
});

test("a NIC name the result contract would refuse is left unmatched", () => {
  const long: ServerReportedIp = {
    ...BACKHAUL,
    interface: "a-very-long-nic-name",
  };
  const spaced: ServerReportedIp = { ...BACKHAUL, interface: "bad nic" };
  assertEquals(
    localInterfaceForEndpoint("10.9.0.20:51820", [long, spaced]),
    undefined,
  );
});

test("stampObservedPeerInterfaces sets interface only where it matches", () => {
  const peers = [
    { publicKey: "a", endpoint: "10.9.0.20:51820" },
    { publicKey: "b", endpoint: "203.0.113.5:51820" },
    { publicKey: "c" },
  ];
  const out = stampObservedPeerInterfaces(peers, [LAN, BACKHAUL]);
  assertEquals(out[0], {
    publicKey: "a",
    endpoint: "10.9.0.20:51820",
    interface: "eno2",
  });
  assertEquals(out[1], peers[1]);
  assertEquals(out[2], peers[2]);
});

test("a fabric reconcile result accepts a valid peer interface and refuses a bad one", () => {
  const key = "A".repeat(43) + "=";
  const ok = parseFabricReconcileResult({
    summary: "ok",
    peers: [{ publicKey: key, interface: "eno2" }],
  });
  assertEquals(ok.peers?.[0]?.interface, "eno2");
  for (const bad of ["", "has space", "x".repeat(16), "../etc", 7]) {
    let threw = false;
    try {
      parseFabricReconcileResult({
        summary: "ok",
        peers: [{ publicKey: key, interface: bad }],
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `interface ${String(bad)} must be refused`);
  }
});
