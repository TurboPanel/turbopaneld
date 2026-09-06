import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { NvmlGpuAdapter, openDefaultNvmlBinding } from "./nvml-adapter.ts";
import type { NvmlBinding, NvmlDeviceHandle } from "./nvml-adapter.ts";
import type { GpuReadContext } from "./adapter.ts";
import type { GpuTopology } from "../../topology/types.ts";

const test = Deno.test.bind(Deno);

const FAKE_HANDLE = {} as NvmlDeviceHandle;

function gpu(overrides: Partial<GpuTopology> = {}): GpuTopology {
  return {
    gpuId: "pci:0000:01:00.0",
    kind: "drm",
    pciPath: "0000:01:00.0",
    vendor: "nvidia",
    chip: "nvidia",
    ...overrides,
  };
}

function ctx(overrides: Partial<GpuReadContext> = {}): GpuReadContext {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    ...overrides,
  };
}

function fakeBinding(overrides: Partial<NvmlBinding> = {}): NvmlBinding {
  return {
    init: () => true,
    shutdown: () => {},
    getHandleByPciBusId: () => FAKE_HANDLE,
    getUtilizationRates: () => ({ gpuPercent: 33, memoryPercent: 12 }),
    getMemoryUsedBytes: () => 4 * 1024 * 1024 * 1024,
    getTemperatureCelsius: () => 58,
    getPowerWatts: () => 220,
    getPcieThroughputBytesPerSecond: () => ({ rx: 1024, tx: 2048 }),
    getThermalViolationNanoseconds: () => 0,
    getEccDoubleBitAggregateTotal: () => 0,
    getLastXidErrorCode: () => 0,
    getRemappedRows: () => ({
      correctable: 0,
      uncorrectable: 0,
      pending: false,
      failureOccurred: false,
    }),
    getRetiredPagesPending: () => false,
    ...overrides,
  };
}

test("NvmlGpuAdapter.read returns a full reading when the binding resolves every field", async () => {
  const adapter = new NvmlGpuAdapter({ openBinding: () => fakeBinding() });
  const reading = await adapter.read(gpu(), ctx());
  assertEquals(reading?.utilizationPercent, 33);
  assertEquals(reading?.memoryActivityPercent, 12);
  assertEquals(reading?.memoryUsedBytes, 4 * 1024 * 1024 * 1024);
  assertEquals(reading?.temperatureCelsius, 58);
  assertEquals(reading?.powerWatts, 220);
  assertEquals(reading?.pcieReceiveBytesPerSecond, 1024);
  assertEquals(reading?.pcieTransmitBytesPerSecond, 2048);
  // NVML has no stable memory-temperature call across driver versions.
  assertEquals(reading?.memoryTemperatureCelsius, null);
});

test("NvmlGpuAdapter.read returns null and stays inactive when the library can't be opened", async () => {
  let openAttempts = 0;
  const adapter = new NvmlGpuAdapter({
    openBinding: () => {
      openAttempts += 1;
      return null;
    },
  });
  assertEquals(await adapter.read(gpu(), ctx()), null);
  assertEquals(await adapter.read(gpu(), ctx()), null);
  // Probed once, memoized — never retried per-tick.
  assertEquals(openAttempts, 1);
});

test("NvmlGpuAdapter.read returns null and stays inactive when nvmlInit_v2 fails", async () => {
  const adapter = new NvmlGpuAdapter({
    openBinding: () => fakeBinding({ init: () => false }),
  });
  assertEquals(await adapter.read(gpu(), ctx()), null);
});

test("NvmlGpuAdapter.read returns null for a GPU with no resolvable PCI path", async () => {
  const adapter = new NvmlGpuAdapter({ openBinding: () => fakeBinding() });
  const reading = await adapter.read(gpu({ pciPath: "" }), ctx());
  assertEquals(reading, null);
});

test("NvmlGpuAdapter.read returns null when no device handle resolves for this GPU's PCI path", async () => {
  const adapter = new NvmlGpuAdapter({
    openBinding: () => fakeBinding({ getHandleByPciBusId: () => null }),
  });
  const reading = await adapter.read(gpu(), ctx());
  assertEquals(reading, null);
});

test("NvmlGpuAdapter.read caches the resolved handle across ticks instead of re-resolving by PCI bus id", async () => {
  let lookups = 0;
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getHandleByPciBusId: () => {
          lookups += 1;
          return FAKE_HANDLE;
        },
      }),
  });
  await adapter.read(gpu(), ctx());
  await adapter.read(gpu(), ctx());
  assertEquals(lookups, 1);
});

test("NvmlGpuAdapter.read nulls only the one field whose binding call throws", async () => {
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getPowerWatts: () => {
          throw new Error("driver glitch");
        },
      }),
  });
  const reading = await adapter.read(gpu(), ctx());
  assertEquals(reading?.powerWatts, null);
  assertEquals(reading?.utilizationPercent, 33);
  assertEquals(reading?.temperatureCelsius, 58);
});

test("NvmlGpuAdapter.read computes throttlePercent from the cumulative violation-ns counter via the shared tracker", async () => {
  const tracker = new CounterBaselineTracker();
  let violationNs = 0;
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getThermalViolationNanoseconds: () => violationNs,
      }),
  });

  // First tick: no prior baseline, so the tracker yields `null` (not 0).
  const first = await adapter.read(gpu(), ctx({ tracker }));
  assertEquals(first?.throttlePercent, null);

  // Second tick, 30s later: 15s of violation time out of 30s = 50%.
  violationNs = 15_000_000_000;
  const second = await adapter.read(gpu(), ctx({ tracker, seconds: 30 }));
  assertEquals(second?.throttlePercent, 50);
});

