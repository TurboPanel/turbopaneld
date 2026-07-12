import { assertEquals } from "jsr:@std/assert";
import { createMetricsCollector } from "./index.ts";
import { it } from "@std/testing/bdd";

it("createMetricsCollector returns unsupported on non-linux", async () => {
  if (Deno.build.os === "linux") {
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
    return;
  }

  const collector = createMetricsCollector();
  const result = await collector.collect({ sequence: 0 });
  assertEquals(result.supported, false);
  if (!result.supported) {
    assertEquals(result.reason, `unsupported_os:${Deno.build.os}`);
  }
});
