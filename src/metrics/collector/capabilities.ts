/**
 * Live capability discovery for the hardware-profile picker: sensor
 * candidate pools with current readings, storage probes, NIC classification,
 * and a `/proc` process-count probe. Not sampled on the metrics tick —
 * only when the control plane asks (`metrics-capabilities-request`).
 */
import { resolveDockerDataRoot } from "../../host/docker.ts";
import { probeStorage } from "./filesystem.ts";
import { resolveHostingPath } from "./hosting.ts";
import { parseProcMounts, storageMountCandidates } from "./mounts.ts";
import { classifyInterface } from "./network.ts";
import { parseNetDev } from "./parse-net-dev.ts";
import { readProcFile } from "./proc-read.ts";
import { countProcessesInProc } from "./processes.ts";
import {
  CPU_HWMON_CHIPS,
  defaultSensorIo,
  discoverSensors,
  fanChipCandidates,
  type GpuDeviceCandidates,
  type SensorIo,
} from "./sensors/index.ts";
import { readFanValue } from "./sensors/fan.ts";
import { readGpuPowerValue } from "./sensors/power.ts";
import { readTemperatureValue } from "./sensors/temperature.ts";
import type { SensorCandidate, StorageProbeResult } from "./types.ts";

export type MetricsSensorReading = {
  value: number;
  unit: "celsius" | "rpm" | "watts";
};

export type MetricsSensorCandidate = {
  chip: string;
  label: string;
  path: string;
  reading: MetricsSensorReading | null;
};

export type MetricsStorageMountCapability = {
  path: string;
  totalBytes: number;
  availableBytes: number;
} | null;

export type MetricsStorageProbeReason =
  | "path_not_found"
  | "docker_absent"
  | "statfs_unsupported";

export type MetricsStorageProbeOutcome = {
  probedPath: string | null;
  result: MetricsStorageMountCapability;
  reason?: MetricsStorageProbeReason;
};

export type MetricsProcessProbeReason = "proc_unreadable";

export type MetricsProcessCapability = {
  probedPath: string;
  reason?: MetricsProcessProbeReason;
};

export type MetricsStorageMountCandidate = {
  path: string;
  source: string;
  fsType: string;
  totalBytes: number;
  availableBytes: number;
};

export type MetricsNetworkInterfaceCapability = {
  name: string;
  classification: "loopback" | "container-bridge" | "fabric" | "uplink";
};

export type MetricsGpuDeviceCandidates = {
  path: string;
  chip: string;
  temperature: MetricsSensorCandidate[];
  power: MetricsSensorCandidate[];
  utilization?: MetricsSensorCandidate[];
  fan: MetricsSensorCandidate[];
};

export type MetricsDiskTemperatureReason =
  | "no_hwmon"
  | "drivetemp_not_loaded"
  | "no_disk_temperature_source";

export type MetricsSensorCapabilities = {
  cpuTemperature: MetricsSensorCandidate[];
  cpuPower: MetricsSensorCandidate[];
  cpuFan: MetricsSensorCandidate[];
  gpuFan: MetricsSensorCandidate[];
  boardTemperature: MetricsSensorCandidate[];
  ambient1Temperature: MetricsSensorCandidate[];
  ambient2Temperature: MetricsSensorCandidate[];
  disk1Temperature: MetricsSensorCandidate[];
  disk2Temperature: MetricsSensorCandidate[];
  systemFan1: MetricsSensorCandidate[];
  systemFan2: MetricsSensorCandidate[];
  gpuDevices: MetricsGpuDeviceCandidates[];
  reasons?: {
    diskTemperature?: MetricsDiskTemperatureReason;
  };
};

export type MetricsCapabilities = {
  sensors: MetricsSensorCapabilities;
  storageMounts: {
    system: MetricsStorageMountCapability;
    hosting: MetricsStorageProbeOutcome;
    docker: MetricsStorageProbeOutcome;
    candidates: MetricsStorageMountCandidate[];
  };
  networkInterfaces: MetricsNetworkInterfaceCapability[];
  process: MetricsProcessCapability;
};

export type CollectMetricsCapabilitiesDeps = {
  sysRoot?: string;
  io?: SensorIo;
  env?: Record<string, string | undefined>;
  daemonStateDir?: string;
  fabricInterfaces?: readonly string[];
  procDir?: string;
  resolveHostingPath?: () => Promise<string>;
  resolveDockerDataRoot?: () => Promise<string | null>;
  probeStorage?: (path: string) => Promise<StorageProbeResult>;
  pathExists?: (path: string) => Promise<boolean>;
  readProcNetDev?: () => Promise<string | undefined>;
  readProcMounts?: () => Promise<string | undefined>;
  countProcesses?: () => Promise<number | null>;
};

