/**
 * Hardware-signal telemetry: reads live values for the signals
 * `topology/hardware-signal-topology.ts` already identified this tick.
 * Topology discovery and telemetry reading intentionally stay separate
 * modules (see `topology/topology.ts`'s doc comment) — this module re-runs
 * `discoverSensors` against the same `io`/`sysRoot` to get live candidates,
 * then joins them back to topology identity via the same `signal:${chip}:
 * ${label}` id `hardware-signal-topology.ts` derives.
 *
 * The live candidate map built here stays deliberately BROADER than the
 * topology catalog it's joined against (fan/GPU/ambient candidates
 * included, even though none of those are projected into
 * `hardwareSignals` telemetry any more) — `events/physical-health.ts` reads
 * this same map directly for fan fault/alarm and voltage/PSU-alarm
 * detection, independent of which signals actually made it into the
 * topology catalog.
 *
 * No physical-machine check is needed here: `topologySignals` is already
 * `[]` on every VM (`physical-classifier.ts` gates topology discovery
 * itself), so this module has nothing to iterate on a non-physical host.
 *
 * A signal topology already identified but unreadable this tick (candidate
 * vanished, sysfs read failed) resolves to `{ value: null }` — it is never
 * dropped, since topology said it exists. The two synthetic CPU virtual
 * signals (hottest-core, thermal-throttled) have no candidate-map entry at
 * all — they're computed directly, branched on by signal id before the
 * candidate lookup.
 */
import {
  CPU_HOTTEST_CORE_SIGNAL_ID,
  CPU_THERMAL_THROTTLED_SIGNAL_ID,
  cpuThermalThrottlePath,
  selectCpuCoreTemperatures,
} from "../topology/hardware-signal-topology.ts";
import {
  discoverSensors,
  sensorId,
  type SensorIo,
} from "./sensors/discovery.ts";
import { readTemperatureValue } from "./sensors/temperature.ts";
import type { CounterBaselineTracker } from "./baseline.ts";
import type { HardwareSignalCandidateMap } from "./events/types.ts";
import type { HardwareSignalSampleV5 } from "../contract-v5.ts";
import type { PhysicalSignalTopology } from "../topology/types.ts";
import type { SensorCandidate } from "./types.ts";

/** Same stable identity discipline as `hardware-signal-topology.ts`'s private `toSignalId`. */
function toSignalId(candidate: SensorCandidate): string {
  return `signal:${sensorId(candidate)}`;
}

export type HardwareSignalSamplesResult = {
  samples: HardwareSignalSampleV5[];
  /** Live candidate map (`signalId → SensorCandidate`) — reused by `events/physical-health.ts` to derive sibling alarm/fault sysfs paths without a third `discoverSensors` walk. */
  candidates: HardwareSignalCandidateMap;
};

type LiveCandidates = {
  candidates: Map<string, SensorCandidate>;
  /** This tick's live per-core CPU temperature candidates — feeds the hottest-core synthetic signal. */
  coreCandidates: SensorCandidate[];
};

/**
 * Every candidate `discoverSensors` can produce, flattened into one
 * `signalId`-keyed map — including GPU-device-scoped fan/power candidates
 * (`capabilities.gpuDevices[].fan`/`.power`), which live outside the flat
 * `capabilities.fan`/`capabilities.gpuPower` arrays. Deliberately includes
 * every category (fan/GPU/ambient) regardless of whether the topology
 * catalog itself projects that category — see this module's doc comment.
 */
async function buildLiveCandidates(
  io: SensorIo,
  sysRoot: string,
): Promise<LiveCandidates> {
  const capabilities = await discoverSensors(sysRoot, io);
  const all: SensorCandidate[] = [
    ...capabilities.cpuTemperature,
    ...capabilities.gpuTemperature,
    ...capabilities.diskTemperature,
    ...capabilities.ambientTemperature,
    ...capabilities.cpuPower,
    ...capabilities.gpuPower,
    ...capabilities.fan,
    ...capabilities.gpuDevices.flatMap((device) => [
      ...device.fan,
      ...device.power,
    ]),
  ];
  const candidates = new Map<string, SensorCandidate>();
  for (const candidate of all) {
    candidates.set(toSignalId(candidate), candidate);
  }
  return {
    candidates,
    coreCandidates: selectCpuCoreTemperatures(capabilities.cpuTemperature),
  };
}

