import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { GenerationEventCollector } from "./generation-events.ts";
import type { EventDetectContext } from "./types.ts";
import type { TopologySnapshot } from "../../topology/types.ts";

const test = Deno.test.bind(Deno);

function snapshot(
  generation: number,
  bootGeneration: number,
): TopologySnapshot {
  return {
    generation,
    bootGeneration,
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    cpu: {
      sockets: 1,
      coresPerSocket: 1,
      threadsPerSocket: 1,
      model: null,
      cores: [],
    },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
  };
}

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 1_000,
    snapshot: snapshot(1, 1),
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

test("GenerationEventCollector: first tick establishes the baseline, no fabricated event", () => {
  const collector = new GenerationEventCollector();
  assertEquals(collector.detect(ctx({ snapshot: snapshot(1, 1) })), []);
});

test("GenerationEventCollector: a topology generation bump fires topology_generation_changed", () => {
  const collector = new GenerationEventCollector();
  collector.detect(ctx({ snapshot: snapshot(1, 1) }));
  const events = collector.detect(
    ctx({ snapshot: snapshot(2, 1), nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "topology_generation_changed");
  assertEquals(events[0].payload, { from: 1, to: 2 });
});

test("GenerationEventCollector: a boot generation bump fires boot_generation_changed", () => {
  const collector = new GenerationEventCollector();
  collector.detect(ctx({ snapshot: snapshot(1, 1) }));
  const events = collector.detect(
    ctx({ snapshot: snapshot(1, 2), nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "boot_generation_changed");
  assertEquals(events[0].severity, "warning");
});

test("GenerationEventCollector: unchanged generations fire nothing", () => {
  const collector = new GenerationEventCollector();
  collector.detect(ctx({ snapshot: snapshot(4, 2) }));
  const events = collector.detect(
    ctx({ snapshot: snapshot(4, 2), nowMs: 2_000 }),
  );
  assertEquals(events, []);
});
