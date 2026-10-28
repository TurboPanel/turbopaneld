import { assertEquals, assertThrows } from "@std/assert";
import {
  parseEnvironmentDeployPayload,
  parseTunnelRoutesPayload,
  parseTunnelRoutesResult,
} from "./commands-contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const GOOD = {
  hash: "a".repeat(64),
  routes: [{
    hostname: "app.example.com",
    local: false,
    lock: true,
    upstreams: [{
      serverId: "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e01",
      addresses: ["10.0.0.5", "fd00::5"],
      port: 443,
    }],
  }],
  peerAddresses: ["10.0.0.5"],
  listenAddresses: ["10.0.0.7"],
  peerMaterial: {
    certificatePem: CERT,
    privateKeyEnvelope: "tpdaemon.AAAA",
    caCertPem: CERT,
  },
};

test("server.tunnel.routes parses a table and an empty table", () => {
  assertEquals(parseTunnelRoutesPayload(GOOD), GOOD);
  const empty = { hash: "b".repeat(64), routes: [], peerAddresses: [] };
  assertEquals(parseTunnelRoutesPayload(empty), empty);
});

test("server.tunnel.routes refuses bad tables", () => {
  const bad: unknown[] = [
    null,
    { ...GOOD, hash: "x" },
    { ...GOOD, peerMaterial: undefined },
    { ...GOOD, peerAddresses: [] },
    { ...GOOD, peerAddresses: ["10.0.0.0/24"] },
    {
      ...GOOD,
      peerMaterial: { ...GOOD.peerMaterial, privateKeyEnvelope: "k" },
    },
    { ...GOOD, routes: [{ ...GOOD.routes[0], upstreams: [] }] },
    { ...GOOD, routes: [GOOD.routes[0], GOOD.routes[0]] },
  ];
  for (const value of bad) {
    assertThrows(() => parseTunnelRoutesPayload(value), TypeError);
  }
});

test("server.tunnel.routes result parses", () => {
  const result = {
    hash: "a".repeat(64),
    applied: true,
    routeCount: 1,
    dropped: [],
    warnings: [],
  };
  assertEquals(parseTunnelRoutesResult(result), result);
  assertThrows(() => parseTunnelRoutesResult({ ...result, applied: 1 }));
});

function deploy(hosting: Record<string, unknown>) {
  return {
    environmentId: "env-1",
    projectId: "p",
    organizationId: "o",
    projectName: "demo",
    hostingIngressNetwork: "00000000-0000-4000-8000-0000000000bb",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime",
      content: "services:\n  web:\n    image: nginx\n",
    }],
    hostings: [{
      hostingId: "h",
      serviceId: "s",
      composeServiceName: "web",
      hostnames: ["app.example.com"],
      ...hosting,
    }],
  };
}

test("hostings[].tunnel is optional, checked, and never combined with acme on a locked name", () => {
  const plain = parseEnvironmentDeployPayload(deploy({}));
  assertEquals(plain.hostings[0]?.tunnel, undefined);
  const tunnel = { hostnames: ["app.example.com"], peers: ["10.0.0.5"] };
  assertEquals(
    parseEnvironmentDeployPayload(deploy({ tunnel })).hostings[0]?.tunnel,
    tunnel,
  );
  assertThrows(() =>
    parseEnvironmentDeployPayload(deploy({
      tunnel: { ...tunnel, hostnames: ["other.example.com"] },
    }))
  );
  assertThrows(() =>
    parseEnvironmentDeployPayload(deploy({ tunnel, tlsMode: "acme" }))
  );
  parseEnvironmentDeployPayload(deploy({
    tunnel: { ...tunnel, openHostnames: ["app.example.com"] },
    tlsMode: "acme",
  }));
});

test("server.tunnel.routes: material, peers and size limits", () => {
  const route = (n: number) => ({
    hostname: `n${n}.example.com`,
    local: true,
    lock: true,
    upstreams: [],
  });
  const ips = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `10.0.${Math.floor(i / 200)}.${(i % 200) + 1}`,
    );
  const material = GOOD.peerMaterial;
  const remote = (upstreams: unknown[]) => [{
    hostname: "a.example.com",
    local: false,
    lock: true,
    upstreams,
  }];
  const cases: unknown[] = [
    { ...GOOD, peerMaterial: undefined, routes: [] },
    { ...GOOD, peerAddresses: [] },
    { ...GOOD, routes: Array.from({ length: 2001 }, (_, i) => route(i)) },
    { ...GOOD, peerAddresses: ips(65) },
    {
      ...GOOD,
      routes: remote([{
        serverId: GOOD.routes[0]!.upstreams[0]!.serverId,
        addresses: ips(9),
      }]),
    },
    {
      ...GOOD,
      routes: remote(Array.from({ length: 17 }, (_, i) => ({
        serverId: `0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e${
          String(i).padStart(2, "0")
        }`,
        addresses: ["10.0.0.5"],
      }))),
    },
    {
      ...GOOD,
      peerMaterial: {
        ...material,
        certificatePem: CERT + "-----BEGIN PRIVATE KEY-----\nx\n",
      },
    },
    { ...GOOD, peerMaterial: { ...material, caCertPem: CERT + "PRIVATE KEY" } },
    {
      ...GOOD,
      peerMaterial: { ...material, certificatePem: CERT + "a".repeat(70_000) },
    },
    {
      ...GOOD,
      peerMaterial: { ...material, caCertPem: CERT + "a".repeat(70_000) },
    },
    {
      ...GOOD,
      peerMaterial: {
        ...material,
        privateKeyEnvelope: "tpdaemon." + "a".repeat(70_000),
      },
    },
    { ...GOOD, peerMaterial: { ...material, privateKeyEnvelope: "tpdaemon." } },
    { ...GOOD, peerMaterial: { ...material, notAfter: "Jan 1 2027" } },
    { ...GOOD, peerMaterial: { ...material, notAfter: "2027-01-01" } },
  ];
  cases.forEach((bad, index) => {
    assertThrows(
      () => parseTunnelRoutesPayload(bad),
      TypeError,
      undefined,
      `case ${index}`,
    );
  });
  parseTunnelRoutesPayload({
    ...GOOD,
    routes: Array.from({ length: 2000 }, (_, i) => route(i)),
  });
  parseTunnelRoutesPayload({ ...GOOD, peerAddresses: ips(64) });
});

test("hostings[].tunnel: upper-case names and size limits are refused", () => {
  const entry = (tunnel: Record<string, unknown>, hostnames: string[]) =>
    parseEnvironmentDeployPayload({
      environmentId: "env-1",
      projectId: "p",
      organizationId: "o",
      projectName: "demo",
      hostingIngressNetwork: "00000000-0000-4000-8000-0000000000bb",
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        content: "services:\n  web:\n    image: nginx\n",
      }],
      hostings: [{
        hostingId: "h",
        serviceId: "s",
        composeServiceName: "web",
        hostnames,
        tunnel,
      }],
    });
  assertThrows(() =>
    entry({ hostnames: ["App.example.com"], peers: ["10.0.0.5"] }, [
      "App.example.com",
    ])
  );
  const names = Array.from({ length: 257 }, (_, i) => `n${i}.example.com`);
  assertThrows(() => entry({ hostnames: names, peers: ["10.0.0.5"] }, names));
  const peers = Array.from({ length: 65 }, (_, i) => `10.0.0.${i + 1}`);
  assertThrows(() =>
    entry({ hostnames: ["app.example.com"], peers }, ["app.example.com"])
  );
});