/** RAPL cumulative `energy_uj` → average watts over the interval, via the shared tracked-rate convention (`Δcounter/Δseconds`, here further divided by 1e6 for microjoules → joules). */
async function readCpuPowerWatts(
  candidate: SensorCandidate,
  signalId: string,
  io: SensorIo,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
  seconds: number,
): Promise<number | null> {
  const key = `signal:${signalId}:energy`;
  const raw = await io.readFile(candidate.path);
  const energyMicrojoules = Number(raw?.trim());
  if (!Number.isFinite(energyMicrojoules)) {
    tracker.invalidate(key);
    return null;
  }
  const rate = tracker.rate(key, energyMicrojoules, bootGeneration, seconds);
  return rate === null ? null : rate / 1e6;
}

/** Max live temperature across this tick's per-core candidates; `null` when none read cleanly (never a max over a partial set silently dropping unreadable cores — a core that fails to read just doesn't contribute). */
async function readHottestCoreValue(
  coreCandidates: readonly SensorCandidate[],
  io: SensorIo,
): Promise<number | null> {
  const values = await Promise.all(
    coreCandidates.map((c) => readTemperatureValue(c.path, io)),
  );
  let max: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

const THERMAL_THROTTLE_BASELINE_KEY = "signal:cpu:thermal-throttled:ms";

/** Cumulative `package_throttle_total_time_ms` → percent of the interval spent throttled, via the same tracked-rate convention `dcgm-adapter.ts` uses for GPU `DCGM_FI_DEV_THERMAL_VIOLATION`. */
async function readThermalThrottledPercent(
  sysRoot: string,
  io: SensorIo,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
  seconds: number,
): Promise<number | null> {
  const raw = await io.readFile(cpuThermalThrottlePath(sysRoot));
  const ms = Number(raw?.trim());
  if (!Number.isFinite(ms)) {
    tracker.invalidate(THERMAL_THROTTLE_BASELINE_KEY);
    return null;
  }
  const rate = tracker.rate(
    THERMAL_THROTTLE_BASELINE_KEY,
    ms,
    bootGeneration,
    seconds,
  );
  if (rate === null) return null;
  return Math.min(100, Math.max(0, (rate / 1000) * 100));
}

export async function buildHardwareSignalSamples(
  topologySignals: readonly PhysicalSignalTopology[],
  deps: {
    io: SensorIo;
    sysRoot?: string;
    tracker: CounterBaselineTracker;
    bootGeneration: number;
    seconds: number;
  },
): Promise<HardwareSignalSamplesResult> {
  if (topologySignals.length === 0) {
    return { samples: [], candidates: new Map() };
  }

  const root = deps.sysRoot ?? "/sys";
  const { candidates, coreCandidates } = await buildLiveCandidates(
    deps.io,
    root,
  );

  const samples = await Promise.all(
    topologySignals.map(async (signal): Promise<HardwareSignalSampleV5> => {
      if (signal.signalId === CPU_HOTTEST_CORE_SIGNAL_ID) {
        const value = await readHottestCoreValue(coreCandidates, deps.io);
        return { signalId: signal.signalId, kind: signal.kind, value };
      }
      if (signal.signalId === CPU_THERMAL_THROTTLED_SIGNAL_ID) {
        const value = await readThermalThrottledPercent(
          root,
          deps.io,
          deps.tracker,
          deps.bootGeneration,
          deps.seconds,
        );
        return { signalId: signal.signalId, kind: signal.kind, value };
      }

      const candidate = candidates.get(signal.signalId);
      if (!candidate) {
        deps.tracker.invalidate(`signal:${signal.signalId}:energy`);
        return { signalId: signal.signalId, kind: signal.kind, value: null };
      }

      if (signal.kind === "temperature") {
        const value = await readTemperatureValue(candidate.path, deps.io);
        return { signalId: signal.signalId, kind: signal.kind, value };
      }
      if (signal.kind === "power" && signal.component === "cpu") {
        const value = await readCpuPowerWatts(
          candidate,
          signal.signalId,
          deps.io,
          deps.tracker,
          deps.bootGeneration,
          deps.seconds,
        );
        return { signalId: signal.signalId, kind: signal.kind, value };
      }

      return { signalId: signal.signalId, kind: signal.kind, value: null };
    }),
  );

  return { samples, candidates };
}
