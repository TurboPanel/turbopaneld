/**
 * Host metrics capabilities: what this host can measure and where.
 *
 * Answers the daemon-side `metrics-capabilities-request` correlated cell
 * round trip (see `src/instance/client.ts`) with the same discovery /
 * storage-probe / interface-classification building blocks the collector
 * uses — discovery is never re-implemented here.
 */
import { statfs } from "node:fs/promises";

import { resolveDockerDataRoot } from "../host/docker.ts";
import { FABRIC_INTERFACE_NAME } from "../instance/commands/fabric.ts";
import { countProcessesInProc } from "./collector/processes.ts";
import { probeStorage } from "./collector/filesystem.ts";
import { resolveHostingPath } from "./collector/hosting.ts";
import { parseProcMounts, storageMountCandidates } from "./collector/mounts.ts";
import { classifyInterface } from "./collector/network.ts";
import { parseNetDev } from "./collector/parse-net-dev.ts";
import { readProcFile } from "./collector/proc-read.ts";
import {
  CPU_HWMON_CHIPS,
  defaultSensorIo,
  discoverSensors,
  fanChipCandidates,
  type GpuDeviceCandidates,
  type SensorCapabilities,
  type SensorIo,
} from "./collector/sensors/index.ts";
import { readTemperatureValue } from "./collector/sensors/temperature.ts";
import { readFanValue } from "./collector/sensors/fan.ts";
import { readGpuPowerValue } from "./collector/sensors/power.ts";
import type {
  NetInterfaceClassification,
  SensorCandidate,
  StatfsResult,
} from "./collector/types.ts";

const PROC_DIR = "/proc";

export type StorageMountCapability = {
  path: string;
  totalBytes: number;
  availableBytes: number;
} | null;

/** Why a `StorageProbeOutcome.result` came back `null`. */
export type StorageProbeReason =
  | "path_not_found"
  | "docker_absent"
  | "statfs_unsupported";

/**
 * A hosting/Docker storage probe's full outcome — unlike the bare
 * `StorageMountCapability` that `system` still carries, this preserves the
 * path that was actually probed even when the probe failed, so an operator
 * can tell "no path resolved" (`probedPath: null`) apart from "resolved
 * `/srv/users`, but `statfs` couldn't answer for it".
 */
export type StorageProbeOutcome = {
  /** Path the daemon attempted to probe; `null` when no candidate path resolved at all. */
  probedPath: string | null;
  /** Successful probe result; `null` when unprobeable — see `reason`. */
  result: StorageMountCapability;
  /** Explanation for a `null` `result`, when known. */
  reason?: StorageProbeReason;
};

/** Why {@link ProcessCapability}'s process count would come back `null`. */
export type ProcessProbeReason = "proc_unreadable";

/**
 * `/proc` process-count probe outcome — surfaces why the process-count chart
 * can go blank (`/proc` unreadable or hardened) instead of giving no
 * explanation at all for a `null` `countProcessesInProc()` result.
 */
export type ProcessCapability = {
  /** Path the daemon attempted to read (`/proc`). */
  probedPath: string;
  /** Explanation for why process counting is unavailable, when known. */
  reason?: ProcessProbeReason;
};

/**
 * One block-backed mount an administrator could select as the hosting
 * filesystem — discovered from the host mount table, probed for capacity.
 */
export type StorageMountCandidate = {
  path: string;
  /** Mount source, e.g. `/dev/nvme0n1p2`. */
  source: string;
  /** Filesystem type, e.g. `ext4`. */
  fsType: string;
  totalBytes: number;
  availableBytes: number;
};

export type NetworkInterfaceCapability = {
  name: string;
  classification: NetInterfaceClassification;
};

/** A candidate's current live value, for the control-plane picker to display beside its identity. */
export type MetricsSensorReading = {
  value: number;
  unit: "celsius" | "rpm" | "watts";
};

/**
 * One selectable sensor candidate, enriched with its current reading (`null`
 * when the sysfs read failed or was out of the plausible range — the same
 * degrade-to-null treatment {@link readTemperatureValue}/{@link readFanValue}/
 * {@link readGpuPowerValue} apply for an actual collected sample).
 */
export type MetricsSensorCandidate = SensorCandidate & {
  reading: MetricsSensorReading | null;
};

/** One physical GPU's candidates, grouped by hwmon chip directory — mirrors {@link GpuDeviceCandidates}, enriched with readings. */
export type MetricsGpuDeviceCandidates = {
  path: string;
  chip: string;
  temperature: MetricsSensorCandidate[];
  power: MetricsSensorCandidate[];
  fan: MetricsSensorCandidate[];
};

/**
 * Sensor candidates reshaped from raw discovery categories
 * ({@link SensorCapabilities}) into the same slots
 * `ServerHardwareProfile` assigns — the control plane and UI forward this
 * verbatim, so the shape here is the wire contract, not an internal detail.
 *
 * `ambient1Temperature`/`ambient2Temperature`/`boardTemperature` share one
 * candidate pool (as do `disk1Temperature`/`disk2Temperature` and
 * `systemFan1`/`systemFan2`) because discovery doesn't further disambiguate
 * them — any candidate in the shared pool may be assigned to any of those
 * slots, mirroring how {@link readHostSensors} resolves them.
 */
