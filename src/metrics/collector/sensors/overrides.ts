/**
 * Admin sensor overrides — read and write paths.
 *
 * Operators select a specific sensor path per measurement via
 * `<daemonStateDir>/metrics/sensor-overrides.json`. The control plane persists
 * selections on `server.metadata` and pushes them here over the cell socket
 * (`metrics-sensor-overrides-update`); {@link writeSensorOverrides} replaces
 * the file atomically. Absent/invalid state yields empty overrides so
 * auto-detection stays in charge.
 */
import { dirname, join } from "@std/path";

import { resolveLayout } from "../../../paths/layout.ts";
import type { SensorOverrides } from "../types.ts";

export const SENSOR_OVERRIDES_RELATIVE_PATH = "metrics/sensor-overrides.json";

/** Overrides file path under the daemon state dir. */
export function sensorOverridesPath(daemonStateDir: string): string {
  return join(daemonStateDir, SENSOR_OVERRIDES_RELATIVE_PATH);
}

function pickPathField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Parse override-file JSON; unknown/invalid fields are dropped, never fatal. */
export function parseSensorOverrides(text: string): SensorOverrides {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const overrides: SensorOverrides = {};
    const cpuTemperature = pickPathField(record.cpuTemperature);
    const gpuTemperature = pickPathField(record.gpuTemperature);
    const cpuPower = pickPathField(record.cpuPower);
    const gpuPower = pickPathField(record.gpuPower);
    if (cpuTemperature) overrides.cpuTemperature = cpuTemperature;
    if (gpuTemperature) overrides.gpuTemperature = gpuTemperature;
    if (cpuPower) overrides.cpuPower = cpuPower;
    if (gpuPower) overrides.gpuPower = gpuPower;
    return overrides;
  } catch {
    return {};
  }
}

/**
 * Persist operator-selected sensors to daemon state. Full replacement: the
 * pushed object is the complete override set, so absent fields clear their
 * overrides. Atomic write (temp file + rename) so a concurrent collect never
 * reads a torn file.
 */
export async function writeSensorOverrides(
  overrides: SensorOverrides,
  daemonStateDir?: string,
): Promise<void> {
  const stateDir = daemonStateDir ??
    resolveLayout(Deno.env.toObject()).daemonStateDir;
  const path = sensorOverridesPath(stateDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await Deno.writeTextFile(tmpPath, JSON.stringify(overrides));
  await Deno.rename(tmpPath, path);
}

/** Read operator-selected sensors from daemon state; `{}` when unset. */
export async function resolveAdminSensorOverrides(
  daemonStateDir?: string,
): Promise<SensorOverrides> {
  try {
    const stateDir = daemonStateDir ??
      resolveLayout(Deno.env.toObject()).daemonStateDir;
    const text = await Deno.readTextFile(sensorOverridesPath(stateDir));
    return parseSensorOverrides(text);
  } catch {
    return {};
  }
}
