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
 *
 * GPU temperature/memory-temperature/power are *not* `GpuSample` fields —
 * they are physical-only readings that ride the `hardware.physical` family
 * keyed to the owning GPU. The adapters here stay their only source, so
 * `buildGpuSamples` merges them with the exact same per-field precedence and
 * returns them alongside the samples (`GpuSamplesResult.thermals`) for
 * `hardware-signals.ts` to resolve `signal:gpu:<gpuId>:<kind>` against.
 */
import type { GpuSample } from "../../../contracts/metrics-contract.ts";
import type { GpuTopology } from "../../../contracts/topology-types.ts";
import { mapSequential } from "../../../util/sequential.ts";
import type { CounterBaselineTracker } from "../baseline.ts";
import type {
  GpuAdapter,
  GpuAdapterSet,
  GpuReadContext,
  GpuReading,
  GpuSizeReading,
  GpuThermalReading,
} from "./adapter.ts";

export type {
  GpuAdapter,
  GpuAdapterId,
  GpuAdapterSet,
  GpuReadContext,
  GpuReading,
  GpuSizeReading,
  GpuThermalReading,
} from "./adapter.ts";
export { DCGM_EXPORTER_ADDR, DcgmGpuAdapter } from "./dcgm-adapter.ts";
export { NvidiaSmiGpuAdapter } from "./nvidia-smi-adapter.ts";
export { NvmlGpuAdapter } from "./nvml-adapter.ts";
export { SysfsGpuAdapter } from "./sysfs-adapter.ts";

const EMPTY_GPU_FIELDS: Omit<GpuSample, "gpuId"> = {
  utilizationPercent: null,
  memoryUsedBytes: null,
  memoryActivityPercent: null,
  pcieReceiveBytesPerSecond: null,
  pcieTransmitBytesPerSecond: null,
  throttlePercent: null,
};

/** All-`null` thermals — the shape a GPU with no readable adapter contributes to `hardware.physical`. */
export const EMPTY_GPU_THERMALS: GpuThermalReading = {
  temperatureCelsius: null,
  memoryTemperatureCelsius: null,
  powerWatts: null,
};

/** Every per-GPU field name, in the order `GpuSample` declares them (minus `gpuId`). */
const GPU_FIELD_NAMES = Object.keys(EMPTY_GPU_FIELDS) as ReadonlyArray<
  keyof typeof EMPTY_GPU_FIELDS
>;

/** Every physical-only per-GPU field name — merged the same way, emitted as `hardware.physical` signals rather than sample fields. */
const GPU_THERMAL_FIELD_NAMES = Object.keys(
  EMPTY_GPU_THERMALS,
) as ReadonlyArray<keyof GpuThermalReading>;

/** Per-GPU physical readings this tick, keyed by the stable `gpuId` — one entry per topology-enumerated GPU, never a partial set. */
export type GpuThermalReadings = Map<string, GpuThermalReading>;

export type GpuSamplesResult = {
  samples: GpuSample[];
  thermals: GpuThermalReadings;
  /** Each GPU's memory size this tick (`null` when no adapter knows it), keyed by `gpuId`. */
  memoryTotals: Map<string, number | null>;
};

/** The empty result — the shape a collector with no wired adapter set produces. */
export function emptyGpuSamplesResult(): GpuSamplesResult {
  return { samples: [], thermals: new Map(), memoryTotals: new Map() };
}

/**
 * Merge one or more adapter readings for the same `gpuId`, resolving each
 * field independently: the first reading in `readings` (already in
 * adapter-precedence order) carrying a non-`null` value for a field wins
 * that field. A field unset or explicitly `null` in every reading stays
 * `null` — never fabricated, never backfilled past the last adapter in
 * the chain.
 */
