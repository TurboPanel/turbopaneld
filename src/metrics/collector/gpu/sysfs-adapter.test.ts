import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import type { SensorIo } from "../sensors/discovery.ts";
import { SysfsGpuAdapter } from "./sysfs-adapter.ts";
import { buildGpuSamples } from "./index.ts";
import type { GpuAdapterSet, GpuReadContext } from "./adapter.ts";
import type { GpuTopology } from "../../topology/types.ts";

const test = Deno.test.bind(Deno);

const SYS_ROOT = "/fake/sys";

function fakeIo(
  files: Record<string, string | undefined>,
  dirs: Record<string, string[]>,
): SensorIo {
  return {
    listDir: (path: string) => dirs[path] ?? [],
    readFile: (path: string) => files[path],
  };
}

function ctx(overrides: Partial<GpuReadContext> = {}): GpuReadContext {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    ...overrides,
  };
}

test("SysfsGpuAdapter reads a full AMD hwmon device: utilization, power, temperature, and VRAM used", async () => {
  const hwmon0 = `${SYS_ROOT}/class/hwmon/hwmon0`;
  const files: Record<string, string | undefined> = {
    [`${hwmon0}/name`]: "amdgpu",
    [`${hwmon0}/temp1_input`]: "45000",
    [`${hwmon0}/temp1_label`]: "edge",
    [`${hwmon0}/temp2_input`]: "50000",
    [`${hwmon0}/temp2_label`]: "junction",
    [`${hwmon0}/power1_average`]: "150000000",
    [`${hwmon0}/power1_label`]: "PPT",
    [`${hwmon0}/device/gpu_busy_percent`]: "37",
    [`${hwmon0}/device/uevent`]: "PCI_SLOT_NAME=0000:01:00.0\nDRIVER=amdgpu\n",
    [`${hwmon0}/device/mem_info_vram_used`]: "2147483648",
  };
  const dirs: Record<string, string[]> = {
    [`${SYS_ROOT}/class/hwmon`]: ["hwmon0"],
    [hwmon0]: [
      "name",
      "temp1_input",
      "temp1_label",
      "temp2_input",
      "temp2_label",
      "power1_average",
      "power1_label",
    ],
  };
  const io = fakeIo(files, dirs);
  const adapter = new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT });
  const gpu: GpuTopology = {
    gpuId: "pci:0000:01:00.0",
    kind: "sysfs",
    pciPath: "0000:01:00.0",
    vendor: "amd",
    chip: "amdgpu",
  };

  const reading = await adapter.read(gpu, ctx());
  assertEquals(reading?.utilizationPercent, 37);
  assertEquals(reading?.temperatureCelsius, 45);
  // `junction` is the GPU-die hotspot proxy, a different physical sensor
  // from memory — it must never be reported as memoryTemperatureCelsius.
  assertEquals(reading?.memoryTemperatureCelsius, null);
  assertEquals(reading?.powerWatts, 150);
  assertEquals(reading?.memoryUsedBytes, 2147483648);
  assertEquals(reading?.memoryActivityPercent, null);
  assertEquals(reading?.pcieReceiveBytesPerSecond, null);
  assertEquals(reading?.throttlePercent, null);
});

test("SysfsGpuAdapter reads memoryTemperatureCelsius from a distinct mem-labeled sensor", async () => {
  const hwmon0 = `${SYS_ROOT}/class/hwmon/hwmon0`;
  const files: Record<string, string | undefined> = {
    [`${hwmon0}/name`]: "amdgpu",
    [`${hwmon0}/temp1_input`]: "45000",
    [`${hwmon0}/temp1_label`]: "edge",
    [`${hwmon0}/temp2_input`]: "50000",
    [`${hwmon0}/temp2_label`]: "junction",
    [`${hwmon0}/temp3_input`]: "38000",
    [`${hwmon0}/temp3_label`]: "mem",
    [`${hwmon0}/device/uevent`]: "PCI_SLOT_NAME=0000:01:00.0\nDRIVER=amdgpu\n",
  };
  const dirs: Record<string, string[]> = {
    [`${SYS_ROOT}/class/hwmon`]: ["hwmon0"],
    [hwmon0]: [
      "name",
      "temp1_input",
      "temp1_label",
      "temp2_input",
      "temp2_label",
      "temp3_input",
      "temp3_label",
    ],
  };
  const io = fakeIo(files, dirs);
  const adapter = new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT });
  const gpu: GpuTopology = {
    gpuId: "pci:0000:01:00.0",
    kind: "sysfs",
    pciPath: "0000:01:00.0",
    vendor: "amd",
    chip: "amdgpu",
  };

  const reading = await adapter.read(gpu, ctx());
  assertEquals(reading?.temperatureCelsius, 45);
  assertEquals(reading?.memoryTemperatureCelsius, 38);
});

