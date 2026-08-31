/**
 * Temperature resolution: one value per measurement from discovered
 * candidates plus admin overrides (override wins over auto-detection; no
 * candidate and no override means `null`, never `0`).
 *
 * hwmon `temp*_input` and thermal-zone `temp` both report millidegrees C.
 */
import { selectCandidate, sensorId, type SensorIo } from "./discovery.ts";
import type { SensorCandidate } from "../types.ts";

export type ResolvedTemperature = {
  celsius: number | null;
  /** Stable identity of the selected sensor; unset when none resolved. */
  sensor?: string;
};

/** Sanity window — readings outside are treated as sensor glitches. */
const MIN_PLAUSIBLE_CELSIUS = -60;
const MAX_PLAUSIBLE_CELSIUS = 180;

export async function resolveTemperature(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
  io: SensorIo,
): Promise<ResolvedTemperature> {
  const candidate = selectCandidate(candidates, overridePath);
  if (!candidate) return { celsius: null };

  const raw = await io.readFile(candidate.path);
  const milli = Number(raw?.trim());
  if (!Number.isFinite(milli)) {
    return { celsius: null, sensor: sensorId(candidate) };
  }
  const celsius = milli / 1000;
  if (celsius < MIN_PLAUSIBLE_CELSIUS || celsius > MAX_PLAUSIBLE_CELSIUS) {
    return { celsius: null, sensor: sensorId(candidate) };
  }
  return { celsius, sensor: sensorId(candidate) };
}
