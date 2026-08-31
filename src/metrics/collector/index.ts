/**
 * Metrics collector factory — the scheduler imports from here.
 *
 * Per-filesystem / per-interface series stay future event types; the v2
 * host-summary sample carries classified aggregates (uplink vs fabric
 * network, three storage probes, one selected sensor per measurement).
 */
import { statfs } from "node:fs/promises";

import { resolveDockerDataRoot } from "../../host/docker.ts";
import { FABRIC_INTERFACE_NAME } from "../../instance/commands/fabric.ts";
import { resolveDimensions } from "./dimensions.ts";
import { resolveHostingPath } from "./hosting.ts";
import { LinuxMetricsCollector } from "./linux-collector.ts";
import { readProcFile } from "./proc-read.ts";
import { countProcessesInProc } from "./processes.ts";
import { readHostSensors } from "./sensors/index.ts";
import { resolveAdminSensorOverrides } from "./sensors/overrides.ts";
import type {
  CollectorDeps,
  MetricsCollector,
  MetricsCollectResult,
  StatfsResult,
} from "./types.ts";

export type {
  CollectorDeps,
  CpuCounters,
  CpuEnergyCounter,
  DiskCounters,
  DiskDeviceCounters,
  MemoryGauges,
  MetricsCollector,
  MetricsCollectResult,
  NetCounters,
  NetInterfaceClassification,
  NetInterfaceCounters,
  RawSnapshot,
  SensorCandidate,
  SensorOverrides,
  SensorReadings,
  StatfsResult,
  StaticDimensions,
  StorageProbeResult,
} from "./types.ts";

export { LinuxMetricsCollector } from "./linux-collector.ts";
export { readProcFile } from "./proc-read.ts";
export { resolveDimensions } from "./dimensions.ts";
export {
  type CpuPercentages,
  cpuPercentagesV2,
  EMPTY_CPU_PERCENTAGES,
} from "./cpu.ts";
export { readMemoryGauges } from "./memory.ts";
export { probeStorage } from "./filesystem.ts";
export {
  isDiskPartition,
  isVirtualDiskDevice,
  readBlockDevices,
} from "./block-devices.ts";
export {
  backingDeviceNames,
  type MountEntry,
  mountForPath,
  parseProcMounts,
  storageMountCandidates,
} from "./mounts.ts";
export {
  HOSTING_PATH_OVERRIDE_RELATIVE_PATH,
  hostingPathOverridePath,
  parseHostingPathOverride,
  resolveAdminHostingPathOverride,
  resolveHostingPath,
} from "./hosting.ts";
export {
  classifiedNetRates,
  classifyInterface,
  interfaceNamesByClass,
  readNetCounters,
} from "./network.ts";
export { countProcessesInProc } from "./processes.ts";
export {
  cpuPowerFromEnergy,
  defaultSensorIo,
  discoverSensors,
  readCpuEnergy,
  readGpuPower,
  readHostSensors,
  resolveAdminSensorOverrides,
  resolveTemperature,
  type SensorCapabilities,
  sensorId,
  type SensorIo,
} from "./sensors/index.ts";

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

/** Minimum wait before re-probing the Docker Engine after a failed data-root read. */
export const DOCKER_DATA_ROOT_RETRY_MS = 5 * 60_000;

/**
 * Docker data-root resolution with a bounded cache: a successful Engine-API
 * (`/info`) read is cached for the life of the collector, and failures are
 * only re-probed after {@link DOCKER_DATA_ROOT_RETRY_MS} — never once per
 * interval, so a present-but-unhealthy daemon cannot reintroduce steady
 * per-tick discovery work. Exported for host-free tests.
 */
export function createCachedDockerDataRoot(
  resolve: () => Promise<string | undefined> = () => resolveDockerDataRoot(),
  now: () => number = () => Date.now(),
): () => Promise<string | null> {
  let cached: string | null = null;
  let lastFailureAtMs: number | null = null;
  return async () => {
    if (cached !== null) return cached;
    if (
      lastFailureAtMs !== null &&
      now() - lastFailureAtMs < DOCKER_DATA_ROOT_RETRY_MS
    ) {
      return null;
    }
    cached = (await resolve()) ?? null;
    lastFailureAtMs = cached === null ? now() : null;
    return cached;
  };
}

function defaultDeps(): CollectorDeps {
  return {
    readProcFile,
    statfs: defaultStatfs,
    now: () => Date.now(),
    countProcesses: countProcessesInProc,
    resolveDimensions,
    resolveDockerDataRoot: createCachedDockerDataRoot(),
    resolveHostingPath: () => resolveHostingPath(),
    readSensors: (overrides) => readHostSensors(overrides ?? {}),
    resolveFabricInterfaces: () => Promise.resolve([FABRIC_INTERFACE_NAME]),
    resolveAdminSensorOverrides: () => resolveAdminSensorOverrides(),
  };
}

class UnsupportedMetricsCollector implements MetricsCollector {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  collect(): Promise<MetricsCollectResult> {
    return Promise.resolve({ supported: false, reason: this.#reason });
  }
}

/**
 * Build the platform metrics collector.
 *
 * Optional `options.os` overrides `Deno.build.os` so host-free tests can
 * exercise the unsupported-OS path without leaving Linux.
 */
export function createMetricsCollector(
  deps?: Partial<CollectorDeps>,
  options?: { os?: string },
): MetricsCollector {
  const os = options?.os ?? Deno.build.os;
  if (os !== "linux") {
    return new UnsupportedMetricsCollector(
      `unsupported_os:${os}`,
    );
  }

  const merged: CollectorDeps = { ...defaultDeps(), ...deps };
  return new LinuxMetricsCollector(merged);
}
