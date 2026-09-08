import { assertEquals } from "@std/assert";
import {
  blockTemperatureSignalId,
  CPU_HOTTEST_CORE_SIGNAL_ID,
  CPU_THERMAL_THROTTLED_SIGNAL_ID,
  gpuSignalId,
} from "../topology/hardware-signal-topology.ts";
import { CounterBaselineTracker } from "./baseline.ts";
import { buildHardwareSignalSamples } from "./hardware-signals.ts";
import type { SensorIo } from "./sensors/discovery.ts";
import type {
  BlockDeviceTopology,
  PhysicalSignalTopology,
} from "../topology/types.ts";

const test = Deno.test.bind(Deno);

/** In-memory `SensorIo`, mirroring `sensors/discovery.test.ts`'s `memoryIo` convention. */
function memoryIo(
  files: Record<string, string | undefined>,
  dirs: Record<string, string[]>,
): SensorIo {
  return {
    listDir: (path: string) => dirs[path] ?? [],
    readFile: (path: string) => files[path],
  };
}

const DIRS: Record<string, string[]> = {
  "/sys/class/hwmon": ["hwmon0", "hwmon1"],
  "/sys/class/hwmon/hwmon0": [
    "name",
    "temp1_input",
    "temp1_label",
    "temp2_input",
    "temp2_label",
    "temp3_input",
    "temp3_label",
  ],
  "/sys/class/hwmon/hwmon1": ["name", "fan1_input"],
  "/sys/class/drm": [],
  "/sys/class/thermal": [],
  "/sys/class/powercap": ["intel-rapl:0"],
  "/sys/class/powercap/intel-rapl:0": [
    "name",
    "energy_uj",
    "max_energy_range_uj",
  ],
  "/sys/block": [],
};

const TEMP_SIGNAL: PhysicalSignalTopology = {
  signalId: "signal:coretemp:Package id 0",
  kind: "temperature",
  unit: "celsius",
  component: "cpu",
  label: "Package id 0",
};
const FAN_SIGNAL: PhysicalSignalTopology = {
  signalId: "signal:nct6775:fan1",
  kind: "fan",
  unit: "rpm",
  component: "system",
  label: "fan1",
};
const POWER_SIGNAL: PhysicalSignalTopology = {
  signalId: "signal:intel-rapl:package-0",
  kind: "power",
  unit: "watts",
  component: "cpu",
  label: "package-0",
};
const VANISHED_SIGNAL: PhysicalSignalTopology = {
  signalId: "signal:coretemp:Core 9",
  kind: "temperature",
  unit: "celsius",
  component: "cpu",
  label: "Core 9",
};
const HOTTEST_CORE_SIGNAL: PhysicalSignalTopology = {
  signalId: CPU_HOTTEST_CORE_SIGNAL_ID,
  kind: "temperature",
  unit: "celsius",
  component: "cpu",
  label: "Hottest core",
};
const THERMAL_THROTTLED_SIGNAL: PhysicalSignalTopology = {
  signalId: CPU_THERMAL_THROTTLED_SIGNAL_ID,
  kind: "percent",
  unit: "percent",
  component: "cpu",
  label: "CPU thermal throttled",
};

function baseFiles(energyMicrojoules: string): Record<string, string> {
  return {
    "/sys/class/hwmon/hwmon0/name": "coretemp",
    "/sys/class/hwmon/hwmon0/temp1_input": "45000",
    "/sys/class/hwmon/hwmon0/temp1_label": "Package id 0",
    "/sys/class/hwmon/hwmon0/temp2_input": "50000",
    "/sys/class/hwmon/hwmon0/temp2_label": "Core 0",
    "/sys/class/hwmon/hwmon0/temp3_input": "62000",
    "/sys/class/hwmon/hwmon0/temp3_label": "Core 1",
    "/sys/class/hwmon/hwmon1/name": "nct6775",
    "/sys/class/hwmon/hwmon1/fan1_input": "1200",
    "/sys/class/powercap/intel-rapl:0/name": "package-0",
    "/sys/class/powercap/intel-rapl:0/energy_uj": energyMicrojoules,
  };
}

