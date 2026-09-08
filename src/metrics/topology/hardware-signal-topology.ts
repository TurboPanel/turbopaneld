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
 * — never a generic "everything else" catch-all. Fan tachometers are
 * excluded entirely: fan RPM has no home in sampled telemetry. (Fan
 * *fault/alarm* detection still works: `events/physical-health.ts` reads
 * the broader live candidate map `hardware-signals.ts` builds each tick
 * directly, independent of this topology catalog.)
 *
 * Entity-joined signals round out the catalog: one temperature /
 * memory-temperature / power signal per topology-enumerated GPU
 * ({@link gpuSignalId}) and one temperature signal per topology-enumerated
 * *service* block device that a disk-temperature candidate actually backs
 * ({@link blockTemperatureSignalId}). These carry the physical-only
 * readings that used to ride `GpuSample`/`BlockDeviceSample` directly, so
 * every physical sensor reading — whatever entity owns it — rides this one
 * family, behind this one `isPhysicalMachine()` gate, with one paging
 * order and one `physicalHardwareSignalSlots` entitlement. They are never
 * fabricated: a GPU signal only exists when GPU topology enumerated that
 * GPU, and a drive signal only when a matching hwmon probe was discovered.
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
  BlockDeviceTopology,
  GpuId,
  GpuTopology,
  PhysicalSignalThresholds,
  PhysicalSignalTopology,
  SignalId,
  TopologyDeviceId,
} from "./types.ts";

export type HardwareSignalTopologyDeps = {
  io: SensorIo;
  sysRoot?: string;
  /**
   * This tick's already-discovered GPU topology — one temperature /
   * memory-temperature / power signal is enumerated per entry. Absent (or
   * empty) means no GPU signals at all; a GPU signal is never synthesized
   * for a GPU topology did not enumerate.
   */
  gpus?: readonly GpuTopology[];
  /**
   * This tick's already-discovered block topology. Only `isServiceDevice`
   * entries are considered (the same membership `buildBlockDeviceSamples`
   * uses), and only those a disk-temperature candidate actually backs get a
   * signal.
   */
  blockDevices?: readonly BlockDeviceTopology[];
};

/** Stable signal identity — `chip:label`, same discipline as every other topology id. */
function toSignalId(candidate: SensorCandidate): SignalId {
  return `signal:${sensorId(candidate)}`;
}

/**
 * NVMe's own composite reading — the vendor-computed whole-drive value the
 * NVMe spec defines and the one that drives the drive's own thermal
 * throttling, so it wins outright over the per-probe `Sensor N` readings.
 * Shared with `collector/block-devices.ts`'s temperature join so both sides
 * of the drive-temperature pipeline agree on which probe is authoritative.
 */
export const NVME_COMPOSITE_LABEL = "Composite";

export const CPU_HOTTEST_CORE_SIGNAL_ID: SignalId = "signal:cpu:hottest-core";
export const CPU_THERMAL_THROTTLED_SIGNAL_ID: SignalId =
  "signal:cpu:thermal-throttled";

/** The three physical readings a GPU contributes to `hardware.physical` — the fields that used to sit on `GpuSample`. */
export type GpuSignalKind = "temperature" | "memory-temperature" | "power";

/** Every GPU signal kind, in the order {@link gpuEntitySignals} enumerates them. */
export const GPU_SIGNAL_KINDS: readonly GpuSignalKind[] = [
  "temperature",
  "memory-temperature",
  "power",
];

/**
 * Stable signal identity for a GPU-owned physical reading. The `signal:gpu:`
 * / `signal:block:` prefixes deliberately can't collide with an hwmon-backed
 * `signal:<chip>:<label>` id, whose chip segment is a kernel hwmon/RAPL name.
 * Consumers must resolve these by exact-id lookup, never by splitting on
 * `:` — a `GpuId`/`TopologyDeviceId` is opaque and may itself contain one.
 */
export function gpuSignalId(gpuId: GpuId, kind: GpuSignalKind): SignalId {
  return `signal:gpu:${gpuId}:${kind}`;
}

/** Stable signal identity for a service block device's drive temperature — see {@link gpuSignalId} on why these are never parsed apart. */
export function blockTemperatureSignalId(
  deviceId: TopologyDeviceId,
): SignalId {
  return `signal:block:${deviceId}:temperature`;
}

const GPU_SIGNAL_SHAPE: Record<
  GpuSignalKind,
  { kind: string; unit: string; suffix: string }
> = {
  "temperature": {
    kind: "temperature",
    unit: "celsius",
    suffix: "temperature",
  },
  "memory-temperature": {
    kind: "temperature",
    unit: "celsius",
    suffix: "memory temperature",
  },
  "power": { kind: "power", unit: "watts", suffix: "power" },
};

