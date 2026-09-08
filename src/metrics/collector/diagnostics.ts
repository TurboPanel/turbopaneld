/**
 * Diagnostics collector: builds `DiagnosticsSample` — v6's single merged
 * depth family, replacing v5's separate `cpu-detail.ts` and
 * `memory-detail.ts` collectors.
 *
 * CPU half: host-wide current-frequency range
 * (`/sys/devices/system/cpu/cpuN/cpufreq/scaling_cur_freq`, falling back to
 * the read-only `cpuinfo_cur_freq` on governors that don't expose
 * `scaling_cur_freq`), and scheduling/interrupt counters
 * (`ctxt`/`processes`/`intr` from `/proc/stat`, routed through the shared
 * `CounterBaselineTracker` as rates). `cpuIrqPercent` reuses `cpu.ts`'s
 * `cpuIrqPercent` against the aggregate `cpu` line, not a per-core sum. No
 * per-core breakdown exists: the busiest-core `hotspots` array was removed
 * with the rest of the per-core surface in v5.
 *
 * Memory half: 9 slab/dirty/writeback/commit gauges from `/proc/meminfo`
 * (`parse-meminfo.ts`'s `parseMeminfoDiagnostics`) plus 3
 * reclaim/compaction rates from `/proc/vmstat` (`parse-vmstat.ts`'s
 * `parseVmstatReclaim`), also routed through the baseline tracker.
 *
 * The two halves degrade independently: a tick that can read `/proc/stat`
 * but not `/proc/meminfo` still reports the CPU half with the memory half
 * all-`null`, rather than dropping the whole row.
 */
import { cpuIrqPercent } from "./cpu.ts";
import { parseMeminfoDiagnostics } from "./parse-meminfo.ts";
import { parseStatScalarCounters } from "./parse-stat.ts";
import { parseVmstatReclaim } from "./parse-vmstat.ts";
import type { CounterBaselineTracker } from "./baseline.ts";
import type { DiagnosticsSample } from "../contract.ts";
import type { SensorIo } from "./sensors/discovery.ts";
import type { CpuCounters } from "./types.ts";

type FrequencyRangeMHz = {
  averageFrequencyMHz: number | null;
  minimumFrequencyMHz: number | null;
  maximumFrequencyMHz: number | null;
};

const EMPTY_FREQUENCY_RANGE: FrequencyRangeMHz = {
  averageFrequencyMHz: null,
  minimumFrequencyMHz: null,
  maximumFrequencyMHz: null,
};

const EMPTY_MEMINFO_GAUGES = {
  memoryFreeBytes: null,
  cachedBytes: null,
  anonPagesBytes: null,
  slabReclaimableBytes: null,
  slabUnreclaimableBytes: null,
  dirtyBytes: null,
  writebackBytes: null,
  shmemBytes: null,
  committedAsBytes: null,
} as const;

async function readCoreFrequencyKHz(
  io: SensorIo,
  sysRoot: string,
  coreKey: string,
): Promise<number | null> {
  const base = `${sysRoot}/devices/system/cpu/cpu${coreKey}/cpufreq`;
  const scaling = await io.readFile(`${base}/scaling_cur_freq`);
  const scalingValue = Number(scaling?.trim());
  if (Number.isFinite(scalingValue) && scalingValue > 0) return scalingValue;

  const cpuinfo = await io.readFile(`${base}/cpuinfo_cur_freq`);
  const cpuinfoValue = Number(cpuinfo?.trim());
  return Number.isFinite(cpuinfoValue) && cpuinfoValue > 0
    ? cpuinfoValue
    : null;
}

/** Average/min/max current frequency (MHz) across every core key present this tick; all-`null` when none read cleanly. */
async function readFrequencyRangeMHz(
  io: SensorIo,
  sysRoot: string,
  coreKeys: readonly string[],
): Promise<FrequencyRangeMHz> {
  if (coreKeys.length === 0) return EMPTY_FREQUENCY_RANGE;

  const readingsKHz = await Promise.all(
    coreKeys.map((key) => readCoreFrequencyKHz(io, sysRoot, key)),
  );
  const valid = readingsKHz.filter((v): v is number => v !== null);
  if (valid.length === 0) return EMPTY_FREQUENCY_RANGE;

  const sumKHz = valid.reduce((sum, v) => sum + v, 0);
  return {
    averageFrequencyMHz: sumKHz / valid.length / 1000,
    minimumFrequencyMHz: Math.min(...valid) / 1000,
    maximumFrequencyMHz: Math.max(...valid) / 1000,
  };
}

