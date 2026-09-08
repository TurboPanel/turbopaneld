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
 * topology catalog it's joined against (fan candidates included, even
 * though fan RPM is never projected into `hardwareSignals` telemetry) —
 * `events/physical-health.ts` reads this same map directly for fan
 * fault/alarm and voltage/PSU-alarm detection, independent of which signals
 * actually made it into the topology catalog.
 *
 * No physical-machine check is needed here: `topologySignals` is already
 * `[]` on every VM (`physical-classifier.ts` gates topology discovery
 * itself), so this module has nothing to iterate on a non-physical host.
 *
 * A signal topology already identified but unreadable this tick (candidate
 * vanished, sysfs read failed) resolves to `{ value: null }` — it is never
 * dropped, since topology said it exists.
 *
 * Three groups of signals have no hwmon candidate of their own and are
 * resolved by exact signal id *before* the candidate lookup (a candidate miss
 * invalidates a RAPL baseline key and returns `null`, which would be wrong
 * for all of them):
 *
 *  - The two synthetic CPU virtual signals (hottest-core, thermal-throttled),
 *    computed directly here.
 *  - The per-GPU temperature/memory-temperature/power signals, whose only
 *    source is this tick's already-merged `GpuThermalReadings` from
 *    `gpu/index.ts` — NVIDIA GPUs expose no hwmon chip at all, so there is
 *    nothing to walk sysfs for. Threading the merge in also means no second
 *    read of the same device per tick.
 *  - The per-service-drive temperature signals, resolved by joining this
 *    tick's own per-probe `component: "disk"` results back onto block
 *    topology by kernel name via `block-devices.ts`'s
 *    `buildBlockDeviceTemperatures` — the same authoritative-`Composite`
 *    discipline that used to fill `BlockDeviceSample.temperatureCelsius`.
 *
 * Because the drive signals are derived from other signals' values, this
 * builder runs in two phases: resolve everything candidate-backed and
 * synthetic first, then fill the drive entities from those results.
 */
import {
  blockTemperatureSignalId,
  CPU_HOTTEST_CORE_SIGNAL_ID,
  CPU_THERMAL_THROTTLED_SIGNAL_ID,
  cpuThermalThrottlePath,
  GPU_SIGNAL_KINDS,
  gpuSignalId,
  selectCpuCoreTemperatures,
} from "../topology/hardware-signal-topology.ts";
import {
  discoverSensors,
  sensorId,
  type SensorIo,
} from "./sensors/discovery.ts";
import { readTemperatureValue } from "./sensors/temperature.ts";
import { buildBlockDeviceTemperatures } from "./block-devices.ts";
import type { CounterBaselineTracker } from "./baseline.ts";
import type { HardwareSignalCandidateMap } from "./events/types.ts";
import type { GpuThermalReading, GpuThermalReadings } from "./gpu/index.ts";
import type { HardwareSignalSample } from "../contract.ts";
import type {
  BlockDeviceTopology,
  PhysicalSignalTopology,
} from "../topology/types.ts";
import type { SensorCandidate } from "./types.ts";

/** Same stable identity discipline as `hardware-signal-topology.ts`'s private `toSignalId`. */
function toSignalId(candidate: SensorCandidate): string {
  return `signal:${sensorId(candidate)}`;
}

export type HardwareSignalSamplesResult = {
  samples: HardwareSignalSample[];
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

/** Which {@link GpuThermalReading} field each GPU signal kind reads — the one place the two vocabularies are tied together. */
const GPU_SIGNAL_FIELD: Record<
  (typeof GPU_SIGNAL_KINDS)[number],
  keyof GpuThermalReading
> = {
  "temperature": "temperatureCelsius",
  "memory-temperature": "memoryTemperatureCelsius",
  "power": "powerWatts",
};

/**
 * This tick's per-GPU signal values, keyed by the exact `signalId`
 * `hardware-signal-topology.ts` derives — built up front so the resolve loop
 * is an id lookup, never a parse of the opaque `gpuId` back out of the id.
 * Empty when no adapter set is wired, which resolves every GPU signal to
 * `null` rather than falling through to the hwmon candidate lookup.
 */
function buildGpuSignalValues(
  thermals: GpuThermalReadings | undefined,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!thermals) return out;
  for (const [gpuId, reading] of thermals) {
    for (const kind of GPU_SIGNAL_KINDS) {
      out.set(gpuSignalId(gpuId, kind), reading[GPU_SIGNAL_FIELD[kind]]);
    }
  }
  return out;
}

/** `signalId → kernelName` for the entity-joined drive signals — same up-front-map discipline as {@link buildGpuSignalValues}. */
function buildBlockSignalKernelNames(
  blockDevices: readonly BlockDeviceTopology[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const device of blockDevices ?? []) {
    out.set(blockTemperatureSignalId(device.deviceId), device.kernelName);
  }
  return out;
}

/**
 * Phase 2: fill the entity-joined drive signals from the per-probe
 * `component: "disk"` readings this tick already produced. Only those are
 * passed to the join — every other component's id parses into a
 * meaningless kernel name that could shadow a real drive.
 */
function resolveDriveTemperatures(
  topologySignals: readonly PhysicalSignalTopology[],
  samples: HardwareSignalSample[],
  kernelNames: Map<string, string>,
): void {
  if (kernelNames.size === 0) return;
  const temperatures = buildBlockDeviceTemperatures(
    samples.filter((_, index) => topologySignals[index].component === "disk"),
  );
  samples.forEach((sample, index) => {
    const kernelName = kernelNames.get(sample.signalId);
    if (kernelName === undefined) return;
    samples[index] = { ...sample, value: temperatures[kernelName] ?? null };
  });
}

export type HardwareSignalDeps = {
  io: SensorIo;
  sysRoot?: string;
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
  /** This tick's merged per-GPU physical readings (`gpu/index.ts`'s `buildGpuSamples`) — the only source for the `component: "gpu"` signals. */
  gpuThermals?: GpuThermalReadings;
  /** This tick's block topology — resolves each `component: "drive"` signal back to the kernel name its temperature is keyed by. */
  blockDevices?: readonly BlockDeviceTopology[];
};

export async function buildHardwareSignalSamples(
  topologySignals: readonly PhysicalSignalTopology[],
  deps: HardwareSignalDeps,
): Promise<HardwareSignalSamplesResult> {
  if (topologySignals.length === 0) {
    return { samples: [], candidates: new Map() };
  }

  const root = deps.sysRoot ?? "/sys";
  const { candidates, coreCandidates } = await buildLiveCandidates(
    deps.io,
    root,
  );
  const gpuValues = buildGpuSignalValues(deps.gpuThermals);
  const blockKernelNames = buildBlockSignalKernelNames(deps.blockDevices);

  const samples = await Promise.all(
    topologySignals.map(async (signal): Promise<HardwareSignalSample> => {
      if (signal.component === "gpu") {
        return {
          signalId: signal.signalId,
          kind: signal.kind,
          value: gpuValues.get(signal.signalId) ?? null,
        };
      }
      if (signal.component === "drive") {
        // Filled in phase 2 — it reads the disk results this pass produces.
        return { signalId: signal.signalId, kind: signal.kind, value: null };
      }
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

  resolveDriveTemperatures(topologySignals, samples, blockKernelNames);
  return { samples, candidates };
}
