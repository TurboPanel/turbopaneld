import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl, join } from "@std/path";
import {
  hardwareProfilePath,
  parseHardwareProfile,
  resolveAdminSensorOverrides,
  resolveHardwareProfile,
  resolveNicSlots,
  writeHardwareProfile,
} from "./overrides.ts";
import { readHostSensors } from "./index.ts";

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`../testdata/${name}`, import.meta.url));
}

it("parseHardwareProfile keeps only well-formed slot/NIC/scalar fields", () => {
  assertEquals(
    parseHardwareProfile(JSON.stringify({
      cpuTemperature: { chip: "coretemp", label: "Package id 0" },
      gpuDevice: null,
      gpuFan: { chip: "amdgpu", label: "fan1" },
      disk1Temperature: { chip: "drivetemp" }, // missing label — dropped
      nic1: "eth0",
      nic2: null,
      hostingPath: "  /mnt/hosting  ",
      drivetempEnabled: true,
      generation: 3,
      generationAppliedAt: "2026-01-01T00:00:00.000Z",
      unknownField: "/x",
    })),
    {
      cpuTemperature: { chip: "coretemp", label: "Package id 0" },
      gpuDevice: null,
      gpuFan: { chip: "amdgpu", label: "fan1" },
      nic1: "eth0",
      nic2: null,
      hostingPath: "/mnt/hosting",
      drivetempEnabled: true,
      generation: 3,
      generationAppliedAt: "2026-01-01T00:00:00.000Z",
    },
  );
  assertEquals(parseHardwareProfile("not json"), {});
  assertEquals(parseHardwareProfile("[1,2]"), {});
  assertEquals(parseHardwareProfile("null"), {});
});

it("parseHardwareProfile drops a malformed on-disk hostingPath instead of accepting it", () => {
  // Matches the PUT /servers/:id/metrics/hardware-profile route-level rule:
  // hostingPath must be an absolute path with no whitespace/control chars.
  // A stale/manually-edited state file with an invalid value must fall back
  // to absent, not win over resolveHostingPath()'s principalHomeRoot default.
  assertEquals(
    parseHardwareProfile(JSON.stringify({ hostingPath: "relative/path" })),
    {},
  );
  assertEquals(
    parseHardwareProfile(JSON.stringify({ hostingPath: "./relative" })),
    {},
  );
  assertEquals(
    parseHardwareProfile(JSON.stringify({ hostingPath: "/mnt/has space" })),
    {},
  );
  assertEquals(
    parseHardwareProfile(JSON.stringify({ hostingPath: "/mnt/has\ttab" })),
    {},
  );
  assertEquals(
    parseHardwareProfile(JSON.stringify({ hostingPath: "/mnt/has\ncontrol" })),
    {},
  );
  assertEquals(
    parseHardwareProfile(JSON.stringify({ hostingPath: "   " })),
    {},
  );
  // A well-formed absolute path with no whitespace is still accepted.
  assertEquals(
    parseHardwareProfile(JSON.stringify({ hostingPath: "/srv/users" })),
    { hostingPath: "/srv/users" },
  );
});

