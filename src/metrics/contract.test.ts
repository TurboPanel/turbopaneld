import { assertEquals, assertThrows } from "@std/assert";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  buildHostMetricsSample,
  clampPercent,
  HOST_METRIC_KEYS,
  type HostMetricsDimensions,
  METRICS_SCHEMA_VERSION,
  sanitizeFinite,
} from "./contract.ts";

/**
 * Cross-repo parity: `contract.ts` is mirrored in the instance repo
 * (`turbopanel/src/daemon/metrics/contract.ts`). Read the peer file from the
 * co-located checkout (`TURBOPANEL_INSTANCE_REPO` or `../turbopanel` next to
 * this repo) and assert the wire contract matches exactly. CI only checks out
 * this repo, so the peer may be absent there — the instance-side twin of this
 * test and co-located local runs still gate drift.
 */
async function readPeerContractSource(): Promise<string | null> {
  const override = Deno.env.get("TURBOPANEL_INSTANCE_REPO")?.trim();
  const root = override ||
    new URL("../../../turbopanel", import.meta.url).pathname;
  try {
    return await Deno.readTextFile(
      join(root, "src/daemon/metrics/contract.ts"),
    );
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

function parsePeerContract(
  source: string,
): { schemaVersion: number; metricKeys: string[] } {
  const versionMatch = /export const METRICS_SCHEMA_VERSION = (\d+) as const;/
    .exec(source);
  if (!versionMatch) {
    throw new Error("peer contract.ts: METRICS_SCHEMA_VERSION not found");
  }
  const keysMatch = /export const HOST_METRIC_KEYS = \[([\s\S]*?)\] as const;/
    .exec(source);
  if (!keysMatch) {
    throw new Error("peer contract.ts: HOST_METRIC_KEYS not found");
  }
  const metricKeys = [...keysMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return { schemaVersion: Number(versionMatch[1]), metricKeys };
}

it("METRICS_SCHEMA_VERSION is 2", () => {
  assertEquals(METRICS_SCHEMA_VERSION, 2);
});

it("HOST_METRIC_KEYS + METRICS_SCHEMA_VERSION match the instance repo contract", async () => {
  const source = await readPeerContractSource();
  if (source === null) {
    console.warn(
      "cross-repo parity skipped: turbopanel checkout not found (standalone CI)",
    );
    return;
  }
  const peer = parsePeerContract(source);
  assertEquals(peer.schemaVersion, METRICS_SCHEMA_VERSION);
  assertEquals(peer.metricKeys, [...HOST_METRIC_KEYS]);
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

const validDimensions: HostMetricsDimensions = {
  schemaVersion: METRICS_SCHEMA_VERSION,
  daemonVersion: "test",
  operatingSystem: "linux",
  architecture: "aarch64",
  kernelRelease: "6.12.0",
  collectionMode: "baseline",
};

const validBuildInput = {
  at: "2020-01-01T00:00:00.000Z",
  intervalSeconds: 60,
  sequence: 1,
  metrics: { cpuUserPercent: 12.5 },
  dimensions: validDimensions,
};

it("buildHostMetricsSample never coerces missing metrics to 0", () => {
  const sample = buildHostMetricsSample({
    ...validBuildInput,
    metrics: { cpuUserPercent: 12.5 },
  });

  assertEquals(sample.type, "metrics");
  assertEquals(sample.version, 2);
  assertEquals(sample.metrics.cpuUserPercent, 12.5);
  assertEquals(sample.metrics.load1, null);
  assertEquals(sample.metrics.memoryTotalBytes, null);
  assertEquals(sample.metrics.processCount, null);

  for (const key of HOST_METRIC_KEYS) {
    if (key === "cpuUserPercent") continue;
    assertEquals(sample.metrics[key], null);
  }
});

it("buildHostMetricsSample sanitizes and clamps percent metrics", () => {
  const sample = buildHostMetricsSample({
    ...validBuildInput,
    sequence: 2,
    metrics: {
      cpuUserPercent: 150,
      load1: Number.NaN,
      memoryTotalBytes: Number.POSITIVE_INFINITY,
      processCount: 10,
    },
  });

  assertEquals(sample.metrics.cpuUserPercent, 100);
  assertEquals(sample.metrics.load1, null);
  assertEquals(sample.metrics.memoryTotalBytes, null);
  assertEquals(sample.metrics.processCount, 10);
});

it("buildHostMetricsSample passes through hardware and dimension metadata", () => {
  const sample = buildHostMetricsSample({
    ...validBuildInput,
    metrics: { cpuTemperatureCelsius: -3.5, cpuPowerWatts: 42 },
    dimensions: {
      ...validDimensions,
      collectionMode: "live",
      cpuTemperatureSensor: "coretemp",
      uplinkInterfaces: ["eth0"],
    },
  });
  assertEquals(sample.metrics.cpuTemperatureCelsius, -3.5);
  assertEquals(sample.metrics.cpuPowerWatts, 42);
  assertEquals(sample.dimensions.collectionMode, "live");
  assertEquals(sample.dimensions.cpuTemperatureSensor, "coretemp");
  assertEquals(sample.dimensions.uplinkInterfaces, ["eth0"]);
});

it("buildHostMetricsSample rejects mismatched dimensions.schemaVersion", () => {
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        dimensions: { ...validDimensions, schemaVersion: 1 as 2 },
      }),
    TypeError,
    "metrics dimensions.schemaVersion must be 2",
  );
});

it("buildHostMetricsSample rejects invalid collectionMode", () => {
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        dimensions: {
          ...validDimensions,
          collectionMode: "turbo" as "baseline",
        },
      }),
    TypeError,
    'metrics dimensions.collectionMode must be "baseline" or "live"',
  );
});

it("buildHostMetricsSample rejects invalid intervalSeconds", () => {
  for (const intervalSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertThrows(
      () => buildHostMetricsSample({ ...validBuildInput, intervalSeconds }),
      TypeError,
      "metrics intervalSeconds must be a finite positive number",
    );
  }
});

it("buildHostMetricsSample accepts a zero sequence", () => {
  const sample = buildHostMetricsSample({
    ...validBuildInput,
    sequence: 0,
  });
  assertEquals(sample.sequence, 0);
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
