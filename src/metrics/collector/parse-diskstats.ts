/**
 * Pure `/proc/diskstats` line parsing. Device filtering/selection lives in
 * `block-devices.ts` — this file never decides which devices count.
 */
import type { DiskDeviceCounters } from "./types.ts";

/**
 * Parse one `/proc/diskstats` row (standard 14+ field layout: major, minor,
 * name, then the counters). Captures the read/write I/O-time fields so
 * average service time can be derived as `Δticks / Δops`.
 */
export function parseDiskstatsRow(
  line: string,
): { name: string; counters: DiskDeviceCounters } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 14) return null;

  const name = parts[2];
  const readsCompleted = Number(parts[3]);
  const sectorsRead = Number(parts[5]);
  const readTicksMs = Number(parts[6]);
  const writesCompleted = Number(parts[7]);
  const sectorsWritten = Number(parts[9]);
  const writeTicksMs = Number(parts[10]);

  if (
    !name ||
    [
      readsCompleted,
      sectorsRead,
      readTicksMs,
      writesCompleted,
      sectorsWritten,
      writeTicksMs,
    ].some((n) => !Number.isFinite(n))
  ) {
    return null;
  }

  return {
    name,
    counters: {
      readsCompleted,
      sectorsRead,
      readTicksMs,
      writesCompleted,
      sectorsWritten,
      writeTicksMs,
    },
  };
}

/** Every parsable device row, keyed by name — unfiltered. */
export function parseDiskstatsRows(
  text: string,
): Record<string, DiskDeviceCounters> {
  const devices: Record<string, DiskDeviceCounters> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseDiskstatsRow(line);
    if (!parsed) continue;
    devices[parsed.name] = parsed.counters;
  }
  return devices;
}
