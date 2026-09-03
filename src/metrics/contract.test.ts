import { assertEquals, assertThrows } from "@std/assert";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  buildHostMetricsSample,
  clampPercent,
  HOST_METRIC_KEYS,
  type HostMetricsDimensions,
  MAX_METRICS_PER_PART,
  METRIC_KEY_PARTS,
  METRIC_PARTS,
  type MetricPart,
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
): {
  schemaVersion: number;
  metricKeys: string[];
  keyParts: [string, string][];
} {
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

  const keyParts: [string, string][] = [];
  for (
    const partArrayMatch of source.matchAll(
      /const (CORE|EXTENDED|SENSORS|TRAFFIC)_PART_KEYS: readonly HostMetricKey\[\] = \[([\s\S]*?)\];/g,
    )
  ) {
    const part = partArrayMatch[1].toLowerCase();
    for (const m of partArrayMatch[2].matchAll(/"([^"]+)"/g)) {
      keyParts.push([m[1], part]);
    }
  }
  return { schemaVersion: Number(versionMatch[1]), metricKeys, keyParts };
}

it("METRICS_SCHEMA_VERSION is 3", () => {
  assertEquals(METRICS_SCHEMA_VERSION, 3);
});

it("HOST_METRIC_KEYS + METRICS_SCHEMA_VERSION + METRIC_KEY_PARTS match the instance repo contract", async () => {
  const source = await readPeerContractSource();
  if (source === null) {
    console.warn(
      "cross-repo parity skipped: turbopaneld checkout not found (standalone CI)",
    );
    return;
  }
  const peer = parsePeerContract(source);
  assertEquals(peer.schemaVersion, METRICS_SCHEMA_VERSION);
  assertEquals(peer.metricKeys, [...HOST_METRIC_KEYS]);
  const peerParts = Object.fromEntries(peer.keyParts);
  for (const key of HOST_METRIC_KEYS) {
    assertEquals(peerParts[key], METRIC_KEY_PARTS[key]);
  }
});

it("cpuTemperatureCelsius and cpuPowerWatts are sensors-part keys", () => {
  // Moved out of core/extended so a host whose only readable hardware is CPU
  // temperature/power still declares the "sensors" part instead of being
  // misreported as sensorless.
  assertEquals(METRIC_KEY_PARTS.cpuTemperatureCelsius, "sensors");
  assertEquals(METRIC_KEY_PARTS.cpuPowerWatts, "sensors");
});

it("no metric part exceeds the MAX_METRICS_PER_PART ceiling", () => {
  const countByPart = new Map<MetricPart, number>();
  for (const key of HOST_METRIC_KEYS) {
    const part = METRIC_KEY_PARTS[key];
    countByPart.set(part, (countByPart.get(part) ?? 0) + 1);
  }
  for (const part of METRIC_PARTS) {
    const count = countByPart.get(part) ?? 0;
    assertEquals(count > 0, true, `part ${part} has no members`);
    assertEquals(
      count <= MAX_METRICS_PER_PART,
      true,
      `part ${part} has ${count} keys, exceeding ${MAX_METRICS_PER_PART}`,
    );
  }
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
  collectionMode: "baseline",
  hardwareProfileGeneration: 1,
  trafficSources: { caddy: false, proxysql: false },
};

const validBuildInput = {
  at: "2020-01-01T00:00:00.000Z",
  intervalSeconds: 60,
  sequence: 1,
  parts: ["core", "extended"] as MetricPart[],
  metrics: { cpuUserPercent: 12.5 },
  dimensions: validDimensions,
};

it("buildHostMetricsSample never coerces missing metrics to 0", () => {
  const sample = buildHostMetricsSample({
    ...validBuildInput,
    parts: ["core", "extended"],
    metrics: { cpuUserPercent: 12.5 },
  });

  assertEquals(sample.type, "metrics");
  assertEquals(sample.version, 3);
  assertEquals(sample.metrics.cpuUserPercent, 12.5);
  assertEquals(sample.metrics.load1, null);
  assertEquals(sample.metrics.memoryTotalBytes, null);
  assertEquals(sample.metrics.processCount, null);

  for (const key of HOST_METRIC_KEYS) {
    if (METRIC_KEY_PARTS[key] !== "core") continue;
    if (key === "cpuUserPercent") continue;
    assertEquals(sample.metrics[key], null);
  }
});

it("buildHostMetricsSample only carries keys whose part is declared", () => {
  const sample = buildHostMetricsSample({
    ...validBuildInput,
    parts: ["core", "extended"],
    metrics: {},
  });
  for (const key of HOST_METRIC_KEYS) {
    const declared = METRIC_KEY_PARTS[key] === "core" ||
      METRIC_KEY_PARTS[key] === "extended";
    assertEquals(key in sample.metrics, declared);
  }
});

it("buildHostMetricsSample rejects parts missing core", () => {
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        parts: ["extended"],
      }),
    TypeError,
    'metrics parts must include "core"',
  );
});

