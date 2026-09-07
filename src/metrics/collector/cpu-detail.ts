/**
 * CPU-detail collector: builds `CpuDetailSampleV5` — host-wide
 * current-frequency
 * range (`/sys/devices/system/cpu/cpuN/cpufreq/scaling_cur_freq`, falling
 * back to the read-only `cpuinfo_cur_freq` on governors that don't expose
 * `scaling_cur_freq`), and scheduling/interrupt counters
 * (`ctxt`/`processes`/`intr` from `/proc/stat`, routed through the shared
 * `CounterBaselineTracker` as rates — `parseStatScalarCounters` already
 * parses these, reserved for this exact phase). `cpuIrqPercent` reuses
 * `cpu.ts`'s `cpuIrqPercentV5` against the aggregate `cpu` line, not a
 * per-core sum.
 *
 * v5 carries no per-core breakdown: the busiest-core `hotspots` array was
 * removed with the rest of the per-core surface, so this family is purely
 * host-scoped and its slot budget dropped from 19 to 7.
 */
import { cpuIrqPercentV5 } from "./cpu.ts";
import { parseStatScalarCounters } from "./parse-stat.ts";
import type { CounterBaselineTracker } from "./baseline.ts";
import type { CpuDetailSampleV5 } from "../contract-v5.ts";
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

export type CpuDetailDeps = {
  io: SensorIo;
  sysRoot?: string;
  statText: string | undefined;
  prevCpu: CpuCounters | null;
  currCpu: CpuCounters | null;
  currCores: Record<string, CpuCounters>;
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
};

/** `null` only when `/proc/stat` itself was unreadable this tick (matches the orchestrator's other "no raw text → no reading" gates). */
export async function buildCpuDetailSample(
  deps: CpuDetailDeps,
): Promise<CpuDetailSampleV5 | null> {
  if (deps.statText === undefined) return null;

  const frequency = await readFrequencyRangeMHz(
    deps.io,
    deps.sysRoot ?? "/sys",
    Object.keys(deps.currCores),
  );
  const scalars = parseStatScalarCounters(deps.statText);

  const contextSwitchesPerSecond = scalars.ctxt === null
    ? null
    : deps.tracker.rate(
      "cpuDetail:host:ctxt",
      scalars.ctxt,
      deps.bootGeneration,
      deps.seconds,
    );
  const forksPerSecond = scalars.processes === null ? null : deps.tracker.rate(
    "cpuDetail:host:processes",
    scalars.processes,
    deps.bootGeneration,
    deps.seconds,
  );
  const interruptsPerSecond = scalars.intr === null ? null : deps.tracker.rate(
    "cpuDetail:host:intr",
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
    cpuIrqPercent: cpuIrqPercentV5(deps.prevCpu, deps.currCpu),
  };
}
