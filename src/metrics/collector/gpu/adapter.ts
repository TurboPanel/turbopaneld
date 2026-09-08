/**
 * Vendor-neutral GPU telemetry adapter interface — one adapter per
 * data-source (sysfs/DRM/hwmon, NVML FFI, DCGM Prometheus scrape), keyed by
 * topology `gpuId` (`topology/gpu-topology.ts`). `gpu/index.ts`'s
 * `buildGpuSamples` is the only orchestrator that calls these.
 */
import type { GpuSample } from "../../contract.ts";
import type { CounterBaselineTracker } from "../baseline.ts";
import type { GpuTopology } from "../../topology/types.ts";

/**
 * The physical-only readings a GPU produces. These are no longer `GpuSample`
 * fields — they ride the `hardware.physical` family, keyed to the owning GPU
 * (`topology/hardware-signal-topology.ts`'s `gpuSignalId`) — but the
 * adapters here remain their only source, so they stay part of every
 * adapter's reading and `gpu/index.ts` routes the merged values into the
 * hardware-signal builder rather than into the sample.
 */
export type GpuThermalReading = {
  temperatureCelsius: number | null;
  memoryTemperatureCelsius: number | null;
  powerWatts: number | null;
};

/**
 * Partial, per-field GPU reading — every `GpuSample` field plus the
 * physical-only {@link GpuThermalReading} fields. A field left unset (not
 * present in the object) or explicitly `null` both mean "this adapter has no
 * reading for this field this tick" — `gpu/index.ts`'s orchestrator merge
 * resolves each field independently along vendor adapter precedence, so
 * either form falls through to the next adapter in the chain for that one
 * field (see that module's doc comment for the full per-field precedence
 * contract).
 */
export type GpuReading = Partial<
  Omit<GpuSample, "gpuId"> & GpuThermalReading
>;

/** Shared context every adapter needs to compute rates from cumulative counters. */
export type GpuReadContext = {
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
};

export type GpuAdapterId = "sysfs" | "nvml" | "dcgm";

/**
 * One telemetry source. `read` returning `null` means "nothing for this GPU
 * this tick" (source unavailable, GPU not present in this source, or a
 * transient failure) — never "GPU is unhealthy"; that distinction is an
 * events-phase concern, not this adapter's. Implementations must never
 * throw — every failure path degrades to `null` (whole reading) or a
 * missing field (partial reading).
 */
export type GpuAdapter = {
  readonly id: GpuAdapterId;
  /** One-time availability probe (library present, endpoint reachable). Memoized — never re-probed per tick. */
  probe(): Promise<void>;
  read(gpu: GpuTopology, ctx: GpuReadContext): Promise<GpuReading | null>;
};

/** The three adapters `buildGpuSamples` picks from, per GPU vendor. */
export type GpuAdapterSet = {
  dcgm: GpuAdapter;
  nvml: GpuAdapter;
  sysfs: GpuAdapter;
};
