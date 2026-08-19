import { assertEquals, assertThrows } from "@std/assert";
import {
  assertValidHostname,
  assertValidNtpServer,
  assertValidTimezone,
  HOSTNAME_MAX_LENGTH,
  isValidHostname,
  isValidIpv4Literal,
  isValidIpv6Literal,
  isValidNtpServer,
  isValidTimezone,
  isValidWireguardAllowedIp,
  isValidWireguardEndpoint,
  isValidWireguardListenPort,
  isValidWireguardPublicKey,
  parseEnvironmentStopPayload,
  parseFabricReconcilePayload,
  parseFabricReconcileResult,
  parseHostnamePayload,
  parseManagedDestroyResult,
  parseManagedHaFailoverResult,
  parseManagedHaReconcileResult,
  parseManagedIngressReconcileResult,
  parseManagedLifecycleResult,
  parseManagedReplicationHealth,
  parseNtpSetPayload,
  parsePingPayload,
  parseRebootPayload,
  parseTimezoneSetPayload,
} from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const WG_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("parsePingPayload accepts an empty object and rejects non-objects", () => {
  assertEquals(parsePingPayload({}), {});
  assertThrows(() => parsePingPayload(null), Error, "Invalid ping payload");
  assertThrows(() => parsePingPayload([]), Error, "Invalid ping payload");
  assertThrows(() => parsePingPayload("ping"), Error, "Invalid ping payload");
});

test("parseRebootPayload accepts an empty object and rejects non-objects", () => {
  assertEquals(parseRebootPayload({}), {});
  assertThrows(
    () => parseRebootPayload(undefined),
    Error,
    "Invalid reboot payload",
  );
});

test("isValidHostname and assertValidHostname reject hostile values", () => {
  assertEquals(isValidHostname("app.example.test"), true);
  assertEquals(isValidHostname("Bad.Host"), false);
  assertEquals(isValidHostname("host;rm"), false);
  assertEquals(isValidHostname(123), false);
  assertThrows(
    () => assertValidHostname("not valid!"),
    Error,
    "Invalid hostname",
  );
  assertThrows(
    () => parseHostnamePayload({ hostname: "" }),
    Error,
    "hostname must be a non-empty string",
  );
});

test("isValidTimezone and parseTimezoneSetPayload reject invalid zones", () => {
  assertEquals(isValidTimezone("UTC"), true);
  assertEquals(isValidTimezone("Bad Zone"), false);
  assertThrows(() => assertValidTimezone(""), Error, "Invalid timezone");
  assertThrows(
    () => parseTimezoneSetPayload({ timezone: "Bad Zone" }),
    Error,
    "Invalid timezone",
  );
});

test("parseNtpSetPayload validates enabled and non-empty server lists", () => {
  assertEquals(parseNtpSetPayload({ enabled: true }), { enabled: true });
  assertThrows(
    () => parseNtpSetPayload({ enabled: "yes" }),
    TypeError,
    "enabled must be a boolean",
  );
  assertThrows(
    () => parseNtpSetPayload({ servers: [] }),
    Error,
    "servers must not be empty when provided",
  );
  assertThrows(
    () => parseNtpSetPayload({ fallbackServers: "pool" }),
    TypeError,
    "fallbackServers must be an array",
  );
});

test("isValidIpv4Literal rejects malformed dotted quads", () => {
  assertEquals(isValidIpv4Literal("203.0.113.10"), true);
  assertEquals(isValidIpv4Literal("999.999.999.999"), false);
  assertEquals(isValidIpv4Literal("01.2.3.4"), false);
  assertEquals(isValidIpv4Literal("256.0.0.1"), false);
  assertEquals(isValidIpv4Literal("not-an-ip"), false);
});

test("isValidIpv6Literal accepts RFC 4291 shapes and rejects garbage", () => {
  assertEquals(isValidIpv6Literal("::1"), true);
  assertEquals(isValidIpv6Literal("2001:db8::1"), true);
  assertEquals(isValidIpv6Literal("2001:db8:0:0:0:0:0:1"), true);
  assertEquals(isValidIpv6Literal("::ffff:203.0.113.1"), true);
  assertEquals(isValidIpv6Literal("203.0.113.10"), false);
  assertEquals(isValidIpv6Literal("::::"), false);
  assertEquals(isValidIpv6Literal("fe80::1%eth0"), false);
  assertEquals(isValidIpv6Literal("1::2::3"), false);
  assertEquals(isValidIpv6Literal("203.0.113.1:abcd::1"), false);
  assertEquals(isValidIpv6Literal("::ffff:999.999.999.999"), false);
});

