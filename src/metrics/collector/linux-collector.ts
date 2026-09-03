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
  type MetricPart,
  METRICS_SCHEMA_VERSION,
  type MetricsCollectionMode,
  type TrafficSourceContribution,
} from "../contract.ts";
import { readBlockDevices } from "./block-devices.ts";
import { cpuPercentagesV2, EMPTY_CPU_PERCENTAGES } from "./cpu.ts";
import { probeStorage } from "./filesystem.ts";
import { readMemoryGauges } from "./memory.ts";
import { backingDeviceNames, parseProcMounts } from "./mounts.ts";
import {
  classifiedNetRates,
  namedInterfaceRates,
  readNetCounters,
} from "./network.ts";
import { parseLoadavg } from "./parse-loadavg.ts";
import { parseStat } from "./parse-stat.ts";
import { parseUptime } from "./parse-uptime.ts";
import { bootChanged, counterDelta, diskRates } from "./rates.ts";
import { cpuPowerFromEnergy } from "./sensors/power.ts";
import type {
  CaddyCounters,
  CollectorDeps,
  MetricsCollector,
  MetricsCollectResult,
  ProxySqlCounters,
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
    nicSlots,
    proxy,
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
    safeAsync(() => deps.resolveNicSlots()),
    safeAsync(() => deps.readProxyCounters()),
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
    nicSlots: nicSlots ?? { nic1: null, nic2: null },
    proxy: proxy ?? { caddy: null, proxysql: null },
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

/** `undefined` when the source was absent on that tick — `counterDelta`'s "first sample" case. */
function caddyPrevField(
  previous: CaddyCounters | null | undefined,
  field: keyof CaddyCounters,
): number | undefined {
  return previous ? previous[field] : undefined;
}

function proxySqlPrevField(
  previous: ProxySqlCounters | null | undefined,
  field: keyof ProxySqlCounters,
): number | undefined {
  return previous ? previous[field] : undefined;
}

/**
 * Traffic-sidecar deltas/gauges for one tick. A source that is `null` this
 * tick (process absent/unreachable) resolves every one of its fields to
 * `null` — never a stale carry-forward. A boot-id change (`reset`) nulls
 * every counter-delta field (the sidecar restarted with the host), but
 * leaves the connection-count/backends-up gauges alone, same reasoning as
 * fan RPM in `hasAnySensorReading`.
 */
function trafficMetrics(
  current: RawSnapshot,
  previous: RawSnapshot | undefined,
  reset: boolean,
): Partial<Record<HostMetricKey, number | null>> {
  const currentCaddy = current.proxy?.caddy ?? null;
  const previousCaddy = reset ? null : previous?.proxy?.caddy;
  const caddyDelta = (field: keyof CaddyCounters): number | null =>
    currentCaddy === null
      ? null
      : counterDelta(caddyPrevField(previousCaddy, field), currentCaddy[field]);

  const currentProxySql = current.proxy?.proxysql ?? null;
  const previousProxySql = reset ? null : previous?.proxy?.proxysql;
  const proxySqlDelta = (field: keyof ProxySqlCounters): number | null =>
    currentProxySql === null ? null : counterDelta(
      proxySqlPrevField(previousProxySql, field),
      currentProxySql[field],
    );

  return {
    caddyRequestsTotal: caddyDelta("requestsTotal"),
    caddyResponses2xxTotal: caddyDelta("responses2xxTotal"),
    caddyResponses3xxTotal: caddyDelta("responses3xxTotal"),
    caddyResponses4xxTotal: caddyDelta("responses4xxTotal"),
    caddyResponses5xxTotal: caddyDelta("responses5xxTotal"),
    caddyRequestBytesTotal: caddyDelta("requestBytesTotal"),
    caddyResponseBytesTotal: caddyDelta("responseBytesTotal"),
    caddyRequestDurationSecondsSum: caddyDelta("requestDurationSecondsSum"),
    caddyRequestsUnder100msTotal: caddyDelta("requestsUnder100msTotal"),
    caddyRequestsUnder1sTotal: caddyDelta("requestsUnder1sTotal"),
    // Gauge, not a delta — unaffected by the boot-id reset above.
    caddyRequestsInFlight: currentCaddy?.requestsInFlight ?? null,
    proxysqlQueriesTotal: proxySqlDelta("queriesTotal"),
    proxysqlSlowQueriesTotal: proxySqlDelta("slowQueriesTotal"),
    proxysqlConnectionErrorsTotal: proxySqlDelta("connectionErrorsTotal"),
    // Gauges, not deltas — unaffected by the boot-id reset above.
    proxysqlClientConnections: currentProxySql?.clientConnections ?? null,
    proxysqlBackendConnections: currentProxySql?.backendConnections ?? null,
    proxysqlBackendsUp: currentProxySql?.backendsUp ?? null,
  };
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
  // Named NIC-slot rates use the *current* tick's slot assignment — but only
  // when the previous tick agreed on that same assignment. `netRates`'
  // membership-churn null only fires when the interface itself vanishes from
  // one snapshot; it does NOT catch a slot reassignment where both the old
  // and new named interfaces are present in both snapshots (e.g. nic1 goes
  // from eth0 to eth1 while both still exist) — that would otherwise compute
  // a real rate for eth1 that partially covers an interval eth1 wasn't even
  // assigned to nic1 for. So a slot whose name changed between ticks is
  // nulled directly instead of calling `namedInterfaceRates`.
  const prevNicSlots = reset ? null : previous?.nicSlots ?? null;
  const nic1 = prevNicSlots && prevNicSlots.nic1 !== current.nicSlots.nic1
    ? { receiveBytesPerSecond: null, transmitBytesPerSecond: null }
    : namedInterfaceRates(
      prevNet,
      current.net,
      current.nicSlots.nic1,
      seconds,
    );
  const nic2 = prevNicSlots && prevNicSlots.nic2 !== current.nicSlots.nic2
    ? { receiveBytesPerSecond: null, transmitBytesPerSecond: null }
    : namedInterfaceRates(
      prevNet,
      current.net,
      current.nicSlots.nic2,
      seconds,
    );

  const power = reset
    ? null
    : cpuPowerWatts(previous?.sensors, current.sensors, seconds);

  const sensors = current.sensors;
  const traffic = trafficMetrics(current, previous, reset);

  return {
    ...traffic,
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
    interfaceReceiveBytesPerSecond: uplink.receiveBytesPerSecond,
    interfaceTransmitBytesPerSecond: uplink.transmitBytesPerSecond,
    fabricReceiveBytesPerSecond: fabric.receiveBytesPerSecond,
    fabricTransmitBytesPerSecond: fabric.transmitBytesPerSecond,
    nic1ReceiveBytesPerSecond: nic1.receiveBytesPerSecond,
    nic1TransmitBytesPerSecond: nic1.transmitBytesPerSecond,
    nic2ReceiveBytesPerSecond: nic2.receiveBytesPerSecond,
    nic2TransmitBytesPerSecond: nic2.transmitBytesPerSecond,
    cpuTemperatureCelsius: sensors?.cpuTemperatureCelsius ?? null,
    gpuTemperatureCelsius: sensors?.gpuTemperatureCelsius ?? null,
    cpuPowerWatts: power,
    gpuPowerWatts: sensors?.gpuPowerWatts ?? null,
    // Gauges, not deltas — unaffected by the boot-id reset above.
    gpuUtilizationPercent: sensors?.gpuUtilizationPercent ?? null,
    gpuFanRpm: sensors?.gpuFanRpm ?? null,
    disk1TemperatureCelsius: sensors?.disk1TemperatureCelsius ?? null,
    disk2TemperatureCelsius: sensors?.disk2TemperatureCelsius ?? null,
    ambient1TemperatureCelsius: sensors?.ambient1TemperatureCelsius ?? null,
    ambient2TemperatureCelsius: sensors?.ambient2TemperatureCelsius ?? null,
    boardTemperatureCelsius: sensors?.boardTemperatureCelsius ?? null,
    cpuFanRpm: sensors?.cpuFanRpm ?? null,
    systemFan1Rpm: sensors?.systemFan1Rpm ?? null,
    systemFan2Rpm: sensors?.systemFan2Rpm ?? null,
    processCount: current.processCount,
    uptimeSeconds: current.uptimeSeconds,
  };
}

/**
 * Whether this tick has any `"sensors"`-part reading to report (contract.ts
 * `SENSORS_PART_KEYS`) — `gpuTemperatureCelsius`/`gpuPowerWatts` live in
 * `extended`, always present, so they don't count here.
 * `cpuTemperatureCelsius`/`cpuPowerWatts` DO live in `sensors` now, so they're
 * checked against the already-computed `metrics` (not the raw sensor
 * snapshot) — `cpuPowerWatts` is a two-snapshot RAPL delta the orchestrator
 * computes outside `SensorReadings`, so the raw snapshot alone can't answer
 * this. `nic1*`/`nic2*` are name-keyed NIC-slot rates, not sensor-chip
 * readings, but they share the `"sensors"` part per the wire contract — an
 * unassigned (or vanished) slot resolves `null` here just like an
 * unassigned sensor slot, so it never forces the part on by itself. A VM
 * with no hwmon at all and no NIC slots assigned resolves every sensors-part
 * field to `null`, so `parts` omits `"sensors"` entirely rather than
 * emitting an all-null part.
 */
function hasAnySensorReading(
  metrics: Partial<Record<HostMetricKey, number | null>>,
): boolean {
  return metrics.cpuTemperatureCelsius !== null ||
    metrics.cpuPowerWatts !== null ||
    metrics.gpuUtilizationPercent !== null ||
    metrics.gpuFanRpm !== null ||
    metrics.disk1TemperatureCelsius !== null ||
    metrics.disk2TemperatureCelsius !== null ||
    metrics.ambient1TemperatureCelsius !== null ||
    metrics.ambient2TemperatureCelsius !== null ||
    metrics.boardTemperatureCelsius !== null ||
    metrics.cpuFanRpm !== null ||
    metrics.systemFan1Rpm !== null ||
    metrics.systemFan2Rpm !== null ||
    metrics.nic1ReceiveBytesPerSecond !== null ||
    metrics.nic1TransmitBytesPerSecond !== null ||
    metrics.nic2ReceiveBytesPerSecond !== null ||
    metrics.nic2TransmitBytesPerSecond !== null;
}

/**
 * Per-source contribution marker for `dimensions.trafficSources` — `true`
 * only when that source's `readProxyCounters()` scrape actually resolved
 * data this tick, independent of `hasAnyTrafficReading`/`"traffic"` part
 * membership below (a gauge-only contribution still counts).
 */
function trafficSourceContribution(
  current: RawSnapshot,
): TrafficSourceContribution {
  return {
    caddy: current.proxy?.caddy !== null && current.proxy?.caddy !== undefined,
    proxysql: current.proxy?.proxysql !== null &&
      current.proxy?.proxysql !== undefined,
  };
}

/**
 * Whether this tick has any `"traffic"`-part reading (contract.ts
 * `TRAFFIC_PART_KEYS`) — a host with neither the site Caddy nor ProxySQL
 * reachable resolves every traffic field to `null`, so `parts` omits
 * `"traffic"` entirely rather than emitting an all-null part.
 */
function hasAnyTrafficReading(
  metrics: Partial<Record<HostMetricKey, number | null>>,
): boolean {
  return metrics.caddyRequestsTotal !== null ||
    metrics.caddyResponses2xxTotal !== null ||
    metrics.caddyResponses3xxTotal !== null ||
    metrics.caddyResponses4xxTotal !== null ||
    metrics.caddyResponses5xxTotal !== null ||
    metrics.caddyRequestBytesTotal !== null ||
    metrics.caddyResponseBytesTotal !== null ||
    metrics.caddyRequestDurationSecondsSum !== null ||
    metrics.caddyRequestsUnder100msTotal !== null ||
    metrics.caddyRequestsUnder1sTotal !== null ||
    metrics.caddyRequestsInFlight !== null ||
    metrics.proxysqlQueriesTotal !== null ||
    metrics.proxysqlSlowQueriesTotal !== null ||
    metrics.proxysqlConnectionErrorsTotal !== null ||
    metrics.proxysqlClientConnections !== null ||
    metrics.proxysqlBackendConnections !== null ||
    metrics.proxysqlBackendsUp !== null;
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
      const hardwareProfileGeneration = await safeAsync(() =>
        Promise.resolve(this.#deps.resolveHardwareProfileGeneration())
      ) ?? 0;
      const dimensions: HostMetricsDimensions = {
        ...staticDimensions,
        collectionMode,
        hardwareProfileGeneration,
        trafficSources: trafficSourceContribution(current),
      };
      const parts: MetricPart[] = ["core", "extended"];
      if (hasAnySensorReading(metrics)) {
        parts.push("sensors");
      }
      if (hasAnyTrafficReading(metrics)) {
        parts.push("traffic");
      }

      const sample = buildHostMetricsSample({
        at: new Date(nowMs).toISOString(),
        intervalSeconds: seconds,
        sequence: options.sequence,
        parts,
        metrics,
        dimensions,
      });

      this.#previous = current;
      return { supported: true, sample };
    } catch {
      const nowMs = options.nowMs ?? this.#deps.now();
      const staticDimensions = await safeAsync(() =>
        Promise.resolve(this.#deps.resolveDimensions())
      ) ?? { schemaVersion: METRICS_SCHEMA_VERSION };
      const dimensions: HostMetricsDimensions = {
        ...staticDimensions,
        collectionMode,
        hardwareProfileGeneration: 0,
        trafficSources: { caddy: false, proxysql: false },
      };

      const sample = buildHostMetricsSample({
        at: new Date(nowMs).toISOString(),
        intervalSeconds: this.#nominalIntervalSeconds,
        sequence: options.sequence,
        parts: ["core", "extended"],
        metrics: {},
        dimensions,
      });

      return { supported: true, sample };
    }
  }
}