export type MetricsSensorCapabilities = {
  cpuTemperature: MetricsSensorCandidate[];
  /** RAPL energy counters, not an instantaneous gauge — no `reading` attached (see `cpuTdpWattsOverride`/collector power delta instead). */
  cpuPower: MetricsSensorCandidate[];
  cpuFan: MetricsSensorCandidate[];
  /** Flattened across every discovered GPU device. */
  gpuFan: MetricsSensorCandidate[];
  boardTemperature: MetricsSensorCandidate[];
  ambient1Temperature: MetricsSensorCandidate[];
  ambient2Temperature: MetricsSensorCandidate[];
  disk1Temperature: MetricsSensorCandidate[];
  disk2Temperature: MetricsSensorCandidate[];
  systemFan1: MetricsSensorCandidate[];
  systemFan2: MetricsSensorCandidate[];
  gpuDevices: MetricsGpuDeviceCandidates[];
  /** Explanation for an empty category the control plane can surface, when known. */
  reasons?: {
    diskTemperature?: string;
  };
};

export type MetricsCapabilities = {
  sensors: MetricsSensorCapabilities;
  storageMounts: {
    system: StorageMountCapability;
    hosting: StorageProbeOutcome;
    docker: StorageProbeOutcome;
    /** Selectable hosting filesystems for the control plane to present/persist. */
    candidates: StorageMountCandidate[];
  };
  networkInterfaces: NetworkInterfaceCapability[];
  process: ProcessCapability;
};

/** Injectable I/O seams mirroring the collector's `CollectorDeps` boundaries. */
export type MetricsCapabilityDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  statfs: (
    path: string,
  ) => StatfsResult | null | Promise<StatfsResult | null>;
  resolveDockerDataRoot: () => Promise<string | null>;
  resolveHostingPath: () => string | Promise<string>;
  resolveFabricInterfaces: () => Promise<string[]>;
  discoverSensors: () => Promise<SensorCapabilities>;
  countProcesses: () => number | null | Promise<number | null>;
  /**
   * Reads one sensor candidate's raw sysfs value — the same IO the
   * `discoverSensors` dep used to enumerate candidates, reused here to
   * attach each candidate's live reading. Injectable so tests can point it
   * at the same fixture root as their `discoverSensors` stub.
   */
  readSensorFile: SensorIo["readFile"];
};

async function defaultStatfs(path: string): Promise<StatfsResult | null> {
  try {
    const result = await statfs(path);
    return {
      blocks: Number(result.blocks),
      bfree: Number(result.bfree),
      bavail: Number(result.bavail),
      bsize: Number(result.bsize),
    };
  } catch {
    return null;
  }
}

function defaultDeps(): MetricsCapabilityDeps {
  return {
    readProcFile,
    statfs: defaultStatfs,
    resolveDockerDataRoot: async () => (await resolveDockerDataRoot()) ?? null,
    resolveHostingPath: () => resolveHostingPath(),
    resolveFabricInterfaces: () => Promise.resolve([FABRIC_INTERFACE_NAME]),
    discoverSensors: () => discoverSensors(),
    countProcesses: () => countProcessesInProc(PROC_DIR),
    readSensorFile: defaultSensorIo().readFile,
  };
}

type SensorReadingKind = "temperature" | "fan" | "gpuPower";

async function readCandidateReading(
  kind: SensorReadingKind,
  path: string,
  io: SensorIo,
): Promise<MetricsSensorReading | null> {
  if (kind === "temperature") {
    const value = await readTemperatureValue(path, io);
    return value === null ? null : { value, unit: "celsius" };
  }
  if (kind === "fan") {
    const value = await readFanValue(path, io);
    return value === null ? null : { value, unit: "rpm" };
  }
  const value = await readGpuPowerValue(path, io);
  return value === null ? null : { value, unit: "watts" };
}

/** Enrich every candidate in a pool with its current reading, in parallel. */
async function enrichCandidates(
  candidates: SensorCandidate[],
  kind: SensorReadingKind,
  io: SensorIo,
): Promise<MetricsSensorCandidate[]> {
  return await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      reading: await readCandidateReading(kind, candidate.path, io),
    })),
  );
}

async function enrichGpuDevice(
  device: GpuDeviceCandidates,
  io: SensorIo,
): Promise<MetricsGpuDeviceCandidates> {
  const [temperature, power, fan] = await Promise.all([
    enrichCandidates(device.temperature, "temperature", io),
    enrichCandidates(device.power, "gpuPower", io),
    enrichCandidates(device.fan, "fan", io),
  ]);
  return { path: device.path, chip: device.chip, temperature, power, fan };
}

/**
 * Reshape raw discovery categories into the hardware-profile slot shape,
 * attaching a live reading to every candidate along the way so the picker
 * can show which physical device is moving.
 */