test("SysfsGpuAdapter returns null when no discovered device correlates to this GPU's PCI path", async () => {
  const io = fakeIo({}, {});
  const adapter = new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT });
  const gpu: GpuTopology = {
    gpuId: "pci:0000:99:00.0",
    kind: "sysfs",
    pciPath: "0000:99:00.0",
    vendor: "amd",
    chip: "amdgpu",
  };
  assertEquals(await adapter.read(gpu, ctx()), null);
});

test("SysfsGpuAdapter keeps two same-driver Intel DRM GPUs cardinality-correct: each topology GPU reads only its own engine counters", async () => {
  const card0 = `${SYS_ROOT}/class/drm/card0`;
  const card1 = `${SYS_ROOT}/class/drm/card1`;
  const files: Record<string, string | undefined> = {
    [`${card0}/device/vendor`]: "0x8086",
    [`${card0}/device/uevent`]: "PCI_SLOT_NAME=0000:00:02.0\nDRIVER=i915\n",
    [`${card0}/engine/rcs0/busy`]: "0",
    [`${card1}/device/vendor`]: "0x8086",
    [`${card1}/device/uevent`]: "PCI_SLOT_NAME=0000:03:00.0\nDRIVER=i915\n",
    [`${card1}/engine/rcs0/busy`]: "0",
  };
  const dirs: Record<string, string[]> = {
    [`${SYS_ROOT}/class/drm`]: ["card0", "card1"],
    [`${card0}/engine`]: ["rcs0"],
    [`${card1}/engine`]: ["rcs0"],
  };
  const io = fakeIo(files, dirs);
  const adapter = new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT });
  const gpuA: GpuTopology = {
    gpuId: "pci:0000:00:02.0",
    kind: "drm",
    pciPath: "0000:00:02.0",
    vendor: "intel",
    chip: "i915",
  };
  const gpuB: GpuTopology = {
    gpuId: "pci:0000:03:00.0",
    kind: "drm",
    pciPath: "0000:03:00.0",
    vendor: "intel",
    chip: "i915",
  };
  const tracker = new CounterBaselineTracker();

  await adapter.read(gpuA, ctx({ tracker, seconds: 10 }));
  await adapter.read(gpuB, ctx({ tracker, seconds: 10 }));

  // Second tick: only card0's engine advances. If the two cards had been
  // collapsed into one device (the pre-fix bug), gpuB would read card0's
  // counter and report a spurious utilization instead of staying at 0%.
  files[`${card0}/engine/rcs0/busy`] = String(5_000_000_000);
  const readingA = await adapter.read(gpuA, ctx({ tracker, seconds: 10 }));
  const readingB = await adapter.read(gpuB, ctx({ tracker, seconds: 10 }));
  assertEquals(readingA?.utilizationPercent, 50);
  assertEquals(readingB?.utilizationPercent, 0);
});

test("SysfsGpuAdapter reduces Intel DRM engine-busy counters to a tracker-backed utilization percent across two ticks", async () => {
  const card0 = `${SYS_ROOT}/class/drm/card0`;
  const files: Record<string, string | undefined> = {
    [`${card0}/device/vendor`]: "0x8086",
    [`${card0}/device/uevent`]: "PCI_SLOT_NAME=0000:00:02.0\nDRIVER=i915\n",
    [`${card0}/engine/rcs0/busy`]: "1000000000",
    [`${card0}/engine/bcs0/busy`]: "1000000000",
  };
  const dirs: Record<string, string[]> = {
    [`${SYS_ROOT}/class/drm`]: ["card0"],
    [`${card0}/engine`]: ["rcs0", "bcs0"],
  };
  const io = fakeIo(files, dirs);
  const adapter = new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT });
  const gpu: GpuTopology = {
    gpuId: "pci:0000:00:02.0",
    kind: "drm",
    pciPath: "0000:00:02.0",
    vendor: "intel",
    chip: "i915",
  };
  const tracker = new CounterBaselineTracker();

  // First tick: no prior baseline for either engine counter — `null`, not 0.
  const first = await adapter.read(gpu, ctx({ tracker, seconds: 10 }));
  assertEquals(first?.utilizationPercent, null);
  assertEquals(first?.temperatureCelsius, null);
  assertEquals(first?.powerWatts, null);

  // Second tick, 10s later: rcs0 busy +5s (50%), bcs0 busy +1s (10%) — the
  // busiest engine wins, engines run in parallel so they are never summed.
  files[`${card0}/engine/rcs0/busy`] = String(1_000_000_000 + 5_000_000_000);
  files[`${card0}/engine/bcs0/busy`] = String(1_000_000_000 + 1_000_000_000);
  const second = await adapter.read(gpu, ctx({ tracker, seconds: 10 }));
  assertEquals(second?.utilizationPercent, 50);
});

