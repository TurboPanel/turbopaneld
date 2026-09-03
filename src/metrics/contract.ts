/** Host metrics wire contract (daemon → instance). Mirrored in instance `src/daemon/metrics/contract.ts`. */

export const METRICS_SCHEMA_VERSION = 3 as const;

/**
 * Named metric keys — the API/query allowlist only. Physical storage
 * positions are backend-private (defined in per-backend field-map/schema
 * files), so this list carries no ordering contract.
 */
export const HOST_METRIC_KEYS = [
  "cpuUserPercent",
  "cpuSystemPercent",
  "cpuNicePercent",
  "cpuIdlePercent",
  "cpuIowaitPercent",
  "cpuIrqPercent",
  "cpuSoftirqPercent",
  "cpuStealPercent",
  "load1",
  "load5",
  "load15",
  "memoryTotalBytes",
  "memoryAvailableBytes",
  "swapTotalBytes",
  "swapFreeBytes",
  "cpuTemperatureCelsius",
  "processCount",
  "uptimeSeconds",
  "systemStorageTotalBytes",
  "systemStorageAvailableBytes",
  "hostingStorageTotalBytes",
  "hostingStorageAvailableBytes",
  "dockerStorageTotalBytes",
  "dockerStorageAvailableBytes",
  "diskReadBytesPerSecond",
  "diskWriteBytesPerSecond",
  "diskReadOpsPerSecond",
  "diskWriteOpsPerSecond",
  "diskReadLatencyMs",
  "diskWriteLatencyMs",
  "interfaceReceiveBytesPerSecond",
  "interfaceTransmitBytesPerSecond",
  "fabricReceiveBytesPerSecond",
  "fabricTransmitBytesPerSecond",
  "gpuTemperatureCelsius",
  "cpuPowerWatts",
  "gpuPowerWatts",
  "nic1ReceiveBytesPerSecond",
  "nic1TransmitBytesPerSecond",
  "nic2ReceiveBytesPerSecond",
  "nic2TransmitBytesPerSecond",
  "gpuUtilizationPercent",
  "gpuFanRpm",
  "disk1TemperatureCelsius",
  "disk2TemperatureCelsius",
  "ambient1TemperatureCelsius",
  "ambient2TemperatureCelsius",
  "boardTemperatureCelsius",
  "cpuFanRpm",
  "systemFan1Rpm",
  "systemFan2Rpm",
  "caddyRequestsTotal",
  "caddyResponses2xxTotal",
  "caddyResponses3xxTotal",
  "caddyResponses4xxTotal",
  "caddyResponses5xxTotal",
  "caddyRequestBytesTotal",
  "caddyResponseBytesTotal",
  "caddyRequestDurationSecondsSum",
  "caddyRequestsUnder100msTotal",
  "caddyRequestsUnder1sTotal",
  "caddyRequestsInFlight",
  "proxysqlQueriesTotal",
  "proxysqlSlowQueriesTotal",
  "proxysqlConnectionErrorsTotal",
  "proxysqlClientConnections",
  "proxysqlBackendConnections",
  "proxysqlBackendsUp",
] as const;

export type HostMetricKey = (typeof HOST_METRIC_KEYS)[number];

export type HostMetrics = Record<HostMetricKey, number | null>;

/**
 * A key is present in `metrics` only when its `MetricPart` was declared in
 * the sample's `parts` list — an absent key means "not collected this tick",
 * distinct from a validated `null` (collected, but no reading available).
 */
export type PartialHostMetrics = Partial<HostMetrics>;

/**
 * Metric groupings a daemon declares per sample via `parts`. `"core"` is
 * always mandatory; the others are collected conditionally (hardware
 * sensors present, traffic sidecars running, etc).
 */
export const METRIC_PARTS = ["core", "extended", "sensors", "traffic"] as const;

export type MetricPart = (typeof METRIC_PARTS)[number];

const CORE_PART_KEYS: readonly HostMetricKey[] = [
  "cpuUserPercent",
  "cpuSystemPercent",
  "cpuNicePercent",
  "cpuIdlePercent",
  "cpuIowaitPercent",
  "cpuIrqPercent",
  "cpuSoftirqPercent",
  "cpuStealPercent",
  "load1",
  "load5",
  "load15",
  "memoryTotalBytes",
  "memoryAvailableBytes",
  "swapTotalBytes",
  "swapFreeBytes",
  "processCount",
  "uptimeSeconds",
];

const EXTENDED_PART_KEYS: readonly HostMetricKey[] = [
  "systemStorageTotalBytes",
  "systemStorageAvailableBytes",
  "hostingStorageTotalBytes",
  "hostingStorageAvailableBytes",
  "dockerStorageTotalBytes",
  "dockerStorageAvailableBytes",
  "diskReadBytesPerSecond",
  "diskWriteBytesPerSecond",
  "diskReadOpsPerSecond",
  "diskWriteOpsPerSecond",
  "diskReadLatencyMs",
  "diskWriteLatencyMs",
  "interfaceReceiveBytesPerSecond",
  "interfaceTransmitBytesPerSecond",
  "fabricReceiveBytesPerSecond",
  "fabricTransmitBytesPerSecond",
  "gpuTemperatureCelsius",
  "gpuPowerWatts",
];

