/**
 * Linux collector orchestrator: builds the raw snapshot from the per-domain
 * modules, computes two-snapshot deltas, and fills every v2 `HostMetrics`
 * field plus the resolved `HostMetricsDimensions`.
 *
 * No collapsed `cpuUsagePercent` is stored — the API derives utilization as
 * `100 - cpuIdlePercent`.
 */
import {
  buildHostMetricsSample,
  type HostMetricKey,
  type HostMetricsDimensions,
  METRICS_SCHEMA_VERSION,
  type MetricsCollectionMode,
} from "../contract.ts";
import { readBlockDevices } from "./block-devices.ts";
import { cpuPercentagesV2, EMPTY_CPU_PERCENTAGES } from "./cpu.ts";
import { probeStorage } from "./filesystem.ts";
import { readMemoryGauges } from "./memory.ts";
import { backingDeviceNames, parseProcMounts } from "./mounts.ts";
import {
  classifiedNetRates,
  interfaceNamesByClass,
  readNetCounters,
} from "./network.ts";
import { parseLoadavg } from "./parse-loadavg.ts";
import { parseStat } from "./parse-stat.ts";
import { parseUptime } from "./parse-uptime.ts";
import { bootChanged, diskRates } from "./rates.ts";
import { cpuPowerFromEnergy } from "./sensors/power.ts";
import type {
  CollectorDeps,
  MetricsCollector,
  MetricsCollectResult,
  RawSnapshot,
  SensorReadings,
} from "./types.ts";

const PROC_STAT = "/proc/stat";
const PROC_MEMINFO = "/proc/meminfo";
const PROC_LOADAVG = "/proc/loadavg";
const PROC_UPTIME = "/proc/uptime";
const PROC_DISKSTATS = "/proc/diskstats";
const PROC_NET_DEV = "/proc/net/dev";
const PROC_MOUNTS = "/proc/mounts";
const PROC_BOOT_ID = "/proc/sys/kernel/random/boot_id";

async function safeAsync<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function buildRawSnapshot(
  deps: CollectorDeps,
  atMs: number,
): Promise<RawSnapshot> {
  // Resolve the probed paths first — the storage probes and the disk device
  // preference (mount-backed disks) both need them.
  const [hostingPath, dockerRoot] = await Promise.all([
    safeAsync(async () => await deps.resolveHostingPath()),
    safeAsync(() => deps.resolveDockerDataRoot()),
  ]);

  const [
    statText,
    memText,
    loadText,
    uptimeText,
    diskstatsText,
    netDevText,
    mountsText,
    bootIdRaw,
    fabricInterfaces,
    systemStorage,
    hostingStorage,
    dockerStorage,
    sensors,
    processCount,
  ] = await Promise.all([
    deps.readProcFile(PROC_STAT),
    deps.readProcFile(PROC_MEMINFO),
    deps.readProcFile(PROC_LOADAVG),
    deps.readProcFile(PROC_UPTIME),
    deps.readProcFile(PROC_DISKSTATS),
    deps.readProcFile(PROC_NET_DEV),
    deps.readProcFile(PROC_MOUNTS),
    deps.readProcFile(PROC_BOOT_ID),
    safeAsync(() => deps.resolveFabricInterfaces()),
    probeStorage("/", { statfs: deps.statfs }),
    safeAsync(async () => {
      if (!hostingPath) return null;
      return await probeStorage(hostingPath, { statfs: deps.statfs });
    }),
    safeAsync(async () => {
      if (!dockerRoot) return null;
      return await probeStorage(dockerRoot, { statfs: deps.statfs });
    }),
    safeAsync(async () => {
      const overrides = await safeAsync(() =>
        deps.resolveAdminSensorOverrides()
      );
      return await deps.readSensors(overrides ?? {});
    }),
    safeAsync(async () => await deps.countProcesses()),
  ]);

  const cpu = statText ? parseStat(statText) : null;
  const memory = memText ? readMemoryGauges(memText) : null;
  const load = loadText ? parseLoadavg(loadText) : null;
  const uptimeSeconds = uptimeText ? parseUptime(uptimeText) : null;
  const probedPaths = ["/", hostingPath, dockerRoot]
    .filter((path): path is string => typeof path === "string");
  const preferredDevices = mountsText
    ? backingDeviceNames(parseProcMounts(mountsText), probedPaths)
    : [];
  const disk = diskstatsText
    ? readBlockDevices(diskstatsText, preferredDevices)
    : null;
  const net = netDevText
    ? readNetCounters(netDevText, fabricInterfaces ?? [])
    : null;
  const bootId = bootIdRaw?.trim() ?? null;

  return {
    atMs,
    bootId,
    cpu,
    disk,
    net,
    load,
    memory,
    storage: {
      system: systemStorage,
      hosting: hostingStorage,
      docker: dockerStorage,
    },
    sensors,
    processCount,
    uptimeSeconds,
  };
}

