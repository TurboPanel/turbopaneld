import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { readHostSensors } from "./index.ts";
import {
  resolveAdminSensorOverrides,
  writeHardwareProfile,
} from "./overrides.ts";

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`../testdata/${name}`, import.meta.url));
}

/** Writes a hardware profile to a fresh temp state dir and resolves it the
 * real way (`resolveAdminSensorOverrides`), so these tests exercise the
 * actual control-plane-to-collector projection instead of a hand-built
 * `SensorOverrides` object. */
async function profileOverrides(
  profile: Parameters<typeof writeHardwareProfile>[0],
): Promise<ReturnType<typeof resolveAdminSensorOverrides>> {
  const stateDir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile(profile, stateDir);
    return await resolveAdminSensorOverrides(stateDir);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

it("readHostSensors on a VM yields all nulls and no sensor identities", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-none"),
  });
  assertEquals(readings, {
    cpuTemperatureCelsius: null,
    gpuTemperatureCelsius: null,
    gpuPowerWatts: null,
    gpuUtilizationPercent: null,
    gpuFanRpm: null,
    disk1TemperatureCelsius: null,
    disk2TemperatureCelsius: null,
    ambient1TemperatureCelsius: null,
    ambient2TemperatureCelsius: null,
    boardTemperatureCelsius: null,
    cpuFanRpm: null,
    systemFan1Rpm: null,
    systemFan2Rpm: null,
    cpuEnergy: null,
    sensors: {},
  });
});

it("readHostSensors on Intel bare metal resolves package temp and RAPL energy", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-intel"),
  });
  assertEquals(readings.cpuTemperatureCelsius, 45);
  assertEquals(readings.gpuTemperatureCelsius, null);
  assertEquals(readings.gpuPowerWatts, null);
  assertEquals(readings.cpuEnergy?.energyMicrojoules, 1_000_000_000);
  assertEquals(readings.sensors, {
    cpuTemperatureSensor: "coretemp:Package id 0",
    cpuPowerSensor: "intel-rapl:package-0",
  });
});

it("readHostSensors on AMD bare metal resolves k10temp plus the GPU hwmon", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-amd"),
  });
  assertEquals(readings.cpuTemperatureCelsius, 52.25);
  assertEquals(readings.gpuTemperatureCelsius, 61);
  assertEquals(readings.gpuPowerWatts, 37);
  assertEquals(readings.cpuEnergy, null);
  assertEquals(readings.sensors, {
    cpuTemperatureSensor: "k10temp:Tctl",
    gpuTemperatureSensor: "amdgpu:edge",
    gpuPowerSensor: "amdgpu:PPT",
  });
});

it("readHostSensors resolves temperature and power from one GPU on multi-GPU hosts", async () => {
  // hwmon1 (first GPU) exposes temperature only; hwmon2 exposes both.
  // Device-first selection picks hwmon2 for BOTH fields — independent
  // per-measurement resolution would have mixed hwmon1's temperature (61°C)
  // with hwmon2's power.
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-multi-gpu"),
  });
  assertEquals(readings.cpuTemperatureCelsius, 52.25);
  assertEquals(readings.gpuTemperatureCelsius, 71);
  assertEquals(readings.gpuPowerWatts, 111);
  assertEquals(readings.sensors, {
    cpuTemperatureSensor: "k10temp:Tctl",
    gpuTemperatureSensor: "amdgpu:edge",
    gpuPowerSensor: "amdgpu:PPT",
  });
});

it("readHostSensors keeps a GPU override and its power on the same device", async () => {
  // Overriding GPU temperature onto hwmon1 selects that device; hwmon1 has
  // no power gauge, so GPU power is null rather than another card's value.
  const root = fixtureRoot("sensors-multi-gpu");
  const readings = await readHostSensors({
    gpuTemperature: `${root}/class/hwmon/hwmon1/temp1_input`,
  }, { root });
  assertEquals(readings.gpuTemperatureCelsius, 61);
  assertEquals(readings.gpuPowerWatts, null);
  assertEquals(readings.sensors.gpuTemperatureSensor, "amdgpu:edge");
  assertEquals(readings.sensors.gpuPowerSensor, undefined);
});