const SENSORS_PART_KEYS: readonly HostMetricKey[] = [
  "cpuTemperatureCelsius",
  "cpuPowerWatts",
  "gpuUtilizationPercent",
  "gpuFanRpm",
  "disk1TemperatureCelsius",
  "disk2TemperatureCelsius",
  "ambient1TemperatureCelsius",
  "ambient2TemperatureCelsius",
  "boardTemperatureCelsius",
  "cpuFanRpm",
  "systemFan1Rpm",
  "systemFan2Rpm",
  "nic1ReceiveBytesPerSecond",
  "nic1TransmitBytesPerSecond",
  "nic2ReceiveBytesPerSecond",
  "nic2TransmitBytesPerSecond",
];

const TRAFFIC_PART_KEYS: readonly HostMetricKey[] = [
  "caddyRequestsTotal",
  "caddyResponses2xxTotal",
  "caddyResponses3xxTotal",
  "caddyResponses4xxTotal",
  "caddyResponses5xxTotal",
  "caddyRequestBytesTotal",
  "caddyResponseBytesTotal",
  "caddyRequestDurationSecondsSum",
  "caddyRequestsUnder100msTotal",
  "caddyRequestsUnder1sTotal",
  "caddyRequestsInFlight",
  "proxysqlQueriesTotal",
  "proxysqlSlowQueriesTotal",
  "proxysqlConnectionErrorsTotal",
  "proxysqlClientConnections",
  "proxysqlBackendConnections",
  "proxysqlBackendsUp",
];

/**
 * Key → part lookup, mirrored between both `contract.ts` copies the same way
 * `HOST_METRIC_KEYS` itself is — the daemon repo has no descriptor module to
 * derive this from, so it carries its own copy. On the instance side,
 * `metric-descriptors.ts` is the canonical source (each descriptor's `part`
 * field); this map exists there too only to keep the two repos structurally
 * parallel and to give `buildHostMetricsSample` a dependency-free lookup.
 */
export const METRIC_KEY_PARTS: Record<HostMetricKey, MetricPart> = {} as Record<
  HostMetricKey,
  MetricPart
>;
for (const key of CORE_PART_KEYS) METRIC_KEY_PARTS[key] = "core";
for (const key of EXTENDED_PART_KEYS) METRIC_KEY_PARTS[key] = "extended";
for (const key of SENSORS_PART_KEYS) METRIC_KEY_PARTS[key] = "sensors";
for (const key of TRAFFIC_PART_KEYS) METRIC_KEY_PARTS[key] = "traffic";

/**
 * Per-part metric-value slot ceiling. Every backend write layout reserves one
 * slot (`double20`-equivalent) for the sample's `intervalSeconds` out of a
 * 20-slot row, leaving 19 slots for actual metric values on each of the four
 * parts — so no part may declare more than 19 keys.
 */
export const MAX_METRICS_PER_PART = 19;

/**
 * Module-load invariant: the four part groups partition `HOST_METRIC_KEYS`
 * exactly (no gaps, no overlaps, none empty, none over `MAX_METRICS_PER_PART`)
 * so a future key addition that forgets to assign a part — or overflows a
 * part's row budget — fails on import rather than at query time.
 */
function assertMetricPartsCoverAllKeys(): void {
  const totalAssigned = CORE_PART_KEYS.length +
    EXTENDED_PART_KEYS.length +
    SENSORS_PART_KEYS.length +
    TRAFFIC_PART_KEYS.length;
  if (totalAssigned !== HOST_METRIC_KEYS.length) {
    throw new TypeError(
      `metric parts overlap or miss a HOST_METRIC_KEYS entry (assigned ${totalAssigned}, expected ${HOST_METRIC_KEYS.length})`,
    );
  }
  for (const key of HOST_METRIC_KEYS) {
    if (METRIC_KEY_PARTS[key] === undefined) {
      throw new TypeError(`host metric ${key} has no assigned part`);
    }
  }
  for (const part of METRIC_PARTS) {
    const memberCount = HOST_METRIC_KEYS.filter((key) =>
      METRIC_KEY_PARTS[key] === part
    ).length;
    if (memberCount === 0) {
      throw new TypeError(`metric part ${part} has no members`);
    }
    if (memberCount > MAX_METRICS_PER_PART) {
      throw new TypeError(
        `metric part ${part} has ${memberCount} keys, exceeding the ${MAX_METRICS_PER_PART}-key per-part ceiling`,
      );
    }
  }
}
assertMetricPartsCoverAllKeys();

/** Sampling cadence the daemon collected under — baseline (steady) or live (on-demand fast). */
export type MetricsCollectionMode = "baseline" | "live";

