import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import {
  defaultSensorIo,
  discoverSensors,
  selectCandidate,
  selectGpuDevice,
  sensorId,
} from "./discovery.ts";

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`../testdata/${name}`, import.meta.url));
}

it("discoverSensors enumerates Intel bare-metal candidates with stable identities", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-intel"));

  // Package sensor sorts before per-core; the thermal zone is a further
  // fallback candidate. Identities are chip:label, never a hwmonN index.
  assertEquals(caps.cpuTemperature.map(sensorId), [
    "coretemp:Package id 0",
    "coretemp:Core 0",
    "thermal:x86_pkg_temp",
  ]);
  assertEquals(
    caps.cpuTemperature[0].path.endsWith(
      "/class/hwmon/hwmon0/temp1_input",
    ),
    true,
  );
  assertEquals(caps.cpuPower.map(sensorId), ["intel-rapl:package-0"]);
  // RAPL subdomains (intel-rapl:0:0 core/uncore) never double-count.
  assertEquals(caps.cpuPower.length, 1);
  assertEquals(caps.gpuTemperature, []);
  assertEquals(caps.gpuPower, []);
});

it("discoverSensors enumerates AMD chips including the GPU hwmon", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-amd"));
  assertEquals(caps.cpuTemperature.map(sensorId), ["k10temp:Tctl"]);
  assertEquals(caps.gpuTemperature.map(sensorId), [
    "amdgpu:edge",
    "amdgpu:junction",
  ]);
  assertEquals(caps.gpuPower.map(sensorId), ["amdgpu:PPT"]);
  assertEquals(caps.cpuPower, []);

  // GPU candidates also group per device so selection cannot mix cards.
  assertEquals(caps.gpuDevices.length, 1);
  assertEquals(caps.gpuDevices[0].chip, "amdgpu");
  assertEquals(caps.gpuDevices[0].temperature.map(sensorId), [
    "amdgpu:edge",
    "amdgpu:junction",
  ]);
  assertEquals(caps.gpuDevices[0].power.map(sensorId), ["amdgpu:PPT"]);
});

it("discoverSensors groups multi-GPU candidates by hwmon device", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-multi-gpu"));
  assertEquals(caps.gpuDevices.length, 2);
  const [first, second] = caps.gpuDevices;
  assertEquals(first.path.endsWith("/class/hwmon/hwmon1"), true);
  assertEquals(first.temperature.map((c) => c.path), [
    `${first.path}/temp1_input`,
  ]);
  assertEquals(first.power, []);
  assertEquals(second.path.endsWith("/class/hwmon/hwmon2"), true);
  assertEquals(second.power.map((c) => c.path), [
    `${second.path}/power1_average`,
  ]);
  // Flat arrays stay the per-device concatenation.
  assertEquals(caps.gpuTemperature.length, 2);
  assertEquals(caps.gpuPower.length, 1);
});

it("discoverSensors yields nothing on a sensorless VM", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-none"));
  assertEquals(caps, {
    cpuTemperature: [],
    gpuTemperature: [],
    cpuPower: [],
    gpuPower: [],
    gpuDevices: [],
  });
});

it("selectGpuDevice picks one device for both measurements", () => {
  const cardA = {
    path: "/sys/class/hwmon/hwmon1",
    chip: "amdgpu",
    temperature: [{
      chip: "amdgpu",
      label: "edge",
      path: "/sys/class/hwmon/hwmon1/temp1_input",
    }],
    power: [],
  };
  const cardB = {
    path: "/sys/class/hwmon/hwmon2",
    chip: "amdgpu",
    temperature: [{
      chip: "amdgpu",
      label: "edge",
      path: "/sys/class/hwmon/hwmon2/temp1_input",
    }],
    power: [{
      chip: "amdgpu",
      label: "PPT",
      path: "/sys/class/hwmon/hwmon2/power1_average",
    }],
  };
  // Auto: prefer the device exposing both temperature and power.
  assertEquals(selectGpuDevice([cardA, cardB], {}), cardB);
  // No device has both: first enumerated wins.
  assertEquals(selectGpuDevice([cardA], {}), cardA);
  // An override path drags the whole device with it.
  assertEquals(
    selectGpuDevice([cardA, cardB], {
      gpuTemperature: "/sys/class/hwmon/hwmon1/temp1_input",
    }),
    cardA,
  );
  assertEquals(
    selectGpuDevice([cardA, cardB], {
      gpuPower: "/sys/class/hwmon/hwmon2/power1_average",
    }),
    cardB,
  );
  // Unmatched overrides fall back to auto-selection.
  assertEquals(
    selectGpuDevice([cardA, cardB], { gpuTemperature: "/custom" }),
    cardB,
  );
  assertEquals(selectGpuDevice([], {}), undefined);
});

it("selectCandidate prefers the admin override over auto-detection", () => {
  const first = { chip: "coretemp", label: "Package id 0", path: "/a" };
  const second = { chip: "coretemp", label: "Core 0", path: "/b" };
  assertEquals(selectCandidate([first, second], undefined), first);
  assertEquals(selectCandidate([first, second], "/b"), second);
  // An override outside the discovered set is honored verbatim.
  assertEquals(selectCandidate([first], "/custom"), {
    chip: "override",
    label: "/custom",
    path: "/custom",
  });
  assertEquals(selectCandidate([], undefined), undefined);
});

it("defaultSensorIo returns empty listings for missing directories", async () => {
  const io = defaultSensorIo();
  assertEquals(
    await io.listDir("/no/such/turbopanel-sensors-dir"),
    [],
  );
});
