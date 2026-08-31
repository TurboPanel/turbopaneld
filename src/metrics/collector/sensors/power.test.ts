import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo, discoverSensors } from "./discovery.ts";
import { cpuPowerFromEnergy, readCpuEnergy, readGpuPower } from "./power.ts";

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`../testdata/${name}`, import.meta.url));
}

it("readCpuEnergy reads the RAPL counter and its wraparound range", async () => {
  const io = defaultSensorIo();
  const caps = await discoverSensors(fixtureRoot("sensors-intel"), io);
  const resolved = await readCpuEnergy(caps.cpuPower, undefined, io);
  assertEquals(resolved.sensor, "intel-rapl:package-0");
  assertEquals(resolved.energy, {
    energyMicrojoules: 1_000_000_000,
    maxEnergyRangeMicrojoules: 262_143_328_850,
  });
});

it("readCpuEnergy returns null energy without any candidate", async () => {
  const resolved = await readCpuEnergy([], undefined, defaultSensorIo());
  assertEquals(resolved, { energy: null });
});

it("readGpuPower converts hwmon microwatts to watts", async () => {
  const io = defaultSensorIo();
  const caps = await discoverSensors(fixtureRoot("sensors-amd"), io);
  const resolved = await readGpuPower(caps.gpuPower, undefined, io);
  assertEquals(resolved.sensor, "amdgpu:PPT");
  assertEquals(resolved.watts, 37);
});

it("readGpuPower returns null without a candidate (NVIDIA stays unsupported)", async () => {
  const resolved = await readGpuPower([], undefined, defaultSensorIo());
  assertEquals(resolved, { watts: null });
});

it("cpuPowerFromEnergy averages the energy delta over the interval", () => {
  const prev = {
    energyMicrojoules: 1_000_000,
    maxEnergyRangeMicrojoules: null,
  };
  const curr = {
    energyMicrojoules: 601_000_000,
    maxEnergyRangeMicrojoules: null,
  };
  // 600 J over 60 s = 10 W.
  assertEquals(cpuPowerFromEnergy(prev, curr, 60), 10);
});

it("cpuPowerFromEnergy nulls on first sample or non-positive interval", () => {
  const counter = {
    energyMicrojoules: 1_000_000,
    maxEnergyRangeMicrojoules: null,
  };
  assertEquals(cpuPowerFromEnergy(null, counter, 60), null);
  assertEquals(cpuPowerFromEnergy(counter, null, 60), null);
  assertEquals(cpuPowerFromEnergy(counter, counter, 0), null);
});

it("cpuPowerFromEnergy handles counter wraparound via the known range", () => {
  const prev = {
    energyMicrojoules: 900,
    maxEnergyRangeMicrojoules: 1_000,
  };
  const curr = {
    energyMicrojoules: 500,
    maxEnergyRangeMicrojoules: 1_000,
  };
  // 500 + 1000 - 900 = 600 µJ over 60 s.
  assertEquals(cpuPowerFromEnergy(prev, curr, 60), 600 / 60 / 1e6);

  const unknownRange = {
    energyMicrojoules: 500,
    maxEnergyRangeMicrojoules: null,
  };
  assertEquals(
    cpuPowerFromEnergy(
      { energyMicrojoules: 900, maxEnergyRangeMicrojoules: null },
      unknownRange,
      60,
    ),
    null,
  );
});
