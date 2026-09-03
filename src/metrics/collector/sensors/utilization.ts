/**
 * GPU utilization resolution: the vendor busy-percent gauge from the
 * selected GPU device (AMD `gpu_busy_percent`, Intel/i915 — see
 * `GPU_UTILIZATION_FILENAMES` in `discovery.ts` for the probed node names),
 * override-aware the same way temperature/power/fan are. NVIDIA exposes no
 * sysfs busy-percent node — only `nvidia-smi`, a per-interval subprocess —
 * so it stays unsupported (`null`), the same reasoning as GPU power.
 */
import { selectCandidate, sensorId, type SensorIo } from "./discovery.ts";
import type { SensorCandidate } from "../types.ts";

export type ResolvedGpuUtilization = {
  percent: number | null;
  sensor?: string;
};

export async function readGpuUtilization(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
  io: SensorIo,
): Promise<ResolvedGpuUtilization> {
  const candidate = selectCandidate(candidates, overridePath);
  if (!candidate) return { percent: null };

  const raw = await io.readFile(candidate.path);
  const percent = Number(raw?.trim());
  if (!Number.isFinite(percent) || percent < 0) {
    return { percent: null, sensor: sensorId(candidate) };
  }
  return { percent, sensor: sensorId(candidate) };
}
