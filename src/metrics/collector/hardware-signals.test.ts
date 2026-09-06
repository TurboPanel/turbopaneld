import { assertEquals } from "@std/assert";
import {
  CPU_HOTTEST_CORE_SIGNAL_ID,
  CPU_THERMAL_THROTTLED_SIGNAL_ID,
} from "../topology/hardware-signal-topology.ts";
import { CounterBaselineTracker } from "./baseline.ts";
import { buildHardwareSignalSamples } from "./hardware-signals.ts";
import type { SensorIo } from "./sensors/discovery.ts";
import type { PhysicalSignalTopology } from "../topology/types.ts";

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