const DEFAULT_FABRIC_INTERFACES = ["tp0"] as const;
const MAX_CANDIDATES_PER_SLOT = 32;
const MAX_GPU_DEVICES = 16;
const MAX_MOUNT_CANDIDATES = 64;
const MAX_NICS = 128;

const DISK_TEMPERATURE_REASONS = new Set<MetricsDiskTemperatureReason>([
  "no_hwmon",
  "drivetemp_not_loaded",
  "no_disk_temperature_source",
]);

function capList<T>(items: T[], max: number): T[] {
  return items.length <= max ? items : items.slice(0, max);
}

function identityCandidate(candidate: SensorCandidate): MetricsSensorCandidate {
  return {
    chip: candidate.chip,
    label: candidate.label,
    path: candidate.path,
    reading: null,
  };
}

async function withReadings(
  candidates: SensorCandidate[],
  unit: MetricsSensorReading["unit"],
  read: (path: string) => Promise<number | null>,
): Promise<MetricsSensorCandidate[]> {
  const limited = capList(candidates, MAX_CANDIDATES_PER_SLOT);
  return await Promise.all(limited.map(async (candidate) => {
    const value = await read(candidate.path);
    return {
      chip: candidate.chip,
      label: candidate.label,
      path: candidate.path,
      reading: value === null ? null : { value, unit },
    };
  }));
}

function diskReason(
  raw: string | undefined,
): MetricsDiskTemperatureReason | undefined {
  if (
    raw && DISK_TEMPERATURE_REASONS.has(raw as MetricsDiskTemperatureReason)
  ) {
    return raw as MetricsDiskTemperatureReason;
  }
  return undefined;
}