it("resolveHardwareProfile reads the state file and defaults to empty", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await resolveHardwareProfile(tempDir), {});

    const path = hardwareProfilePath(tempDir);
    await Deno.mkdir(join(tempDir, "metrics"), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ nic2: "eth1" }),
    );
    assertEquals(await resolveHardwareProfile(tempDir), { nic2: "eth1" });

    await Deno.writeTextFile(path, "{broken");
    assertEquals(await resolveHardwareProfile(tempDir), {});
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("writeHardwareProfile replaces the state file atomically", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile({
      cpuTemperature: { chip: "coretemp", label: "Package id 0" },
      hostingPath: "/mnt/hosting",
      generation: 1,
    }, tempDir);
    assertEquals(await resolveHardwareProfile(tempDir), {
      cpuTemperature: { chip: "coretemp", label: "Package id 0" },
      hostingPath: "/mnt/hosting",
      generation: 1,
    });

    // Full replacement: an absent field clears it.
    await writeHardwareProfile({ nic1: "eth0" }, tempDir);
    assertEquals(await resolveHardwareProfile(tempDir), { nic1: "eth0" });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveAdminSensorOverrides projects assigned slots to chip:label identities", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await resolveAdminSensorOverrides(tempDir), {});

    await writeHardwareProfile({
      cpuTemperature: { chip: "coretemp", label: "Package id 0" },
      cpuPower: { chip: "intel-rapl", label: "package-0" },
      gpuDevice: { chip: "amdgpu", label: "edge" },
    }, tempDir);

    assertEquals(await resolveAdminSensorOverrides(tempDir), {
      cpuTemperature: "coretemp:Package id 0",
      cpuPower: "intel-rapl:package-0",
      // All four GPU measurements resolve from the single gpuDevice slot.
      gpuTemperature: "amdgpu:edge",
      gpuPower: "amdgpu:edge",
      gpuUtilization: "amdgpu:edge",
      gpuFan: "amdgpu:edge",
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("an explicit gpuFan assignment wins over the gpuDevice fan-out", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile({
      gpuDevice: { chip: "amdgpu", label: "edge" },
      gpuFan: { chip: "amdgpu", label: "fan1" },
    }, tempDir);

    assertEquals(await resolveAdminSensorOverrides(tempDir), {
      gpuTemperature: "amdgpu:edge",
      gpuPower: "amdgpu:edge",
      gpuUtilization: "amdgpu:edge",
      // Not "amdgpu:edge" (the gpuDevice fan-out) — the explicit slot wins.
      gpuFan: "amdgpu:fan1",
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveAdminSensorOverrides projects the fan/disk/ambient/board slots", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile({
      disk1Temperature: { chip: "nvme0n1", label: "Composite" },
      disk2Temperature: { chip: "sda", label: "temp1" },
      ambient1Temperature: { chip: "nct6775", label: "SYSTIN" },
      ambient2Temperature: { chip: "nct6775", label: "AUXTIN" },
      boardTemperature: { chip: "nct6775", label: "SYSTIN" },
      cpuFan: { chip: "coretemp", label: "cpu_fan" },
      systemFan1: { chip: "nct6775", label: "sys_fan1" },
      systemFan2: { chip: "nct6775", label: "sys_fan2" },
    }, tempDir);

    assertEquals(await resolveAdminSensorOverrides(tempDir), {
      disk1Temperature: "nvme0n1:Composite",
      disk2Temperature: "sda:temp1",
      ambient1Temperature: "nct6775:SYSTIN",
      ambient2Temperature: "nct6775:AUXTIN",
      boardTemperature: "nct6775:SYSTIN",
      cpuFan: "coretemp:cpu_fan",
      systemFan1: "nct6775:sys_fan1",
      systemFan2: "nct6775:sys_fan2",
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveNicSlots collapses unset and explicitly-unassigned NIC slots to null", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await resolveNicSlots(tempDir), { nic1: null, nic2: null });

    await writeHardwareProfile({ nic1: "eth0", nic2: null }, tempDir);
    assertEquals(await resolveNicSlots(tempDir), { nic1: "eth0", nic2: null });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveAdminSensorOverrides output round-trips through readHostSensors — an assigned GPU slot reads back non-null on every measurement", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // The gpuDevice slot's chip:label identity is fanned out to all four GPU
    // override keys (temperature/power/utilization/fan) — resolving them
    // through the real collector must not null out power/utilization/fan
    // just because that shared identity only literally names the device's
    // temperature candidate.
    await writeHardwareProfile({
      gpuDevice: { chip: "amdgpu", label: "edge" },
    }, tempDir);
    const overrides = await resolveAdminSensorOverrides(tempDir);
    const readings = await readHostSensors(overrides, {
      root: fixtureRoot("sensors-gpu-utilization"),
    });
    assertEquals(readings.gpuTemperatureCelsius, 61);
    assertEquals(readings.gpuPowerWatts, 37);
    assertEquals(readings.gpuUtilizationPercent, 42);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