test("buildHardwareSignalSamples resolves a temperature reading for a topology-identified signal", async () => {
  const io = memoryIo(baseFiles("1000000"), DIRS);
  const tracker = new CounterBaselineTracker();
  const { samples } = await buildHardwareSignalSamples(
    [TEMP_SIGNAL],
    { io, tracker, bootGeneration: 1, seconds: 60 },
  );

  assertEquals(samples.find((s) => s.signalId === TEMP_SIGNAL.signalId), {
    signalId: TEMP_SIGNAL.signalId,
    kind: "temperature",
    value: 45,
  });
});

test("buildHardwareSignalSamples: a fan-kind topology signal (legacy/stale topology) never reads a live RPM — fan telemetry is not sampled any more", async () => {
  const io = memoryIo(baseFiles("1000000"), DIRS);
  const tracker = new CounterBaselineTracker();
  const { samples } = await buildHardwareSignalSamples(
    [FAN_SIGNAL],
    { io, tracker, bootGeneration: 1, seconds: 60 },
  );

  assertEquals(samples, [{
    signalId: FAN_SIGNAL.signalId,
    kind: "fan",
    value: null,
  }]);
});

test("buildHardwareSignalSamples: CPU RAPL power is null on the first tick, then a real delta on the second", async () => {
  const tracker = new CounterBaselineTracker();

  const first = await buildHardwareSignalSamples([POWER_SIGNAL], {
    io: memoryIo(baseFiles("1000000"), DIRS),
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });
  assertEquals(first.samples[0].value, null);

  // +6,000,000 microjoules over 60s = 0.1 W.
  const second = await buildHardwareSignalSamples([POWER_SIGNAL], {
    io: memoryIo(baseFiles("7000000"), DIRS),
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });
  assertEquals(second.samples[0].value, 0.1);
});

test("buildHardwareSignalSamples: a topology-identified signal absent from this tick's discovery stays present with value null", async () => {
  const io = memoryIo(baseFiles("1000000"), DIRS);
  const tracker = new CounterBaselineTracker();
  const { samples } = await buildHardwareSignalSamples(
    [TEMP_SIGNAL, VANISHED_SIGNAL],
    { io, tracker, bootGeneration: 1, seconds: 60 },
  );

  assertEquals(samples.length, 2);
  assertEquals(
    samples.find((s) => s.signalId === VANISHED_SIGNAL.signalId)?.value,
    null,
  );
});

test("buildHardwareSignalSamples: no topology signals (VM) short-circuits without discovering sensors", async () => {
  let discovered = false;
  const io: SensorIo = {
    listDir: (path) => {
      discovered = true;
      return DIRS[path] ?? [];
    },
    readFile: (path) => baseFiles("1000000")[path],
  };
  const tracker = new CounterBaselineTracker();
  const result = await buildHardwareSignalSamples([], {
    io,
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });
  assertEquals(result.samples, []);
  assertEquals(result.candidates.size, 0);
  assertEquals(discovered, false);
});

test("buildHardwareSignalSamples: hottest-core resolves the max live reading across this tick's per-core candidates", async () => {
  const io = memoryIo(baseFiles("1000000"), DIRS);
  const tracker = new CounterBaselineTracker();
  const { samples } = await buildHardwareSignalSamples(
    [HOTTEST_CORE_SIGNAL],
    { io, tracker, bootGeneration: 1, seconds: 60 },
  );
  assertEquals(samples, [{
    signalId: CPU_HOTTEST_CORE_SIGNAL_ID,
    kind: "temperature",
    value: 62, // Core 1 (62°C) beats Core 0 (50°C).
  }]);
});

test("buildHardwareSignalSamples: hottest-core is null when no per-core candidate exists this tick", async () => {
  const noCoreDirs: Record<string, string[]> = {
    ...DIRS,
    "/sys/class/hwmon/hwmon0": ["name", "temp1_input", "temp1_label"],
  };
  const io = memoryIo(
    {
      "/sys/class/hwmon/hwmon0/name": "coretemp",
      "/sys/class/hwmon/hwmon0/temp1_input": "45000",
      "/sys/class/hwmon/hwmon0/temp1_label": "Package id 0",
    },
    noCoreDirs,
  );
  const tracker = new CounterBaselineTracker();
  const { samples } = await buildHardwareSignalSamples(
    [HOTTEST_CORE_SIGNAL],
    { io, tracker, bootGeneration: 1, seconds: 60 },
  );
  assertEquals(samples, [{
    signalId: CPU_HOTTEST_CORE_SIGNAL_ID,
    kind: "temperature",
    value: null,
  }]);
});

