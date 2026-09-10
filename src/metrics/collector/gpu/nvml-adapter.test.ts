import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import {
  createNvmlBindingFromLibrary,
  NvmlGpuAdapter,
  openDefaultNvmlBinding,
} from "./nvml-adapter.ts";
import type {
  NvmlBinding,
  NvmlDeviceHandle,
  NvmlLibrary,
} from "./nvml-adapter.ts";
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

function writeU32(buf: Uint8Array, offset: number, value: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(
    offset,
    value,
    true,
  );
}

function writeU64(buf: Uint8Array, offset: number, value: bigint): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(
    offset,
    value,
    true,
  );
}

function writeI32(buf: Uint8Array, offset: number, value: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setInt32(
    offset,
    value,
    true,
  );
}

const NVML_FAIL = 1;

function fakeLibrary(
  overrides: Partial<NvmlLibrary["symbols"]> = {},
  close: () => void = () => {},
): NvmlLibrary {
  return {
    symbols: {
      nvmlInit_v2: () => 0,
      nvmlShutdown: () => 0,
      nvmlDeviceGetHandleByPciBusId_v2: (_bus, out) => {
        writeU64(out, 0, 0x100n);
        return 0;
      },
      nvmlDeviceGetUtilizationRates: (_handle, out) => {
        writeU32(out, 0, 41);
        writeU32(out, 4, 17);
        return 0;
      },
      nvmlDeviceGetMemoryInfo_v2: (_handle, out) => {
        writeU64(out, 24, 8n * 1024n * 1024n * 1024n);
        return 0;
      },
      nvmlDeviceGetTemperature: (_handle, _sensor, out) => {
        writeU32(out, 0, 62);
        return 0;
      },
      nvmlDeviceGetPowerUsage: (_handle, out) => {
        writeU32(out, 0, 215_000);
        return 0;
      },
      nvmlDeviceGetPcieThroughput: (_handle, counter, out) => {
        // NVML_PCIE_UTIL_TX_BYTES = 0, NVML_PCIE_UTIL_RX_BYTES = 1.
        writeU32(out, 0, counter === 1 ? 8 : 4);
        return 0;
      },
      nvmlDeviceGetViolationStatus: (_handle, _policy, out) => {
        writeU64(out, 8, 3_000_000_000n);
        return 0;
      },
      nvmlDeviceGetTotalEccErrors: (_handle, _bit, _counter, out) => {
        writeU64(out, 0, 5n);
        return 0;
      },
      nvmlDeviceGetFieldValues: (_handle, _count, out) => {
        writeI32(out, 28, 0);
        writeU32(out, 32, 79);
        return 0;
      },
      nvmlDeviceGetRemappedRows: (
        _handle,
        corr,
        unc,
        pending,
        failure,
      ) => {
        writeU32(corr, 0, 4);
        writeU32(unc, 0, 1);
        writeU32(pending, 0, 1);
        writeU32(failure, 0, 0);
        return 0;
      },
      nvmlDeviceGetRetiredPagesPendingStatus: (_handle, out) => {
        writeU32(out, 0, 1);
        return 0;
      },
      ...overrides,
    },
    close,
  };
}

test("createNvmlBindingFromLibrary decodes every NVML field from the FFI out-buffers", () => {
  const seenBusIds: Uint8Array[] = [];
  let closed = false;
  const binding = createNvmlBindingFromLibrary(fakeLibrary({
    nvmlDeviceGetHandleByPciBusId_v2: (bus, out) => {
      seenBusIds.push(new Uint8Array(bus));
      writeU64(out, 0, 0x100n);
      return 0;
    },
  }, () => {
    closed = true;
  }));

  assertEquals(binding.init(), true);
  const handle = binding.getHandleByPciBusId("0000:01:00.0");
  if (handle === null) {
    throw new TypeError("expected a decoded NVML handle");
  }
  assertEquals(
    new TextDecoder().decode(seenBusIds[0]).startsWith("0000:01:00.0"),
    true,
  );
  assertEquals(binding.getUtilizationRates(handle), {
    gpuPercent: 41,
    memoryPercent: 17,
  });
  assertEquals(binding.getMemoryUsedBytes(handle), 8 * 1024 * 1024 * 1024);
  assertEquals(binding.getTemperatureCelsius(handle), 62);
  assertEquals(binding.getPowerWatts(handle), 215);
  assertEquals(binding.getPcieThroughputBytesPerSecond(handle), {
    rx: 8 * 1024,
    tx: 4 * 1024,
  });
  assertEquals(binding.getThermalViolationNanoseconds(handle), 3_000_000_000);
  assertEquals(binding.getEccDoubleBitAggregateTotal(handle), 5);
  assertEquals(binding.getLastXidErrorCode(handle), 79);
  assertEquals(binding.getRemappedRows(handle), {
    correctable: 4,
    uncorrectable: 1,
    pending: true,
    failureOccurred: false,
  });
  assertEquals(binding.getRetiredPagesPending(handle), true);
  binding.shutdown();
  assertEquals(closed, true);
});

