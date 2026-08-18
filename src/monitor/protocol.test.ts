import { assertEquals } from "@std/assert";
import {
  isMonitorResourceStatus,
  MONITOR_PROTOCOL_VERSION,
  parseMonitorMessage,
} from "./protocol.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER_ID = "00000000-0000-4000-8000-000000000011";

test("isMonitorResourceStatus accepts known statuses only", () => {
  assertEquals(isMonitorResourceStatus("healthy"), true);
  assertEquals(isMonitorResourceStatus("offline"), true);
  assertEquals(isMonitorResourceStatus("bogus"), false);
  assertEquals(isMonitorResourceStatus(42), false);
  assertEquals(isMonitorResourceStatus(null), false);
});

test("parseMonitorMessage returns null for invalid input", () => {
  assertEquals(parseMonitorMessage(null), null);
  assertEquals(parseMonitorMessage(42), null);
  assertEquals(parseMonitorMessage("not-json"), null);
  assertEquals(parseMonitorMessage({ type: "unknown" }), null);
  assertEquals(
    parseMonitorMessage({
      type: "monitor.sync",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      instance: {},
      resources: [],
      protocolVersion: 999,
    }),
    null,
  );
});

test("parseMonitorMessage accepts a sync message from JSON string", () => {
  const raw = JSON.stringify({
    type: "monitor.sync",
    from: "daemon",
    serverId: SERVER_ID,
    at: "2026-01-01T00:00:00Z",
    sequence: 3,
    instance: { uptimeSeconds: 10 },
    resources: [
      {
        resourceKey: "container:abc",
        kind: "container",
        status: "healthy",
        name: "web",
      },
    ],
    events: [
      {
        toStatus: "healthy",
        at: "2026-01-01T00:00:01Z",
        resourceKey: "container:abc",
        kind: "container",
        fromStatus: "starting",
        reason: "ready",
        sequence: 1,
      },
    ],
    protocolVersion: MONITOR_PROTOCOL_VERSION,
    daemonBuild: {
      commit: "abc1234",
      buildId: "build-1",
      builtAt: "2026-01-01T00:00:00Z",
      channel: "trunk",
    },
  });

  const parsed = parseMonitorMessage(raw);
  assertEquals(parsed?.type, "monitor.sync");
  if (parsed?.type !== "monitor.sync") {
    throw new TypeError("expected monitor.sync");
  }
  assertEquals(parsed.serverId, SERVER_ID);
  assertEquals(parsed.sequence, 3);
  assertEquals(parsed.protocolVersion, MONITOR_PROTOCOL_VERSION);
  assertEquals(parsed.resources.length, 1);
  assertEquals(parsed.events?.length, 1);
  assertEquals(parsed.daemonBuild?.commit, "abc1234");
  assertEquals(parsed.daemonBuild?.channel, "trunk");
});

test("parseMonitorMessage accepts heartbeat with optional resources", () => {
  const parsed = parseMonitorMessage({
    type: "monitor.heartbeat",
    from: "daemon",
    serverId: SERVER_ID,
    at: "2026-01-01T00:00:00Z",
    sequence: 4,
    instance: { load: { one: 0.5 } },
  });
  assertEquals(parsed?.type, "monitor.heartbeat");
  if (parsed?.type !== "monitor.heartbeat") {
    throw new TypeError("expected monitor.heartbeat");
  }
  assertEquals(parsed.resources, undefined);
  assertEquals(parsed.events, undefined);
});

test("parseMonitorMessage rejects heartbeat with invalid resources", () => {
  assertEquals(
    parseMonitorMessage({
      type: "monitor.heartbeat",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 4,
      instance: {},
      resources: [{ resourceKey: "x", kind: "container", status: "bogus" }],
    }),
    null,
  );
});

test("parseMonitorMessage accepts transition and ack messages", () => {
  const transition = parseMonitorMessage({
    type: "monitor.transition",
    from: "daemon",
    serverId: SERVER_ID,
    at: "2026-01-01T00:00:00Z",
    sequence: 5,
    events: [{ toStatus: "unhealthy", at: "2026-01-01T00:00:02Z" }],
  });
  assertEquals(transition?.type, "monitor.transition");
  if (transition?.type !== "monitor.transition") {
    throw new TypeError("expected monitor.transition");
  }
  assertEquals(transition.events.length, 1);

  const ack = parseMonitorMessage({
    type: "monitor.ack",
    from: "instance",
    serverId: SERVER_ID,
    at: "2026-01-01T00:00:00Z",
    acceptedSequence: 5,
    resyncNeeded: true,
  });
  assertEquals(ack?.type, "monitor.ack");
  if (ack?.type !== "monitor.ack") {
    throw new TypeError("expected monitor.ack");
  }
  assertEquals(ack.acceptedSequence, 5);
  assertEquals(ack.resyncNeeded, true);
});

