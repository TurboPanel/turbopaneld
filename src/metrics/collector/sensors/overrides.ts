/**
 * Hardware-profile state — read and write paths.
 *
 * Operators assign sensor/NIC slots, a hosting path, and a drivetemp opt-in
 * from the control plane. The selection is persisted on
 * `server.metadata.hardwareProfile` and pushed here over the cell socket
 * (`metrics-sensor-overrides-update`); {@link writeHardwareProfile} replaces
 * `<daemonStateDir>/metrics/hardware-profile.json` atomically — full
 * replacement, so an absent field clears that setting. Absent/invalid state
 * yields an empty profile so auto-detection/defaults stay in charge.
 */
import { dirname, join } from "@std/path";

import { resolveLayout } from "../../../paths/layout.ts";
import type {
  HardwareProfile,
  HardwareProfileSensorSlot,
  NicSlots,
  SensorOverrides,
} from "../types.ts";

export const HARDWARE_PROFILE_RELATIVE_PATH = "metrics/hardware-profile.json";

/** Hardware-profile file path under the daemon state dir. */
export function hardwareProfilePath(daemonStateDir: string): string {
  return join(daemonStateDir, HARDWARE_PROFILE_RELATIVE_PATH);
}

const SENSOR_SLOT_KEYS = [
  "cpuTemperature",
  "cpuPower",
  "gpuDevice",
  "gpuFan",
  "disk1Temperature",
  "disk2Temperature",
  "ambient1Temperature",
  "ambient2Temperature",
  "boardTemperature",
  "cpuFan",
  "systemFan1",
  "systemFan2",
] as const satisfies readonly (keyof HardwareProfile)[];

const NIC_KEYS = ["nic1", "nic2"] as const satisfies readonly (
  keyof HardwareProfile
)[];

function pickTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickSensorSlot(
  value: unknown,
): HardwareProfileSensorSlot | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const chip = pickTrimmedString(record.chip);
  const label = pickTrimmedString(record.label);
  if (!chip || !label) return undefined;
  return { chip, label };
}

function pickNicBinding(value: unknown): string | null | undefined {
  if (value === null) return null;
  return pickTrimmedString(value);
}

/**
 * `hostingPath` is only accepted when it is an absolute path without
 * whitespace/control characters — the same rule the `PUT
 * /servers/:id/metrics/hardware-profile` route enforces before persisting
 * it. A malformed on-disk value (relative path, embedded whitespace) is
 * treated as absent so {@link resolveHostingPath} falls back to
 * `principalHomeRoot` instead of `nearestExistingAncestor` walking a
 * relative path up to the daemon's working directory.
 */
function pickHostingPath(value: unknown): string | undefined {
  const trimmed = pickTrimmedString(value);
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("/") || /[\s\p{Cc}]/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function pickGeneration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function applySensorSlots(
  record: Record<string, unknown>,
  profile: HardwareProfile,
): void {
  for (const key of SENSOR_SLOT_KEYS) {
    if (!(key in record)) continue;
    const slot = pickSensorSlot(record[key]);
    if (slot !== undefined) profile[key] = slot;
  }
}

function applyNicBindings(
  record: Record<string, unknown>,
  profile: HardwareProfile,
): void {
  for (const key of NIC_KEYS) {
    if (!(key in record)) continue;
    const nic = pickNicBinding(record[key]);
    if (nic !== undefined) profile[key] = nic;
  }
}

function applyScalarFields(
  record: Record<string, unknown>,
  profile: HardwareProfile,
): void {
  const hostingPath = pickHostingPath(record.hostingPath);
  if (hostingPath) profile.hostingPath = hostingPath;

  if (typeof record.drivetempEnabled === "boolean") {
    profile.drivetempEnabled = record.drivetempEnabled;
  }

  const generation = pickGeneration(record.generation);
  if (generation !== undefined) profile.generation = generation;

  const generationAppliedAt = pickTrimmedString(record.generationAppliedAt);
  if (generationAppliedAt) profile.generationAppliedAt = generationAppliedAt;
}

/** Parse hardware-profile-file JSON; unknown/invalid fields are dropped, never fatal. */
export function parseHardwareProfile(text: string): HardwareProfile {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;

    const profile: HardwareProfile = {};
    applySensorSlots(record, profile);
    applyNicBindings(record, profile);
    applyScalarFields(record, profile);
    return profile;
  } catch {
    return {};
  }
}

