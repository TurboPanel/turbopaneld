import { assertEquals } from "@std/assert";
import { createMetricsCollector } from "./index.ts";
import { it } from "@std/testing/bdd";

it({
  name: "createMetricsCollector returns supported on linux with injected deps",
  // Live OS gate: fixture-driven linux path only runs on linux hosts.
  ignore: Deno.build.os !== "linux",
  fn: async () => {
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

it({
  name: "createMetricsCollector returns unsupported on non-linux",
  // Live OS gate: unsupported_os path only runs off linux.
  ignore: Deno.build.os === "linux",
  fn: async () => {
    const collector = createMetricsCollector();
    const result = await collector.collect({ sequence: 0 });
    assertEquals(result.supported, false);
    if (!result.supported) {
      assertEquals(result.reason, `unsupported_os:${Deno.build.os}`);
    }
  },
});
