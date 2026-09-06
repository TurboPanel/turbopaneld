/**
 * Physical hardware-signal topology: a conservative, physical-only subset of
 * the hwmon/RAPL sensor candidates `collector/sensors/discovery.ts` already
 * enumerates, mapped into stable `PhysicalSignalTopology` entries — signal
 * identity/membership only, never a telemetry reading (see `topology.ts`'s
 * doc comment). Callers gate this behind `isPhysicalMachine()` — see
 * `physical-classifier.ts` — so a VM never reports fabricated signals.
 *
 * `hardwareSignals` is deliberately narrower than everything
 * `discoverSensors` can produce: CPU package temperature, CPU package power
 * (RAPL), NVMe/`drivetemp` storage temperatures, and only board/inlet/DIMM/
 * VRM/chipset temperatures whose hwmon label is trustworthily identifiable
 * — never a generic "everything else" catch-all. Fan tachometers and GPU
 * temperature/power are excluded entirely: fan RPM has no home in sampled
 * telemetry, and GPU temperature/power already ride `GpuSampleV4` (via
 * `gpus[]`, `gpu-topology.ts`/`collector/gpu/`) — projecting them here too
 * would double-report the same reading under two different families. (Fan
 * *fault/alarm* fault detection still works: `events/physical-health.ts`
 * reads the broader live candidate map `hardware-signals.ts` builds each
 * tick directly, independent of this topology catalog.)
 *
 * Two synthetic (non-hwmon-file-backed) CPU virtual signals round out the
 * catalog: hottest-core temperature (max of the per-core hwmon candidates,
 * computed per-tick in `collector/hardware-signals.ts`) and CPU
 * thermal-throttled percent (from the kernel's cumulative
 * `package_throttle_total_time_ms` counter, tracked-rate same as RAPL
 * power). Each is only added when its underlying data actually exists this
 * discovery pass — an entry that can never resolve would be fabricated
 * identity, which this module's discovery-only contract forbids.
 */
import {
  discoverSensors,
  sensorId,
  type SensorIo,
} from "../collector/sensors/discovery.ts";
import type { SensorCandidate } from "../collector/types.ts";
import type {
  PhysicalSignalThresholds,
  PhysicalSignalTopology,
  SignalId,
} from "./types.ts";

export type HardwareSignalTopologyDeps = {
  io: SensorIo;
  sysRoot?: string;
};

/** Stable signal identity — `chip:label`, same discipline as every other topology id. */
function toSignalId(candidate: SensorCandidate): SignalId {
  return `signal:${sensorId(candidate)}`;
}

export const CPU_HOTTEST_CORE_SIGNAL_ID: SignalId = "signal:cpu:hottest-core";
export const CPU_THERMAL_THROTTLED_SIGNAL_ID: SignalId =
  "signal:cpu:thermal-throttled";

/** Cumulative ms a CPU package has spent thermally throttled since boot (Intel, kernel ≥5.4) — package-wide, so only `cpu0`'s copy is read (every core in a package reports the same counter; summing per-cpuN would double-count). */
export function cpuThermalThrottlePath(sysRoot: string): string {
  return `${sysRoot}/devices/system/cpu/cpu0/thermal_throttle/package_throttle_total_time_ms`;
}

const TEMP_INPUT_SUFFIX = "_input";
const TEMP_THRESHOLD_FILES: ReadonlyArray<
  [keyof PhysicalSignalThresholds, string]
> = [
  ["warning", "_max"],
  ["critical", "_crit"],
];

/** Package-level (never per-core) CPU temperature labels — hwmon's own `coretemp`/`k10temp`/`zenpower` naming, or a CPU thermal-zone type. */
const CPU_PACKAGE_TEMP_LABEL_RE =
  /^(package id \d+|tctl|tdie|x86_pkg_temp|cpu-thermal|cpu_thermal)$/i;
/** Per-core CPU temperature labels — `coretemp`'s `Core N`, or AMD chiplet-die `TccdN`. */
const CPU_CORE_TEMP_LABEL_RE = /^(core \d+|tccd\d+)$/i;

/** Board/inlet/DIMM/VRM/chipset — the only ambient-temperature labels trustworthy enough to report; an unrecognized `tempN`/vendor-specific label (e.g. `AUXTIN`, `CPUTIN`) is dropped rather than guessed at. */
const TRUSTED_BOARD_LABEL_RE =
  /(inlet|ambient|board|systin|motherboard|dimm|dram|vrm|vcore|pch|chipset)/i;

/**
 * hwmon commonly exposes `tempN_max`/`tempN_crit` next to `tempN_input` —
 * both report millidegrees C, same as the reading itself. Absent when the
 * chip exposes neither file.
 */
async function readTemperatureThresholds(
  path: string,
  io: SensorIo,
): Promise<PhysicalSignalThresholds | undefined> {
  if (!path.endsWith(TEMP_INPUT_SUFFIX)) return undefined;
  const base = path.slice(0, -TEMP_INPUT_SUFFIX.length);
  const thresholds: PhysicalSignalThresholds = {};
  for (const [key, suffix] of TEMP_THRESHOLD_FILES) {
    const raw = await io.readFile(`${base}${suffix}`);
    const milli = Number(raw?.trim());
    if (Number.isFinite(milli)) thresholds[key] = milli / 1000;
  }
  return Object.keys(thresholds).length > 0 ? thresholds : undefined;
}