it("readHostSensors lets an admin override beat auto-detection", async () => {
  const root = fixtureRoot("sensors-amd");
  const readings = await readHostSensors({
    gpuTemperature: `${root}/class/hwmon/hwmon1/temp2_input`,
  }, { root });
  assertEquals(readings.gpuTemperatureCelsius, 65);
  assertEquals(readings.sensors.gpuTemperatureSensor, "amdgpu:junction");
});

it("readHostSensors leaves disk1/disk2 unset with no auto-default, even with nvme candidates available", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-nvme-disk"),
  });
  assertEquals(readings.disk1TemperatureCelsius, null);
  assertEquals(readings.sensors.disk1TemperatureSensor, undefined);
  assertEquals(readings.disk2TemperatureCelsius, null);
  assertEquals(readings.sensors.disk2TemperatureSensor, undefined);
});

it("a hardware-profile disk1/disk2 assignment resolves normally despite having no positional default", async () => {
  const root = fixtureRoot("sensors-nvme-disk");
  const overrides = await profileOverrides({
    disk1Temperature: { chip: "nvme0n1", label: "Composite" },
    disk2Temperature: { chip: "nvme0n1", label: "Sensor 1" },
  });
  const readings = await readHostSensors(overrides, { root });
  assertEquals(readings.disk1TemperatureCelsius, 36.85);
  assertEquals(readings.sensors.disk1TemperatureSensor, "nvme0n1:Composite");
  // Same drive's second sensor — one nvme device can still fill both slots.
  assertEquals(readings.disk2TemperatureCelsius, 36.85);
  assertEquals(readings.sensors.disk2TemperatureSensor, "nvme0n1:Sensor 1");
});

it("readHostSensors leaves disk1 unset with no auto-default, even with a drivetemp candidate available", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-drivetemp"),
  });
  assertEquals(readings.disk1TemperatureCelsius, null);
  assertEquals(readings.sensors.disk1TemperatureSensor, undefined);
});

it("a hardware-profile disk1 assignment resolves from the drivetemp candidate pool", async () => {
  const root = fixtureRoot("sensors-drivetemp");
  const overrides = await profileOverrides({
    disk1Temperature: { chip: "sda", label: "temp1" },
  });
  const readings = await readHostSensors(overrides, { root });
  assertEquals(readings.disk1TemperatureCelsius, 35);
  assertEquals(readings.sensors.disk1TemperatureSensor, "sda:temp1");
});

it("readHostSensors resolves fans and ambient temps, leaving board unassigned", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-fans-ambient"),
  });
  assertEquals(readings.cpuFanRpm, 1200);
  assertEquals(readings.systemFan1Rpm, 800);
  assertEquals(readings.systemFan2Rpm, 750);
  assertEquals(readings.ambient1TemperatureCelsius, 32);
  assertEquals(readings.ambient2TemperatureCelsius, 45);
  // Board has no positional auto-default — stays null without an override.
  assertEquals(readings.boardTemperatureCelsius, null);
  assertEquals(readings.sensors.cpuFanSensor, "coretemp:cpu_fan");
  assertEquals(readings.sensors.systemFan1Sensor, "nct6775:sys_fan1");
  assertEquals(readings.sensors.systemFan2Sensor, "nct6775:sys_fan2");
  assertEquals(readings.sensors.boardTemperatureSensor, undefined);
});

it("readHostSensors resolves board temperature only when overridden", async () => {
  const root = fixtureRoot("sensors-fans-ambient");
  const readings = await readHostSensors({
    boardTemperature: `${root}/class/hwmon/hwmon1/temp1_input`,
  }, { root });
  assertEquals(readings.boardTemperatureCelsius, 32);
  assertEquals(readings.sensors.boardTemperatureSensor, "nct6775:SYSTIN");
});