/**
 * Per-source traffic-sidecar contribution for this tick — `true` only when
 * that source's scrape actually resolved data this sample (a reachable
 * process), `false` for both an absent/never-installed sidecar and a
 * present-but-currently-unreachable one. Rides every sample regardless of
 * whether `"traffic"` is in `parts`, the same way `hardwareProfileGeneration`
 * rides every sample regardless of `"sensors"` — so a consumer comparing
 * ticks over time can tell "this host has never once reported ProxySQL"
 * (every tick `false`) from "ProxySQL just dropped out" (a `true` streak
 * followed by `false`), which a bare per-metric `null` cannot distinguish on
 * its own.
 */
export type TrafficSourceContribution = {
  caddy: boolean;
  proxysql: boolean;
};

export type HostMetricsDimensions = {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  collectionMode: MetricsCollectionMode;
  runtimeMode?: string;
  /** Generation number of the detected hardware profile (sensor/NIC layout). */
  hardwareProfileGeneration: number;
  /** Which traffic sidecars actually contributed data this tick. */
  trafficSources: TrafficSourceContribution;
};

export type HostMetricsSample = {
  type: "metrics";
  version: typeof METRICS_SCHEMA_VERSION;
  at: string;
  intervalSeconds: number;
  sequence: number;
  /** Metric groupings collected this tick — always includes `"core"`. */
  parts: MetricPart[];
  /** Only carries keys whose part is present in `parts`. */
  metrics: PartialHostMetrics;
  dimensions: HostMetricsDimensions;
};

const PERCENT_METRIC_KEYS = new Set<HostMetricKey>([
  "cpuUserPercent",
  "cpuSystemPercent",
  "cpuNicePercent",
  "cpuIdlePercent",
  "cpuIowaitPercent",
  "cpuIrqPercent",
  "cpuSoftirqPercent",
  "cpuStealPercent",
  "gpuUtilizationPercent",
]);

/** Clamp percent metrics to 0–100; pass through `null`. */
export function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** Reject NaN/±Infinity → null; missing stays null (never coerced to 0). */
export function sanitizeFinite(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function assertFiniteNonNegative(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `metrics ${field} must be a finite non-negative number`,
    );
  }
}

function assertFinitePositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `metrics ${field} must be a finite positive number`,
    );
  }
}

function assertValidParts(parts: readonly MetricPart[]): void {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("metrics parts must be a non-empty array");
  }
  const seen = new Set<MetricPart>();
  for (const part of parts) {
    if (!(METRIC_PARTS as readonly string[]).includes(part)) {
      throw new TypeError(`metrics parts contains an invalid part: ${part}`);
    }
    if (seen.has(part)) {
      throw new TypeError(`metrics parts contains a duplicate part: ${part}`);
    }
    seen.add(part);
  }
  if (!seen.has("core")) {
    throw new TypeError('metrics parts must include "core"');
  }
  if (!seen.has("extended")) {
    throw new TypeError('metrics parts must include "extended"');
  }
}

export function buildHostMetricsSample(input: {
  at: string;
  intervalSeconds: number;
  sequence: number;
  parts: MetricPart[];
  metrics: Partial<Record<HostMetricKey, number | null>>;
  dimensions: HostMetricsDimensions;
}): HostMetricsSample {
  if (input.dimensions.schemaVersion !== METRICS_SCHEMA_VERSION) {
    throw new TypeError(
      `metrics dimensions.schemaVersion must be ${METRICS_SCHEMA_VERSION}`,
    );
  }
  if (
    input.dimensions.collectionMode !== "baseline" &&
    input.dimensions.collectionMode !== "live"
  ) {
    throw new TypeError(
      'metrics dimensions.collectionMode must be "baseline" or "live"',
    );
  }
  if (
    typeof input.dimensions.trafficSources?.caddy !== "boolean" ||
    typeof input.dimensions.trafficSources?.proxysql !== "boolean"
  ) {
    throw new TypeError(
      "metrics dimensions.trafficSources.caddy and .proxysql must be boolean",
    );
  }
  // intervalSeconds is divisor-bearing downstream — zero is never valid.
  assertFinitePositive("intervalSeconds", input.intervalSeconds);
  assertFiniteNonNegative("sequence", input.sequence);
  assertValidParts(input.parts);

  const declaredParts = new Set<MetricPart>(input.parts);
  const metrics: PartialHostMetrics = {};
  for (const key of HOST_METRIC_KEYS) {
    if (!declaredParts.has(METRIC_KEY_PARTS[key])) continue;
    let value = sanitizeFinite(input.metrics[key]);
    if (PERCENT_METRIC_KEYS.has(key)) {
      value = clampPercent(value);
    }
    metrics[key] = value;
  }
  return {
    type: "metrics",
    version: METRICS_SCHEMA_VERSION,
    at: input.at,
    intervalSeconds: input.intervalSeconds,
    sequence: input.sequence,
    parts: [...input.parts],
    metrics,
    dimensions: input.dimensions,
  };
}