test("NvmlGpuAdapter.readHealthSignals resolves its own handle without a prior read()", async () => {
  let lookups = 0;
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getHandleByPciBusId: () => {
          lookups += 1;
          return FAKE_HANDLE;
        },
        getEccDoubleBitAggregateTotal: () => 3,
      }),
  });
  assertEquals(await adapter.readHealthSignals(gpu()), {
    eccDoubleBitAggregateTotal: 3,
    lastXidErrorCode: 0,
    remappedRows: {
      correctable: 0,
      uncorrectable: 0,
      pending: false,
      failureOccurred: false,
    },
    retiredPagesPending: false,
  });
  assertEquals(lookups, 1);
});

test("NvmlGpuAdapter.readHealthSignals returns every field null for a GPU with no resolvable PCI path", async () => {
  const adapter = new NvmlGpuAdapter({ openBinding: () => fakeBinding() });
  assertEquals(await adapter.readHealthSignals(gpu({ pciPath: "" })), {
    eccDoubleBitAggregateTotal: null,
    lastXidErrorCode: null,
    remappedRows: null,
    retiredPagesPending: null,
  });
});

test("NvmlGpuAdapter.readHealthSignals reuses the handle a prior read() already cached, without a second lookup", async () => {
  let lookups = 0;
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getHandleByPciBusId: () => {
          lookups += 1;
          return FAKE_HANDLE;
        },
        getEccDoubleBitAggregateTotal: () => 3,
      }),
  });
  await adapter.read(gpu(), ctx());
  assertEquals(
    (await adapter.readHealthSignals(gpu())).eccDoubleBitAggregateTotal,
    3,
  );
  assertEquals(lookups, 1);
});

test("NvmlGpuAdapter.readHealthSignals surfaces XID, remapped-row, and retirement state", async () => {
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getLastXidErrorCode: () => 79,
        getRemappedRows: () => ({
          correctable: 4,
          uncorrectable: 1,
          pending: true,
          failureOccurred: false,
        }),
        getRetiredPagesPending: () => true,
      }),
  });
  const signals = await adapter.readHealthSignals(gpu());
  assertEquals(signals.lastXidErrorCode, 79);
  assertEquals(signals.remappedRows, {
    correctable: 4,
    uncorrectable: 1,
    pending: true,
    failureOccurred: false,
  });
  assertEquals(signals.retiredPagesPending, true);
});

test("NvmlGpuAdapter.readHealthSignals returns every field null when NVML never activates", async () => {
  const adapter = new NvmlGpuAdapter({ openBinding: () => null });
  assertEquals(await adapter.readHealthSignals(gpu()), {
    eccDoubleBitAggregateTotal: null,
    lastXidErrorCode: null,
    remappedRows: null,
    retiredPagesPending: null,
  });
});

test("openDefaultNvmlBinding returns null when libnvidia-ml.so.1 cannot be opened", () => {
  assertEquals(openDefaultNvmlBinding(), null);
});

test("NvmlGpuAdapter.read nulls utilization and PCIe fields when those binding calls return null", async () => {
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getUtilizationRates: () => null,
        getPcieThroughputBytesPerSecond: () => null,
      }),
  });
  const reading = await adapter.read(gpu(), ctx());
  assertEquals(reading?.utilizationPercent, null);
  assertEquals(reading?.memoryActivityPercent, null);
  assertEquals(reading?.pcieReceiveBytesPerSecond, null);
  assertEquals(reading?.pcieTransmitBytesPerSecond, null);
  assertEquals(reading?.temperatureCelsius, 58);
});

test("NvmlGpuAdapter.read clamps throttlePercent to 100 when violation time exceeds the interval", async () => {
  const tracker = new CounterBaselineTracker();
  let violationNs = 0;
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getThermalViolationNanoseconds: () => violationNs,
      }),
  });
  await adapter.read(gpu(), ctx({ tracker }));
  violationNs = 90_000_000_000;
  const second = await adapter.read(gpu(), ctx({ tracker, seconds: 30 }));
  assertEquals(second?.throttlePercent, 100);
});

test("NvmlGpuAdapter.read stays inactive when openBinding throws", async () => {
  const adapter = new NvmlGpuAdapter({
    openBinding: () => {
      throw new Error("dlopen denied");
    },
  });
  assertEquals(await adapter.read(gpu(), ctx()), null);
  assertEquals(await adapter.read(gpu(), ctx()), null);
});

test("NvmlGpuAdapter.readHealthSignals returns every field null when no device handle resolves", async () => {
  const adapter = new NvmlGpuAdapter({
    openBinding: () => fakeBinding({ getHandleByPciBusId: () => null }),
  });
  assertEquals(await adapter.readHealthSignals(gpu()), {
    eccDoubleBitAggregateTotal: null,
    lastXidErrorCode: null,
    remappedRows: null,
    retiredPagesPending: null,
  });
});

test("NvmlGpuAdapter.readHealthSignals treats a throwing handle lookup as unresolved", async () => {
  const adapter = new NvmlGpuAdapter({
    openBinding: () =>
      fakeBinding({
        getHandleByPciBusId: () => {
          throw new Error("ABI mismatch");
        },
      }),
  });
  assertEquals(await adapter.readHealthSignals(gpu()), {
    eccDoubleBitAggregateTotal: null,
    lastXidErrorCode: null,
    remappedRows: null,
    retiredPagesPending: null,
  });
});
