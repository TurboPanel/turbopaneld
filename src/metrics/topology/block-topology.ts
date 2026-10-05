/**
 * Block device topology: wraps `collector/block-devices.ts`'s whole-disk/
 * partition classification and adds the parent/child graph (partition →
 * whole disk, dm/LVM/md → backing device via `/sys/block/<name>/slaves/`)
 * plus per-device identity/model/serial/WWN. Unlike the v3 aggregation
 * filter (which excludes `dm-`/`md` outright), topology represents them as
 * `"virtual"` devices with a resolved backing chain — real storage/RAID
 * layout an operator would want to see, not just an aggregation nuisance.
 *
 * True pseudo-devices (`loop`, `ram`, `zram`, `fd`, `dcssblk`, `sr`, `nbd`)
 * carry no useful topology identity and stay excluded entirely, same as v3.
 */
import { parseDiskstatsRows } from "../collector/parse-diskstats.ts";
import { mapSequential } from "../../util/sequential.ts";
import {
  type BlockDeviceIdentity,
  deriveBlockDeviceIdentity,
  type IdentityIo,
} from "./identity.ts";
import type {
  BlockDeviceTopology,
  BlockDeviceType,
} from "../../contracts/topology-types.ts";

const EXCLUDED_PSEUDO_DEVICE_PREFIXES = [
  "loop",
  "ram",
  "zram",
  "fd",
  "dcssblk",
  "sr",
  "nbd",
] as const;

const VIRTUAL_BACKED_DEVICE_PREFIXES = ["dm-", "md"] as const;

/**
 * Partition naming by device family. Never a bare "prefix plus digits" rule:
 * `dm-10` is not a partition of `dm-1`, `md127` is not one of `md1`, and
 * `nvme0n10` is not one of `nvme0n1`. Device-mapper and md nodes have no
 * partition suffix form.
 */
const PARTITION_NAME_PATTERNS: readonly RegExp[] = [
  /^((?:sd|vd|xvd|hd)[a-z]+)\d+$/,
  /^((?:nvme\d+n\d+|mmcblk\d+|nbd\d+))p\d+$/,
];

/** The whole disk `name` is a partition of, when it is one and that disk is in `candidates`. */
function partitionParent(
  name: string,
  candidates: readonly string[],
): string | undefined {
  for (const pattern of PARTITION_NAME_PATTERNS) {
    const parent = pattern.exec(name)?.[1];
    if (parent !== undefined && candidates.includes(parent)) return parent;
  }
  return undefined;
}

function isExcludedPseudoDevice(name: string): boolean {
  return EXCLUDED_PSEUDO_DEVICE_PREFIXES.some((prefix) =>
    name.startsWith(prefix)
  );
}

function isVirtualBackedDevice(name: string): boolean {
  return VIRTUAL_BACKED_DEVICE_PREFIXES.some((prefix) =>
    name.startsWith(prefix)
  );
}

function isPartitionOf(name: string, wholeDiskNames: string[]): boolean {
  return partitionParent(name, wholeDiskNames) !== undefined;
}

function findWholeDiskParent(
  name: string,
  wholeDiskNames: string[],
): string | undefined {
  return partitionParent(name, wholeDiskNames);
}

/** Whether `deviceName` (a whole disk or virtual/dm-md device) backs one of `serviceDeviceNames`. */
function backsServiceDevice(
  deviceName: string,
  serviceDeviceNames: string[],
): boolean {
  return serviceDeviceNames.some((preferred) => {
    if (preferred === deviceName) return true;
    return partitionParent(preferred, [deviceName]) !== undefined;
  });
}

async function readCapacityBytes(
  name: string,
  io: IdentityIo,
  root: string,
): Promise<number | undefined> {
  const raw = await io.readFile(`${root}/block/${name}/size`);
  if (raw === undefined) return undefined;
  const sectors = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(sectors) && sectors >= 0 ? sectors * 512 : undefined;
}

async function loadIdentities(
  names: string[],
  io: IdentityIo,
  root: string,
): Promise<Map<string, BlockDeviceIdentity>> {
  const identities = new Map<string, BlockDeviceIdentity>();
  await Promise.all(
    names.map(async (name) => {
      identities.set(name, await deriveBlockDeviceIdentity(name, io, root));
    }),
  );
  return identities;
}

/**
 * Single-backing-device parent for a dm/md virtual device. Multiple slaves
 * (striped/mirrored RAID, multi-PV LVM) have no single parent to represent
 * in this graph — left unset rather than arbitrarily picking one.
 */