function pickerClassification(
  name: string,
  fabricInterfaces: readonly string[],
): MetricsNetworkInterfaceCapability["classification"] {
  const kind = classifyInterface(name, [...fabricInterfaces]);
  if (
    kind === "loopback" || kind === "container-bridge" || kind === "fabric" ||
    kind === "uplink"
  ) {
    return kind;
  }
  return "uplink";
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function mountFromProbe(
  path: string,
  probe: StorageProbeResult,
): MetricsStorageMountCapability {
  if (!probe) return null;
  return {
    path,
    totalBytes: probe.totalBytes,
    availableBytes: probe.availableBytes,
  };
}

async function probeOutcome(args: {
  probedPath: string | null;
  absentReason?: MetricsStorageProbeReason;
  pathExists: (path: string) => Promise<boolean>;
  probe: (path: string) => Promise<StorageProbeResult>;
}): Promise<MetricsStorageProbeOutcome> {
  const { probedPath, absentReason, pathExists, probe } = args;
  if (probedPath === null) {
    return { probedPath: null, result: null, reason: absentReason };
  }
  if (!(await pathExists(probedPath))) {
    return { probedPath, result: null, reason: "path_not_found" };
  }
  const result = mountFromProbe(probedPath, await probe(probedPath));
  if (result) return { probedPath, result };
  return { probedPath, result: null, reason: "statfs_unsupported" };
}

async function collectGpuDevices(
  devices: GpuDeviceCandidates[],
  io: SensorIo,
): Promise<MetricsGpuDeviceCandidates[]> {
  const limited = capList(devices, MAX_GPU_DEVICES);
  return await Promise.all(limited.map(async (device) => {
    const [temperature, power, fan, utilization] = await Promise.all([
      withReadings(
        device.temperature,
        "celsius",
        (path) => readTemperatureValue(path, io),
      ),
      withReadings(
        device.power,
        "watts",
        (path) => readGpuPowerValue(path, io),
      ),
      withReadings(device.fan, "rpm", (path) => readFanValue(path, io)),
      Promise.resolve(
        capList(device.utilization, MAX_CANDIDATES_PER_SLOT).map(
          identityCandidate,
        ),
      ),
    ]);
    return {
      path: device.path,
      chip: device.chip,
      temperature,
      power,
      ...(utilization.length > 0 ? { utilization } : {}),
      fan,
    };
  }));
}

async function collectSensors(
  sysRoot: string,
  io: SensorIo,
): Promise<MetricsSensorCapabilities> {
  const discovered = await discoverSensors(sysRoot, io);
  const cpuFanPool = fanChipCandidates(
    discovered.fan,
    CPU_HWMON_CHIPS,
    true,
  );
  const systemFanPool = fanChipCandidates(
    discovered.fan,
    CPU_HWMON_CHIPS,
    false,
  );
  const ambientPool = discovered.ambientTemperature;
  const diskPool = discovered.diskTemperature;

  const [
    cpuTemperature,
    cpuFan,
    boardTemperature,
    diskTemperature,
    systemFan,
    gpuDevices,
  ] = await Promise.all([
    withReadings(
      discovered.cpuTemperature,
      "celsius",
      (path) => readTemperatureValue(path, io),
    ),
    withReadings(cpuFanPool, "rpm", (path) => readFanValue(path, io)),
    withReadings(
      ambientPool,
      "celsius",
      (path) => readTemperatureValue(path, io),
    ),
    withReadings(
      diskPool,
      "celsius",
      (path) => readTemperatureValue(path, io),
    ),
    withReadings(systemFanPool, "rpm", (path) => readFanValue(path, io)),
    collectGpuDevices(discovered.gpuDevices, io),
  ]);

  const cpuPower = capList(discovered.cpuPower, MAX_CANDIDATES_PER_SLOT).map(
    identityCandidate,
  );
  const gpuFan = gpuDevices.flatMap((device) => device.fan);
  const reason = diskReason(discovered.reasons?.diskTemperature);

  return {
    cpuTemperature,
    cpuPower,
    cpuFan,
    gpuFan,
    boardTemperature,
    ambient1Temperature: boardTemperature,
    ambient2Temperature: boardTemperature,
    disk1Temperature: diskTemperature,
    disk2Temperature: diskTemperature,
    systemFan1: systemFan,
    systemFan2: systemFan,
    gpuDevices,
    ...(reason ? { reasons: { diskTemperature: reason } } : {}),
  };
}

async function collectStorage(
  deps: CollectMetricsCapabilitiesDeps,
): Promise<MetricsCapabilities["storageMounts"]> {
  const pathExists = deps.pathExists ?? defaultPathExists;
  const probe = deps.probeStorage ?? ((path) => probeStorage(path));
  const hostingPath = deps.resolveHostingPath ??
    (() => resolveHostingPath(deps.env, deps.daemonStateDir));
  const dockerRoot = deps.resolveDockerDataRoot ??
    (async () => (await resolveDockerDataRoot()) ?? null);
  const readMounts = deps.readProcMounts ??
    (() => readProcFile("/proc/mounts"));

  const [systemProbe, hosting, docker, mountsText] = await Promise.all([
    probe("/"),
    hostingPath().then((path) =>
      probeOutcome({ probedPath: path, pathExists, probe })
    ),
    dockerRoot().then((path) =>
      probeOutcome({
        probedPath: path,
        absentReason: "docker_absent",
        pathExists,
        probe,
      })
    ),
    readMounts(),
  ]);

  const entries = mountsText
    ? storageMountCandidates(parseProcMounts(mountsText))
    : [];
  const candidates: MetricsStorageMountCandidate[] = [];
  for (const entry of capList(entries, MAX_MOUNT_CANDIDATES)) {
    const probed = await probe(entry.mountPoint);
    if (!probed) continue;
    candidates.push({
      path: entry.mountPoint,
      source: entry.source,
      fsType: entry.fsType,
      totalBytes: probed.totalBytes,
      availableBytes: probed.availableBytes,
    });
  }

  return {
    system: mountFromProbe("/", systemProbe),
    hosting,
    docker,
    candidates,
  };
}

async function collectNetwork(
  deps: CollectMetricsCapabilitiesDeps,
): Promise<MetricsNetworkInterfaceCapability[]> {
  const fabric = deps.fabricInterfaces ?? DEFAULT_FABRIC_INTERFACES;
  const readNetDev = deps.readProcNetDev ??
    (() => readProcFile("/proc/net/dev"));
  const text = await readNetDev();
  const parsed = text ? parseNetDev(text) : null;
  if (!parsed) return [];
  return capList(
    Object.keys(parsed).sort((a, b) => a.localeCompare(b)),
    MAX_NICS,
  )
    .map((name) => ({
      name,
      classification: pickerClassification(name, fabric),
    }));
}

async function collectProcess(
  deps: CollectMetricsCapabilitiesDeps,
): Promise<MetricsProcessCapability> {
  const procDir = deps.procDir ?? "/proc";
  const count = deps.countProcesses
    ? await deps.countProcesses()
    : await countProcessesInProc(procDir);
  if (count === null) {
    return { probedPath: procDir, reason: "proc_unreadable" };
  }
  return { probedPath: procDir };
}

/** Assemble the hardware-profile picker's live discovery payload. */
export async function collectMetricsCapabilities(
  deps: CollectMetricsCapabilitiesDeps = {},
): Promise<MetricsCapabilities> {
  const sysRoot = deps.sysRoot ?? "/sys";
  const io = deps.io ?? defaultSensorIo();
  const [sensors, storageMounts, networkInterfaces, process] = await Promise
    .all([
      collectSensors(sysRoot, io),
      collectStorage(deps),
      collectNetwork(deps),
      collectProcess(deps),
    ]);
  return { sensors, storageMounts, networkInterfaces, process };
}
