/**
 * Fan tachometer resolution: one RPM value per slot from discovered
 * candidates plus admin overrides (override wins over auto-detection; no
 * candidate and no override means `null`, never `0`).
 *
 * hwmon `fanN_input` reports RPM directly (no unit conversion).
 */
import {
  type CandidateSelectionOptions,
  selectCandidateWithOptions,
  sensorId,
  type SensorIo,
} from "./discovery.ts";
import type { SensorCandidate } from "../types.ts";

export type ResolvedFan = {
  rpm: number | null;
  /** Stable identity of the selected sensor; unset when none resolved. */
  sensor?: string;
};

/** Sanity window — readings outside are treated as sensor glitches. */
const MIN_PLAUSIBLE_RPM = 0;
const MAX_PLAUSIBLE_RPM = 20_000;

/**
 * Read and sanity-check one fan candidate's raw sysfs value, independent of
 * candidate selection — shared by {@link resolveFan} (one selected
 * candidate) and capability discovery (every candidate, for the picker's
 * live-reading column).
 */
export async function readFanValue(
  path: string,
  io: SensorIo,
): Promise<number | null> {
  const raw = await io.readFile(path);
  const rpm = Number(raw?.trim());
  if (!Number.isFinite(rpm)) return null;
  if (rpm < MIN_PLAUSIBLE_RPM || rpm > MAX_PLAUSIBLE_RPM) return null;
  return rpm;
}

export async function resolveFan(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
  io: SensorIo,
  options?: CandidateSelectionOptions,
): Promise<ResolvedFan> {
  const candidate = selectCandidateWithOptions(
    candidates,
    overridePath,
    options,
  );
  if (!candidate) return { rpm: null };

  const rpm = await readFanValue(candidate.path, io);
  if (rpm === null) return { rpm: null, sensor: sensorId(candidate) };
  return { rpm, sensor: sensorId(candidate) };
}
