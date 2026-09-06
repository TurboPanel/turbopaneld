/**
 * NVIDIA NVML FFI adapter — direct `libnvidia-ml.so.1` bindings via
 * `Deno.dlopen`, which needs `--allow-ffi` (added to every deno.json task
 * that runs the daemon — `deno.json`). Library absence, permission denial,
 * or an unexpected ABI all degrade this adapter to permanently inactive for
 * the process lifetime — probed once (`probe`), never retried per-tick.
 *
 * GPU identity correlation reuses the same PCI slot-name identity topology
 * already discovers (`GpuTopology.pciPath`, from `topology/identity.ts`'s
 * `parsePciSlotName`) via `nvmlDeviceGetHandleByPciBusId_v2` — there is no
 * separate NVML-index enumeration/identity scheme here.
 *
 * This file is the single place raw NVML FFI structs are laid out. The
 * `NvmlBinding` seam sits above the raw symbol table so tests can exercise
 * adapter/merge logic without `Deno.dlopen` or a real NVIDIA driver. Every
 * per-field read is independently wrapped (`safeCall`) — one field's ABI
 * mismatch or driver-version quirk nulls only that field, never the whole
 * reading.
 */
import type { GpuTopology } from "../../topology/types.ts";
import type { GpuAdapter, GpuReadContext, GpuReading } from "./adapter.ts";

const NVML_LIBRARY = "libnvidia-ml.so.1";
const NVML_SUCCESS = 0;

/** `nvmlTemperatureSensors_t` — GPU die sensor. */
const NVML_TEMPERATURE_GPU = 0;
/** `nvmlPcieUtilCounter_t`. */
const NVML_PCIE_UTIL_TX_BYTES = 0;
const NVML_PCIE_UTIL_RX_BYTES = 1;
/** `nvmlPerfPolicyType_t` — thermal slowdown only; power-cap slowdown is not read here. */
const NVML_PERF_POLICY_THERMAL = 1;
/** `nvmlEccBitType_t` / `nvmlEccCounterType_t` — aggregate double-bit only. */
const NVML_DOUBLE_BIT_ECC = 1;
const NVML_AGGREGATE_ECC = 1;
/** `nvmlFieldId_t` — `NVML_FI_DEV_XID_ERRORS`, the last Xid error code observed. */
const NVML_FIELD_ID_XID_ERRORS = 55;

