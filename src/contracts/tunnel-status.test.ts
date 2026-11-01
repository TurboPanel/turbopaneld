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
  pinnedVersion: "2026.10.7",
  connectors: [
    { tunnelId: ID, status: "connected", version: "2026.10.7", slot: "a" },
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
    parseTunnelStatusResult({ pinnedVersion: "2026.10.7", connectors: [] }),
    { pinnedVersion: "2026.10.7", connectors: [] },
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
