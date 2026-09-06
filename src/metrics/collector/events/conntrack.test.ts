import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { ConntrackEventCollector } from "./conntrack.ts";
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

test("ConntrackEventCollector: baseline tick under the high-water mark fires nothing", () => {
  const collector = new ConntrackEventCollector();
  assertEquals(collector.detect(ctx({ conntrackUsedPercent: 50 })), []);
});

test("ConntrackEventCollector: crossing the high-water mark fires conntrack_exhaustion once", () => {
  const collector = new ConntrackEventCollector();
  const first = collector.detect(ctx({ conntrackUsedPercent: 95 }));
  assertEquals(first.length, 1);
  assertEquals(first[0].kind, "conntrack_exhaustion");
  assertEquals(first[0].severity, "critical");

  // Staying above the high-water mark never re-fires (no duplicate spam).
  const second = collector.detect(
    ctx({ conntrackUsedPercent: 96, nowMs: 2_000 }),
  );
  assertEquals(second, []);
});

test("ConntrackEventCollector: dropping under the low-water mark then re-crossing high fires again", () => {
  const collector = new ConntrackEventCollector();
  collector.detect(ctx({ conntrackUsedPercent: 95 }));
  collector.detect(ctx({ conntrackUsedPercent: 70, nowMs: 2_000 }));
  const events = collector.detect(
    ctx({ conntrackUsedPercent: 92, nowMs: 3_000 }),
  );
  assertEquals(events.length, 1);
});

test("ConntrackEventCollector: hysteresis band (between low and high) never re-arms", () => {
  const collector = new ConntrackEventCollector();
  collector.detect(ctx({ conntrackUsedPercent: 95 }));
  collector.detect(ctx({ conntrackUsedPercent: 85, nowMs: 2_000 }));
  const events = collector.detect(
    ctx({ conntrackUsedPercent: 92, nowMs: 3_000 }),
  );
  assertEquals(events, []);
});

test("ConntrackEventCollector: null percent (module not loaded) never fires", () => {
  const collector = new ConntrackEventCollector();
  assertEquals(collector.detect(ctx({ conntrackUsedPercent: null })), []);
});
