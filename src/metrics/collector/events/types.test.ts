import { assertEquals, assertNotEquals } from "@std/assert";
import { makeEvent } from "./types.ts";

const test = Deno.test.bind(Deno);

test("makeEvent: identical kind/entity/payload yields the same eventId, even at a different nowMs", () => {
  const a = makeEvent("nic_link_down", "critical", 1_000, {
    entityId: "mac:aa:bb",
    payload: { name: "eth0" },
  });
  const b = makeEvent("nic_link_down", "critical", 999_000, {
    entityId: "mac:aa:bb",
    payload: { name: "eth0" },
  });
  assertEquals(a.eventId, b.eventId);
  assertNotEquals(a.at, b.at);
});

test("makeEvent: payload key order never changes the eventId", () => {
  const a = makeEvent("fabric_peer_change", "info", 0, {
    entityId: "peer-1",
    payload: { from: "healthy", to: "stale" },
  });
  const b = makeEvent("fabric_peer_change", "info", 0, {
    entityId: "peer-1",
    payload: { to: "stale", from: "healthy" },
  });
  assertEquals(a.eventId, b.eventId);
});

test("makeEvent: a different entity produces a different eventId", () => {
  const a = makeEvent("nic_link_down", "critical", 0, {
    entityId: "mac:aa:bb",
  });
  const b = makeEvent("nic_link_down", "critical", 0, {
    entityId: "mac:cc:dd",
  });
  assertNotEquals(a.eventId, b.eventId);
});

test("makeEvent: a different payload produces a different eventId", () => {
  const a = makeEvent("oom_kill", "warning", 0, { payload: { count: 1 } });
  const b = makeEvent("oom_kill", "warning", 0, { payload: { count: 2 } });
  assertNotEquals(a.eventId, b.eventId);
});

test("makeEvent: a different kind produces a different eventId for otherwise-identical options", () => {
  const a = makeEvent("fabric_unavailable", "warning", 0, {
    entityId: "peer-1",
  });
  const b = makeEvent("fabric_recovered", "info", 0, { entityId: "peer-1" });
  assertNotEquals(a.eventId, b.eventId);
});

test("makeEvent: no options at all is stable across calls", () => {
  const a = makeEvent("clock_sync_lost", "warning", 0);
  const b = makeEvent("clock_sync_lost", "warning", 5_000);
  assertEquals(a.eventId, b.eventId);
});