async function buildSensorCapabilities(
  raw: SensorCapabilities,
  readSensorFile: MetricsCapabilityDeps["readSensorFile"],
): Promise<MetricsSensorCapabilities> {
  const io: SensorIo = { listDir: () => [], readFile: readSensorFile };

  const [
    cpuTemperature,
    cpuFan,
    systemFan,
    ambientBoard,
    disk,
    gpuDevices,
  ] = await Promise.all([
    enrichCandidates(raw.cpuTemperature, "temperature", io),
    enrichCandidates(fanChipCandidates(raw.fan, CPU_HWMON_CHIPS, true), "fan", io),
    enrichCandidates(fanChipCandidates(raw.fan, CPU_HWMON_CHIPS, false), "fan", io),
    enrichCandidates(raw.ambientTemperature, "temperature", io),
    enrichCandidates(raw.diskTemperature, "temperature", io),
    Promise.all(raw.gpuDevices.map((device) => enrichGpuDevice(device, io))),
  ]);

  return {
    cpuTemperature,
    cpuPower: raw.cpuPower.map((candidate) => ({ ...candidate, reading: null })),
    cpuFan,
    gpuFan: gpuDevices.flatMap((device) => device.fan),
    boardTemperature: ambientBoard,
    ambient1Temperature: ambientBoard,
    ambient2Temperature: ambientBoard,
    disk1Temperature: disk,
    disk2Temperature: disk,
    systemFan1: systemFan,
    systemFan2: systemFan,
    gpuDevices,
    ...(raw.reasons ? { reasons: raw.reasons } : {}),
  };
}

async function probeMount(
  path: string | null,
  statfs: MetricsCapabilityDeps["statfs"],
): Promise<StorageMountCapability> {
  if (!path) return null;
  const probe = await probeStorage(path, { statfs });
  if (!probe) return null;
  return { path, ...probe };
}

/**
 * Probe a hosting/Docker candidate path, preserving the probed path and a
 * reason code even on failure — `probeMount` alone collapses that context
 * away into a bare `null`.
 */
async function probeMountOutcome(
  path: string | null,
  statfs: MetricsCapabilityDeps["statfs"],
  reasonWhenNoPath: StorageProbeReason,
): Promise<StorageProbeOutcome> {
  const result = await probeMount(path, statfs);
  if (result) return { probedPath: path, result };
  return {
    probedPath: path,
    result: null,
    reason: path ? "statfs_unsupported" : reasonWhenNoPath,
  };
}

/** Probe every discovered mount candidate; unprobeable candidates are dropped. */
async function probeMountCandidates(
  mountsText: string | undefined,
  statfs: MetricsCapabilityDeps["statfs"],
): Promise<StorageMountCandidate[]> {
  if (!mountsText) return [];
  const discovered = storageMountCandidates(parseProcMounts(mountsText));
  const probed = await Promise.all(
    discovered.map(async (entry): Promise<StorageMountCandidate | null> => {
      const probe = await probeStorage(entry.mountPoint, { statfs });
      if (!probe) return null;
      return {
        path: entry.mountPoint,
        source: entry.source,
        fsType: entry.fsType,
        ...probe,
      };
    }),
  );
  return probed.filter((c): c is StorageMountCandidate => c !== null);
}

/** Enumerate sensors, storage mounts, and classified network interfaces. */
export async function collectMetricsCapabilities(
  deps?: Partial<MetricsCapabilityDeps>,
): Promise<MetricsCapabilities> {
  const merged: MetricsCapabilityDeps = { ...defaultDeps(), ...deps };

  const [
    rawSensors,
    fabricInterfaces,
    dockerRoot,
    hostingPath,
    netDevText,
    processCount,
  ] = await Promise.all([
    merged.discoverSensors(),
    merged.resolveFabricInterfaces().catch(() => [] as string[]),
    merged.resolveDockerDataRoot().catch(() => null),
    Promise.resolve()
      .then(() => merged.resolveHostingPath())
      .catch(() => null),
    merged.readProcFile("/proc/net/dev"),
    Promise.resolve()
      .then(() => merged.countProcesses())
      .catch(() => null),
  ]);
  const mountsText = await merged.readProcFile("/proc/mounts");
  const sensors = await buildSensorCapabilities(
    rawSensors,
    merged.readSensorFile,
  );

  const [system, hosting, docker, candidates] = await Promise.all([
    probeMount("/", merged.statfs),
    probeMountOutcome(hostingPath, merged.statfs, "path_not_found"),
    probeMountOutcome(dockerRoot, merged.statfs, "docker_absent"),
    probeMountCandidates(mountsText, merged.statfs),
  ]);

  const parsed = netDevText ? parseNetDev(netDevText) : null;
  const networkInterfaces: NetworkInterfaceCapability[] = Object.keys(
    parsed ?? {},
  )
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      classification: classifyInterface(name, fabricInterfaces),
    }));

  const process: ProcessCapability = processCount === null
    ? { probedPath: PROC_DIR, reason: "proc_unreadable" }
    : { probedPath: PROC_DIR };

  return {
    sensors,
    storageMounts: {
      system,
      hosting,
      docker,
      candidates,
    },
    networkInterfaces,
    process,
  };
}