const NVML_SYMBOLS = {
  nvmlInit_v2: { parameters: [], result: "i32" },
  nvmlShutdown: { parameters: [], result: "i32" },
  nvmlDeviceGetHandleByPciBusId_v2: {
    parameters: ["buffer", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetUtilizationRates: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetMemoryInfo_v2: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetTemperature: {
    parameters: ["pointer", "u32", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetPowerUsage: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetPcieThroughput: {
    parameters: ["pointer", "u32", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetViolationStatus: {
    parameters: ["pointer", "u32", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetTotalEccErrors: {
    parameters: ["pointer", "u32", "u32", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetFieldValues: {
    parameters: ["pointer", "i32", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetRemappedRows: {
    parameters: ["pointer", "buffer", "buffer", "buffer", "buffer"],
    result: "i32",
  },
  nvmlDeviceGetRetiredPagesPendingStatus: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
} as const;

/** Opaque `nvmlDevice_t` handle, reconstructed from the FFI out-param bytes. */
export type NvmlDeviceHandle = Deno.PointerValue;

/**
 * Vendor-neutral surface over the raw FFI symbol table — the injectable
 * seam tests use to exercise adapter logic without `Deno.dlopen` or a real
 * NVIDIA driver. {@link openDefaultNvmlBinding} is the only implementation
 * that touches `Deno.dlopen` directly.
 */
export type NvmlBinding = {
  init(): boolean;
  shutdown(): void;
  getHandleByPciBusId(pciBusId: string): NvmlDeviceHandle | null;
  getUtilizationRates(
    handle: NvmlDeviceHandle,
  ): { gpuPercent: number; memoryPercent: number } | null;
  getMemoryUsedBytes(handle: NvmlDeviceHandle): number | null;
  getTemperatureCelsius(handle: NvmlDeviceHandle): number | null;
  getPowerWatts(handle: NvmlDeviceHandle): number | null;
  getPcieThroughputBytesPerSecond(
    handle: NvmlDeviceHandle,
  ): { rx: number; tx: number } | null;
  getThermalViolationNanoseconds(handle: NvmlDeviceHandle): number | null;
  getEccDoubleBitAggregateTotal(handle: NvmlDeviceHandle): number | null;
  /** Last Xid critical-error code observed for this device, `null` when none has been recorded. */
  getLastXidErrorCode(handle: NvmlDeviceHandle): number | null;
  getRemappedRows(handle: NvmlDeviceHandle): NvmlRemappedRows | null;
  /** Whether a row-retirement (page-retirement) event is pending a reboot to take effect. */
  getRetiredPagesPending(handle: NvmlDeviceHandle): boolean | null;
};

/** `nvmlDeviceGetRemappedRows` — row-remapping ECC-repair state (Ampere+). */
export type NvmlRemappedRows = {
  correctable: number;
  uncorrectable: number;
  pending: boolean;
  failureOccurred: boolean;
};

function readPointer(buf: Uint8Array): Deno.PointerValue {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return Deno.UnsafePointer.create(view.getBigUint64(0, true));
}

function pciBusIdBuffer(pciBusId: string): Uint8Array {
  return new TextEncoder().encode(`${pciBusId}\0`);
}

/** Real `Deno.dlopen` binding. `null` when the library can't be opened. */
export function openDefaultNvmlBinding(): NvmlBinding | null {
  let lib: Deno.DynamicLibrary<typeof NVML_SYMBOLS>;
  try {
    lib = Deno.dlopen(NVML_LIBRARY, NVML_SYMBOLS);
  } catch {
    return null;
  }
  const sym = lib.symbols;

  return {
    init(): boolean {
      try {
        return sym.nvmlInit_v2() === NVML_SUCCESS;
      } catch {
        return false;
      }
    },
    shutdown(): void {
      try {
        sym.nvmlShutdown();
        lib.close();
      } catch {
        // Best-effort — the process is likely exiting anyway.
      }
    },
    getHandleByPciBusId(pciBusId: string): NvmlDeviceHandle | null {
      const out = new Uint8Array(8);
      const rc = sym.nvmlDeviceGetHandleByPciBusId_v2(
        pciBusIdBuffer(pciBusId),
        out,
      );
      if (rc !== NVML_SUCCESS) return null;
      return readPointer(out);
    },
    getUtilizationRates(handle) {
      const out = new Uint8Array(8);
      const rc = sym.nvmlDeviceGetUtilizationRates(handle, out);
      if (rc !== NVML_SUCCESS) return null;
      const view = new DataView(out.buffer);
      return {
        gpuPercent: view.getUint32(0, true),
        memoryPercent: view.getUint32(4, true),
      };
    },
    getMemoryUsedBytes(handle) {
      // nvmlMemory_v2_t: { u32 version; u64 total; u64 reserved; u64 free; u64 used; } (40 bytes, 8-byte aligned).
      const STRUCT_SIZE = 40;
      const out = new Uint8Array(STRUCT_SIZE);
      const view = new DataView(out.buffer);
      // NVML_STRUCT_VERSION(Memory, 2) = sizeof(nvmlMemory_v2_t) | (2 << 24)
      view.setUint32(0, STRUCT_SIZE | (2 << 24), true);
      const rc = sym.nvmlDeviceGetMemoryInfo_v2(handle, out);
      if (rc !== NVML_SUCCESS) return null;
      return Number(view.getBigUint64(24, true));
    },
    getTemperatureCelsius(handle) {
      const out = new Uint8Array(4);
      const rc = sym.nvmlDeviceGetTemperature(
        handle,
        NVML_TEMPERATURE_GPU,
        out,
      );
      if (rc !== NVML_SUCCESS) return null;
      return new DataView(out.buffer).getUint32(0, true);
    },
    getPowerWatts(handle) {
      const out = new Uint8Array(4);
      const rc = sym.nvmlDeviceGetPowerUsage(handle, out);
      if (rc !== NVML_SUCCESS) return null;
      return new DataView(out.buffer).getUint32(0, true) / 1000;
    },
    getPcieThroughputBytesPerSecond(handle) {
      const rxOut = new Uint8Array(4);
      const txOut = new Uint8Array(4);
      const rxRc = sym.nvmlDeviceGetPcieThroughput(
        handle,
        NVML_PCIE_UTIL_RX_BYTES,
        rxOut,
      );
      const txRc = sym.nvmlDeviceGetPcieThroughput(
        handle,
        NVML_PCIE_UTIL_TX_BYTES,
        txOut,
      );
      if (rxRc !== NVML_SUCCESS || txRc !== NVML_SUCCESS) return null;
      return {
        rx: new DataView(rxOut.buffer).getUint32(0, true) * 1024,
        tx: new DataView(txOut.buffer).getUint32(0, true) * 1024,
      };
    },
    getThermalViolationNanoseconds(handle) {
      // nvmlViolationTime_t: { u64 referenceTime; u64 violationTime; }
      const out = new Uint8Array(16);
      const rc = sym.nvmlDeviceGetViolationStatus(
        handle,
        NVML_PERF_POLICY_THERMAL,
        out,
      );
      if (rc !== NVML_SUCCESS) return null;
      return Number(new DataView(out.buffer).getBigUint64(8, true));
    },
    getEccDoubleBitAggregateTotal(handle) {
      const out = new Uint8Array(8);
      const rc = sym.nvmlDeviceGetTotalEccErrors(
        handle,
        NVML_DOUBLE_BIT_ECC,
        NVML_AGGREGATE_ECC,
        out,
      );
      if (rc !== NVML_SUCCESS) return null;
      return Number(new DataView(out.buffer).getBigUint64(0, true));
    },
    getLastXidErrorCode(handle) {
      // nvmlFieldValue_t: { u32 fieldId; u32 scopeId; i64 timestamp;
      // i64 latencyUsec; u32 valueType; i32 nvmlReturn; u64 value; }
      // (40 bytes, 8-byte aligned). `nvmlReturn` at offset 28 is this one
      // field's own per-value status, independent of the call's overall rc.
      const STRUCT_SIZE = 40;
      const out = new Uint8Array(STRUCT_SIZE);
      const view = new DataView(out.buffer);
      view.setUint32(0, NVML_FIELD_ID_XID_ERRORS, true);
      const rc = sym.nvmlDeviceGetFieldValues(handle, 1, out);
      if (rc !== NVML_SUCCESS) return null;
      if (view.getInt32(28, true) !== NVML_SUCCESS) return null;
      return view.getUint32(32, true);
    },
    getRemappedRows(handle) {
      const corrOut = new Uint8Array(4);
      const uncOut = new Uint8Array(4);
      const pendingOut = new Uint8Array(4);
      const failureOut = new Uint8Array(4);
      const rc = sym.nvmlDeviceGetRemappedRows(
        handle,
        corrOut,
        uncOut,
        pendingOut,
        failureOut,
      );
      if (rc !== NVML_SUCCESS) return null;
      return {
        correctable: new DataView(corrOut.buffer).getUint32(0, true),
        uncorrectable: new DataView(uncOut.buffer).getUint32(0, true),
        pending: new DataView(pendingOut.buffer).getUint32(0, true) !== 0,
        failureOccurred: new DataView(failureOut.buffer).getUint32(0, true) !==
          0,
      };
    },
    getRetiredPagesPending(handle) {
      const out = new Uint8Array(4);
      const rc = sym.nvmlDeviceGetRetiredPagesPendingStatus(handle, out);
      if (rc !== NVML_SUCCESS) return null;
      return new DataView(out.buffer).getUint32(0, true) !== 0;
    },
  };
}

function safeCall<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export class NvmlGpuAdapter implements GpuAdapter {
  readonly id = "nvml" as const;
  readonly #openBinding: () => NvmlBinding | null;
  #binding: NvmlBinding | null | undefined = undefined;
  readonly #handles = new Map<string, NvmlDeviceHandle | null>();

  constructor(deps?: { openBinding?: () => NvmlBinding | null }) {
    this.#openBinding = deps?.openBinding ?? openDefaultNvmlBinding;
  }

  // deno-lint-ignore require-await
  async probe(): Promise<void> {
    if (this.#binding !== undefined) return;
    this.#binding = safeCall(() => {
      const binding = this.#openBinding();
      if (!binding) return null;
      return binding.init() ? binding : null;
    });
  }

  async read(
    gpu: GpuTopology,
    ctx: GpuReadContext,
  ): Promise<GpuReading | null> {
    await this.probe();
    const binding = this.#binding;
    if (!binding || !gpu.pciPath) return null;

    let handle = this.#handles.get(gpu.gpuId);
    if (handle === undefined) {
      handle = safeCall(() => binding.getHandleByPciBusId(gpu.pciPath)) ??
        null;
      this.#handles.set(gpu.gpuId, handle);
    }
    if (!handle) return null;

    const utilization = safeCall(() => binding.getUtilizationRates(handle));
    const memoryUsedBytes = safeCall(() => binding.getMemoryUsedBytes(handle));
    const temperatureCelsius = safeCall(() =>
      binding.getTemperatureCelsius(handle)
    );
    const powerWatts = safeCall(() => binding.getPowerWatts(handle));
    const pcie = safeCall(() =>
      binding.getPcieThroughputBytesPerSecond(handle)
    );
    const violationNs = safeCall(() =>
      binding.getThermalViolationNanoseconds(handle)
    );

    let throttlePercent: number | null = null;
    if (violationNs !== null) {
      const rate = ctx.tracker.rate(
        `gpu:nvml:${gpu.gpuId}:violation`,
        violationNs,
        ctx.bootGeneration,
        ctx.seconds,
      );
      throttlePercent = rate === null
        ? null
        : Math.min(100, Math.max(0, (rate / 1e9) * 100));
    }

    return {
      utilizationPercent: utilization?.gpuPercent ?? null,
      memoryUsedBytes,
      memoryActivityPercent: utilization?.memoryPercent ?? null,
      temperatureCelsius,
      memoryTemperatureCelsius: null,
      powerWatts,
      pcieReceiveBytesPerSecond: pcie?.rx ?? null,
      pcieTransmitBytesPerSecond: pcie?.tx ?? null,
      throttlePercent,
    };
  }

  /**
   * Raw health-signal read for the events-phase collector to consume later
   * — this adapter never synthesizes `MetricEventV4` rows itself, only
   * exposes the counts/flags. Resolves (and caches) its own device handle
   * on demand, exactly like {@link read} — it does not require a prior
   * `read()` call for `gpu.gpuId` to have already populated the handle
   * cache. Every field is `null` when NVML is inactive, `gpu.pciPath` is
   * unresolvable, or no handle resolves for it.
   */
  async readHealthSignals(gpu: GpuTopology): Promise<{
    eccDoubleBitAggregateTotal: number | null;
    lastXidErrorCode: number | null;
    remappedRows: NvmlRemappedRows | null;
    retiredPagesPending: boolean | null;
  }> {
    await this.probe();
    const empty = {
      eccDoubleBitAggregateTotal: null,
      lastXidErrorCode: null,
      remappedRows: null,
      retiredPagesPending: null,
    };
    const binding = this.#binding;
    if (!binding || !gpu.pciPath) return empty;

    let handle = this.#handles.get(gpu.gpuId);
    if (handle === undefined) {
      handle = safeCall(() => binding.getHandleByPciBusId(gpu.pciPath)) ??
        null;
      this.#handles.set(gpu.gpuId, handle);
    }
    if (!handle) return empty;

    return {
      eccDoubleBitAggregateTotal: safeCall(() =>
        binding.getEccDoubleBitAggregateTotal(handle)
      ),
      lastXidErrorCode: safeCall(() => binding.getLastXidErrorCode(handle)),
      remappedRows: safeCall(() => binding.getRemappedRows(handle)),
      retiredPagesPending: safeCall(() =>
        binding.getRetiredPagesPending(handle)
      ),
    };
  }
}