async function toSignal(
  candidate: SensorCandidate,
  kind: string,
  unit: string,
  component: string,
  io: SensorIo,
  withThresholds: boolean,
): Promise<PhysicalSignalTopology> {
  const thresholds = withThresholds
    ? await readTemperatureThresholds(candidate.path, io)
    : undefined;
  return {
    signalId: toSignalId(candidate),
    kind,
    unit,
    component,
    label: candidate.label,
    ...(thresholds ? { thresholds } : {}),
  };
}

async function toSignals(
  candidates: SensorCandidate[],
  kind: string,
  unit: string,
  component: string,
  io: SensorIo,
  withThresholds: boolean,
): Promise<PhysicalSignalTopology[]> {
  return await Promise.all(
    candidates.map((candidate) =>
      toSignal(candidate, kind, unit, component, io, withThresholds)
    ),
  );
}

/** First package-level candidate; falls back to the first CPU-temperature candidate at all (mirrors `sensors/discovery.ts`'s `selectCandidate` auto-detect fallback) when no label matches the known package-level set. */
function selectCpuPackageTemperature(
  candidates: readonly SensorCandidate[],
): SensorCandidate | undefined {
  return candidates.find((c) => CPU_PACKAGE_TEMP_LABEL_RE.test(c.label)) ??
    candidates[0];
}

/** Exported for `collector/hardware-signals.ts`'s per-tick hottest-core computation — same label discipline as topology discovery. */
export function selectCpuCoreTemperatures(
  candidates: readonly SensorCandidate[],
): SensorCandidate[] {
  return candidates.filter((c) => CPU_CORE_TEMP_LABEL_RE.test(c.label));
}

async function hottestCoreSignal(
  coreCandidates: readonly SensorCandidate[],
  io: SensorIo,
): Promise<PhysicalSignalTopology | undefined> {
  if (coreCandidates.length === 0) return undefined;
  // Threshold files are uniform across a coretemp package's cores — the
  // first core's is representative for the synthetic max signal too.
  const thresholds = await readTemperatureThresholds(
    coreCandidates[0].path,
    io,
  );
  return {
    signalId: CPU_HOTTEST_CORE_SIGNAL_ID,
    kind: "temperature",
    unit: "celsius",
    component: "cpu",
    label: "Hottest core",
    ...(thresholds ? { thresholds } : {}),
  };
}

async function thermalThrottledSignal(
  sysRoot: string,
  io: SensorIo,
): Promise<PhysicalSignalTopology | undefined> {
  const raw = await io.readFile(cpuThermalThrottlePath(sysRoot));
  if (raw === undefined) return undefined;
  return {
    signalId: CPU_THERMAL_THROTTLED_SIGNAL_ID,
    kind: "percent",
    unit: "percent",
    component: "cpu",
    label: "CPU thermal throttled",
  };
}

/**
 * Enumerate the conservative physical-signal catalog: CPU package
 * temperature/power, NVMe/`drivetemp` storage temperatures, trustworthily
 * labeled board/inlet/DIMM/VRM/chipset temperatures, and (when discoverable)
 * the two synthetic CPU virtual signals.
 */
export async function collectHardwareSignals(
  deps: HardwareSignalTopologyDeps,
): Promise<PhysicalSignalTopology[]> {
  const root = deps.sysRoot ?? "/sys";
  const capabilities = await discoverSensors(root, deps.io);

  const packageCandidate = selectCpuPackageTemperature(
    capabilities.cpuTemperature,
  );
  const coreCandidates = selectCpuCoreTemperatures(capabilities.cpuTemperature);
  const boardCandidates = capabilities.ambientTemperature.filter((c) =>
    TRUSTED_BOARD_LABEL_RE.test(c.label)
  );

  const [
    cpuTemperature,
    diskTemperature,
    boardTemperature,
    cpuPower,
    hottestCore,
    thermalThrottled,
  ] = await Promise.all([
    packageCandidate
      ? toSignal(
        packageCandidate,
        "temperature",
        "celsius",
        "cpu",
        deps.io,
        true,
      )
        .then((s) => [s])
      : Promise.resolve([]),
    toSignals(
      capabilities.diskTemperature,
      "temperature",
      "celsius",
      "disk",
      deps.io,
      true,
    ),
    toSignals(
      boardCandidates,
      "temperature",
      "celsius",
      "board",
      deps.io,
      true,
    ),
    toSignals(capabilities.cpuPower, "power", "watts", "cpu", deps.io, false),
    hottestCoreSignal(coreCandidates, deps.io),
    thermalThrottledSignal(root, deps.io),
  ]);

  return [
    ...cpuTemperature,
    ...diskTemperature,
    ...boardTemperature,
    ...cpuPower,
    ...(hottestCore ? [hottestCore] : []),
    ...(thermalThrottled ? [thermalThrottled] : []),
  ];
}
