/**
 * `/proc/net/softnet_stat` parsing: one row per CPU, hex-encoded fields.
 * Field 2 (0-indexed 1) is the cumulative packet-drop count for that CPU —
 * summed across every row for the host-wide total.
 */
import type { CounterBaselineTracker } from "./baseline.ts";

/** Sum the per-CPU drop-count column (2nd hex field) across every row. */
export function parseSoftnetStat(text: string): number {
  let total = 0;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const drops = Number.parseInt(fields[1], 16);
    if (Number.isFinite(drops)) total += drops;
  }
  return total;
}

/** Route the summed cumulative drop total through the shared baseline tracker into a per-second rate. */
export function softnetDropsPerSecond(
  currentTotal: number,
  seconds: number,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
): number | null {
  return tracker.rate(
    "softnet:total:drops",
    currentTotal,
    bootGeneration,
    seconds,
  );
}
