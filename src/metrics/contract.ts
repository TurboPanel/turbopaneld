/** Host metrics wire contract (daemon → instance). Mirrored in instance `src/daemon/metrics/contract.ts`. */

export const METRICS_SCHEMA_VERSION = 2 as const;

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
  "memoryFreeBytes",
  "swapTotalBytes",
  "swapFreeBytes",
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
  "uplinkReceiveBytesPerSecond",
  "uplinkTransmitBytesPerSecond",
  "fabricReceiveBytesPerSecond",
  "fabricTransmitBytesPerSecond",
  "cpuTemperatureCelsius",
  "gpuTemperatureCelsius",
  "cpuPowerWatts",
  "gpuPowerWatts",
  "processCount",
  "uptimeSeconds",
] as const;

export type HostMetricKey = (typeof HOST_METRIC_KEYS)[number];

export type HostMetrics = Record<HostMetricKey, number | null>;

/** Sampling cadence the daemon collected under — baseline (steady) or live (on-demand fast). */
export type MetricsCollectionMode = "baseline" | "live";

export type HostMetricsDimensions = {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  daemonVersion: string;
  operatingSystem: string;
  architecture: string;
  kernelRelease: string;
  collectionMode: MetricsCollectionMode;
  runtimeMode?: string;
  cpuTemperatureSensor?: string;
  gpuTemperatureSensor?: string;
  cpuPowerSensor?: string;
  gpuPowerSensor?: string;
  uplinkInterfaces?: string[];
  fabricInterfaces?: string[];
};

export type HostMetricsSample = {
  type: "metrics";
  version: typeof METRICS_SCHEMA_VERSION;
  at: string;
  intervalSeconds: number;
  sequence: number;
  metrics: HostMetrics;
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

export function buildHostMetricsSample(input: {
  at: string;
  intervalSeconds: number;
  sequence: number;
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
  // intervalSeconds is divisor-bearing downstream — zero is never valid.
  assertFinitePositive("intervalSeconds", input.intervalSeconds);
  assertFiniteNonNegative("sequence", input.sequence);

  const metrics = {} as HostMetrics;
  for (const key of HOST_METRIC_KEYS) {
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
    metrics,
    dimensions: input.dimensions,
  };
}
