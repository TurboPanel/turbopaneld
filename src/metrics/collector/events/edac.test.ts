import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { EdacEventCollector } from "./edac.ts";
import type { EventDetectContext } from "./types.ts";
import type { SensorIo } from "../sensors/discovery.ts";

const test = Deno.test.bind(Deno);

function edacIo(ce: string, ue: string): SensorIo {
  const files: Record<string, string> = {
    "/sys/devices/system/edac/mc/mc0/ce_count": ce,
    "/sys/devices/system/edac/mc/mc0/ue_count": ue,
  };
  return {
    listDir: (path) => path === "/sys/devices/system/edac/mc" ? ["mc0"] : [],
    readFile: (path) => files[path],
  };
}

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
    io: edacIo("0", "0"),
    isPhysical: true,
    ...overrides,
  };
}

test("EdacEventCollector: a VM (isPhysical false) never reads sysfs and never fires", async () => {
  const collector = new EdacEventCollector();
  let read = false;
  const io: SensorIo = {
    listDir: () => {
      read = true;
      return [];
    },
    readFile: () => undefined,
  };
  const events = await collector.detect(ctx({ isPhysical: false, io }));
  assertEquals(events, []);
  assertEquals(read, false);
});

test("EdacEventCollector: first tick establishes the baseline, no fabricated event", async () => {
  const collector = new EdacEventCollector();
  const tracker = new CounterBaselineTracker();
  const events = await collector.detect(ctx({ tracker, io: edacIo("2", "0") }));
  assertEquals(events, []);
});

test("EdacEventCollector: a positive corrected-error delta fires edac_corrected", async () => {
  const collector = new EdacEventCollector();
  const tracker = new CounterBaselineTracker();
  await collector.detect(ctx({ tracker, io: edacIo("2", "0") }));
  const events = await collector.detect(
    ctx({ tracker, io: edacIo("5", "0"), nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "edac_corrected");
  assertEquals(events[0].payload, { count: 3 });
});

test("EdacEventCollector: a positive uncorrected-error delta fires edac_uncorrected (critical)", async () => {
  const collector = new EdacEventCollector();
  const tracker = new CounterBaselineTracker();
  await collector.detect(ctx({ tracker, io: edacIo("0", "0") }));
  const events = await collector.detect(
    ctx({ tracker, io: edacIo("0", "1"), nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "edac_uncorrected");
  assertEquals(events[0].severity, "critical");
});

test("EdacEventCollector: no EDAC sysfs tree present resolves to nothing", async () => {
  const collector = new EdacEventCollector();
  const events = await collector.detect(
    ctx({ io: { listDir: () => [], readFile: () => undefined } }),
  );
  assertEquals(events, []);
});