test("createNvmlBindingFromLibrary nulls a field when that NVML call returns non-success", () => {
  const binding = createNvmlBindingFromLibrary(fakeLibrary({
    nvmlDeviceGetHandleByPciBusId_v2: () => NVML_FAIL,
    nvmlDeviceGetUtilizationRates: () => NVML_FAIL,
    nvmlDeviceGetMemoryInfo_v2: () => NVML_FAIL,
    nvmlDeviceGetTemperature: () => NVML_FAIL,
    nvmlDeviceGetPowerUsage: () => NVML_FAIL,
    nvmlDeviceGetPcieThroughput: () => NVML_FAIL,
    nvmlDeviceGetViolationStatus: () => NVML_FAIL,
    nvmlDeviceGetTotalEccErrors: () => NVML_FAIL,
    nvmlDeviceGetFieldValues: () => NVML_FAIL,
    nvmlDeviceGetRemappedRows: () => NVML_FAIL,
    nvmlDeviceGetRetiredPagesPendingStatus: () => NVML_FAIL,
  }));
  const dummy = {} as NvmlDeviceHandle;
  assertEquals(binding.getHandleByPciBusId("0000:01:00.0"), null);
  assertEquals(binding.getUtilizationRates(dummy), null);
  assertEquals(binding.getMemoryUsedBytes(dummy), null);
  assertEquals(binding.getTemperatureCelsius(dummy), null);
  assertEquals(binding.getPowerWatts(dummy), null);
  assertEquals(binding.getPcieThroughputBytesPerSecond(dummy), null);
  assertEquals(binding.getThermalViolationNanoseconds(dummy), null);
  assertEquals(binding.getEccDoubleBitAggregateTotal(dummy), null);
  assertEquals(binding.getLastXidErrorCode(dummy), null);
  assertEquals(binding.getRemappedRows(dummy), null);
  assertEquals(binding.getRetiredPagesPending(dummy), null);
});

test("createNvmlBindingFromLibrary init returns false when nvmlInit_v2 throws or fails", () => {
  const failing = createNvmlBindingFromLibrary(fakeLibrary({
    nvmlInit_v2: () => NVML_FAIL,
  }));
  assertEquals(failing.init(), false);

  const throwing = createNvmlBindingFromLibrary(fakeLibrary({
    nvmlInit_v2: () => {
      throw new Error("ABI mismatch");
    },
  }));
  assertEquals(throwing.init(), false);
});

test("createNvmlBindingFromLibrary shutdown swallows library-close failures", () => {
  const binding = createNvmlBindingFromLibrary(fakeLibrary({}, () => {
    throw new Error("already closed");
  }));
  binding.shutdown();
});

test("createNvmlBindingFromLibrary treats a per-field XID nvmlReturn as missing", () => {
  const binding = createNvmlBindingFromLibrary(fakeLibrary({
    nvmlDeviceGetFieldValues: (_handle, _count, out) => {
      writeI32(out, 28, NVML_FAIL);
      writeU32(out, 32, 79);
      return 0;
    },
  }));
  const dummy = {} as NvmlDeviceHandle;
  assertEquals(binding.getLastXidErrorCode(dummy), null);
});

test("createNvmlBindingFromLibrary reports remapped-row failure and no pending retirement", () => {
  const binding = createNvmlBindingFromLibrary(fakeLibrary({
    nvmlDeviceGetRemappedRows: (_handle, corr, unc, pending, failure) => {
      writeU32(corr, 0, 0);
      writeU32(unc, 0, 2);
      writeU32(pending, 0, 0);
      writeU32(failure, 0, 1);
      return 0;
    },
    nvmlDeviceGetRetiredPagesPendingStatus: (_handle, out) => {
      writeU32(out, 0, 0);
      return 0;
    },
  }));
  const dummy = {} as NvmlDeviceHandle;
  assertEquals(binding.getRemappedRows(dummy), {
    correctable: 0,
    uncorrectable: 2,
    pending: false,
    failureOccurred: true,
  });
  assertEquals(binding.getRetiredPagesPending(dummy), false);
});

test("createNvmlBindingFromLibrary nulls PCIe when only one direction succeeds", () => {
  const binding = createNvmlBindingFromLibrary(fakeLibrary({
    nvmlDeviceGetPcieThroughput: (_handle, counter, out) => {
      if (counter === 0) {
        writeU32(out, 0, 4);
        return 0;
      }
      return NVML_FAIL;
    },
  }));
  const dummy = {} as NvmlDeviceHandle;
  assertEquals(binding.getPcieThroughputBytesPerSecond(dummy), null);
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
