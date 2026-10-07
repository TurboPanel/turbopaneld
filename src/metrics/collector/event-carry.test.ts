import { assertEquals } from "@std/assert";
import type { MetricEvent } from "../../contracts/metrics-contract.ts";
import { MAX_CARRIED_EVENTS, takeEventsForSample } from "./linux-collector.ts";

function event(
  i: number,
  severity: MetricEvent["severity"],
): MetricEvent {
  return {
    eventId: `e${i}`,
    at: new Date(Date.UTC(2026, 9, 7, 0, 0, i)).toISOString(),
    kind: "nic_link_down",
    severity,
    source: "test",
  } as MetricEvent;
}

Deno.test("a sample carries at most 16 events, most severe first, and the rest wait for the next sample", () => {
  const events = [
    ...Array.from({ length: 20 }, (_, i) => event(i, "info")),
    event(100, "critical"),
    event(101, "warning"),
  ];
  const { sent, carried } = takeEventsForSample(events);
  assertEquals(sent.length, 16);
  assertEquals(sent[0]?.severity, "critical");
  assertEquals(sent[1]?.severity, "warning");
  assertEquals(carried.length, events.length - 16);
});

Deno.test("an event storm never grows the carried set past its bound", () => {
  const storm = Array.from({ length: 1000 }, (_, i) => event(i, "info"));
  const { sent, carried } = takeEventsForSample(storm);
  assertEquals(sent.length, 16);
  assertEquals(carried.length, MAX_CARRIED_EVENTS);
});
