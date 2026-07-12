/** Host metrics wire contract (daemon → instance). Mirrored in instance `src/daemon/metrics/contract.ts`. */

export const METRICS_SCHEMA_VERSION = 1 as const;

/** Ordered metric keys — this exact order is the storage contract. */
export const HOST_METRIC_KEYS = [
  "cpuUsagePercent",
  "cpuUserPercent",
  "cpuSystemPercent",
  "cpuIowaitPercent",
  "load1",
  "load5",
  "load15",
  "memoryUsedPercent",
  "memoryUsedBytes",
  "memoryAvailableBytes",
  "swapUsedPercent",
  "diskUsedPercent",
  "diskReadBytesPerSecond",
  "diskWriteBytesPerSecond",
  "diskReadOpsPerSecond",
  "diskWriteOpsPerSecond",
  "networkReceiveBytesPerSecond",
  "networkTransmitBytesPerSecond",
  "processCount",
  "uptimeSeconds",
] as const;

export type HostMetricKey = (typeof HOST_METRIC_KEYS)[number];

export type HostMetrics = Record<HostMetricKey, number | null>;

export type HostMetricsDimensions = {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  daemonVersion: string;
  operatingSystem: string;
  architecture: string;
  kernelRelease: string;
  runtimeMode?: string;
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
  "cpuUsagePercent",
  "cpuUserPercent",
  "cpuSystemPercent",
  "cpuIowaitPercent",
  "memoryUsedPercent",
  "swapUsedPercent",
  "diskUsedPercent",
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
  assertFiniteNonNegative("intervalSeconds", input.intervalSeconds);
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