export type DiagnosticsDeps = {
  io: SensorIo;
  sysRoot?: string;
  statText: string | undefined;
  memText: string | undefined;
  vmstatText: string | undefined;
  prevCpu: CpuCounters | null;
  currCpu: CpuCounters | null;
  currCores: Record<string, CpuCounters>;
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
};

async function buildDiagnosticsCpu(
  deps: DiagnosticsDeps,
): Promise<DiagnosticsSample["cpu"]> {
  const frequency = await readFrequencyRangeMHz(
    deps.io,
    deps.sysRoot ?? "/sys",
    Object.keys(deps.currCores),
  );
  const scalars = deps.statText === undefined
    ? { ctxt: null, processes: null, intr: null }
    : parseStatScalarCounters(deps.statText);

  const contextSwitchesPerSecond = scalars.ctxt === null
    ? null
    : deps.tracker.rate(
      "diagnostics:host:ctxt",
      scalars.ctxt,
      deps.bootGeneration,
      deps.seconds,
    );
  const forksPerSecond = scalars.processes === null ? null : deps.tracker.rate(
    "diagnostics:host:processes",
    scalars.processes,
    deps.bootGeneration,
    deps.seconds,
  );
  const interruptsPerSecond = scalars.intr === null ? null : deps.tracker.rate(
    "diagnostics:host:intr",
    scalars.intr,
    deps.bootGeneration,
    deps.seconds,
  );

  return {
    averageFrequencyMHz: frequency.averageFrequencyMHz,
    minimumFrequencyMHz: frequency.minimumFrequencyMHz,
    maximumFrequencyMHz: frequency.maximumFrequencyMHz,
    contextSwitchesPerSecond,
    interruptsPerSecond,
    forksPerSecond,
    cpuIrqPercent: cpuIrqPercent(deps.prevCpu, deps.currCpu),
  };
}

function buildDiagnosticsMemory(
  deps: DiagnosticsDeps,
): DiagnosticsSample["memory"] {
  const gauges = deps.memText
    ? parseMeminfoDiagnostics(deps.memText)
    : { ...EMPTY_MEMINFO_GAUGES };

  const reclaim = deps.vmstatText
    ? parseVmstatReclaim(deps.vmstatText)
    : { pgscanDirect: null, pgscanKswapd: null, compactStall: null };

  const pageScanDirectPerSecond = reclaim.pgscanDirect === null
    ? null
    : deps.tracker.rate(
      "diagnostics:host:pgscanDirect",
      reclaim.pgscanDirect,
      deps.bootGeneration,
      deps.seconds,
    );
  const pageScanKswapdPerSecond = reclaim.pgscanKswapd === null
    ? null
    : deps.tracker.rate(
      "diagnostics:host:pgscanKswapd",
      reclaim.pgscanKswapd,
      deps.bootGeneration,
      deps.seconds,
    );
  const compactionStallsPerSecond = reclaim.compactStall === null
    ? null
    : deps.tracker.rate(
      "diagnostics:host:compactStall",
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

/**
 * `null` only when none of `/proc/stat`, `/proc/meminfo` and `/proc/vmstat`
 * were readable this tick — matching the orchestrator's other "no raw text →
 * no reading" gates. Any one of them present yields a row, with the
 * unreadable sources' fields `null` rather than `0`.
 */
export async function buildDiagnosticsSample(
  deps: DiagnosticsDeps,
): Promise<DiagnosticsSample | null> {
  if (
    deps.statText === undefined && deps.memText === undefined &&
    deps.vmstatText === undefined
  ) {
    return null;
  }

  return {
    cpu: await buildDiagnosticsCpu(deps),
    memory: buildDiagnosticsMemory(deps),
  };
}
