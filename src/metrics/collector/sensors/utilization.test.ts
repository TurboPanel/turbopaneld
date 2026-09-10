import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { gpuUtilizationFromBusy, readGpuUtilization } from "./utilization.ts";
import type { SensorCandidate } from "../types.ts";

it("gpuUtilizationFromBusy returns null without two snapshots or a positive interval", () => {
  const busy = { engines: { rcs0: 1_000_000_000 } };
  assertEquals(gpuUtilizationFromBusy(null, busy, 1), null);
  assertEquals(gpuUtilizationFromBusy(busy, busy, 0), null);
});

it("gpuUtilizationFromBusy uses the busiest engine and clamps at 100", () => {
  const previous = { engines: { rcs0: 0, bcs0: 0 } };
  const current = { engines: { rcs0: 500_000_000, bcs0: 100_000_000 } };
  assertEquals(gpuUtilizationFromBusy(previous, current, 1), 50);
  assertEquals(
    gpuUtilizationFromBusy(previous, { engines: { rcs0: 2_000_000_000 } }, 1),
    100,
  );
});

it("gpuUtilizationFromBusy ignores engines that did not appear in the previous snapshot", () => {
  assertEquals(
    gpuUtilizationFromBusy(
      { engines: { rcs0: 0 } },
      { engines: { bcs0: 1_000_000_000 } },
      1,
    ),
    null,
  );
});

it("gpuUtilizationFromBusy skips an engine whose counter went backwards", () => {
  assertEquals(
    gpuUtilizationFromBusy(
      { engines: { rcs0: 2_000_000_000 } },
      { engines: { rcs0: 500_000_000 } },
      1,
    ),
    0,
  );
  assertEquals(
    gpuUtilizationFromBusy(
      { engines: { rcs0: 2_000_000_000, bcs0: 0 } },
      { engines: { rcs0: 500_000_000, bcs0: 250_000_000 } },
      1,
    ),
    25,
  );
});

it("readGpuUtilization skips non-finite engine-busy counters and stays empty", async () => {
  const candidates: SensorCandidate[] = [
    {
      chip: "i915",
      label: "rcs0",
      path: "/sys/class/drm/card0/engine/rcs0/busy",
    },
  ];
  const resolved = await readGpuUtilization(candidates, undefined, {
    listDir: () => [],
    readFile: () => "nope",
  });
  assertEquals(resolved, {
    percent: null,
    busy: null,
    sensor: "i915:rcs0",
  });
});

it("readGpuUtilization returns null percent when the gauge sysfs value is unreadable", async () => {
  const candidates: SensorCandidate[] = [
    {
      chip: "amdgpu",
      label: "gpu_busy_percent",
      path: "/sys/class/drm/card0/device/gpu_busy_percent",
    },
  ];
  const resolved = await readGpuUtilization(candidates, undefined, {
    listDir: () => [],
    readFile: () => "nope",
  });
  assertEquals(resolved, {
    percent: null,
    busy: null,
    sensor: "amdgpu:gpu_busy_percent",
  });
});
