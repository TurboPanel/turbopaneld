import { createMonitorDeltaTracker } from "./delta.ts";
import type { MonitorResourceState } from "./protocol.ts";
import { assert, assertEquals, assertExists } from "@std/assert";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const resource = (
  key: string,
  status: MonitorResourceState["status"],
): MonitorResourceState => ({
  resourceKey: key,
  kind: "container",
  status,
});

test("buildSync returns sequence 1 on first call and includes all resources", () => {
  const tracker = createMonitorDeltaTracker();
  const bundle = tracker.buildSync({}, [resource("container:a", "healthy")]);
  assertEquals(bundle.sequence, 1);
  assertEquals(bundle.payload.sequence, 1);
  assertEquals(bundle.payload.resources?.length, 1);
});

test("buildHeartbeat returns only changed resources since last acked sequence", () => {
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

test("applyAck advances baseline so subsequent heartbeats omit acked resources", () => {
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

test("buildTransition emits a focused event for a single changed resource", () => {
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

test("buildRemovalTransition emits offline event for removed container", () => {
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

test("applyAck does not advance deliveredSequence beyond confirmed pending delivery", () => {
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

test("buildSync establishes authoritative baseline after sequence gap", () => {
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
