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

function parseDiskstatsRow(
  line: string,
): { name: string; counters: DiskDeviceCounters } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 14) return null;

  const name = parts[2];
  const readsCompleted = Number(parts[3]);
  const sectorsRead = Number(parts[5]);
  const writesCompleted = Number(parts[7]);
  const sectorsWritten = Number(parts[9]);

  if (
    !name ||
    [readsCompleted, sectorsRead, writesCompleted, sectorsWritten].some((n) =>
      !Number.isFinite(n)
    )
  ) {
    return null;
  }

  return {
    name,
    counters: {
      readsCompleted,
      sectorsRead,
      writesCompleted,
      sectorsWritten,
    },
  };
}

/**
 * Parse `/proc/diskstats` and return summed whole-disk counters.
 * Sectors are 512 bytes per kernel convention.
 *
 * Filtering: drop virtual devices, then drop partition rows when a parent
 * whole-disk name survives (avoids double-counting disk + partition).
 */
export function parseDiskstats(text: string): DiskCounters | null {
  const devices = new Map<string, DiskDeviceCounters>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseDiskstatsRow(line);
    if (!parsed) continue;
    devices.set(parsed.name, parsed.counters);
  }

  if (devices.size === 0) return null;

  const names = [...devices.keys()].filter((name) => !isVirtualDevice(name));
  const wholeDisks = names.filter((name) => !isPartition(name, names));

  if (wholeDisks.length === 0) return null;

  const filtered: Record<string, DiskDeviceCounters> = {};
  for (const name of wholeDisks) {
    const counters = devices.get(name);
    if (!counters) continue;
    filtered[name] = counters;
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
