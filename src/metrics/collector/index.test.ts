import { assertEquals } from "@std/assert";
import { createMetricsCollector } from "./index.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "createMetricsCollector returns supported on linux with injected deps",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const collector = createMetricsCollector({
      readProcFile: () => undefined,
      statfs: () => null,
      now: () => 0,
      countProcesses: () => null,
      resolveDimensions: () => ({
        schemaVersion: 1,
        daemonVersion: "test",
        operatingSystem: "linux",
        architecture: "x86_64",
        kernelRelease: "",
      }),
    });
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

test({
  name:
    "createMetricsCollector merges default statfs when other deps are overridden",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const collector = createMetricsCollector({
      readProcFile: () => undefined,
      now: () => 1_000,
      countProcesses: () => 7,
      resolveDimensions: () => ({
        schemaVersion: 1,
        daemonVersion: "test",
        operatingSystem: "linux",
        architecture: "x86_64",
        kernelRelease: "fixture",
      }),
    });
    const result = await collector.collect({ sequence: 1 });
    assertEquals(result.supported, true);
    if (!result.supported) return;
    const disk = result.sample.metrics.diskUsedPercent;
    if (disk !== null && typeof disk !== "number") {
      throw new TypeError("diskUsedPercent must be a number when present");
    }
  },
});