/**
 * Three signals per topology-enumerated GPU. Gated on GPU topology alone,
 * never on an hwmon probe: NVIDIA GPUs expose no hwmon chip at all (their
 * readings come from NVML/DCGM), so requiring a sensor candidate here would
 * drop every NVIDIA GPU. A GPU whose adapters read nothing this tick
 * resolves to `{ value: null }` in `collector/hardware-signals.ts`, the same
 * as any other identified-but-unreadable signal.
 */
function gpuEntitySignals(
  gpus: readonly GpuTopology[],
): PhysicalSignalTopology[] {
  return gpus.flatMap((gpu) =>
    GPU_SIGNAL_KINDS.map((signalKind): PhysicalSignalTopology => {
      const shape = GPU_SIGNAL_SHAPE[signalKind];
      const prefix = gpu.chip.trim() || "GPU";
      return {
        signalId: gpuSignalId(gpu.gpuId, signalKind),
        kind: shape.kind,
        unit: shape.unit,
        component: "gpu",
        label: `${prefix} ${shape.suffix}`,
      };
    })
  );
}

/**
 * One drive-temperature signal per *service* block device an actual
 * disk-temperature candidate backs — `discovery.ts` already resolves an
 * NVMe/`drivetemp` hwmon chip down to its backing block device, which is
 * exactly the `kernelName` block topology keys on. A service device with no
 * probe gets no signal rather than a permanently-`null` one.
 *
 * The per-probe `component: "disk"` signals stay in the catalog alongside
 * these: NVMe exposes several probes per drive and an operator may want the
 * individual ones, while this entity-joined signal is the single
 * whole-drive reading (`Composite` when present) that joins onto the drive.
 * Thresholds come from the same candidate the reading will — they are here
 * so the control plane can draw a drive's warning/critical lines, *not* so a
 * crossing fires twice: `events/physical-health.ts` raises thermal events
 * from the raw `component: "disk"` probe only and skips these mirrors.
 */
async function blockEntitySignals(
  blockDevices: readonly BlockDeviceTopology[],
  diskCandidates: readonly SensorCandidate[],
  io: SensorIo,
): Promise<PhysicalSignalTopology[]> {
  const byKernelName = new Map<string, SensorCandidate[]>();
  for (const candidate of diskCandidates) {
    const bucket = byKernelName.get(candidate.chip);
    if (bucket) bucket.push(candidate);
    else byKernelName.set(candidate.chip, [candidate]);
  }

  const devices = blockDevices.filter((device) =>
    device.isServiceDevice && byKernelName.has(device.kernelName)
  );
  return await Promise.all(devices.map(async (device) => {
    const bucket = byKernelName.get(device.kernelName)!;
    const representative = bucket.find((c) =>
      c.label === NVME_COMPOSITE_LABEL
    ) ?? bucket[0];
    const thresholds = await readTemperatureThresholds(
      representative.path,
      io,
    );
    return {
      signalId: blockTemperatureSignalId(device.deviceId),
      kind: "temperature",
      unit: "celsius",
      component: "drive",
      label: `${device.kernelName} temperature`,
      ...(thresholds ? { thresholds } : {}),
    };
  }));
}

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
    label: operatorFacingSignalLabel(candidate.label, kind, component),
    ...(thresholds ? { thresholds } : {}),
  };
}

/**
 * Kernel hwmon/RAPL names (`Package id 0`, `package-0`) are identity, not
 * operator copy. Chart titles use these; `signalId` stays `chip:label`.
 */
function operatorFacingSignalLabel(
  kernelLabel: string,
  kind: string,
  component: string,
): string {
  if (
    component === "cpu" && kind === "temperature" &&
    CPU_PACKAGE_TEMP_LABEL_RE.test(kernelLabel)
  ) {
    return "CPU package temperature";
  }
  if (
    component === "cpu" && kind === "power" &&
    /^package-\d+$/i.test(kernelLabel)
  ) {
    return "CPU package power";
  }
  return kernelLabel;
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
 * labeled board/inlet/DIMM/VRM/chipset temperatures, (when discoverable) the
 * two synthetic CPU virtual signals, and the entity-joined GPU/service-drive
 * signals `deps.gpus`/`deps.blockDevices` make possible.
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
    blockEntities,
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
    blockEntitySignals(
      deps.blockDevices ?? [],
      capabilities.diskTemperature,
      deps.io,
    ),
  ]);

  return [
    ...cpuTemperature,
    ...diskTemperature,
    ...boardTemperature,
    ...cpuPower,
    ...(hottestCore ? [hottestCore] : []),
    ...(thermalThrottled ? [thermalThrottled] : []),
    ...blockEntities,
    ...gpuEntitySignals(deps.gpus ?? []),
  ];
}