test("isValidTimezone and isValidNtpServer reject non-string and over-length values", () => {
  assertEquals(isValidTimezone(123), false);
  assertEquals(isValidTimezone(null), false);
  assertEquals(isValidNtpServer("a".repeat(HOSTNAME_MAX_LENGTH + 1)), false);
  assertThrows(
    () => parseTimezoneSetPayload({ timezone: 123 }),
    Error,
    "timezone must be a non-empty string",
  );
});

test("WireGuard validators reject non-string CIDR and endpoint values", () => {
  assertEquals(isValidWireguardAllowedIp(123), false);
  assertEquals(isValidWireguardAllowedIp("203.0.113.0/not-a-prefix"), false);
  assertEquals(isValidWireguardEndpoint(123), false);
  assertEquals(isValidWireguardEndpoint(""), false);
});

test("isValidNtpServer and assertValidNtpServer stay aligned with hostname/IP rules", () => {
  assertEquals(isValidNtpServer("time.example.test"), true);
  assertEquals(isValidNtpServer("203.0.113.1"), true);
  assertEquals(isValidNtpServer("2001:db8::1"), true);
  assertEquals(isValidNtpServer(""), false);
  assertEquals(isValidNtpServer("999.999.999.999"), false);
  assertEquals(isValidNtpServer("pool; rm -rf /"), false);
  assertThrows(
    () => assertValidNtpServer(123),
    Error,
    "Invalid NTP server",
  );
  assertValidNtpServer("203.0.113.1");
});

test("WireGuard validators accept canonical encodings and reject hostile input", () => {
  assertEquals(isValidWireguardPublicKey(WG_PUBKEY), true);
  assertEquals(isValidWireguardPublicKey(123), false);
  assertEquals(isValidWireguardPublicKey("short"), false);
  assertEquals(isValidWireguardPublicKey(`${WG_PUBKEY};`), false);
  assertEquals(isValidWireguardPublicKey(`${WG_PUBKEY} `), false);
  assertEquals(isValidWireguardListenPort(51820), true);
  assertEquals(isValidWireguardListenPort(0), false);
  assertEquals(isValidWireguardListenPort(65536), false);
  assertEquals(isValidWireguardListenPort(1.5), false);
  assertEquals(isValidWireguardAllowedIp("203.0.113.0/24"), true);
  assertEquals(isValidWireguardAllowedIp("2001:db8::/32"), true);
  assertEquals(isValidWireguardAllowedIp("203.0.113.0"), false);
  assertEquals(isValidWireguardAllowedIp("203.0.113.0/33"), false);
  assertEquals(isValidWireguardAllowedIp("203.0.113.0/not-a-prefix"), false);
  assertEquals(isValidWireguardEndpoint("203.0.113.10:51820"), true);
  assertEquals(isValidWireguardEndpoint("[2001:db8::1]:51820"), true);
  assertEquals(isValidWireguardEndpoint("relay.example.test:51820"), true);
  assertEquals(isValidWireguardEndpoint("203.0.113.10"), false);
  assertEquals(isValidWireguardEndpoint("203.0.113.10:0"), false);
  assertEquals(isValidWireguardEndpoint("203.0.113.10:not-a-port"), false);
});

test("parseFabricReconcilePayload rejects invalid peer keepalive and mtu", () => {
  const basePeer = {
    publicKey: WG_PUBKEY,
    allowedIPs: ["203.0.113.0/24"],
    keepalive: 25,
  };
  const basePayload = {
    enabled: true,
    address: "203.0.113.2/32",
    prefix: "10.192.0.0/16",
    peers: [basePeer],
  };
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        peers: [{ ...basePeer, keepalive: 0 }],
      }),
    TypeError,
    "Invalid fabric peer keepalive",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        mtu: 9001,
      }),
    TypeError,
    "Invalid fabric mtu",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        fabricId: "not-a-uuid",
      }),
    TypeError,
    "Invalid fabric fabricId",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        gateway: "yes",
      }),
    TypeError,
    "Invalid fabric gateway",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        networks: [{ name: "bad name", subnet: "10.192.11.0/24" }],
      }),
    TypeError,
    "Invalid fabric network name",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        peers: [{
          ...basePeer,
          pathKind: "vpn",
        }],
      }),
    TypeError,
    "Invalid fabric peer pathKind",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        peers: [null],
      }),
    TypeError,
    "Invalid fabric peer entry",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        peers: [{ publicKey: WG_PUBKEY, allowedIPs: "not-an-array" }],
      }),
    TypeError,
    "Invalid fabric peer allowedIPs",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        peers: [{
          publicKey: WG_PUBKEY,
          allowedIPs: ["203.0.113.0/24"],
          endpoint: "203.0.113.10",
        }],
      }),
    TypeError,
    "Invalid fabric peer endpoint",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        ...basePayload,
        peers: [{
          publicKey: WG_PUBKEY,
          allowedIPs: ["203.0.113.0/24"],
          presharedKeyEnvelope: "not-an-envelope",
        }],
      }),
    TypeError,
    "Invalid fabric peer presharedKeyEnvelope",
  );
});

