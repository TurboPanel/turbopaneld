import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import {
  blockTemperatureSignalId,
  collectHardwareSignals,
  CPU_HOTTEST_CORE_SIGNAL_ID,
  CPU_THERMAL_THROTTLED_SIGNAL_ID,
  gpuSignalId,
} from "./hardware-signal-topology.ts";
import type { BlockDeviceTopology, GpuTopology } from "./types.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

test("collectHardwareSignals maps hwmon/RAPL candidates into stable signal identities", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-basic"),
  });

  assertEquals(signals.length, 2);

  const temp = signals.find((s) => s.kind === "temperature");
  assertEquals(temp?.signalId, "signal:coretemp:Package id 0");
  assertEquals(temp?.unit, "celsius");
  assertEquals(temp?.component, "cpu");
  assertEquals(temp?.label, "CPU package temperature");
  // hwmon's sibling tempN_max/tempN_crit files, converted to celsius same as the reading.
  assertEquals(temp?.thresholds, { warning: 90, critical: 100 });

  const power = signals.find((s) => s.kind === "power");
  assertEquals(power?.signalId, "signal:intel-rapl:package-0");
  assertEquals(power?.unit, "watts");
  assertEquals(power?.component, "cpu");
  assertEquals(power?.label, "CPU package power");
  // RAPL energy counters expose no threshold files.
  assertEquals(power?.thresholds, undefined);
});

test("collectHardwareSignals yields nothing on a sensorless host", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fromFileUrl(
      new URL(`../collector/testdata/sensors-none`, import.meta.url),
    ),
  });
  assertEquals(signals, []);
});

test("collectHardwareSignals: the full conservative catalog — fan-free, no entity signals without entity topology, only trustworthy board labels, both synthetic CPU signals present", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-full"),
  });

  // 1 CPU package temp + 1 disk temp + 2 trusted board temps (SYSTIN,
  // PCH_CHIP_TEMP — AUXTIN is dropped) + 1 CPU power + hottest-core +
  // thermal-throttled. No fan ever. No GPU or drive-entity signals either:
  // this call passes no `gpus`/`blockDevices`, and entity signals are never
  // synthesized for an entity topology did not enumerate — not even for the
  // `amdgpu` hwmon chip sitting right there in the fixture.
  assertEquals(signals.length, 7);
  assertEquals(signals.some((s) => s.kind === "fan"), false);
  assertEquals(signals.some((s) => s.component === "gpu"), false);
  assertEquals(signals.some((s) => s.component === "drive"), false);
  assertEquals(signals.some((s) => s.label === "AUXTIN"), false);

  const packageTemp = signals.find((s) =>
    s.signalId === "signal:coretemp:Package id 0"
  );
  assertEquals(packageTemp?.component, "cpu");
  assertEquals(packageTemp?.thresholds, { warning: 90, critical: 100 });
  // Individual per-core entries (Core 0/Core 1) are not separate physical
  // signals — they only feed the hottest-core synthetic below.
  assertEquals(
    signals.some((s) => s.label === "Core 0" || s.label === "Core 1"),
    false,
  );

  const diskTemp = signals.find((s) => s.component === "disk");
  assertEquals(diskTemp?.label, "Composite");

  const boardLabels = signals.filter((s) => s.component === "board").map((
    s,
  ) => s.label).sort();
  assertEquals(boardLabels, ["PCH_CHIP_TEMP", "SYSTIN"]);

  const power = signals.find((s) => s.kind === "power");
  assertEquals(power?.component, "cpu");
  assertEquals(power?.signalId, "signal:intel-rapl:package-0");
  assertEquals(power?.label, "CPU package power");

  const hottestCore = signals.find((s) =>
    s.signalId === CPU_HOTTEST_CORE_SIGNAL_ID
  );
  assertEquals(hottestCore?.kind, "temperature");
  assertEquals(hottestCore?.component, "cpu");
  // Same threshold files as the package (coretemp is uniform per-package).
  assertEquals(hottestCore?.thresholds, { warning: 90, critical: 100 });

  const throttled = signals.find((s) =>
    s.signalId === CPU_THERMAL_THROTTLED_SIGNAL_ID
  );
  assertEquals(throttled?.kind, "percent");
  assertEquals(throttled?.component, "cpu");
});

