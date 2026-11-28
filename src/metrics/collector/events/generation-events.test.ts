import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { GenerationEventCollector } from "./generation-events.ts";
import type { EventDetectContext } from "./types.ts";
import type { CollectedTopology } from "../../topology/topology.ts";

const test = Deno.test.bind(Deno);

function snapshot(bootGeneration: number): CollectedTopology {
  return {
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
    snapshot: snapshot(1),
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

test("GenerationEventCollector: first tick establishes the baseline, no fabricated event", () => {
  const collector = new GenerationEventCollector();
  assertEquals(collector.detect(ctx({ snapshot: snapshot(1) })), []);
});

test("GenerationEventCollector: a boot generation bump fires boot_generation_changed", () => {
  const collector = new GenerationEventCollector();
  collector.detect(ctx({ snapshot: snapshot(1) }));
  const events = collector.detect(
    ctx({ snapshot: snapshot(2), nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "boot_generation_changed");
  assertEquals(events[0].severity, "warning");
});

test("GenerationEventCollector: an unchanged boot generation fires nothing", () => {
  const collector = new GenerationEventCollector();
  collector.detect(ctx({ snapshot: snapshot(2) }));
  const events = collector.detect(
    ctx({ snapshot: snapshot(2), nowMs: 2_000 }),
  );
  assertEquals(events, []);
});