/**
 * Persist the operator-assigned hardware profile to daemon state. Full
 * replacement: the pushed object is the complete profile, so absent fields
 * clear their setting. Atomic write (temp file + rename) so a concurrent
 * collect never reads a torn file.
 */
export async function writeHardwareProfile(
  profile: HardwareProfile,
  daemonStateDir?: string,
): Promise<void> {
  const stateDir = daemonStateDir ??
    resolveLayout(Deno.env.toObject()).daemonStateDir;
  const path = hardwareProfilePath(stateDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await Deno.writeTextFile(tmpPath, JSON.stringify(profile));
  await Deno.rename(tmpPath, path);
}

/** Read the operator-assigned hardware profile from daemon state; `{}` when unset. */
export async function resolveHardwareProfile(
  daemonStateDir?: string,
): Promise<HardwareProfile> {
  try {
    const stateDir = daemonStateDir ??
      resolveLayout(Deno.env.toObject()).daemonStateDir;
    const text = await Deno.readTextFile(hardwareProfilePath(stateDir));
    return parseHardwareProfile(text);
  } catch {
    return {};
  }
}

function sensorSlotIdentity(slot: HardwareProfileSensorSlot): string {
  return `${slot.chip}:${slot.label}`;
}

/**
 * Collector-facing projection: sensor-slot identities as opaque `chip:label`
 * strings, for {@link SensorOverrides} consumers. `selectCandidate`/
 * `selectGpuDevice` (`discovery.ts`) resolve these identities against live
 * capabilities; an assigned slot with no matching candidate (a sensor that
 * disappeared, e.g. across a reboot) degrades to "no reading" rather than
 * crashing or trying to open a `chip:label` string as a literal file path.
 */
export async function resolveAdminSensorOverrides(
  daemonStateDir?: string,
): Promise<SensorOverrides> {
  const profile = await resolveHardwareProfile(daemonStateDir);
  const overrides: SensorOverrides = {};
  if (profile.cpuTemperature) {
    overrides.cpuTemperature = sensorSlotIdentity(profile.cpuTemperature);
  }
  if (profile.cpuPower) {
    overrides.cpuPower = sensorSlotIdentity(profile.cpuPower);
  }
  // GPU temperature, power, utilization, and fan all resolve from the
  // single gpuDevice slot — a multi-GPU host never mixes two cards.
  if (profile.gpuDevice) {
    const identity = sensorSlotIdentity(profile.gpuDevice);
    overrides.gpuTemperature = identity;
    overrides.gpuPower = identity;
    overrides.gpuUtilization = identity;
    overrides.gpuFan = identity;
  }
  // An explicit gpuFan assignment wins over the gpuDevice fan-out above —
  // for a GPU whose fan tachometer isn't discoverable from the same device
  // identity as its temperature/power.
  if (profile.gpuFan) {
    overrides.gpuFan = sensorSlotIdentity(profile.gpuFan);
  }
  if (profile.disk1Temperature) {
    overrides.disk1Temperature = sensorSlotIdentity(profile.disk1Temperature);
  }
  if (profile.disk2Temperature) {
    overrides.disk2Temperature = sensorSlotIdentity(profile.disk2Temperature);
  }
  if (profile.ambient1Temperature) {
    overrides.ambient1Temperature = sensorSlotIdentity(
      profile.ambient1Temperature,
    );
  }
  if (profile.ambient2Temperature) {
    overrides.ambient2Temperature = sensorSlotIdentity(
      profile.ambient2Temperature,
    );
  }
  if (profile.boardTemperature) {
    overrides.boardTemperature = sensorSlotIdentity(profile.boardTemperature);
  }
  if (profile.cpuFan) {
    overrides.cpuFan = sensorSlotIdentity(profile.cpuFan);
  }
  if (profile.systemFan1) {
    overrides.systemFan1 = sensorSlotIdentity(profile.systemFan1);
  }
  if (profile.systemFan2) {
    overrides.systemFan2 = sensorSlotIdentity(profile.systemFan2);
  }
  return overrides;
}

/**
 * Collector-facing projection: the two NIC-slot interface-name assignments.
 * `undefined` (never configured) and explicit `null` (unassigned) both
 * collapse to `null` here — the collector only needs "which name, if any".
 */
export async function resolveNicSlots(
  daemonStateDir?: string,
): Promise<NicSlots> {
  const profile = await resolveHardwareProfile(daemonStateDir);
  return {
    nic1: profile.nic1 ?? null,
    nic2: profile.nic2 ?? null,
  };
}
