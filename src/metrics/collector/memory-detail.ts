/**
 * Memory-detail collector: builds `MemoryDetailSampleV5` — the 16 slab/
 * dirty/writeback/commit gauge fields from `/proc/meminfo`
 * (`parse-meminfo.ts`'s `parseMeminfoDetail`) plus 3 reclaim/compaction
 * rates from `/proc/vmstat` (`parse-vmstat.ts`'s `parseVmstatReclaim`),
 * routed through the shared `CounterBaselineTracker`.
 */
import { parseMeminfoDetail } from "./parse-meminfo.ts";
import { parseVmstatReclaim } from "./parse-vmstat.ts";
import type { CounterBaselineTracker } from "./baseline.ts";
import type { MemoryDetailSampleV5 } from "../contract-v5.ts";

export type MemoryDetailDeps = {
  memText: string | undefined;
  vmstatText: string | undefined;
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
};

/** `null` only when both `/proc/meminfo` and `/proc/vmstat` were unreadable this tick. */
export function buildMemoryDetailSample(
  deps: MemoryDetailDeps,
): MemoryDetailSampleV5 | null {
  if (deps.memText === undefined && deps.vmstatText === undefined) {
    return null;
  }

  const gauges = deps.memText ? parseMeminfoDetail(deps.memText) : {
    memoryFreeBytes: null,
    cachedBytes: null,
    anonPagesBytes: null,
    slabReclaimableBytes: null,
    slabUnreclaimableBytes: null,
    dirtyBytes: null,
    writebackBytes: null,
    shmemBytes: null,
    pageTablesBytes: null,
    kernelStackBytes: null,
    committedAsBytes: null,
    commitLimitBytes: null,
    activeAnonBytes: null,
    inactiveAnonBytes: null,
    activeFileBytes: null,
    inactiveFileBytes: null,
  };

  const reclaim = deps.vmstatText
    ? parseVmstatReclaim(deps.vmstatText)
    : { pgscanDirect: null, pgscanKswapd: null, compactStall: null };

  const pageScanDirectPerSecond = reclaim.pgscanDirect === null
    ? null
    : deps.tracker.rate(
      "memoryDetail:host:pgscanDirect",
      reclaim.pgscanDirect,
      deps.bootGeneration,
      deps.seconds,
    );
  const pageScanKswapdPerSecond = reclaim.pgscanKswapd === null
    ? null
    : deps.tracker.rate(
      "memoryDetail:host:pgscanKswapd",
      reclaim.pgscanKswapd,
      deps.bootGeneration,
      deps.seconds,
    );
  const compactionStallsPerSecond = reclaim.compactStall === null
    ? null
    : deps.tracker.rate(
      "memoryDetail:host:compactStall",
      reclaim.compactStall,
      deps.bootGeneration,
      deps.seconds,
    );

  return {
    ...gauges,
    pageScanDirectPerSecond,
    pageScanKswapdPerSecond,
    compactionStallsPerSecond,
  };
}