test("collectHardwareSignals: no per-core candidates and no throttle file omits both synthetic entries (never fabricated identity)", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-basic"),
  });
  assertEquals(
    signals.some((s) => s.signalId === CPU_HOTTEST_CORE_SIGNAL_ID),
    false,
  );
  assertEquals(
    signals.some((s) => s.signalId === CPU_THERMAL_THROTTLED_SIGNAL_ID),
    false,
  );
});

// ---------------------------------------------------------------------------
// Entity-joined signals: GPU temperature/memory-temperature/power and
// service-drive temperature, which used to ride `GpuSample`/
// `BlockDeviceSample` fields instead.
// ---------------------------------------------------------------------------

const NVIDIA_GPU: GpuTopology = {
  gpuId: "gpu:pci:0000:01:00.0",
  kind: "drm",
  pciPath: "0000:01:00.0",
  vendor: "nvidia",
  chip: "AD102",
};

function serviceDevice(
  overrides: Partial<BlockDeviceTopology> = {},
): BlockDeviceTopology {
  return {
    deviceId: "blk:nvme0n1",
    kernelName: "nvme0n1",
    deviceType: "physical",
    isServiceDevice: true,
    ...overrides,
  };
}

test("collectHardwareSignals: three signals per topology GPU, gated on GPU topology alone (NVIDIA exposes no hwmon chip to gate on)", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-full"),
    gpus: [NVIDIA_GPU],
  });

  const gpuSignals = signals.filter((s) => s.component === "gpu");
  assertEquals(gpuSignals.map((s) => s.signalId), [
    gpuSignalId(NVIDIA_GPU.gpuId, "temperature"),
    gpuSignalId(NVIDIA_GPU.gpuId, "memory-temperature"),
    gpuSignalId(NVIDIA_GPU.gpuId, "power"),
  ]);
  assertEquals(gpuSignals.map((s) => s.kind), [
    "temperature",
    "temperature",
    "power",
  ]);
  assertEquals(gpuSignals.map((s) => s.unit), ["celsius", "celsius", "watts"]);
  assertEquals(gpuSignals.map((s) => s.label), [
    "AD102 temperature",
    "AD102 memory temperature",
    "AD102 power",
  ]);
});

test("collectHardwareSignals: a service drive with a disk-temperature probe gets one entity-joined temperature signal, alongside the per-probe one", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-full"),
    blockDevices: [serviceDevice()],
  });

  const drive = signals.find((s) => s.component === "drive");
  assertEquals(drive?.signalId, blockTemperatureSignalId("blk:nvme0n1"));
  assertEquals(drive?.kind, "temperature");
  assertEquals(drive?.unit, "celsius");
  assertEquals(drive?.label, "nvme0n1 temperature");
  // The per-probe `component: "disk"` signal stays in the catalog too — the
  // entity-joined one is the whole-drive reading, not a replacement for the
  // individual probes.
  assertEquals(signals.some((s) => s.component === "disk"), true);
});

test("collectHardwareSignals: never fabricates a drive signal — a non-service device, or one with no hwmon probe, gets none", async () => {
  const nonService = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-full"),
    blockDevices: [serviceDevice({ isServiceDevice: false })],
  });
  assertEquals(nonService.some((s) => s.component === "drive"), false);

  const noProbe = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-full"),
    blockDevices: [
      serviceDevice({ deviceId: "blk:sda", kernelName: "sda" }),
    ],
  });
  assertEquals(noProbe.some((s) => s.component === "drive"), false);
});