test("parseMonitorMessage rejects ack with non-boolean resyncNeeded", () => {
  assertEquals(
    parseMonitorMessage({
      type: "monitor.ack",
      from: "instance",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      acceptedSequence: 1,
      resyncNeeded: "yes",
    }),
    null,
  );
});

test("parseMonitorMessage rejects sync with bad resource shape", () => {
  assertEquals(
    parseMonitorMessage({
      type: "monitor.sync",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      instance: {},
      resources: [{ resourceKey: "x", kind: "unknown", status: "healthy" }],
      protocolVersion: MONITOR_PROTOCOL_VERSION,
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.sync",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      instance: {},
      resources: [null],
      protocolVersion: MONITOR_PROTOCOL_VERSION,
    }),
    null,
  );
});

test("parseMonitorMessage rejects malformed events and daemon base", () => {
  assertEquals(
    parseMonitorMessage({
      type: "monitor.transition",
      from: "instance",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      events: [{ toStatus: "healthy", at: "2026-01-01T00:00:00Z" }],
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.transition",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: "1",
      events: [{ toStatus: "healthy", at: "2026-01-01T00:00:00Z" }],
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.heartbeat",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      instance: {},
      events: [{ toStatus: "healthy" }],
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.heartbeat",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      instance: {},
      events: [{
        toStatus: "healthy",
        at: "2026-01-01T00:00:00Z",
        fromStatus: "nope",
      }],
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.heartbeat",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      instance: {},
      events: [{
        toStatus: "healthy",
        at: "2026-01-01T00:00:00Z",
        reason: 12,
      }],
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.sync",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      instance: "bad",
      resources: [],
      protocolVersion: MONITOR_PROTOCOL_VERSION,
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.ack",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      acceptedSequence: 1,
    }),
    null,
  );
});

test("parseMonitorMessage ignores incomplete daemonBuild objects", () => {
  const parsed = parseMonitorMessage({
    type: "monitor.heartbeat",
    from: "daemon",
    serverId: SERVER_ID,
    at: "2026-01-01T00:00:00Z",
    sequence: 1,
    instance: {},
    daemonBuild: { commit: "", buildId: "x" },
  });
  assertEquals(parsed?.type, "monitor.heartbeat");
  if (parsed?.type !== "monitor.heartbeat") {
    throw new TypeError("expected monitor.heartbeat");
  }
  assertEquals(parsed.daemonBuild, undefined);
});

test("parseMonitorMessage accepts heartbeat resources and rejects bad kinds", () => {
  const parsed = parseMonitorMessage({
    type: "monitor.heartbeat",
    from: "daemon",
    serverId: SERVER_ID,
    at: "2026-01-01T00:00:00Z",
    sequence: 2,
    instance: { cpu: { cores: 4 } },
    resources: [{
      resourceKey: "service:web",
      kind: "service",
      status: "degraded",
      name: "web",
    }],
    events: [{
      toStatus: "degraded",
      at: "2026-01-01T00:00:01Z",
      resourceKey: "service:web",
      kind: "service",
      fromStatus: "healthy",
      reason: "status_change",
      sequence: 2,
    }],
  });
  assertEquals(parsed?.type, "monitor.heartbeat");
  if (parsed?.type !== "monitor.heartbeat") {
    throw new TypeError("expected monitor.heartbeat");
  }
  assertEquals(parsed.resources?.length, 1);
  assertEquals(parsed.events?.length, 1);

  assertEquals(
    parseMonitorMessage({
      type: "monitor.sync",
      from: "daemon",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      instance: {},
      resources: [{ resourceKey: "x", kind: 12, status: "healthy" }],
      protocolVersion: MONITOR_PROTOCOL_VERSION,
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.ack",
      from: "instance",
      serverId: SERVER_ID,
      at: "2026-01-01T00:00:00Z",
      acceptedSequence: "1",
    }),
    null,
  );
  assertEquals(
    parseMonitorMessage({
      type: "monitor.transition",
      from: "daemon",
      serverId: 12,
      at: "2026-01-01T00:00:00Z",
      sequence: 1,
      events: [{ toStatus: "healthy", at: "2026-01-01T00:00:00Z" }],
    }),
    null,
  );
});
