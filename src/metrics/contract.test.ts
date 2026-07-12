import { assertEquals, assertThrows } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  buildHostMetricsSample,
  clampPercent,
  HOST_METRIC_KEYS,
  type HostMetricsDimensions,
  sanitizeFinite,
  METRICS_SCHEMA_VERSION,
} from "./contract.ts";

/** Parity lock: mirrored instance contract must keep this exact order + schema version. */
const EXPECTED_METRIC_KEYS = [
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

it("METRICS_SCHEMA_VERSION is 1", () => {
  assertEquals(METRICS_SCHEMA_VERSION, 1);
});

it("HOST_METRIC_KEYS parity: count and order", () => {
  assertEquals(HOST_METRIC_KEYS.length, 20);
  assertEquals([...HOST_METRIC_KEYS], [...EXPECTED_METRIC_KEYS]);
});

it("clampPercent clamps 0–100 and passes null", () => {
  assertEquals(clampPercent(null), null);
  assertEquals(clampPercent(0), 0);
  assertEquals(clampPercent(100), 100);
  assertEquals(clampPercent(50.5), 50.5);
  assertEquals(clampPercent(-1), 0);
  assertEquals(clampPercent(101), 100);
});

it("sanitizeFinite rejects NaN and ±Infinity", () => {
  assertEquals(sanitizeFinite(null), null);
  assertEquals(sanitizeFinite(undefined), null);
  assertEquals(sanitizeFinite(42), 42);
  assertEquals(sanitizeFinite(Number.NaN), null);
  assertEquals(sanitizeFinite(Number.POSITIVE_INFINITY), null);
  assertEquals(sanitizeFinite(Number.NEGATIVE_INFINITY), null);
});

it("buildHostMetricsSample never coerces missing metrics to 0", () => {
  const sample = buildHostMetricsSample({
    at: "2020-01-01T00:00:00.000Z",
    intervalSeconds: 60,
    sequence: 1,
    metrics: { cpuUsagePercent: 12.5 },
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "linux",
      architecture: "aarch64",
      kernelRelease: "6.12.0",
    },
  });

  assertEquals(sample.type, "metrics");
  assertEquals(sample.version, 1);
  assertEquals(sample.metrics.cpuUsagePercent, 12.5);
  assertEquals(sample.metrics.load1, null);
  assertEquals(sample.metrics.memoryUsedBytes, null);
  assertEquals(sample.metrics.processCount, null);

  for (const key of HOST_METRIC_KEYS) {
    if (key === "cpuUsagePercent") continue;
    assertEquals(sample.metrics[key], null);
  }
});

it("buildHostMetricsSample sanitizes and clamps percent metrics", () => {
  const sample = buildHostMetricsSample({
    at: "2020-01-01T00:00:00.000Z",
    intervalSeconds: 60,
    sequence: 2,
    metrics: {
      cpuUsagePercent: 150,
      load1: Number.NaN,
      memoryUsedBytes: Number.POSITIVE_INFINITY,
      processCount: 10,
    },
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "linux",
      architecture: "aarch64",
      kernelRelease: "6.12.0",
    },
  });

  assertEquals(sample.metrics.cpuUsagePercent, 100);
  assertEquals(sample.metrics.load1, null);
  assertEquals(sample.metrics.memoryUsedBytes, null);
  assertEquals(sample.metrics.processCount, 10);
});

const validDimensions: HostMetricsDimensions = {
  schemaVersion: METRICS_SCHEMA_VERSION,
  daemonVersion: "test",
  operatingSystem: "linux",
  architecture: "aarch64",
  kernelRelease: "6.12.0",
};

const validBuildInput = {
  at: "2020-01-01T00:00:00.000Z",
  intervalSeconds: 60,
  sequence: 1,
  metrics: { cpuUsagePercent: 12.5 },
  dimensions: validDimensions,
};

it("buildHostMetricsSample rejects mismatched dimensions.schemaVersion", () => {
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        dimensions: { ...validDimensions, schemaVersion: 2 as 1 },
      }),
    TypeError,
    "metrics dimensions.schemaVersion must be 1",
  );
});

it("buildHostMetricsSample rejects invalid intervalSeconds", () => {
  for (const intervalSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertThrows(
      () => buildHostMetricsSample({ ...validBuildInput, intervalSeconds }),
      TypeError,
      "metrics intervalSeconds must be a finite non-negative number",
    );
  }
});

it("buildHostMetricsSample rejects invalid sequence", () => {
  for (const sequence of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assertThrows(
      () => buildHostMetricsSample({ ...validBuildInput, sequence }),
      TypeError,
      "metrics sequence must be a finite non-negative number",
    );
  }
});