test("parseEnvironmentStopPayload rejects invalid fabric network names", () => {
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        fabricNetworks: ["bridge_net1"],
      }),
    TypeError,
    "Invalid environment.stop fabricNetworks name",
  );
});

test("parseManagedReplicationHealth is lenient and preserves optional lag fields", () => {
  assertEquals(parseManagedReplicationHealth(undefined), undefined);
  assertEquals(parseManagedReplicationHealth("bad"), undefined);
  assertEquals(
    parseManagedReplicationHealth({
      state: "streaming",
      observedAt: "2026-08-09T12:00:00.000Z",
      lagBytes: 1024,
      lagSeconds: 2,
    }),
    {
      state: "streaming",
      observedAt: "2026-08-09T12:00:00.000Z",
      lagBytes: 1024,
      lagSeconds: 2,
    },
  );
  assertEquals(
    parseManagedReplicationHealth({
      state: "not-a-state",
      observedAt: "2026-08-09T12:00:00.000Z",
    }),
    undefined,
  );
});

test("parseManagedLifecycleResult and parseManagedDestroyResult round-trip", () => {
  assertEquals(
    parseManagedLifecycleResult({ status: "stopped", summary: "stopped" }),
    { status: "stopped", summary: "stopped" },
  );
  assertEquals(parseManagedLifecycleResult(null), { status: "" });
  assertEquals(
    parseManagedDestroyResult({
      status: "destroyed",
      summary: "destroyed",
      containers: [],
    }),
    { status: "destroyed", summary: "destroyed", containers: [] },
  );
  assertEquals(parseManagedDestroyResult(null), { status: "", containers: [] });
});

test("parseFabricReconcileResult rejects malformed peer observations", () => {
  assertThrows(
    () =>
      parseFabricReconcileResult({
        summary: "ok",
        peers: [{ publicKey: "short" }],
      }),
    TypeError,
    "Invalid fabric reconcile result peer publicKey",
  );
  assertThrows(
    () =>
      parseFabricReconcileResult({
        summary: "ok",
        skipped: "yes",
      }),
    TypeError,
    "Invalid fabric reconcile result skipped",
  );
});

test("parseManagedIngressReconcileResult accepts optional containers", () => {
  assertEquals(
    parseManagedIngressReconcileResult({
      summary: "ok",
      appliedUsers: ["app"],
      appliedBackends: ["00000000-0000-4000-8000-000000000001"],
      restarted: true,
    }),
    {
      summary: "ok",
      appliedUsers: ["app"],
      appliedBackends: ["00000000-0000-4000-8000-000000000001"],
      restarted: true,
    },
  );
  assertThrows(
    () =>
      parseManagedIngressReconcileResult({
        summary: "ok",
        appliedUsers: [],
        appliedBackends: [],
        restarted: "yes",
      }),
    TypeError,
    "Invalid managed.ingress.reconcile result",
  );
  assertEquals(
    parseManagedIngressReconcileResult({
      summary: "ok",
      appliedUsers: [],
      appliedBackends: [],
      restarted: false,
      containers: [{
        composeServiceName: "proxysql",
        containerId: "cid-1",
        containerName: "proxysql-1",
        status: "running",
        role: "ingress",
      }],
    }).containers?.length,
    1,
  );
});

test("parseManagedHaReconcileResult and parseManagedHaFailoverResult reject invalid shapes", () => {
  assertThrows(
    () =>
      parseManagedHaReconcileResult({
        summary: "ok",
        registeredClusters: [],
        restarted: "yes",
      }),
    TypeError,
    "Invalid managed.ha.reconcile result",
  );
  assertThrows(
    () =>
      parseManagedHaFailoverResult({
        summary: "ok",
        phase: "promote",
      }),
    TypeError,
    "Invalid managed.ha.failover result",
  );
});
