/**
 * `/proc/vmstat` parsing and rate conversion for swap and major-fault
 * counters. `oom_kill` is parsed when present (some older kernels expose no
 * such vmstat entry) and exposed as a raw cumulative counter for a later
 * events-phase collector to diff — this phase never emits `MetricEventV5`.
 */
import type { CounterBaselineTracker } from "./baseline.ts";

/** Injectable one-shot page-size probe — fixture-driven for host-free tests. */
export type PageSizeIo = {
  runGetconf: () => { code: number; stdout: Uint8Array };
};

function defaultRunGetconf(): { code: number; stdout: Uint8Array } {
  return new Deno.Command("getconf", {
    args: ["PAGE_SIZE"],
    stdout: "piped",
    stderr: "null",
    // Scoped --allow-run=getconf cannot inherit LD_* / DYLD_* (Deno 2.9).
    clearEnv: true,
  }).outputSync();
}

/**
 * Host page size in bytes, resolved once (at collector construction, never
 * per tick) via `getconf PAGE_SIZE` — not every supported host uses Linux's
 * historical 4096-byte default (16 KiB/64 KiB kernel pages exist), and
 * `vmstat`'s `pswpin`/`pswpout` counters are page counts, not bytes. Falls
 * back to 4096 on any failure (non-Linux, sandboxed `--allow-run`, missing
 * `getconf`) rather than throwing — a wrong-but-plausible default beats an
 * unsupported collector.
 */
export function resolvePageSizeBytes(io?: PageSizeIo): number {
  try {
    const { code, stdout } = (io?.runGetconf ?? defaultRunGetconf)();
    if (code !== 0) return 4096;
    const value = Number(new TextDecoder().decode(stdout).trim());
    return Number.isFinite(value) && value > 0 ? value : 4096;
  } catch {
    return 4096;
  }
}

export type VmstatCounters = {
  pswpin: number | null;
  pswpout: number | null;
  pgmajfault: number | null;
  /** Cumulative OOM-kill count; `null` when the vmstat entry is absent (older kernels). */
  oomKill: number | null;
};

function parseLine(text: string, key: string): number | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key} `)) continue;
    const value = Number(trimmed.slice(key.length + 1).trim());
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export function parseVmstat(text: string): VmstatCounters {
  return {
    pswpin: parseLine(text, "pswpin"),
    pswpout: parseLine(text, "pswpout"),
    pgmajfault: parseLine(text, "pgmajfault"),
    oomKill: parseLine(text, "oom_kill"),
  };
}

/**
 * Cumulative reclaim/compaction counters for `memory-detail.ts`'s
 * `MemoryDetailSampleV5.pageScanDirectPerSecond`/`pageScanKswapdPerSecond`/
 * `compactionStallsPerSecond`. `pgscanDirect`/`pgscanKswapd` each sum every
 * `pgscan_direct*` (respectively `pgscan_kswapd*`) line present — modern
 * kernels expose one bare counter per reclaim path, older kernels split per
 * memory zone (`pgscan_direct_dma32`, ...); either way this sums to the same
 * per-path total. Kept apart rather than combined into one scan total
 * because the two paths mean different things operationally: `pgscan_direct`
 * is the calling process itself stalling to reclaim memory (acute pressure),
 * while `pgscan_kswapd` is the background reclaim daemon keeping ahead of
 * demand. `pgscan_direct_throttle` (a distinct "times reclaim was
 * throttled" counter, unrelated to pages scanned) is deliberately excluded
 * despite sharing the `pgscan_direct` prefix.
 */
export type VmstatReclaimCounters = {
  pgscanDirect: number | null;
  pgscanKswapd: number | null;
  compactStall: number | null;
};

function isReclaimCounterKey(key: string, prefix: string): boolean {
  if (key === prefix) return true;
  if (!key.startsWith(`${prefix}_`)) return false;
  return key !== `${prefix}_throttle`;
}

function sumReclaimLines(
  text: string,
  prefixes: readonly string[],
): number | null {
  let sum = 0;
  let found = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex === -1) continue;
    const key = trimmed.slice(0, spaceIndex);
    if (!prefixes.some((prefix) => isReclaimCounterKey(key, prefix))) continue;
    const value = Number(trimmed.slice(spaceIndex + 1).trim());
    if (!Number.isFinite(value)) continue;
    sum += value;
    found = true;
  }
  return found ? sum : null;
}

export function parseVmstatReclaim(text: string): VmstatReclaimCounters {
  return {
    pgscanDirect: sumReclaimLines(text, ["pgscan_direct"]),
    pgscanKswapd: sumReclaimLines(text, ["pgscan_kswapd"]),
    compactStall: parseLine(text, "compact_stall"),
  };
}

export type VmstatRates = {
  swapInBytesPerSecond: number | null;
  swapOutBytesPerSecond: number | null;
  majorPageFaultsPerSecond: number | null;
};

/** Route `pswpin`/`pswpout`/`pgmajfault` through the shared baseline tracker into per-second rates. */
export function vmstatRates(
  curr: VmstatCounters,
  seconds: number,
  pageSizeBytes: number,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
): VmstatRates {
  const pswpinRate = curr.pswpin === null
    ? null
    : tracker.rate("vmstat:host:pswpin", curr.pswpin, bootGeneration, seconds);
  const pswpoutRate = curr.pswpout === null ? null : tracker.rate(
    "vmstat:host:pswpout",
    curr.pswpout,
    bootGeneration,
    seconds,
  );
  const pgmajfaultRate = curr.pgmajfault === null ? null : tracker.rate(
    "vmstat:host:pgmajfault",
    curr.pgmajfault,
    bootGeneration,
    seconds,
  );

  return {
    swapInBytesPerSecond: pswpinRate === null
      ? null
      : pswpinRate * pageSizeBytes,
    swapOutBytesPerSecond: pswpoutRate === null
      ? null
      : pswpoutRate * pageSizeBytes,
    majorPageFaultsPerSecond: pgmajfaultRate,
  };
}