function intervalSeconds(
  previous: RawSnapshot | undefined,
  nowMs: number,
  nominalIntervalSeconds: number,
): number {
  if (!previous) return nominalIntervalSeconds;
  const elapsed = (nowMs - previous.atMs) / 1000;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return nominalIntervalSeconds;
  return elapsed;
}

/** CPU power comes from an energy-counter delta — same sensor on both sides. */
function cpuPowerWatts(
  previous: SensorReadings | null | undefined,
  current: SensorReadings | null,
  seconds: number,
): number | null {
  if (!previous || !current) return null;
  if (
    previous.sensors.cpuPowerSensor !== current.sensors.cpuPowerSensor
  ) {
    return null;
  }
  return cpuPowerFromEnergy(previous.cpuEnergy, current.cpuEnergy, seconds);
}

function snapshotToMetrics(
  current: RawSnapshot,
  previous: RawSnapshot | undefined,
  seconds: number,
): Partial<Record<HostMetricKey, number | null>> {
  // A boot-id change means every monotonic counter restarted: rate, CPU, and
  // power-delta metrics for the interval are null, gauges still report.
  const reset = previous !== undefined &&
    bootChanged(previous.bootId, current.bootId);

  const cpu = reset ? EMPTY_CPU_PERCENTAGES : cpuPercentagesV2(
    previous?.cpu ?? null,
    current.cpu,
    seconds,
  );

  const diskRate = reset
    ? {
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
      readOpsPerSecond: null,
      writeOpsPerSecond: null,
      readLatencyMs: null,
      writeLatencyMs: null,
    }
    : diskRates(previous?.disk ?? null, current.disk, seconds);

  const prevNet = reset ? null : previous?.net ?? null;
  const uplink = classifiedNetRates(prevNet, current.net, "uplink", seconds);
  const fabric = classifiedNetRates(prevNet, current.net, "fabric", seconds);

  const power = reset
    ? null
    : cpuPowerWatts(previous?.sensors, current.sensors, seconds);

  return {
    cpuUserPercent: cpu.userPercent,
    cpuSystemPercent: cpu.systemPercent,
    cpuNicePercent: cpu.nicePercent,
    cpuIdlePercent: cpu.idlePercent,
    cpuIowaitPercent: cpu.iowaitPercent,
    cpuIrqPercent: cpu.irqPercent,
    cpuSoftirqPercent: cpu.softirqPercent,
    cpuStealPercent: cpu.stealPercent,
    load1: current.load?.one ?? null,
    load5: current.load?.five ?? null,
    load15: current.load?.fifteen ?? null,
    memoryTotalBytes: current.memory?.totalBytes ?? null,
    memoryAvailableBytes: current.memory?.availableBytes ?? null,
    memoryFreeBytes: current.memory?.freeBytes ?? null,
    swapTotalBytes: current.memory?.swapTotalBytes ?? null,
    swapFreeBytes: current.memory?.swapFreeBytes ?? null,
    systemStorageTotalBytes: current.storage.system?.totalBytes ?? null,
    systemStorageAvailableBytes: current.storage.system?.availableBytes ??
      null,
    hostingStorageTotalBytes: current.storage.hosting?.totalBytes ?? null,
    hostingStorageAvailableBytes: current.storage.hosting?.availableBytes ??
      null,
    dockerStorageTotalBytes: current.storage.docker?.totalBytes ?? null,
    dockerStorageAvailableBytes: current.storage.docker?.availableBytes ??
      null,
    diskReadBytesPerSecond: diskRate.readBytesPerSecond,
    diskWriteBytesPerSecond: diskRate.writeBytesPerSecond,
    diskReadOpsPerSecond: diskRate.readOpsPerSecond,
    diskWriteOpsPerSecond: diskRate.writeOpsPerSecond,
    diskReadLatencyMs: diskRate.readLatencyMs,
    diskWriteLatencyMs: diskRate.writeLatencyMs,
    uplinkReceiveBytesPerSecond: uplink.receiveBytesPerSecond,
    uplinkTransmitBytesPerSecond: uplink.transmitBytesPerSecond,
    fabricReceiveBytesPerSecond: fabric.receiveBytesPerSecond,
    fabricTransmitBytesPerSecond: fabric.transmitBytesPerSecond,
    cpuTemperatureCelsius: current.sensors?.cpuTemperatureCelsius ?? null,
    gpuTemperatureCelsius: current.sensors?.gpuTemperatureCelsius ?? null,
    cpuPowerWatts: power,
    gpuPowerWatts: current.sensors?.gpuPowerWatts ?? null,
    processCount: current.processCount,
    uptimeSeconds: current.uptimeSeconds,
  };
}