const THROTTLE_PATH =
  "/sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_total_time_ms";

test("buildHardwareSignalSamples: CPU thermal-throttled percent is null on the first tick, then a real rate on the second", async () => {
  const tracker = new CounterBaselineTracker();

  const first = await buildHardwareSignalSamples([THERMAL_THROTTLED_SIGNAL], {
    io: memoryIo({ [THROTTLE_PATH]: "0" }, DIRS),
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });
  assertEquals(first.samples[0].value, null);

  // +30,000 ms throttled over 60s of wall time = 50%.
  const second = await buildHardwareSignalSamples([THERMAL_THROTTLED_SIGNAL], {
    io: memoryIo({ [THROTTLE_PATH]: "30000" }, DIRS),
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });
  assertEquals(second.samples[0].value, 50);
});

test("buildHardwareSignalSamples: CPU thermal-throttled percent clamps at 100 and is null when the throttle file is unreadable", async () => {
  const tracker = new CounterBaselineTracker();
  await buildHardwareSignalSamples([THERMAL_THROTTLED_SIGNAL], {
    io: memoryIo({ [THROTTLE_PATH]: "0" }, DIRS),
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });
  // +120,000 ms over 60s would be 200% — clamped to 100.
  const clamped = await buildHardwareSignalSamples([THERMAL_THROTTLED_SIGNAL], {
    io: memoryIo({ [THROTTLE_PATH]: "120000" }, DIRS),
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });
  assertEquals(clamped.samples[0].value, 100);

  const unreadable = await buildHardwareSignalSamples(
    [THERMAL_THROTTLED_SIGNAL],
    {
      io: memoryIo({}, DIRS),
      tracker,
      bootGeneration: 1,
      seconds: 60,
    },
  );
  assertEquals(unreadable.samples[0].value, null);
});

// ---------------------------------------------------------------------------
// Entity-joined signals: GPU thermals come from the adapter merge threaded
// in, drive temperature from this tick's own per-probe disk readings.
// ---------------------------------------------------------------------------

const GPU_ID = "gpu:pci:0000:01:00.0";

function gpuSignal(
  kind: "temperature" | "memory-temperature" | "power",
): PhysicalSignalTopology {
  return {
    signalId: gpuSignalId(GPU_ID, kind),
    kind: kind === "power" ? "power" : "temperature",
    unit: kind === "power" ? "watts" : "celsius",
    component: "gpu",
    label: `AD102 ${kind}`,
  };
}

const NVME_PROBE_SIGNAL: PhysicalSignalTopology = {
  signalId: "signal:nvme0n1:Composite",
  kind: "temperature",
  unit: "celsius",
  component: "disk",
  label: "Composite",
};
const NVME_HOT_PROBE_SIGNAL: PhysicalSignalTopology = {
  signalId: "signal:nvme0n1:Sensor 2",
  kind: "temperature",
  unit: "celsius",
  component: "disk",
  label: "Sensor 2",
};
const DRIVE_SIGNAL: PhysicalSignalTopology = {
  signalId: blockTemperatureSignalId("blk:nvme0n1"),
  kind: "temperature",
  unit: "celsius",
  component: "drive",
  label: "nvme0n1 temperature",
};

const NVME_DIRS: Record<string, string[]> = {
  ...DIRS,
  "/sys/class/hwmon": ["hwmon0", "hwmon1", "hwmon3"],
  "/sys/class/hwmon/hwmon3": [
    "name",
    "device",
    "temp1_input",
    "temp1_label",
    "temp2_input",
    "temp2_label",
  ],
  "/sys/class/hwmon/hwmon3/device": ["nvme0n1"],
};

