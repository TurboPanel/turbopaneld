/**
 * GPU utilization resolution: the vendor busy-percent gauge from the
 * selected GPU device (AMD `gpu_busy_percent`, Intel/i915 placeholder
 * `gt_busy_percent`), or Intel DRM engine busy accumulating nanosecond
 * counters (two-snapshot delta in the collector orchestrator). NVIDIA
 * exposes no sysfs busy-percent node — only `nvidia-smi`, a per-interval
 * subprocess — so it stays unsupported (`null`), the same reasoning as GPU
 * power.
 */
import { selectCandidate, sensorId, type SensorIo } from "./discovery.ts";
import type { GpuBusyCounters, SensorCandidate } from "../types.ts";

export type ResolvedGpuUtilization = {
  /** Instantaneous 0–100 gauge (`gpu_busy_percent`); `null` for engine counters. */
  percent: number | null;
  /** Accumulating engine busy-ns; `null` when the device uses a percent gauge. */
  busy: GpuBusyCounters | null;
  sensor?: string;
};

function isEngineBusyPath(path: string): boolean {
  return path.endsWith("/busy");
}

/**
 * Average GPU busy percent over the interval from two engine-busy snapshots.
 * Uses the busiest engine (engines run in parallel, so a sum can exceed 100).
 * `null` on first sample, non-positive interval, or no overlapping engines.
 */
export function gpuUtilizationFromBusy(
  previous: GpuBusyCounters | null | undefined,
  current: GpuBusyCounters | null | undefined,
  seconds: number,
): number | null {
  if (!previous || !current || seconds <= 0) return null;
  const wallNs = seconds * 1e9;
  let sawEngine = false;
  let maxRatio = 0;
  for (const [engine, ns] of Object.entries(current.engines)) {
    const prevNs = previous.engines[engine];
    if (prevNs === undefined) continue;
    sawEngine = true;
    const delta = ns - prevNs;
    if (delta < 0) continue;
    maxRatio = Math.max(maxRatio, delta / wallNs);
  }
  if (!sawEngine) return null;
  return Math.min(100, maxRatio * 100);
}

async function readEngineBusy(
  candidates: SensorCandidate[],
  io: SensorIo,
): Promise<ResolvedGpuUtilization> {
  const engines: Record<string, number> = {};
  for (const candidate of candidates) {
    const raw = await io.readFile(candidate.path);
    const nanoseconds = Number(raw?.trim());
    if (!Number.isFinite(nanoseconds) || nanoseconds < 0) continue;
    engines[candidate.label] = nanoseconds;
  }
  const chip = candidates[0]?.chip;
  if (!chip || Object.keys(engines).length === 0) {
    return {
      percent: null,
      busy: null,
      sensor: candidates[0] ? sensorId(candidates[0]) : undefined,
    };
  }
  return {
    percent: null,
    busy: { engines },
    sensor: `${chip}:engines`,
  };
}

export async function readGpuUtilization(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
  io: SensorIo,
): Promise<ResolvedGpuUtilization> {
  const busyCandidates = candidates.filter((c) => isEngineBusyPath(c.path));
  if (busyCandidates.length > 0) {
    return await readEngineBusy(busyCandidates, io);
  }

  const candidate = selectCandidate(candidates, overridePath);
  if (!candidate) return { percent: null, busy: null };

  const raw = await io.readFile(candidate.path);
  const percent = Number(raw?.trim());
  if (!Number.isFinite(percent) || percent < 0) {
    return { percent: null, busy: null, sensor: sensorId(candidate) };
  }
  return { percent, busy: null, sensor: sensorId(candidate) };
}
