import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { readHostSensors } from "./index.ts";

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`../testdata/${name}`, import.meta.url));
}

it("readHostSensors on a VM yields all nulls and no sensor identities", async () => {
  const readings = await readHostSensors({}, {
    root: fixtureRoot("sensors-none"),
  });
  assertEquals(readings, {
    cpuTemperatureCelsius: null,
    gpuTemperatureCelsius: null,
    gpuPowerWatts: null,
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
