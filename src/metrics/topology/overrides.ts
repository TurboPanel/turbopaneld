/**
 * Topology-overrides projection: the operator-assigned `HardwareProfile`
 * (`collector/sensors/overrides.ts`, still the single on-disk store, pushed
 * over the cell socket as `topology-overrides-update`) narrowed to the
 * fields that resolve against stable topology identity —
 * `nicSlotDeviceIds`/`hostingFilesystemId` — plus `drivetempEnabled`.
 * `nic1`/`nic2`/`hostingPath`/sensor slots stay `HardwareProfile`-only; this
 * module never reads or writes those.
 */
import { resolveHardwareProfile } from "../collector/sensors/overrides.ts";
import type { HardwareProfile } from "../collector/types.ts";
import { EMPTY_TOPOLOGY_OVERRIDES, type TopologyOverrides } from "./types.ts";

/** Pure field projection — no I/O, no name/path resolution against a snapshot. */
export function toTopologyOverrides(
  profile: HardwareProfile,
): TopologyOverrides {
  return {
    nicSlotDeviceIds: profile.nicSlotDeviceIds ?? [],
    hostingFilesystemId: profile.hostingFilesystemId ?? null,
    drivetempEnabled: profile.drivetempEnabled ?? false,
  };
}

/** Read the operator-assigned hardware profile from daemon state and project it into topology-override shape; {@link EMPTY_TOPOLOGY_OVERRIDES} when unset. */
export async function resolveTopologyOverrides(
  daemonStateDir?: string,
): Promise<TopologyOverrides> {
  const profile = await resolveHardwareProfile(daemonStateDir);
  if (Object.keys(profile).length === 0) return EMPTY_TOPOLOGY_OVERRIDES;
  return toTopologyOverrides(profile);
}
