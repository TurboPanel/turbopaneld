/**
 * Power resolution.
 *
 * CPU power is NOT an instantaneous register: RAPL exposes a cumulative
 * `energy_uj` counter, so watts are a two-snapshot delta
 * (`Δenergy_uj / Δseconds / 1e6`) computed by the orchestrator with the same
 * first-sample/boot-reset `null` treatment as CPU/disk/net rates. This module
 * reads the raw counter (plus `max_energy_range_uj` for wraparound) and the
 * pure delta helper.
 *
 * GPU power is an instantaneous gauge where hwmon exposes one (AMD
 * `power1_average`, microwatts). NVIDIA power is only answerable via
 * `nvidia-smi` — a per-interval subprocess — so it stays unsupported (`null`).
 */
import { selectCandidate, sensorId, type SensorIo } from "./discovery.ts";
import type { CpuEnergyCounter, SensorCandidate } from "../types.ts";

export type ResolvedCpuEnergy = {
  energy: CpuEnergyCounter | null;
  sensor?: string;
};

export type ResolvedGpuPower = {
  watts: number | null;
  sensor?: string;
};

function siblingPath(valuePath: string, filename: string): string {
  const slash = valuePath.lastIndexOf("/");
  return `${valuePath.slice(0, slash + 1)}${filename}`;
}

/** Read the cumulative RAPL energy counter for the selected CPU power sensor. */
export async function readCpuEnergy(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
  io: SensorIo,
): Promise<ResolvedCpuEnergy> {
  const candidate = selectCandidate(candidates, overridePath);
  if (!candidate) return { energy: null };

  const raw = await io.readFile(candidate.path);
  const energyMicrojoules = Number(raw?.trim());
  if (!Number.isFinite(energyMicrojoules) || energyMicrojoules < 0) {
    return { energy: null, sensor: sensorId(candidate) };
  }

  const maxRaw = await io.readFile(
    siblingPath(candidate.path, "max_energy_range_uj"),
  );
  const maxRange = Number(maxRaw?.trim());
  return {
    energy: {
      energyMicrojoules,
      maxEnergyRangeMicrojoules: Number.isFinite(maxRange) && maxRange > 0
        ? maxRange
        : null,
    },
    sensor: sensorId(candidate),
  };
}

/** Instantaneous GPU power gauge (hwmon `power1_average`, microwatts). */
export async function readGpuPower(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
  io: SensorIo,
): Promise<ResolvedGpuPower> {
  const candidate = selectCandidate(candidates, overridePath);
  if (!candidate) return { watts: null };

  const raw = await io.readFile(candidate.path);
  const microwatts = Number(raw?.trim());
  if (!Number.isFinite(microwatts) || microwatts < 0) {
    return { watts: null, sensor: sensorId(candidate) };
  }
  return { watts: microwatts / 1e6, sensor: sensorId(candidate) };
}

/**
 * Average watts over the interval from two cumulative energy counters.
 * `null` on first sample, non-positive interval, or an unexplainable
 * decrease; a decrease with a known counter range is treated as wraparound.
 */
export function cpuPowerFromEnergy(
  prev: CpuEnergyCounter | null,
  curr: CpuEnergyCounter | null,
  seconds: number,
): number | null {
  if (!prev || !curr || seconds <= 0) return null;
  let delta = curr.energyMicrojoules - prev.energyMicrojoules;
  if (delta < 0) {
    const range = curr.maxEnergyRangeMicrojoules;
    if (range === null || range <= 0) return null;
    delta += range;
    if (delta < 0) return null;
  }
  return delta / seconds / 1e6;
}
