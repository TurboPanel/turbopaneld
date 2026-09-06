/**
 * GPU domain orchestrator: per-topology-GPU vendor-scoped adapter selection
 * and per-field merge, mirroring `network.ts`'s `buildNetworkDeviceSamples`
 * contract — every topology-enumerated GPU is always present in the output
 * (never dropped), keyed by the stable `gpuId`.
 *
 * Adapter precedence is vendor-scoped: NVIDIA GPUs try DCGM first, then
 * NVML; AMD/Intel GPUs only ever try sysfs. Every adapter in the chain is
 * read for the GPU (not just the first that answers), and the merge then
 * resolves *each field independently* along that precedence order — the
 * first adapter in the chain to have a non-`null` value for a given field
 * wins that field, so a higher-precedence adapter's partial reading (e.g.
 * DCGM missing `powerWatts` on an older exporter) is backfilled per-field
 * from the next adapter down, never left `null` while a lower-precedence
 * adapter has that same field for the same `gpuId`. This still never mixes
 * *different GPUs* into one row — correlation stays anchored to the one
 * topology-enumerated `gpuId` for the whole merge.
 *
 * When no adapter in the chain returns anything, every baseline-tracked
 * counter key this GPU's adapters might have used is invalidated (so a
 * later readable tick re-origins instead of diffing across the gap) and an
 * all-`null` sample is still emitted for that `gpuId`.
 */
import type { GpuSampleV4 } from "../../contract-v4.ts";
import type { GpuTopology } from "../../topology/types.ts";
import type { CounterBaselineTracker } from "../baseline.ts";
import type {
  GpuAdapter,
  GpuAdapterSet,
  GpuReadContext,
  GpuReading,
} from "./adapter.ts";

export type {
  GpuAdapter,
  GpuAdapterId,
  GpuAdapterSet,
  GpuReadContext,
  GpuReading,
} from "./adapter.ts";
export { DCGM_EXPORTER_ADDR, DcgmGpuAdapter } from "./dcgm-adapter.ts";
export { NvmlGpuAdapter } from "./nvml-adapter.ts";
export { SysfsGpuAdapter } from "./sysfs-adapter.ts";

const EMPTY_GPU_FIELDS: Omit<GpuSampleV4, "gpuId"> = {
  utilizationPercent: null,
  memoryUsedBytes: null,
  memoryActivityPercent: null,
  temperatureCelsius: null,
  memoryTemperatureCelsius: null,
  powerWatts: null,
  pcieReceiveBytesPerSecond: null,
  pcieTransmitBytesPerSecond: null,
  throttlePercent: null,
};

/** Every per-GPU field name, in the order `GpuSampleV4` declares them (minus `gpuId`). */
const GPU_FIELD_NAMES = Object.keys(EMPTY_GPU_FIELDS) as ReadonlyArray<
  keyof typeof EMPTY_GPU_FIELDS
>;

/**
 * Merge one or more adapter readings for the same `gpuId`, resolving each
 * field independently: the first reading in `readings` (already in
 * adapter-precedence order) carrying a non-`null` value for a field wins
 * that field. A field unset or explicitly `null` in every reading stays
 * `null` — never fabricated, never backfilled past the last adapter in
 * the chain.
 */
function mergeReadings(gpuId: string, readings: GpuReading[]): GpuSampleV4 {
  const fields: Omit<GpuSampleV4, "gpuId"> = { ...EMPTY_GPU_FIELDS };
  for (const field of GPU_FIELD_NAMES) {
    for (const reading of readings) {
      const candidate = reading[field];
      if (candidate !== undefined && candidate !== null) {
        fields[field] = candidate;
        break;
      }
    }
  }
  return { gpuId, ...fields };
}

/** Vendor-scoped adapter precedence chain — never mixed per GPU (see module doc). */
function adapterChainFor(
  vendor: string,
  adapters: GpuAdapterSet,
): GpuAdapter[] {
  if (vendor === "nvidia") return [adapters.dcgm, adapters.nvml];
  return [adapters.sysfs];
}

/** Every cumulative-counter key namespace an adapter might have written for `gpuId`. */
function invalidateKnownBaselineKeys(
  tracker: CounterBaselineTracker,
  gpuId: string,
): void {
  tracker.invalidate(`gpu:nvml:${gpuId}:violation`);
  tracker.invalidate(`gpu:dcgm:${gpuId}:violation`);
  // sysfs engine-busy keys are per-engine-name (`gpu:sysfs:<gpuId>:engine:
  // <name>`) and unbounded without device knowledge — the engine names
  // themselves are only known to `SysfsGpuAdapter` at read time, discovered
  // fresh every tick. `invalidatePrefix` drops every key under this GPU's
  // namespace without needing them enumerated here, so an unreadable tick
  // never leaves a stale per-engine baseline for the next readable tick to
  // diff across (which would compress however many missed intervals
  // elapsed into one fabricated utilization sample).
  tracker.invalidatePrefix(`gpu:sysfs:${gpuId}:engine:`);
}

/**
 * Build one `GpuSampleV4` per topology-enumerated GPU. See the module doc
 * comment for the adapter-precedence and never-drop-the-entity contract.
 */
export async function buildGpuSamples(
  topology: readonly GpuTopology[],
  adapters: GpuAdapterSet,
  ctx: {
    tracker: CounterBaselineTracker;
    bootGeneration: number;
    seconds: number;
  },
): Promise<GpuSampleV4[]> {
  const readCtx: GpuReadContext = ctx;

  return await Promise.all(topology.map(async (gpu) => {
    const chain = adapterChainFor(gpu.vendor, adapters);
    const readings: GpuReading[] = [];
    for (const adapter of chain) {
      let reading: GpuReading | null;
      try {
        reading = await adapter.read(gpu, readCtx);
      } catch {
        reading = null;
      }
      if (reading !== null) readings.push(reading);
    }
    if (readings.length === 0) {
      invalidateKnownBaselineKeys(ctx.tracker, gpu.gpuId);
      return { gpuId: gpu.gpuId, ...EMPTY_GPU_FIELDS };
    }
    return mergeReadings(gpu.gpuId, readings);
  }));
}