function nvmeFiles(): Record<string, string> {
  return {
    ...baseFiles("0"),
    "/sys/class/hwmon/hwmon3/name": "nvme",
    "/sys/class/hwmon/hwmon3/temp1_input": "44000",
    "/sys/class/hwmon/hwmon3/temp1_label": "Composite",
    "/sys/class/hwmon/hwmon3/temp2_input": "61000",
    "/sys/class/hwmon/hwmon3/temp2_label": "Sensor 2",
  };
}

const NVME_DEVICE: BlockDeviceTopology = {
  deviceId: "blk:nvme0n1",
  kernelName: "nvme0n1",
  deviceType: "physical",
  isServiceDevice: true,
};

test("buildHardwareSignalSamples: GPU signals resolve from the threaded-in adapter merge, never from a sysfs walk", async () => {
  const result = await buildHardwareSignalSamples(
    [
      gpuSignal("temperature"),
      gpuSignal("memory-temperature"),
      gpuSignal("power"),
    ],
    {
      io: memoryIo(baseFiles("0"), DIRS),
      tracker: new CounterBaselineTracker(),
      bootGeneration: 1,
      seconds: 60,
      gpuThermals: new Map([[GPU_ID, {
        temperatureCelsius: 71,
        memoryTemperatureCelsius: 84,
        powerWatts: 310,
      }]]),
    },
  );
  assertEquals(result.samples.map((s) => s.value), [71, 84, 310]);
});

test("buildHardwareSignalSamples: a GPU topology identified but with no adapter reading resolves to null, never to the hwmon candidate fallback", async () => {
  const result = await buildHardwareSignalSamples([gpuSignal("temperature")], {
    io: memoryIo(baseFiles("0"), DIRS),
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
  });
  assertEquals(result.samples, [{
    signalId: gpuSignalId(GPU_ID, "temperature"),
    kind: "temperature",
    value: null,
  }]);
});

test("buildHardwareSignalSamples: drive temperature joins this tick's own disk probes onto the owning device, Composite winning over a hotter internal probe", async () => {
  const result = await buildHardwareSignalSamples(
    [NVME_HOT_PROBE_SIGNAL, NVME_PROBE_SIGNAL, DRIVE_SIGNAL],
    {
      io: memoryIo(nvmeFiles(), NVME_DIRS),
      tracker: new CounterBaselineTracker(),
      bootGeneration: 1,
      seconds: 60,
      blockDevices: [NVME_DEVICE],
    },
  );
  // The per-probe signals keep their own raw readings...
  assertEquals(result.samples[0].value, 61);
  assertEquals(result.samples[1].value, 44);
  // ...and the entity-joined one is the vendor Composite, not the max.
  assertEquals(result.samples[2].value, 44);
});

test("buildHardwareSignalSamples: a drive whose probes all read nothing this tick resolves to null rather than dropping out", async () => {
  const result = await buildHardwareSignalSamples(
    [NVME_PROBE_SIGNAL, DRIVE_SIGNAL],
    {
      io: memoryIo(baseFiles("0"), DIRS),
      tracker: new CounterBaselineTracker(),
      bootGeneration: 1,
      seconds: 60,
      blockDevices: [NVME_DEVICE],
    },
  );
  assertEquals(result.samples.map((s) => s.value), [null, null]);
});

test("buildHardwareSignalSamples: a non-disk signal never leaks into the drive join, even when its id parses into a matching kernel name", async () => {
  // `signal:cpu:hottest-core` splits to kernelName "cpu"; a device literally
  // named `cpu` must still get its own probes' reading, not the CPU's.
  const result = await buildHardwareSignalSamples(
    [HOTTEST_CORE_SIGNAL, {
      ...DRIVE_SIGNAL,
      signalId: blockTemperatureSignalId("blk:cpu"),
    }],
    {
      io: memoryIo(baseFiles("0"), DIRS),
      tracker: new CounterBaselineTracker(),
      bootGeneration: 1,
      seconds: 60,
      blockDevices: [{
        ...NVME_DEVICE,
        deviceId: "blk:cpu",
        kernelName: "cpu",
      }],
    },
  );
  // Hottest core reads the real 62C max across Core 0/Core 1...
  assertEquals(result.samples[0].value, 62);
  // ...and the drive, which has no probe of its own, stays null.
  assertEquals(result.samples[1].value, null);
});