function snapshotToDimensionExtras(
  current: RawSnapshot,
): Partial<HostMetricsDimensions> {
  const extras: Partial<HostMetricsDimensions> = {};
  const sensors = current.sensors?.sensors;
  if (sensors?.cpuTemperatureSensor) {
    extras.cpuTemperatureSensor = sensors.cpuTemperatureSensor;
  }
  if (sensors?.gpuTemperatureSensor) {
    extras.gpuTemperatureSensor = sensors.gpuTemperatureSensor;
  }
  if (sensors?.cpuPowerSensor) {
    extras.cpuPowerSensor = sensors.cpuPowerSensor;
  }
  if (sensors?.gpuPowerSensor) {
    extras.gpuPowerSensor = sensors.gpuPowerSensor;
  }
  const uplinkInterfaces = interfaceNamesByClass(current.net, "uplink");
  if (uplinkInterfaces.length > 0) {
    extras.uplinkInterfaces = uplinkInterfaces;
  }
  const fabricInterfaces = interfaceNamesByClass(current.net, "fabric");
  if (fabricInterfaces.length > 0) {
    extras.fabricInterfaces = fabricInterfaces;
  }
  return extras;
}

export class LinuxMetricsCollector implements MetricsCollector {
  #previous: RawSnapshot | undefined;
  readonly #deps: CollectorDeps;
  readonly #nominalIntervalSeconds: number;

  constructor(
    deps: CollectorDeps,
    options?: { nominalIntervalSeconds?: number },
  ) {
    this.#deps = deps;
    this.#nominalIntervalSeconds = options?.nominalIntervalSeconds ?? 60;
  }

  async collect(options: {
    sequence: number;
    nowMs?: number;
    collectionMode?: MetricsCollectionMode;
  }): Promise<MetricsCollectResult> {
    const collectionMode = options.collectionMode ?? "baseline";
    try {
      const nowMs = options.nowMs ?? this.#deps.now();
      const current = await buildRawSnapshot(this.#deps, nowMs);
      const previous = this.#previous;
      const seconds = intervalSeconds(
        previous,
        nowMs,
        this.#nominalIntervalSeconds,
      );
      const metrics = snapshotToMetrics(current, previous, seconds);
      const staticDimensions = await this.#deps.resolveDimensions();
      const dimensions: HostMetricsDimensions = {
        ...staticDimensions,
        collectionMode,
        ...snapshotToDimensionExtras(current),
      };

      const sample = buildHostMetricsSample({
        at: new Date(nowMs).toISOString(),
        intervalSeconds: seconds,
        sequence: options.sequence,
        metrics,
        dimensions,
      });

      this.#previous = current;
      return { supported: true, sample };
    } catch {
      const nowMs = options.nowMs ?? this.#deps.now();
      const staticDimensions = await safeAsync(() =>
        Promise.resolve(this.#deps.resolveDimensions())
      ) ?? {
        schemaVersion: METRICS_SCHEMA_VERSION,
        daemonVersion: "unknown",
        operatingSystem: Deno.build.os,
        architecture: Deno.build.arch,
        kernelRelease: "",
      };
      const dimensions: HostMetricsDimensions = {
        ...staticDimensions,
        collectionMode,
      };

      const sample = buildHostMetricsSample({
        at: new Date(nowMs).toISOString(),
        intervalSeconds: this.#nominalIntervalSeconds,
        sequence: options.sequence,
        metrics: {},
        dimensions,
      });

      return { supported: true, sample };
    }
  }
}
