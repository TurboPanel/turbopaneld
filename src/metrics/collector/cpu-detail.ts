/**
 * CPU-detail collector: builds `CpuDetailSampleV4` — the daemon's 4 busiest
 * logical cores this interval (`hotspots`), host-wide current-frequency
 * range (`/sys/devices/system/cpu/cpuN/cpufreq/scaling_cur_freq`, falling
 * back to the read-only `cpuinfo_cur_freq` on governors that don't expose
 * `scaling_cur_freq`), and scheduling/interrupt counters
 * (`ctxt`/`processes`/`intr` from `/proc/stat`, routed through the shared
 * `CounterBaselineTracker` as rates — `parseStatScalarCounters` already
 * parses these, reserved for this exact phase). `cpuIrqPercent` reuses
 * `cpu.ts`'s `cpuIrqPercentV4` against the aggregate `cpu` line, not a
 * per-core sum.
 *
 * Cores are identified via `coreIdOf`, resolved from `topology/
 * cpu-topology.ts`'s per-core topology catalog (`buildCpuCoreIdIndex`/
 * `coreIdForStatKey`) — a topology-stable id, not the raw `/proc/stat`
 * `cpuN` key, so a reboot/hotplug reindex never silently reuses an old id
 * for a different logical thread.
 */
import { cpuBusyPercentV4, cpuIrqPercentV4 } from "./cpu.ts";
import { parseStatScalarCounters } from "./parse-stat.ts";
import type { CounterBaselineTracker } from "./baseline.ts";
import type { CpuDetailSampleV4, CpuHotspotSampleV4 } from "../contract-v4.ts";
import type { SensorIo } from "./sensors/discovery.ts";
import type { CpuCounters } from "./types.ts";

const HOTSPOT_COUNT = 4;

/** This tick's `HOTSPOT_COUNT` busiest logical cores, by `busyPercent`, present in both snapshots. */
function selectHotspots(
  prevCores: Record<string, CpuCounters>,
  currCores: Record<string, CpuCounters>,
  seconds: number,
  coreIdOf: (key: string) => string,
): CpuHotspotSampleV4[] {
  const scored: CpuHotspotSampleV4[] = [];
  for (const key of Object.keys(currCores)) {
    const prev = prevCores[key];
    const curr = currCores[key];
    if (!prev) continue;
    const pct = cpuBusyPercentV4(prev, curr, seconds);
    if (pct.busyPercent === null) continue;
    scored.push({
      coreId: coreIdOf(key),
      busyPercent: pct.busyPercent,
      iowaitPercent: pct.iowaitPercent,
      stealPercent: pct.stealPercent,
    });
  }
  scored.sort((a, b) => (b.busyPercent ?? 0) - (a.busyPercent ?? 0));
  return scored.slice(0, HOTSPOT_COUNT);
}

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
  prevCores: Record<string, CpuCounters>;
  currCores: Record<string, CpuCounters>;
  /** Resolves a `/proc/stat` logical-core key (e.g. `"0"`) to its topology-stable coreId. */
  coreIdOf: (key: string) => string;
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
};

/** `null` only when `/proc/stat` itself was unreadable this tick (matches the orchestrator's other "no raw text → no reading" gates). */
export async function buildCpuDetailSample(
  deps: CpuDetailDeps,
): Promise<CpuDetailSampleV4 | null> {
  if (deps.statText === undefined) return null;

  const hotspots = selectHotspots(
    deps.prevCores,
    deps.currCores,
    deps.seconds,
    deps.coreIdOf,
  );
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
    hotspots,
    averageFrequencyMHz: frequency.averageFrequencyMHz,
    minimumFrequencyMHz: frequency.minimumFrequencyMHz,
    maximumFrequencyMHz: frequency.maximumFrequencyMHz,
    contextSwitchesPerSecond,
    interruptsPerSecond,
    forksPerSecond,
    cpuIrqPercent: cpuIrqPercentV4(deps.prevCpu, deps.currCpu),
  };
}
