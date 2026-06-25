import { createMonitorDeltaTracker } from "./delta.ts";
import type { MonitorResourceState } from "./protocol.ts";

const resource = (
  key: string,
  status: MonitorResourceState["status"],
): MonitorResourceState => ({
  resourceKey: key,
  kind: "container",
  status,
});

Deno.test("buildSync returns sequence 1 on first call and includes all resources", () => {
  const tracker = createMonitorDeltaTracker();
  const bundle = tracker.buildSync({}, [resource("container:a", "healthy")]);
  assertEquals(bundle.sequence, 1);
  assertEquals(bundle.payload.sequence, 1);
  assertEquals(bundle.payload.resources?.length, 1);
});

Deno.test("buildHeartbeat returns only changed resources since last acked sequence", () => {
  const tracker = createMonitorDeltaTracker();
  tracker.seedTracked([resource("container:a", "healthy")]);
  tracker.registerPendingDelivery(1, [resource("container:a", "healthy")]);
  tracker.applyAck(1);

  const bundle = tracker.buildHeartbeat({}, [
    resource("container:a", "healthy"),
    resource("container:b", "starting"),
  ]);
  assertEquals(bundle.sequence, 2);
  assertEquals(bundle.payload.resources?.length, 1);
  assertEquals(bundle.payload.resources?.[0]?.resourceKey, "container:b");
});

Deno.test("applyAck advances baseline so subsequent heartbeats omit acked resources", () => {
  const tracker = createMonitorDeltaTracker();
  tracker.seedTracked([resource("container:a", "healthy")]);
  const first = tracker.buildHeartbeat({}, [
    resource("container:a", "degraded"),
  ]);
  tracker.registerPendingDelivery(first.sequence, first.resourcesAfter);
  tracker.applyAck(first.sequence);

  const second = tracker.buildHeartbeat({}, [
    resource("container:a", "degraded"),
  ]);
  assertEquals(second.payload.resources, undefined);
});

Deno.test("buildTransition emits a focused event for a single changed resource", () => {
  const tracker = createMonitorDeltaTracker();
  tracker.seedTracked([resource("container:a", "healthy")]);
  const next = resource("container:a", "unhealthy");
  const bundle = tracker.buildTransition(
    next.resourceKey,
    next,
    [next],
  );
  assertExists(bundle);
  assertEquals(bundle!.payload.events.length, 1);
  assertEquals(bundle!.payload.events[0]?.toStatus, "unhealthy");
});

Deno.test("buildRemovalTransition emits offline event for removed container", () => {
  const tracker = createMonitorDeltaTracker();
  const previous = resource("container:a", "healthy");
  tracker.seedTracked([previous]);
  const bundle = tracker.buildRemovalTransition(
    previous.resourceKey,
    previous,
    [],
  );
  assertEquals(bundle.payload.events[0]?.toStatus, "offline");
  assertEquals(bundle.payload.resources?.[0]?.status, "offline");
});

Deno.test("applyAck does not advance deliveredSequence beyond confirmed pending delivery", () => {
  const tracker = createMonitorDeltaTracker();
  const first = tracker.buildSync({}, [resource("container:a", "healthy")]);
  tracker.registerPendingDelivery(first.sequence, first.resourcesAfter);
  tracker.applyAck(6);

  assertEquals(tracker.getSequence(), first.sequence);
  const second = tracker.buildSync({}, [
    resource("container:a", "healthy"),
    resource("container:b", "healthy"),
  ]);
  assertEquals(second.sequence, first.sequence + 1);
});

Deno.test("buildSync establishes authoritative baseline after sequence gap", () => {
  const tracker = createMonitorDeltaTracker();
  const first = tracker.buildSync({}, [resource("container:a", "healthy")]);
  tracker.registerPendingDelivery(first.sequence, first.resourcesAfter);
  tracker.applyAck(first.sequence);

  const gapHeartbeat = tracker.buildHeartbeat({}, [
    resource("container:a", "degraded"),
  ]);
  tracker.registerPendingDelivery(
    gapHeartbeat.sequence,
    gapHeartbeat.resourcesAfter,
  );

  const resync = tracker.buildSync({}, [
    resource("container:a", "degraded"),
    resource("container:b", "healthy"),
  ]);
  assert(resync.sequence > gapHeartbeat.sequence);
  assertEquals(resync.payload.resources?.length, 2);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)} but got ${String(actual)}`);
  }
}

function assertExists<T>(value: T | null | undefined): asserts value is T {
  if (value == null) throw new Error("expected value to exist");
}

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}
