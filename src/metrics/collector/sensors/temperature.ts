/**
 * Temperature resolution: one value per measurement from discovered
 * candidates plus admin overrides (override wins over auto-detection; no
 * candidate and no override means `null`, never `0`).
 *
 * hwmon `temp*_input` and thermal-zone `temp` both report millidegrees C.
 */
import {
  type CandidateSelectionOptions,
  selectCandidateWithOptions,
  sensorId,
  type SensorIo,
} from "./discovery.ts";
import type { SensorCandidate } from "../types.ts";

export type ResolvedTemperature = {
  celsius: number | null;
  /** Stable identity of the selected sensor; unset when none resolved. */
  sensor?: string;
};

/** Sanity window — readings outside are treated as sensor glitches. */
const MIN_PLAUSIBLE_CELSIUS = -60;
const MAX_PLAUSIBLE_CELSIUS = 180;

/**
 * Read and sanity-check one temperature candidate's raw sysfs value,
 * independent of candidate selection — shared by {@link resolveTemperature}
 * (one selected candidate) and capability discovery (every candidate, for
 * the picker's live-reading column).
 */
export async function readTemperatureValue(
  path: string,
  io: SensorIo,
): Promise<number | null> {
  const raw = await io.readFile(path);
  const milli = Number(raw?.trim());
  if (!Number.isFinite(milli)) return null;
  const celsius = milli / 1000;
  if (celsius < MIN_PLAUSIBLE_CELSIUS || celsius > MAX_PLAUSIBLE_CELSIUS) {
    return null;
  }
  return celsius;
}

export async function resolveTemperature(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
  io: SensorIo,
  options?: CandidateSelectionOptions,
): Promise<ResolvedTemperature> {
  const candidate = selectCandidateWithOptions(
    candidates,
    overridePath,
    options,
  );
  if (!candidate) return { celsius: null };

  const celsius = await readTemperatureValue(candidate.path, io);
  if (celsius === null) {
    return { celsius: null, sensor: sensorId(candidate) };
  }
  return { celsius, sensor: sensorId(candidate) };
}