test("buildGpuSamples invalidates the Intel engine-busy baseline on an unreadable tick, so the next readable tick doesn't fabricate a rate across the gap", async () => {
  const card0 = `${SYS_ROOT}/class/drm/card0`;
  const files: Record<string, string | undefined> = {
    [`${card0}/device/vendor`]: "0x8086",
    [`${card0}/device/uevent`]: "PCI_SLOT_NAME=0000:00:02.0\nDRIVER=i915\n",
    [`${card0}/engine/rcs0/busy`]: "0",
  };
  const dirs: Record<string, string[]> = {
    [`${SYS_ROOT}/class/drm`]: ["card0"],
    [`${card0}/engine`]: ["rcs0"],
  };
  const io = fakeIo(files, dirs);
  const gpu: GpuTopology = {
    gpuId: "pci:0000:00:02.0",
    kind: "drm",
    pciPath: "0000:00:02.0",
    vendor: "intel",
    chip: "i915",
  };
  const adapters: GpuAdapterSet = {
    dcgm: {
      id: "dcgm",
      probe: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
    nvml: {
      id: "nvml",
      probe: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
    sysfs: new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT }),
  };
  const tracker = new CounterBaselineTracker();
  const tick = () =>
    buildGpuSamples([gpu], adapters, {
      tracker,
      bootGeneration: 1,
      seconds: 10,
    });

  // Tick 1: readable, first observation — no prior baseline yet.
  let samples = await tick();
  assertEquals(samples[0].utilizationPercent, null);

  // Tick 2: readable, 10s later — busy +5s over 10s = 50%, a real baseline.
  files[`${card0}/engine/rcs0/busy`] = String(5_000_000_000);
  samples = await tick();
  assertEquals(samples[0].utilizationPercent, 50);

  // Tick 3: unreadable — the DRM card vanishes. buildGpuSamples must
  // invalidate the engine-busy baseline it left behind, not just emit the
  // empty sample.
  dirs[`${SYS_ROOT}/class/drm`] = [];
  samples = await tick();
  assertEquals(samples[0].utilizationPercent, null);

  // Tick 4: readable again. Without invalidation this would diff against
  // tick 2's stale baseline across the two missed ticks and fabricate a
  // rate; it must instead behave like a first observation: `null`.
  dirs[`${SYS_ROOT}/class/drm`] = ["card0"];
  files[`${card0}/engine/rcs0/busy`] = String(5_000_000_000 + 3_000_000_000);
  samples = await tick();
  assertEquals(samples[0].utilizationPercent, null);
});

test("SysfsGpuAdapter reduces Intel RC6 residency to a tracker-backed GT-awake percent across two ticks", async () => {
  const card0 = `${SYS_ROOT}/class/drm/card0`;
  const files: Record<string, string | undefined> = {
    [`${card0}/device/vendor`]: "0x8086",
    [`${card0}/device/uevent`]: "PCI_SLOT_NAME=0000:00:02.0\nDRIVER=i915\n",
    [`${card0}/gt/gt0/rc6_residency_ms`]: "100000",
  };
  const dirs: Record<string, string[]> = {
    [`${SYS_ROOT}/class/drm`]: ["card0"],
    [`${card0}/engine`]: ["rcs0"],
    [`${card0}/gt`]: ["gt0"],
    [`${card0}/gt/gt0`]: ["rc6_residency_ms"],
  };
  const io = fakeIo(files, dirs);
  const adapter = new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT });
  const gpu: GpuTopology = {
    gpuId: "pci:0000:00:02.0",
    kind: "drm",
    pciPath: "0000:00:02.0",
    vendor: "intel",
    chip: "i915",
  };
  const tracker = new CounterBaselineTracker();

  const first = await adapter.read(gpu, ctx({ tracker, seconds: 10 }));
  assertEquals(first?.utilizationPercent, null);

  // 5000 ms RC6 over 10 s wall = 50% idle = 50% GT-awake.
  files[`${card0}/gt/gt0/rc6_residency_ms`] = "105000";
  const second = await adapter.read(gpu, ctx({ tracker, seconds: 10 }));
  assertEquals(second?.utilizationPercent, 50);
});

