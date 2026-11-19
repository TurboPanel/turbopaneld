import { assertEquals, assertThrows } from "@std/assert";
import {
  parseTunnelStatusPayload,
  parseTunnelStatusResult,
} from "./commands-contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const GOOD = {
  pinnedVersion: "2026.11.1",
  connectors: [
    { tunnelId: ID, status: "connected", version: "2026.11.1", slot: "a" },
    { tunnelId: "instance", status: "stopped", version: "2026.5.0", slot: "b" },
  ],
};

test("server.tunnel.status takes no input", () => {
  assertEquals(parseTunnelStatusPayload({}), {});
  assertThrows(() => parseTunnelStatusPayload({ x: 1 }));
  assertThrows(() => parseTunnelStatusPayload(null));
  assertThrows(() => parseTunnelStatusPayload([]));
});

test("server.tunnel.status parses a result and an empty one", () => {
  assertEquals(parseTunnelStatusResult(GOOD), GOOD);
  assertEquals(
    parseTunnelStatusResult({ pinnedVersion: "2026.11.1", connectors: [] }),
    { pinnedVersion: "2026.11.1", connectors: [] },
  );
});

test("server.tunnel.status carries how the last update ended", () => {
  const withLast = (lastUpdate: unknown) => ({
    ...GOOD,
    connectors: [{ ...GOOD.connectors[0], lastUpdate }],
  });
  const rolled = {
    outcome: "rolled-back",
    at: "2026-10-28T12:00:00.000Z",
    reason: "the new connector did not report connected in time",
  };
  assertEquals(
    parseTunnelStatusResult(withLast(rolled)) as unknown,
    withLast(rolled),
  );
  const updated = { outcome: "updated", at: "2026-10-28T12:00:00Z" };
  assertEquals(
    parseTunnelStatusResult(withLast(updated)) as unknown,
    withLast(updated),
  );
  for (
    const bad of [
      { ...rolled, outcome: "paused" },
      { ...rolled, at: "yesterday" },
      { ...rolled, reason: "x".repeat(301) },
      { ...rolled, reason: 5 },
      "rolled-back",
    ]
  ) {
    assertThrows(() => parseTunnelStatusResult(withLast(bad)));
  }
});

test("server.tunnel.status refuses a malformed result", () => {
  const bad = (patch: Record<string, unknown>) =>
    assertThrows(() => parseTunnelStatusResult({ ...GOOD, ...patch }));
  bad({ pinnedVersion: "latest" });
  bad({ pinnedVersion: "1".repeat(40) });
  bad({ connectors: "none" });
  bad({ connectors: Array.from({ length: 601 }, () => GOOD.connectors[0]) });
  const one = (patch: Record<string, unknown>) =>
    bad({ connectors: [{ ...GOOD.connectors[0], ...patch }] });
  one({ tunnelId: "../x" });
  one({ tunnelId: ID.toUpperCase() });
  one({ status: "paused" });
  one({ version: "v1" });
  one({ slot: "c" });
  one({ slot: undefined });
});

test("server.tunnel.status keeps the connector facts and refuses bad ones", () => {
  const facts = {
    ...GOOD.connectors[0],
    edgeConnections: 4,
    hostnames: ["panel.example.com"],
  };
  const parsed = parseTunnelStatusResult({ ...GOOD, connectors: [facts] });
  assertEquals(parsed.connectors[0].edgeConnections, 4);
  assertEquals(parsed.connectors[0].hostnames, ["panel.example.com"]);
  const bad = (patch: Record<string, unknown>) =>
    assertThrows(() =>
      parseTunnelStatusResult({
        ...GOOD,
        connectors: [{ ...GOOD.connectors[0], ...patch }],
      })
    );
  bad({ edgeConnections: -1 });
  bad({ edgeConnections: 1.5 });
  bad({ edgeConnections: "4" });
  bad({ hostnames: "panel.example.com" });
  bad({ hostnames: [""] });
  bad({ hostnames: ["x".repeat(254)] });
  bad({
    hostnames: Array.from({ length: 101 }, (_, i) => `n${i}.example.com`),
  });
});

test("server.tunnel.status carries what the hop does about client certificates", () => {
  const down = {
    ...GOOD,
    peerClientAuth: "verify",
    peerClientAuthDowngraded: true,
  };
  assertEquals<unknown>(parseTunnelStatusResult(down), down);
  const ok = { ...GOOD, peerClientAuth: "require" };
  assertEquals<unknown>(parseTunnelStatusResult(ok), ok);
  assertThrows(() => parseTunnelStatusResult({ ...GOOD, peerClientAuth: "x" }));
  assertThrows(() =>
    parseTunnelStatusResult({ ...GOOD, peerClientAuthDowngraded: false })
  );
});

test("server.tunnel.status carries the last metrics port lock load, optionally", () => {
  assertEquals<unknown>(parseTunnelStatusResult(GOOD), GOOD);
  const at = "2026-11-19T10:00:00.000Z";
  const locked = {
    ...GOOD,
    statusPortsLocked: true,
    statusPortsLockCheckedAt: at,
  };
  assertEquals<unknown>(parseTunnelStatusResult(locked), locked);
  const bare = { ...GOOD, statusPortsLocked: true };
  assertEquals<unknown>(parseTunnelStatusResult(bare), bare);
  const failed = {
    ...GOOD,
    statusPortsLocked: false,
    statusPortsLockReason: "nft is not installed",
    statusPortsLockCheckedAt: at,
  };
  assertEquals<unknown>(parseTunnelStatusResult(failed), failed);
  const bad = (extra: Record<string, unknown>) =>
    assertThrows(() => parseTunnelStatusResult({ ...GOOD, ...extra }));
  bad({ statusPortsLocked: "yes" });
  bad({ statusPortsLockReason: "x" }); // a reason without a fact
  bad({ statusPortsLockCheckedAt: at }); // a time without a fact
  bad({ statusPortsLocked: true, statusPortsLockReason: "x" }); // reason only when false
  bad({ statusPortsLocked: false, statusPortsLockReason: 3 });
  bad({ statusPortsLocked: false, statusPortsLockReason: "" });
  bad({ statusPortsLocked: false, statusPortsLockReason: "a\nb" });
  bad({ statusPortsLocked: false, statusPortsLockReason: "a\rb" });
  bad({ statusPortsLocked: false, statusPortsLockReason: "a\tb" });
  bad({ statusPortsLocked: false, statusPortsLockReason: "a\u001b[31mb" });
  bad({ statusPortsLocked: false, statusPortsLockReason: "x".repeat(201) });
  bad({ statusPortsLocked: true, statusPortsLockCheckedAt: "yesterday" });
});

test("a status answer naming the retired tunnel id default is refused", () => {
  assertThrows(
    () =>
      parseTunnelStatusResult({
        pinnedVersion: "2026.5.2",
        connectors: [{
          tunnelId: "default",
          status: "connected",
          version: "2026.5.2",
          slot: "a",
        }],
      }),
    TypeError,
  );
});
