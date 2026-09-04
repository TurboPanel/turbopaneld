import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import {
  defaultSensorIo,
  discoverSensors,
  selectCandidate,
  selectGpuDevice,
  sensorId,
  withinDeviceOverride,
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
  assertEquals(caps.diskTemperature, []);
  assertEquals(caps.fan, []);
  assertEquals(caps.ambientTemperature, []);
  assertEquals(caps.reasons, { diskTemperature: "no_disk_temperature_source" });
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
  assertEquals(caps.gpuDevices[0].utilization, []);
  assertEquals(caps.gpuDevices[0].fan, []);
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
    diskTemperature: [],
    fan: [],
    ambientTemperature: [],
    reasons: { diskTemperature: "no_hwmon" },
  });
});

it("discoverSensors correlates nvme hwmon temps to a block device name", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-nvme-disk"));
  assertEquals(caps.diskTemperature.map(sensorId), [
    "nvme0n1:Composite",
    "nvme0n1:Sensor 1",
  ]);
  assertEquals(caps.reasons, undefined);
});

it("discoverSensors reports drivetemp SATA/SAS temps under their block device name", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-drivetemp"));
  assertEquals(caps.diskTemperature.map(sensorId), ["sda:temp1"]);
  assertEquals(caps.reasons, undefined);
});

it("discoverSensors reports drivetemp_not_loaded when SATA disks exist but drivetemp isn't loaded", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-fans-ambient"));
  assertEquals(caps.diskTemperature, []);
  assertEquals(caps.reasons, { diskTemperature: "drivetemp_not_loaded" });
});

it("discoverSensors enumerates fan tachometers and sweeps unclaimed temps into ambient", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-fans-ambient"));
  assertEquals(caps.fan.map(sensorId), [
    "coretemp:cpu_fan",
    "nct6775:sys_fan1",
    "nct6775:sys_fan2",
  ]);
  assertEquals(caps.ambientTemperature.map(sensorId), [
    "nct6775:SYSTIN",
    "nct6775:AUXTIN",
  ]);
});

it("discoverSensors reads the amdgpu busy-percent gauge into the device's utilization candidates", async () => {
  const caps = await discoverSensors(fixtureRoot("sensors-gpu-utilization"));
  assertEquals(caps.gpuDevices.length, 1);
  assertEquals(caps.gpuDevices[0].utilization.map(sensorId), [
    "amdgpu:gpu_busy_percent",
  ]);
});

it("discoverSensors classifies an i915 chip as a GPU device and reads its busy-percent gauge", async () => {
  const caps = await discoverSensors(
    fixtureRoot("sensors-gpu-utilization-intel"),
  );
  assertEquals(caps.gpuDevices.length, 1);
  assertEquals(caps.gpuDevices[0].chip, "i915");
  assertEquals(caps.gpuDevices[0].utilization.map(sensorId), [
    "i915:gt_busy_percent",
  ]);
  // i915 registers no coretemp/k10temp-style temp candidate in this
  // fixture, so nothing leaks into cpuTemperature/ambientTemperature.
  assertEquals(caps.cpuTemperature, []);
  assertEquals(caps.ambientTemperature, []);
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
    utilization: [],
    fan: [],
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
    utilization: [],
    fan: [],
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

it("selectGpuDevice matches a hardware-profile chip:label identity, not just a raw path", () => {
  const cardA = {
    path: "/sys/class/hwmon/hwmon1",
    chip: "amdgpu",
    temperature: [{
      chip: "amdgpu",
      label: "edge",
      path: "/sys/class/hwmon/hwmon1/temp1_input",
    }],
    power: [],
    utilization: [],
    fan: [],
  };
  const cardB = {
    path: "/sys/class/hwmon/hwmon2",
    chip: "amdgpu",
    temperature: [{
      chip: "amdgpu",
      label: "junction",
      path: "/sys/class/hwmon/hwmon2/temp1_input",
    }],
    power: [{
      chip: "amdgpu",
      label: "PPT",
      path: "/sys/class/hwmon/hwmon2/power1_average",
    }],
    utilization: [],
    fan: [],
  };
  assertEquals(
    selectGpuDevice([cardA, cardB], { gpuTemperature: "amdgpu:edge" }),
    cardA,
  );
  assertEquals(
    selectGpuDevice([cardA, cardB], { gpuPower: "amdgpu:PPT" }),
    cardB,
  );
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

it("selectCandidate matches a hardware-profile chip:label identity, and degrades to no reading when stale", () => {
  const first = { chip: "coretemp", label: "Package id 0", path: "/a" };
  const second = { chip: "coretemp", label: "Core 0", path: "/b" };
  assertEquals(selectCandidate([first, second], "coretemp:Core 0"), second);
  // A chip:label identity with no matching candidate degrades to "no
  // reading" (undefined) — it must never be opened as a literal path.
  assertEquals(
    selectCandidate([first], "coretemp:Stale Sensor"),
    undefined,
  );
});

it("withinDeviceOverride falls back to undefined for a device identity outside this pool, but honors a raw path or a within-pool match", () => {
  const power = [{
    chip: "amdgpu",
    label: "PPT",
    path: "/sys/class/hwmon/hwmon0/power1_average",
  }];
  // "amdgpu:edge" is the device's temperature-representative identity
  // (resolveAdminSensorOverrides fans one gpuDevice slot to all four GPU
  // measurement keys) — it names nothing in the power pool, so the device
  // stays pinned but per-measurement selection falls through to auto.
  assertEquals(withinDeviceOverride(power, "amdgpu:edge"), undefined);
  // It matches directly when it does name a candidate in this pool.
  assertEquals(withinDeviceOverride(power, "amdgpu:PPT"), "amdgpu:PPT");
  // A raw sysfs path is always passed through verbatim.
  assertEquals(withinDeviceOverride(power, "/custom/path"), "/custom/path");
  assertEquals(withinDeviceOverride(power, undefined), undefined);
});

it("defaultSensorIo returns empty listings for missing directories", async () => {
  const io = defaultSensorIo();
  assertEquals(
    await io.listDir("/no/such/turbopanel-sensors-dir"),
    [],
  );
});

it("defaultSensorIo listDir uses ls when Deno.readDir throws", async () => {
  const io = defaultSensorIo({
    readDir: () => {
      throw new Error("blocked");
    },
    runLs: () =>
      Promise.resolve({
        code: 0,
        stdout: new TextEncoder().encode("hwmon3\nhwmon0\n"),
      }),
  });
  assertEquals(await io.listDir("/sys/class/hwmon"), ["hwmon0", "hwmon3"]);
});

it("defaultSensorIo listDir stays empty when both readDir and ls fail", async () => {
  const io = defaultSensorIo({
    readDir: () => {
      throw new Error("blocked");
    },
    runLs: () => Promise.resolve({ code: 1, stdout: new Uint8Array() }),
  });
  assertEquals(await io.listDir("/sys/class/hwmon"), []);
});
