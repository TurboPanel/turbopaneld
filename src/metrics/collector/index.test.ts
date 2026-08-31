import { assertEquals } from "@std/assert";
import {
  createCachedDockerDataRoot,
  createMetricsCollector,
  DOCKER_DATA_ROOT_RETRY_MS,
} from "./index.ts";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import type { CollectorDeps } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function inertDeps(): Partial<CollectorDeps> {
  return {
    readProcFile: () => undefined,
    statfs: () => null,
    now: () => 0,
    countProcesses: () => null,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "linux",
      architecture: "x86_64",
      kernelRelease: "",
    }),
    resolveDockerDataRoot: () => Promise.resolve(null),
    resolveHostingPath: () => "/srv/users",
    readSensors: () =>
      Promise.resolve({
        cpuTemperatureCelsius: null,
        gpuTemperatureCelsius: null,
        gpuPowerWatts: null,
        cpuEnergy: null,
        sensors: {},
      }),
    resolveFabricInterfaces: () => Promise.resolve(["tp0"]),
    resolveAdminSensorOverrides: () => Promise.resolve({}),
  };
}

test({
  name: "createMetricsCollector returns supported on linux with injected deps",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const collector = createMetricsCollector(inertDeps());
    const result = await collector.collect({ sequence: 0 });
    assertEquals(result.supported, true);
  },
});

test("createMetricsCollector returns unsupported on non-linux via options.os", async () => {
  const collector = createMetricsCollector(undefined, { os: "darwin" });
  const result = await collector.collect({ sequence: 0 });
  assertEquals(result.supported, false);
  if (!result.supported) {
    assertEquals(result.reason, "unsupported_os:darwin");
  }

  const windows = createMetricsCollector(undefined, { os: "windows" });
  const windowsResult = await windows.collect({ sequence: 0 });
  assertEquals(windowsResult.supported, false);
  if (!windowsResult.supported) {
    assertEquals(windowsResult.reason, "unsupported_os:windows");
  }
});

test("createCachedDockerDataRoot caches a successful resolution forever", async () => {
  let calls = 0;
  const cached = createCachedDockerDataRoot(
    () => {
      calls += 1;
      return Promise.resolve("/var/lib/docker");
    },
    () => 0,
  );
  assertEquals(await cached(), "/var/lib/docker");
  assertEquals(await cached(), "/var/lib/docker");
  assertEquals(calls, 1);
});

test("createCachedDockerDataRoot bounds re-probes after failure", async () => {
  let calls = 0;
  let nowMs = 0;
  let answer: string | undefined = undefined;
  const cached = createCachedDockerDataRoot(
    () => {
      calls += 1;
      return Promise.resolve(answer);
    },
    () => nowMs,
  );

  // Repeated collects inside the cooldown never re-probe.
  assertEquals(await cached(), null);
  nowMs = 60_000;
  assertEquals(await cached(), null);
  assertEquals(calls, 1);

  // After the cooldown the probe runs again and a success sticks.
  nowMs = DOCKER_DATA_ROOT_RETRY_MS;
  answer = "/mnt/docker-data";
  assertEquals(await cached(), "/mnt/docker-data");
  assertEquals(await cached(), "/mnt/docker-data");
  assertEquals(calls, 2);
});

test({
  name:
    "createMetricsCollector merges default statfs when other deps are overridden",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const deps = inertDeps();
    delete deps.statfs;
    const collector = createMetricsCollector({ ...deps, now: () => 1_000 });
    const result = await collector.collect({ sequence: 1 });
    assertEquals(result.supported, true);
    if (!result.supported) return;
    const total = result.sample.metrics.systemStorageTotalBytes;
    if (total !== null && typeof total !== "number") {
      throw new TypeError(
        "systemStorageTotalBytes must be a number when present",
      );
    }
  },
});
