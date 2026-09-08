/**
 * CPU domain: v5 percentage splits from `/proc/stat` jiffie deltas.
 *
 * Raw parsing stays in `parse-stat.ts`; this module only turns two counter
 * snapshots into percentages. No collapsed `usage` value is computed — the
 * API derives utilization as `100 - cpuIdlePercent`, never the daemon.
 */
import type { CpuCounters } from "./types.ts";

function fieldDelta(
  prev: number | undefined,
  curr: number | undefined,
): number | null {
  if (prev === undefined || curr === undefined) return null;
  if (curr < prev) return null;
  return curr - prev;
}

/**
 * v5 CPU percentages: `busyPercent` is `100 - idle% - iowait% - steal%`
 * (never `100 - idle` alone — steal/iowait are not "busy" time this host
 * controls). `guest`/`guest_nice` deltas are folded out of `user`/`nice`
 * before computing their percentages, since the kernel already counts guest
 * ticks inside `user`/`nice` — without this, guest time would be counted
 * twice (once in `user`, once implicitly via `busyPercent`).
 */
export type CpuPercentages = {
  busyPercent: number | null;
  userPercent: number | null;
  systemPercent: number | null;
  iowaitPercent: number | null;
  stealPercent: number | null;
  softirqPercent: number | null;
};

export const EMPTY_CPU_PERCENTAGES: CpuPercentages = {
  busyPercent: null,
  userPercent: null,
  systemPercent: null,
  iowaitPercent: null,
  stealPercent: null,
  softirqPercent: null,
};

export function cpuBusyPercent(
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

  const idlePercent = pct(fieldDelta(prev.idle, curr.idle));
  const iowaitPercent = pct(fieldDelta(prev.iowait, curr.iowait));
  const stealPercent = pct(fieldDelta(prev.steal, curr.steal));

  const busyPercent = idlePercent === null || iowaitPercent === null ||
      stealPercent === null
    ? null
    : 100 - idlePercent - iowaitPercent - stealPercent;

  const userDelta = fieldDelta(prev.user, curr.user);
  const guestDelta = fieldDelta(prev.guest, curr.guest);
  const dedupedUserDelta = userDelta === null
    ? null
    : userDelta - (guestDelta ?? 0);

  const niceDelta = fieldDelta(prev.nice, curr.nice);
  const guestNiceDelta = fieldDelta(prev.guestNice, curr.guestNice);
  const dedupedNiceDelta = niceDelta === null
    ? null
    : niceDelta - (guestNiceDelta ?? 0);

  const userPercent = pct(dedupedUserDelta);
  const nicePercent = pct(dedupedNiceDelta);
  const systemPercentRaw = pct(fieldDelta(prev.system, curr.system));

  // user/nice are reported together as one "userPercent" field in the v5
  // contract; combine only after de-duplicating guest time from each.
  const combinedUserPercent = userPercent === null && nicePercent === null
    ? null
    : (userPercent ?? 0) + (nicePercent ?? 0);

  return {
    busyPercent,
    userPercent: combinedUserPercent,
    systemPercent: systemPercentRaw,
    iowaitPercent,
    stealPercent,
    softirqPercent: pct(fieldDelta(prev.softirq, curr.softirq)),
  };
}

/** A logical core at or above this busy% counts as saturated for the interval. */
export const SATURATED_CORE_BUSY_PERCENT = 90;

/**
 * How many logical cores ran at or above {@link SATURATED_CORE_BUSY_PERCENT}
 * this interval, across every `cpuN` key present in *both* snapshots.
 *
 * v5's replacement for v4's `maxCoreBusyPercent`. A maximum saturates as a
 * statistic on a many-core host — something is nearly always near the top,
 * so the series pins high and stops carrying information. A *count* scales
 * with the core budget instead: `0` on a healthy host, `1` when a single
 * thread is wedged (the single-threaded-bottleneck signal the max was
 * really there to catch), and a large number when the box is genuinely
 * saturated. Cores missing from either snapshot contribute nothing rather
 * than being counted as idle; `null` when zero cores compute cleanly, so an
 * unreadable `/proc/stat` never reads as "nothing is busy".
 */
export function saturatedCoreCount(
  prevCores: Record<string, CpuCounters>,
  currCores: Record<string, CpuCounters>,
  seconds: number,
): number | null {
  let counted = 0;
  let saturated = 0;
  for (const key of Object.keys(currCores)) {
    const prev = prevCores[key];
    const curr = currCores[key];
    if (!prev) continue;
    const { busyPercent } = cpuBusyPercent(prev, curr, seconds);
    if (busyPercent === null) continue;
    counted += 1;
    if (busyPercent >= SATURATED_CORE_BUSY_PERCENT) saturated += 1;
  }
  return counted === 0 ? null : saturated;
}

/**
 * Share of aggregate delta ticks spent servicing hardware+software
 * interrupts (`irq` + `softirq`), against the same `deltaTotal` denominator
 * as every other v5 CPU percentage — feeds `DiagnosticsSample.cpu.cpuIrqPercent`.
 */
export function cpuIrqPercent(
  prev: CpuCounters | null,
  curr: CpuCounters | null,
): number | null {
  if (!prev || !curr) return null;

  const deltaTotal = curr.total - prev.total;
  if (deltaTotal <= 0) return null;

  const irqDelta = fieldDelta(prev.irq, curr.irq);
  const softirqDelta = fieldDelta(prev.softirq, curr.softirq);
  if (irqDelta === null && softirqDelta === null) return null;

  const combined = (irqDelta ?? 0) + (softirqDelta ?? 0);
  return (combined / deltaTotal) * 100;
}