async function resolveVirtualParent(
  name: string,
  identities: Map<string, BlockDeviceIdentity>,
  io: IdentityIo,
  root: string,
): Promise<string | undefined> {
  const slaves = await io.listDir(`${root}/block/${name}/slaves`);
  if (slaves.length !== 1) return undefined;
  const slaveName = slaves[0];
  if (!slaveName) return undefined;
  const slaveIdentity = identities.get(slaveName) ??
    await deriveBlockDeviceIdentity(slaveName, io, root);
  return slaveIdentity.deviceId;
}

async function resolveDeviceRelation(
  name: string,
  isPartition: boolean,
  wholeDiskNames: string[],
  identities: Map<string, BlockDeviceIdentity>,
  io: IdentityIo,
  root: string,
): Promise<{ deviceType: BlockDeviceType; parentDeviceId?: string }> {
  if (isPartition) {
    const parentName = findWholeDiskParent(name, wholeDiskNames);
    return {
      deviceType: "partition",
      parentDeviceId: parentName
        ? identities.get(parentName)?.deviceId
        : undefined,
    };
  }
  if (isVirtualBackedDevice(name)) {
    return {
      deviceType: "virtual",
      parentDeviceId: await resolveVirtualParent(name, identities, io, root),
    };
  }
  return { deviceType: "physical" };
}

function toBlockDeviceTopology(
  name: string,
  identity: BlockDeviceIdentity,
  deviceType: BlockDeviceType,
  parentDeviceId: string | undefined,
  capacityBytes: number | undefined,
  isServiceDevice: boolean,
): BlockDeviceTopology {
  const result: BlockDeviceTopology = {
    deviceId: identity.deviceId,
    kernelName: name,
    deviceType,
    isServiceDevice,
  };
  if (identity.model) result.model = identity.model;
  if (identity.serial) result.serial = identity.serial;
  if (identity.wwn) result.wwn = identity.wwn;
  if (capacityBytes !== undefined) result.capacityBytes = capacityBytes;
  if (parentDeviceId) result.parentDeviceId = parentDeviceId;
  return result;
}

export type BlockTopologyDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  io: IdentityIo;
  sysRoot?: string;
  /** Kernel device names backing the probed system/hosting/Docker mounts (`collector/mounts.ts` `backingDeviceNames`). */
  serviceDeviceNames: string[];
};

async function collectOneDevice(
  name: string,
  wholeDiskNames: string[],
  identities: Map<string, BlockDeviceIdentity>,
  deps: BlockTopologyDeps,
  root: string,
): Promise<BlockDeviceTopology | undefined> {
  const identity = identities.get(name);
  if (!identity) return undefined;
  const isPartition = !wholeDiskNames.includes(name);
  const { deviceType, parentDeviceId } = await resolveDeviceRelation(
    name,
    isPartition,
    wholeDiskNames,
    identities,
    deps.io,
    root,
  );
  return toBlockDeviceTopology(
    name,
    identity,
    deviceType,
    parentDeviceId,
    await readCapacityBytes(name, deps.io, root),
    !isPartition && backsServiceDevice(name, deps.serviceDeviceNames),
  );
}

/** Enumerate every real block device (whole disk, partition, or dm/md virtual) with stable identity and its parent/child graph. */
export async function collectBlockTopology(
  deps: BlockTopologyDeps,
): Promise<BlockDeviceTopology[]> {
  const root = deps.sysRoot ?? "/sys";
  const text = await deps.readProcFile("/proc/diskstats");
  if (!text) return [];

  const allNames = Object.keys(parseDiskstatsRows(text)).filter((name) =>
    !isExcludedPseudoDevice(name)
  );
  if (allNames.length === 0) return [];

  const wholeDiskNames = allNames.filter((name) =>
    !isPartitionOf(name, allNames)
  );
  const identities = await loadIdentities(allNames, deps.io, root);
  // One device at a time: resolving a dm/md relation lists sysfs directories,
  // which can shell out to `ls`, so keep that from bursting across every disk.
  const devices = await mapSequential(
    allNames,
    (name) => collectOneDevice(name, wholeDiskNames, identities, deps, root),
  );
  // Allowlist: partitions of a kept disk are never drives, and dm/md devices
  // only count when they back a mount.
  const results = devices.filter((device) => device !== undefined).filter((
    device,
  ) =>
    device.deviceType !== "partition" &&
    (device.deviceType !== "virtual" || device.isServiceDevice)
  );
  return results.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}