it("readHostSensors resolves GPU utilization from the amdgpu busy-percent gauge", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-gpu-utilization"),
  });
  assertEquals(readings.gpuUtilizationPercent, 42);
  assertEquals(
    readings.sensors.gpuUtilizationSensor,
    "amdgpu:gpu_busy_percent",
  );
});

it("readHostSensors resolves GPU utilization from the i915 busy-percent gauge", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-gpu-utilization-intel"),
  });
  assertEquals(readings.gpuUtilizationPercent, 17);
  assertEquals(
    readings.sensors.gpuUtilizationSensor,
    "i915:gt_busy_percent",
  );
});

// Regression coverage for a hardware-profile assignment resolving to `null`
// across the board: resolveAdminSensorOverrides() projects a `gpuDevice`
// slot to the SAME chip:label identity on all four GPU override keys, and
// selectCandidate previously only matched candidate.path — so gpuPower/
// gpuUtilization/gpuFan silently went null even though the device itself
// was correctly selected.

it("a hardware-profile GPU assignment resolves temperature, power, and utilization from the real overrides projection", async () => {
  const root = fixtureRoot("sensors-gpu-utilization");
  const overrides = await profileOverrides({
    gpuDevice: { chip: "amdgpu", label: "edge" },
  });
  const readings = await readHostSensors(overrides, { root });
  assertEquals(readings.gpuTemperatureCelsius, 61);
  assertEquals(readings.gpuPowerWatts, 37);
  assertEquals(readings.gpuUtilizationPercent, 42);
  // No fan candidate on this device — stays null, not fabricated.
  assertEquals(readings.gpuFanRpm, null);
  assertEquals(readings.sensors.gpuTemperatureSensor, "amdgpu:edge");
  assertEquals(readings.sensors.gpuPowerSensor, "amdgpu:PPT");
  assertEquals(
    readings.sensors.gpuUtilizationSensor,
    "amdgpu:gpu_busy_percent",
  );
});

it("a hardware-profile CPU temperature assignment picks the assigned candidate, not just the auto-detected default", async () => {
  const root = fixtureRoot("sensors-intel");
  // "Core 0" is discovered second (Package id 0 sorts first by default
  // preference) — picking it proves the identity actually disambiguates
  // rather than coincidentally landing on the auto-detected candidate.
  const overrides = await profileOverrides({
    cpuTemperature: { chip: "coretemp", label: "Core 0" },
  });
  const readings = await readHostSensors(overrides, { root });
  assertEquals(readings.sensors.cpuTemperatureSensor, "coretemp:Core 0");
  assertEquals(readings.cpuTemperatureCelsius, 43);
});

it("a hardware-profile board temperature assignment resolves via identity from the ambient pool", async () => {
  const root = fixtureRoot("sensors-fans-ambient");
  // AUXTIN is ambient2's candidate, not the (unassignable) positional
  // default — proves board temperature resolves by identity, not position.
  const overrides = await profileOverrides({
    boardTemperature: { chip: "nct6775", label: "AUXTIN" },
  });
  const readings = await readHostSensors(overrides, { root });
  assertEquals(readings.boardTemperatureCelsius, 45);
  assertEquals(readings.sensors.boardTemperatureSensor, "nct6775:AUXTIN");
});

it("a stale hardware-profile assignment degrades to no reading instead of crashing", async () => {
  const root = fixtureRoot("sensors-intel");
  const overrides = await profileOverrides({
    cpuTemperature: { chip: "coretemp", label: "Sensor Removed On Reboot" },
  });
  const readings = await readHostSensors(overrides, { root });
  assertEquals(readings.cpuTemperatureCelsius, null);
  assertEquals(readings.sensors.cpuTemperatureSensor, undefined);
});
