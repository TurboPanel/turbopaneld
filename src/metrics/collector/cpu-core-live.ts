/**
 * Live-only per-core CPU breakdown (`CpuCoreLiveSampleV4[]`) — one entry per
 * online logical core, same per-core math as `cpu.ts`'s
 * `maxCoreBusyPercentV4`. Pure function: whether the result gets attached to
 * a sample is `linux-collector.ts`'s call (only when `collectionMode ===
 * "live"`), never this module's — keeps it trivially testable without
 * threading collection-mode through it.
 *
 * `coreIdOf` resolves a `/proc/stat` logical-core key to its topology-stable
 * id (`topology/cpu-topology.ts`'s `buildCpuCoreIdIndex`/
 * `coreIdForStatKey`) — sorting still happens on the numeric `/proc/stat`
 * key, since the stable id isn't itself numeric-orderable.
 */
import { cpuBusyPercentV4 } from "./cpu.ts";
import type { CpuCoreLiveSampleV4 } from "../contract-v4.ts";
import type { CpuCounters } from "./types.ts";

/** Every logical core present in both snapshots, sorted by numeric core index (never insertion/object-key order). */
export function buildCpuCoreLiveSamples(
  prevCores: Record<string, CpuCounters>,
  currCores: Record<string, CpuCounters>,
  seconds: number,
  coreIdOf: (key: string) => string,
): CpuCoreLiveSampleV4[] {
  const entries: { key: string; sample: CpuCoreLiveSampleV4 }[] = [];
  for (const key of Object.keys(currCores)) {
    const prev = prevCores[key];
    const curr = currCores[key];
    if (!prev) continue;
    const pct = cpuBusyPercentV4(prev, curr, seconds);
    if (pct.busyPercent === null) continue;
    entries.push({
      key,
      sample: {
        coreId: coreIdOf(key),
        busyPercent: pct.busyPercent,
        iowaitPercent: pct.iowaitPercent,
        stealPercent: pct.stealPercent,
      },
    });
  }
  entries.sort((a, b) => Number(a.key) - Number(b.key));
  return entries.map((entry) => entry.sample);
}
