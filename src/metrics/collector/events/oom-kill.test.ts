import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { OomKillEventCollector } from "./oom-kill.ts";
import type { EventDetectContext } from "./types.ts";

const test = Deno.test.bind(Deno);

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 1_000,
    // deno-lint-ignore no-explicit-any
    snapshot: {} as any,
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    gpus: [],
    gpuThermals: new Map(),
    hardwareSignals: [],
    hardwareSignalCandidates: new Map(),
    oomKillTotal: null,
    conntrackUsedPercent: null,
    mountEntries: [],
    mdstatText: undefined,
    io: { listDir: () => [], readFile: () => undefined },
    isPhysical: false,
    ...overrides,
  };
}

test("OomKillEventCollector: first tick establishes the baseline, no fabricated event", () => {
  const collector = new OomKillEventCollector();
  const tracker = new CounterBaselineTracker();
  const events = collector.detect(ctx({ tracker, oomKillTotal: 5 }));
  assertEquals(events, []);
});

test("OomKillEventCollector: a positive delta fires a warning event", () => {
  const collector = new OomKillEventCollector();
  const tracker = new CounterBaselineTracker();
  collector.detect(ctx({ tracker, oomKillTotal: 5 }));
  const events = collector.detect(
    ctx({ tracker, oomKillTotal: 6, nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "oom_kill");
  assertEquals(events[0].severity, "warning");
  assertEquals(events[0].payload, { count: 1 });
});

test("OomKillEventCollector: 3+ kills in one interval escalate to critical", () => {
  const collector = new OomKillEventCollector();
  const tracker = new CounterBaselineTracker();
  collector.detect(ctx({ tracker, oomKillTotal: 0 }));
  const events = collector.detect(
    ctx({ tracker, oomKillTotal: 4, nowMs: 2_000 }),
  );
  assertEquals(events[0].severity, "critical");
});

test("OomKillEventCollector: no repeat event when the counter doesn't move", () => {
  const collector = new OomKillEventCollector();
  const tracker = new CounterBaselineTracker();
  collector.detect(ctx({ tracker, oomKillTotal: 2 }));
  const events = collector.detect(
    ctx({ tracker, oomKillTotal: 2, nowMs: 2_000 }),
  );
  assertEquals(events, []);
});

test("OomKillEventCollector: null counter (older kernel) never fires", () => {
  const collector = new OomKillEventCollector();
  const events = collector.detect(ctx({ oomKillTotal: null }));
  assertEquals(events, []);
});