function mergeReadings(
  gpuId: string,
  readings: GpuReading[],
): {
  sample: GpuSample;
  thermals: GpuThermalReading;
  memoryTotalBytes: number | null;
} {
  const fields: Omit<GpuSample, "gpuId"> = { ...EMPTY_GPU_FIELDS };
  for (const field of GPU_FIELD_NAMES) {
    for (const reading of readings) {
      const candidate = reading[field];
      if (candidate !== undefined && candidate !== null) {
        fields[field] = candidate;
        break;
      }
    }
  }
  const thermals: GpuThermalReading = { ...EMPTY_GPU_THERMALS };
  for (const field of GPU_THERMAL_FIELD_NAMES) {
    for (const reading of readings) {
      const candidate = reading[field];
      if (candidate !== undefined && candidate !== null) {
        thermals[field] = candidate;
        break;
      }
    }
  }
  let memoryTotalBytes: number | null = null;
  for (const reading of readings) {
    const candidate = reading.memoryTotalBytes;
    if (candidate !== undefined && candidate !== null) {
      memoryTotalBytes = candidate;
      break;
    }
  }
  return { sample: { gpuId, ...fields }, thermals, memoryTotalBytes };
}

/** Vendor-scoped adapter precedence chain — never mixed per GPU (see module doc). */
/**
 * NVIDIA's proprietary driver answers through DCGM, then NVML, then
 * nvidia-smi. An NVIDIA card on `nouveau` has none of those — its telemetry
 * is the nouveau hwmon chip — so it takes the sysfs chain like AMD/Intel.
 */
function adapterChainFor(
  gpu: GpuTopology,
  adapters: GpuAdapterSet,
): GpuAdapter[] {
  if (gpu.vendor === "nvidia" && gpu.chip !== "nouveau") {
    const chain = [adapters.dcgm, adapters.nvml];
    if (adapters.nvidiaSmi) chain.push(adapters.nvidiaSmi);
    return chain;
  }
  return [adapters.sysfs];
}

/** Every cumulative-counter key namespace an adapter might have written for `gpuId`. */
function invalidateKnownBaselineKeys(
  tracker: CounterBaselineTracker,
  gpuId: string,
): void {
  tracker.invalidate(`gpu:nvml:${gpuId}:violation`);
  tracker.invalidate(`gpu:dcgm:${gpuId}:violation`);
  // sysfs keys fan out per source (`gpu:sysfs:<gpuId>:engine:<name>` and
  // `gpu:sysfs:<gpuId>:rc6_ms`) and are discovered fresh every tick.
  // `invalidatePrefix` drops every key under this GPU's namespace so an
  // unreadable tick never leaves a stale baseline for the next readable
  // tick to diff across (which would compress missed intervals into one
  // fabricated utilization sample).
  tracker.invalidatePrefix(`gpu:sysfs:${gpuId}:`);
}

/**
 * Build one `GpuSample` — plus one {@link GpuThermalReading} — per
 * topology-enumerated GPU. See the module doc comment for the
 * adapter-precedence and never-drop-the-entity contract. Both maps always
 * cover every topology GPU, so an unreadable GPU still yields an all-`null`
 * sample *and* all-`null` thermals rather than dropping out of either.
 */
export async function buildGpuSamples(
  topology: readonly GpuTopology[],
  adapters: GpuAdapterSet,
  ctx: {
    tracker: CounterBaselineTracker;
    bootGeneration: number;
    seconds: number;
  },
): Promise<GpuSamplesResult> {
  const readCtx: GpuReadContext = ctx;

  const merged = await Promise.all(topology.map(async (gpu) => {
    const chain = adapterChainFor(gpu, adapters);
    // Adapters for one GPU run one after another, in precedence order; a
    // fallback-only adapter is skipped once an earlier one answered.
    let answered = false;
    const attempts = await mapSequential(chain, async (adapter) => {
      if (adapter.fallbackOnly && answered) return null;
      try {
        const reading = await adapter.read(gpu, readCtx);
        if (reading !== null) answered = true;
        return reading;
      } catch {
        return null;
      }
    });
    const readings: GpuReading[] = attempts.filter((r) => r !== null);
    if (readings.length === 0) {
      invalidateKnownBaselineKeys(ctx.tracker, gpu.gpuId);
      return {
        sample: { gpuId: gpu.gpuId, ...EMPTY_GPU_FIELDS },
        thermals: { ...EMPTY_GPU_THERMALS },
        memoryTotalBytes: null,
      };
    }
    return mergeReadings(gpu.gpuId, readings);
  }));

  return {
    samples: merged.map((entry) => entry.sample),
    thermals: new Map(
      merged.map((entry) => [entry.sample.gpuId, entry.thermals]),
    ),
    memoryTotals: new Map(
      merged.map((entry) => [entry.sample.gpuId, entry.memoryTotalBytes]),
    ),
  };
}