test("SysfsGpuAdapter prefers DRM engine busy over RC6 when both exist", async () => {
  const card0 = `${SYS_ROOT}/class/drm/card0`;
  const files: Record<string, string | undefined> = {
    [`${card0}/device/vendor`]: "0x8086",
    [`${card0}/device/uevent`]: "PCI_SLOT_NAME=0000:00:02.0\nDRIVER=i915\n",
    [`${card0}/engine/rcs0/busy`]: "0",
    [`${card0}/gt/gt0/rc6_residency_ms`]: "0",
  };
  const dirs: Record<string, string[]> = {
    [`${SYS_ROOT}/class/drm`]: ["card0"],
    [`${card0}/engine`]: ["rcs0"],
    [`${card0}/gt`]: ["gt0"],
  };
  const io = fakeIo(files, dirs);
  const adapter = new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT });
  const gpu: GpuTopology = {
    gpuId: "pci:0000:00:02.0",
    kind: "drm",
    pciPath: "0000:00:02.0",
    vendor: "intel",
    chip: "i915",
  };
  const tracker = new CounterBaselineTracker();
  await adapter.read(gpu, ctx({ tracker, seconds: 10 }));
  files[`${card0}/engine/rcs0/busy`] = String(2_000_000_000);
  files[`${card0}/gt/gt0/rc6_residency_ms`] = "0";
  const second = await adapter.read(gpu, ctx({ tracker, seconds: 10 }));
  // Engine busy +2s / 10s = 20%. Fully-busy RC6 (delta 0) would be 100%.
  assertEquals(second?.utilizationPercent, 20);
});

test("SysfsGpuAdapter reduces RAPL uncore energy_uj to Intel GPU watts across two ticks", async () => {
  const card0 = `${SYS_ROOT}/class/drm/card0`;
  const uncore = `${SYS_ROOT}/class/powercap/intel-rapl:0:1`;
  const files: Record<string, string | undefined> = {
    [`${card0}/device/vendor`]: "0x8086",
    [`${card0}/device/uevent`]: "PCI_SLOT_NAME=0000:00:02.0\nDRIVER=i915\n",
    [`${card0}/gt/gt0/rc6_residency_ms`]: "0",
    [`${SYS_ROOT}/class/powercap/intel-rapl:0/name`]: "package-0",
    [`${SYS_ROOT}/class/powercap/intel-rapl:0/energy_uj`]: "9000000000",
    [`${uncore}/name`]: "uncore",
    [`${uncore}/energy_uj`]: "1000000000",
  };
  const dirs: Record<string, string[]> = {
    [`${SYS_ROOT}/class/drm`]: ["card0"],
    [`${card0}/engine`]: ["rcs0"],
    [`${card0}/gt`]: ["gt0"],
    [`${SYS_ROOT}/class/powercap`]: ["intel-rapl:0", "intel-rapl:0:1"],
  };
  const io = fakeIo(files, dirs);
  const adapter = new SysfsGpuAdapter({ io, sysRoot: SYS_ROOT });
  const gpu: GpuTopology = {
    gpuId: "pci:0000:00:02.0",
    kind: "drm",
    pciPath: "0000:00:02.0",
    vendor: "intel",
    chip: "i915",
  };
  const tracker = new CounterBaselineTracker();

  const first = await adapter.read(gpu, ctx({ tracker, seconds: 10 }));
  assertEquals(first?.powerWatts, null);

  // +50_000_000 µJ over 10 s = 5 W. Package energy must not leak in.
  files[`${uncore}/energy_uj`] = "1050000000";
  files[`${SYS_ROOT}/class/powercap/intel-rapl:0/energy_uj`] = "9500000000";
  const second = await adapter.read(gpu, ctx({ tracker, seconds: 10 }));
  assertEquals(second?.powerWatts, 5);
});