it("buildHostMetricsSample rejects parts missing extended", () => {
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        parts: ["core"],
      }),
    TypeError,
    'metrics parts must include "extended"',
  );
});

it("buildHostMetricsSample rejects empty, duplicate, or invalid parts", () => {
  assertThrows(
    () => buildHostMetricsSample({ ...validBuildInput, parts: [] }),
    TypeError,
    "metrics parts must be a non-empty array",
  );
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        parts: ["core", "core"],
      }),
    TypeError,
    "metrics parts contains a duplicate part",
  );
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        // deno-lint-ignore no-explicit-any
        parts: ["core", "bogus" as any],
      }),
    TypeError,
    "metrics parts contains an invalid part",
  );
});

it("buildHostMetricsSample sanitizes and clamps percent metrics", () => {
  const sample = buildHostMetricsSample({
    ...validBuildInput,
    sequence: 2,
    parts: ["core", "extended"],
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
    parts: ["core", "extended", "sensors"],
    metrics: {
      cpuTemperatureCelsius: -3.5,
      cpuPowerWatts: 42,
      gpuUtilizationPercent: 150,
    },
    dimensions: {
      ...validDimensions,
      collectionMode: "live",
      hardwareProfileGeneration: 2,
      trafficSources: { caddy: true, proxysql: false },
    },
  });
  assertEquals(sample.metrics.cpuTemperatureCelsius, -3.5);
  assertEquals(sample.metrics.cpuPowerWatts, 42);
  assertEquals(sample.metrics.gpuUtilizationPercent, 100);
  assertEquals(sample.dimensions.collectionMode, "live");
  assertEquals(sample.dimensions.hardwareProfileGeneration, 2);
  assertEquals(sample.dimensions.trafficSources, {
    caddy: true,
    proxysql: false,
  });
});

it("buildHostMetricsSample rejects mismatched dimensions.schemaVersion", () => {
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        dimensions: { ...validDimensions, schemaVersion: 1 as 3 },
      }),
    TypeError,
    "metrics dimensions.schemaVersion must be 3",
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

it("buildHostMetricsSample rejects a missing or malformed dimensions.trafficSources", () => {
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        dimensions: {
          ...validDimensions,
          // deno-lint-ignore no-explicit-any
          trafficSources: undefined as any,
        },
      }),
    TypeError,
    "metrics dimensions.trafficSources.caddy and .proxysql must be boolean",
  );
  assertThrows(
    () =>
      buildHostMetricsSample({
        ...validBuildInput,
        dimensions: {
          ...validDimensions,
          // deno-lint-ignore no-explicit-any
          trafficSources: { caddy: "yes", proxysql: false } as any,
        },
      }),
    TypeError,
    "metrics dimensions.trafficSources.caddy and .proxysql must be boolean",
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
