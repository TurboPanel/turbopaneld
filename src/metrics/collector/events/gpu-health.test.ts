import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { GpuHealthEventCollector } from "./gpu-health.ts";
import type { GpuHealthSignals } from "./gpu-health.ts";
import type { EventDetectContext } from "./types.ts";
import type { GpuTopology, TopologySnapshot } from "../../topology/types.ts";
import type { GpuSample } from "../../contract.ts";
import type { GpuThermalReadings } from "../gpu/index.ts";

const test = Deno.test.bind(Deno);

const GPU: GpuTopology = {
  gpuId: "pci:0000:01:00.0",
  kind: "drm",
  pciPath: "0000:01:00.0",
  vendor: "nvidia",
  chip: "nvidia",
};

const EMPTY_HEALTH: GpuHealthSignals = {
  eccDoubleBitAggregateTotal: null,
  lastXidErrorCode: null,
  remappedRows: null,
  retiredPagesPending: null,
};

const GPU_SAMPLE: GpuSample = {
  gpuId: GPU.gpuId,
  utilizationPercent: null,
  memoryUsedBytes: null,
  memoryActivityPercent: null,
  pcieReceiveBytesPerSecond: null,
  pcieTransmitBytesPerSecond: null,
  throttlePercent: null,
};

/**
 * GPU temperature is a `hardware.physical` reading now, not a `GpuSample`
 * field, so the thermal cross-check reads `ctx.gpuThermals` — the adapter
 * merge itself, which still exists on a GPU-passthrough VM where the whole
 * `hardware.physical` family does not.
 */
function gpuThermals(
  temperatureCelsius: number | null,
): GpuThermalReadings {
  return new Map([[GPU.gpuId, {
    temperatureCelsius,
    memoryTemperatureCelsius: null,
    powerWatts: null,
  }]]);
}

function snapshot(gpus: GpuTopology[]): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 1,
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus,
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
    nowMs: 0,
    snapshot: snapshot([GPU]),
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    gpus: [GPU_SAMPLE],
    gpuThermals: gpuThermals(60),
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

test("GpuHealthEventCollector: a new Xid code fires gpu_xid", async () => {
  const collector = new GpuHealthEventCollector({
    reader: () => Promise.resolve({ ...EMPTY_HEALTH, lastXidErrorCode: 13 }),
  });
  const events = await collector.detect(ctx());
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_xid");
  assertEquals(events[0].payload, { xid: 13 });
});

test("GpuHealthEventCollector: repeated identical Xid never re-fires", async () => {
  const collector = new GpuHealthEventCollector({
    reader: () => Promise.resolve({ ...EMPTY_HEALTH, lastXidErrorCode: 13 }),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  const events = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events, []);
});

test("GpuHealthEventCollector: Xid 79 fires gpu_xid (critical) and gpu_fallen_off_bus", async () => {
  const collector = new GpuHealthEventCollector({
    reader: () => Promise.resolve({ ...EMPTY_HEALTH, lastXidErrorCode: 79 }),
  });
  const events = await collector.detect(ctx());
  const kinds = events.map((e) => e.kind).sort();
  assertEquals(kinds, ["gpu_fallen_off_bus", "gpu_xid"]);
  assertEquals(events.find((e) => e.kind === "gpu_xid")?.severity, "critical");
});

test("GpuHealthEventCollector: a positive ECC delta fires gpu_ecc", async () => {
  let ecc = 0;
  const tracker = new CounterBaselineTracker();
  const collector = new GpuHealthEventCollector({
    reader: () =>
      Promise.resolve({ ...EMPTY_HEALTH, eccDoubleBitAggregateTotal: ecc }),
  });
  await collector.detect(ctx({ tracker, nowMs: 0 }));
  ecc = 4;
  const events = await collector.detect(ctx({ tracker, nowMs: 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_ecc");
  assertEquals(events[0].payload, { count: 4 });
});

test("GpuHealthEventCollector: remapped-rows pending rising edge fires gpu_row_remap once", async () => {
  let pending = false;
  const collector = new GpuHealthEventCollector({
    reader: () =>
      Promise.resolve({
        ...EMPTY_HEALTH,
        remappedRows: {
          correctable: 1,
          uncorrectable: 0,
          pending,
          failureOccurred: false,
        },
      }),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  pending = true;
  const events = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_row_remap");
  const again = await collector.detect(ctx({ nowMs: 2_000 }));
  assertEquals(again, []);
});

test("GpuHealthEventCollector: remap pending fires gpu_row_remap critical when failureOccurred is true", async () => {
  const collector = new GpuHealthEventCollector({
    reader: () =>
      Promise.resolve({
        ...EMPTY_HEALTH,
        remappedRows: {
          correctable: 0,
          uncorrectable: 1,
          pending: true,
          failureOccurred: true,
        },
      }),
  });
  const events = await collector.detect(ctx());
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_row_remap");
  assertEquals(events[0].severity, "critical");
});

test("GpuHealthEventCollector: a remap failure surfacing on an already-pending row still fires (severe case)", async () => {
  let failureOccurred = false;
  const collector = new GpuHealthEventCollector({
    reader: () =>
      Promise.resolve({
        ...EMPTY_HEALTH,
        remappedRows: {
          correctable: 0,
          uncorrectable: 1,
          pending: true,
          failureOccurred,
        },
      }),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  failureOccurred = true;
  const events = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_row_remap");
  assertEquals(events[0].severity, "critical");
});

test("GpuHealthEventCollector: retirement pending rising edge fires gpu_retirement once", async () => {
  let pending = false;
  const collector = new GpuHealthEventCollector({
    reader: () =>
      Promise.resolve({ ...EMPTY_HEALTH, retiredPagesPending: pending }),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  pending = true;
  const events = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_retirement");
});

test("GpuHealthEventCollector: GPU thermal at/above the critical threshold fires gpu_thermal_critical once", async () => {
  const collector = new GpuHealthEventCollector({
    reader: () => Promise.resolve(EMPTY_HEALTH),
  });
  await collector.detect(ctx({ gpuThermals: gpuThermals(60), nowMs: 0 }));
  const events = await collector.detect(
    ctx({ gpuThermals: gpuThermals(110), nowMs: 1_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_thermal_critical");
  const again = await collector.detect(
    ctx({ gpuThermals: gpuThermals(111), nowMs: 2_000 }),
  );
  assertEquals(again, []);
});

test("GpuHealthEventCollector: a GPU dropping out of topology fires gpu_disappeared", async () => {
  const collector = new GpuHealthEventCollector({
    reader: () => Promise.resolve(EMPTY_HEALTH),
  });
  await collector.detect(ctx({ snapshot: snapshot([GPU]), nowMs: 0 }));
  const events = await collector.detect(
    ctx({ snapshot: snapshot([]), nowMs: 1_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_disappeared");
});

test("GpuHealthEventCollector: a healthy GPU going all-null after a prior healthy read fires gpu_fallen_off_bus", async () => {
  let allNull = false;
  const collector = new GpuHealthEventCollector({
    reader: () =>
      Promise.resolve(
        allNull ? EMPTY_HEALTH : { ...EMPTY_HEALTH, lastXidErrorCode: 1 },
      ),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  allNull = true;
  const events = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "gpu_fallen_off_bus");
});

test("GpuHealthEventCollector: an always-inactive adapter (never healthy) never fabricates fallen_off_bus", async () => {
  const collector = new GpuHealthEventCollector({
    reader: () => Promise.resolve(EMPTY_HEALTH),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  const events = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events, []);
});
