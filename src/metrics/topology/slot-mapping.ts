/**
 * Pure slot-mapping: `TopologySnapshot` + `TopologyOverrides` → `SlotMapping`.
 * No I/O — shared verbatim with the Cloudflare packer/query-reconstruction
 * layer (the control plane vendors/mirrors this file the same way
 * `contract.ts` is mirrored today).
 *
 * Normal-NIC slot rule (see `types.ts`'s `TopologyOverrides` /
 * `SlotMapping`):
 *
 *  - An operator list (`overrides.nicSlotDeviceIds`) wins outright: it is
 *    the complete monitored set in slot order, deduplicated, capped at
 *    `MAX_NIC_SLOTS`. Ids are kept even when absent from this snapshot — a
 *    pinned device that is unplugged this tick stays pinned (its sample goes
 *    missing rather than a different device silently taking its slot).
 *  - Otherwise exactly one slot: the `uplink` flagged `defaultRoute` (the
 *    gateway NIC), falling back to the first uplink by sorted id when the
 *    kernel reports no default route on a monitorable uplink. Nothing else
 *    is monitored by default — additional NICs are an explicit operator
 *    choice.
 */
import {
  MAX_NIC_SLOTS,
  type SlotMapping,
  type TopologyOverrides,
  type TopologySnapshot,
} from "./types.ts";

function byId(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Operator list, deduplicated in first-seen order and capped at `MAX_NIC_SLOTS`. */
function normalizeNicSlotList(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_NIC_SLOTS) break;
  }
  return out;
}

/** The auto-selected primary: the default-route uplink, else the first uplink by sorted id. */
function resolveDefaultNicSlots(
  networks: TopologySnapshot["networks"],
): string[] {
  const uplinks = networks.filter((device) => device.kind === "uplink");
  const gateway = uplinks.find((device) => device.defaultRoute === true);
  if (gateway) return [gateway.deviceId];
  const sorted = uplinks.map((device) => device.deviceId).sort(byId);
  return sorted.length > 0 ? [sorted[0]] : [];
}

export function computeSlotMapping(
  snapshot: TopologySnapshot,
  overrides: TopologyOverrides,
): SlotMapping {
  const explicit = normalizeNicSlotList(overrides.nicSlotDeviceIds);
  const normalNicSlots = explicit.length > 0
    ? explicit
    : resolveDefaultNicSlots(snapshot.networks);

  const fabricDeviceIds = snapshot.networks
    .filter((device) => device.kind === "fabric")
    .map((device) => device.deviceId)
    .sort(byId);

  const rootFilesystemId =
    snapshot.filesystems.find((fs) => fs.roles.includes("root"))
      ?.filesystemId ?? null;

  const filesystemIdsSorted = snapshot.filesystems
    .map((fs) => fs.filesystemId)
    .sort(byId);
  const hostingOverride = overrides.hostingFilesystemId;
  const filesystemPageOrder =
    hostingOverride && filesystemIdsSorted.includes(hostingOverride)
      ? [
        hostingOverride,
        ...filesystemIdsSorted.filter((id) => id !== hostingOverride),
      ]
      : filesystemIdsSorted;

  const blockPageOrder = snapshot.blockDevices
    .map((device) => device.deviceId)
    .sort(byId);
  const gpuPageOrder = snapshot.gpus.map((gpu) => gpu.gpuId).sort(byId);
  const hardwareSignalPageOrder = snapshot.hardwareSignals
    .map((signal) => signal.signalId)
    .sort(byId);

  return {
    normalNicSlots,
    fabricDeviceIds,
    rootFilesystemId,
    gpuPageOrder,
    blockPageOrder,
    filesystemPageOrder,
    hardwareSignalPageOrder,
  };
}
