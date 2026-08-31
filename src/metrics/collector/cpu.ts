/**
 * CPU domain: v2 eight-way percentage split from `/proc/stat` jiffie deltas.
 *
 * Raw parsing stays in `parse-stat.ts`; this module only turns two counter
 * snapshots into percentages. No collapsed `usage` value is computed — the
 * API derives utilization as `100 - cpuIdlePercent`, never the daemon.
 */
import type { CpuCounters } from "./types.ts";

export type CpuPercentages = {
  userPercent: number | null;
  systemPercent: number | null;
  nicePercent: number | null;
  idlePercent: number | null;
  iowaitPercent: number | null;
  irqPercent: number | null;
  softirqPercent: number | null;
  stealPercent: number | null;
};

export const EMPTY_CPU_PERCENTAGES: CpuPercentages = {
  userPercent: null,
  systemPercent: null,
  nicePercent: null,
  idlePercent: null,
  iowaitPercent: null,
  irqPercent: null,
  softirqPercent: null,
  stealPercent: null,
};

function fieldDelta(
  prev: number | undefined,
  curr: number | undefined,
): number | null {
  if (prev === undefined || curr === undefined) return null;
  if (curr < prev) return null;
  return curr - prev;
}

/**
 * All eight CPU percentages from jiffie deltas between two aggregate `cpu`
 * snapshots against `deltaTotal`. A field whose counter is missing on either
 * side stays `null` (never coerced to `0`); user and nice are NOT combined.
 */
export function cpuPercentagesV2(
  prev: CpuCounters | null,
  curr: CpuCounters | null,
  seconds: number,
): CpuPercentages {
  if (!prev || !curr || seconds <= 0) return EMPTY_CPU_PERCENTAGES;

  const deltaTotal = curr.total - prev.total;
  if (deltaTotal <= 0) return EMPTY_CPU_PERCENTAGES;

  const pct = (delta: number | null): number | null => {
    if (delta === null) return null;
    return (delta / deltaTotal) * 100;
  };

  return {
    userPercent: pct(fieldDelta(prev.user, curr.user)),
    systemPercent: pct(fieldDelta(prev.system, curr.system)),
    nicePercent: pct(fieldDelta(prev.nice, curr.nice)),
    idlePercent: pct(fieldDelta(prev.idle, curr.idle)),
    iowaitPercent: pct(fieldDelta(prev.iowait, curr.iowait)),
    irqPercent: pct(fieldDelta(prev.irq, curr.irq)),
    softirqPercent: pct(fieldDelta(prev.softirq, curr.softirq)),
    stealPercent: pct(fieldDelta(prev.steal, curr.steal)),
  };
}
