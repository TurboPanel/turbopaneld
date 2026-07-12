import { buildHostMetricsSample, type HostMetricKey } from "../contract.ts";
import { parseDiskstats } from "./parse-diskstats.ts";
import { parseLoadavg } from "./parse-loadavg.ts";
import { parseMeminfo } from "./parse-meminfo.ts";
import { parseNetDev } from "./parse-net-dev.ts";
import { parseStat } from "./parse-stat.ts";
import { parseUptime } from "./parse-uptime.ts";
import {
  bootChanged,
  cpuPercentages,
  diskRates,
  netRates,
} from "./rates.ts";
import type {
  CollectorDeps,
  RawSnapshot,
  MetricsCollectResult,
  MetricsCollector,
} from "./types.ts";

const PROC_STAT = "/proc/stat";
const PROC_MEMINFO = "/proc/meminfo";
const PROC_LOADAVG = "/proc/loadavg";
const PROC_UPTIME = "/proc/uptime";
const PROC_DISKSTATS = "/proc/diskstats";
const PROC_NET_DEV = "/proc/net/dev";
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
  const [
    statText,
    memText,
    loadText,
    uptimeText,
    diskstatsText,
    netDevText,
    bootIdRaw,
    diskCapacity,
    processCount,
  ] = await Promise.all([
    deps.readProcFile(PROC_STAT),
    deps.readProcFile(PROC_MEMINFO),
    deps.readProcFile(PROC_LOADAVG),
    deps.readProcFile(PROC_UPTIME),
    deps.readProcFile(PROC_DISKSTATS),
    deps.readProcFile(PROC_NET_DEV),
    deps.readProcFile(PROC_BOOT_ID),
    safeAsync(async () => {
      const stat = await deps.statfs("/");
      if (!stat) return null;
      const used = (stat.blocks - stat.bfree) * stat.bsize;
      const avail = stat.bavail * stat.bsize;
      const denominator = used + avail;
      if (denominator <= 0) return null;
      return { diskUsedPercent: (used / denominator) * 100 };
    }),
    safeAsync(async () => await deps.countProcesses()),
  ]);

  const cpu = statText ? parseStat(statText) : null;
  const memory = memText ? parseMeminfo(memText) : null;
  const load = loadText ? parseLoadavg(loadText) : null;
  const uptimeSeconds = uptimeText ? parseUptime(uptimeText) : null;
  const disk = diskstatsText ? parseDiskstats(diskstatsText) : null;
  const net = netDevText ? parseNetDev(netDevText) : null;
  const bootId = bootIdRaw?.trim() ?? null;

  return {
    atMs,
    bootId,
    cpu,
    disk,
    net,
    load,
    memory,
    diskCapacity,
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

function snapshotToMetrics(
  current: RawSnapshot,
  previous: RawSnapshot | undefined,
  seconds: number,
): Partial<Record<HostMetricKey, number | null>> {
  const reset = previous !== undefined && bootChanged(previous.bootId, current.bootId);

  const cpu = reset
    ? { usage: null, user: null, system: null, iowait: null }
    : cpuPercentages(previous?.cpu ?? null, current.cpu, seconds);

  const diskRate = reset
    ? {
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
      readOpsPerSecond: null,
      writeOpsPerSecond: null,
    }
    : diskRates(previous?.disk ?? null, current.disk, seconds);

  const netRate = reset
    ? { receiveBytesPerSecond: null, transmitBytesPerSecond: null }
    : netRates(previous?.net ?? null, current.net, seconds);

  return {
    cpuUsagePercent: cpu.usage,
    cpuUserPercent: cpu.user,
    cpuSystemPercent: cpu.system,
    cpuIowaitPercent: cpu.iowait,
    load1: current.load?.one ?? null,
    load5: current.load?.five ?? null,
    load15: current.load?.fifteen ?? null,
    memoryUsedPercent: current.memory?.memoryUsedPercent ?? null,
    memoryUsedBytes: current.memory?.memoryUsedBytes ?? null,
    memoryAvailableBytes: current.memory?.memoryAvailableBytes ?? null,
    swapUsedPercent: current.memory?.swapUsedPercent ?? null,
    diskUsedPercent: current.diskCapacity?.diskUsedPercent ?? null,
    diskReadBytesPerSecond: diskRate.readBytesPerSecond,
    diskWriteBytesPerSecond: diskRate.writeBytesPerSecond,
    diskReadOpsPerSecond: diskRate.readOpsPerSecond,
    diskWriteOpsPerSecond: diskRate.writeOpsPerSecond,
    networkReceiveBytesPerSecond: netRate.receiveBytesPerSecond,
    networkTransmitBytesPerSecond: netRate.transmitBytesPerSecond,
    processCount: current.processCount,
    uptimeSeconds: current.uptimeSeconds,
  };
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
  }): Promise<MetricsCollectResult> {
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
      const dimensions = await this.#deps.resolveDimensions();

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
      const dimensions = await safeAsync(() =>
        Promise.resolve(this.#deps.resolveDimensions())
      ) ?? {
        schemaVersion: 1 as const,
        daemonVersion: "unknown",
        operatingSystem: Deno.build.os,
        architecture: Deno.build.arch,
        kernelRelease: "",
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
