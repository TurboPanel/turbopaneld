/**
 * Block-device domain: whole-disk selection over parsed `/proc/diskstats`,
 * preferring the disks that back the probed system/hosting/Docker mounts
 * when the caller can resolve them (see `mounts.ts`).
 *
 * Filtering: drop virtual devices, then drop partition rows when a parent
 * whole-disk name survives (never count a disk and its partition twice —
 * NVMe `nvme0n1p1` and classic `sda1` naming both match). `dm-` stays
 * excluded: device-mapper I/O is accounted on the underlying physical
 * device, consistent with the no-subprocess (`no df`) design; no sysfs
 * `slaves` traversal.
 *
 * Sectors are 512 bytes per kernel convention.
 */
import { parseDiskstatsRows } from "./parse-diskstats.ts";
import type { DiskCounters, DiskDeviceCounters } from "./types.ts";

/** Virtual/pseudo block devices — excluded from host-summary disk totals. */
const VIRTUAL_DEVICE_PREFIXES = [
  "loop",
  "ram",
  "zram",
  "fd",
  "dm-",
  "md",
  "dcssblk",
  "sr",
  "nbd",
] as const;

const PARTITION_SUFFIX = /^p?\d+$/;

function isVirtualDevice(name: string): boolean {
  return VIRTUAL_DEVICE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isPartition(name: string, survivors: string[]): boolean {
  for (const other of survivors) {
    if (other === name || other.length >= name.length) continue;
    if (!name.startsWith(other)) continue;
    const suffix = name.slice(other.length);
    if (PARTITION_SUFFIX.test(suffix)) return true;
  }
  return false;
}

/**
 * Whole-disk survivors that back `preferredDevices` (mount sources — whole
 * disks or their partitions, e.g. `nvme0n1p2` → `nvme0n1`). Empty when none
 * of the preferred devices resolve to a surviving whole disk.
 */
function backingWholeDisks(
  wholeDisks: string[],
  preferredDevices: string[],
): string[] {
  const backing = new Set<string>();
  for (const device of preferredDevices) {
    for (const disk of wholeDisks) {
      if (device === disk) {
        backing.add(disk);
        break;
      }
      if (
        device.startsWith(disk) &&
        PARTITION_SUFFIX.test(device.slice(disk.length))
      ) {
        backing.add(disk);
        break;
      }
    }
  }
  return wholeDisks.filter((disk) => backing.has(disk));
}

/**
 * Parse `/proc/diskstats` and keep only whole-disk survivors.
 *
 * When `preferredDevices` (devices backing the probed system/hosting/Docker
 * mounts) resolve to surviving whole disks, aggregation narrows to those —
 * unrelated extra disks neither pollute the totals nor null the interval on
 * device-set churn. The host-wide whole-disk filter stays as the fallback
 * when mount resolution is unavailable (no mount table, or sources like
 * `/dev/mapper/*` that never match a diskstats name).
 */
export function readBlockDevices(
  text: string,
  preferredDevices?: string[],
): DiskCounters | null {
  const devices = parseDiskstatsRows(text);
  if (Object.keys(devices).length === 0) return null;

  const names = Object.keys(devices).filter((name) => !isVirtualDevice(name));
  const wholeDisks = names.filter((name) => !isPartition(name, names));

  if (wholeDisks.length === 0) return null;

  const preferred = preferredDevices?.length
    ? backingWholeDisks(wholeDisks, preferredDevices)
    : [];
  const selected = preferred.length > 0 ? preferred : wholeDisks;

  const filtered: Record<string, DiskDeviceCounters> = {};
  for (const name of selected) {
    filtered[name] = devices[name];
  }

  return { devices: filtered };
}

/** Exported for tests — whether a device name would be filtered as virtual. */
export function isVirtualDiskDevice(name: string): boolean {
  return isVirtualDevice(name);
}

/** Exported for tests — whether `name` is a partition of a surviving whole disk. */
export function isDiskPartition(name: string, allNames: string[]): boolean {
  const survivors = allNames.filter((n) => !isVirtualDevice(n));
  return isPartition(name, survivors);
}
