import { assertEquals } from "@std/assert";
import { writeHardwareProfile } from "../collector/sensors/overrides.ts";
import { resolveTopologyOverrides, toTopologyOverrides } from "./overrides.ts";
import { EMPTY_TOPOLOGY_OVERRIDES } from "./types.ts";
import type { HardwareProfile } from "../collector/types.ts";

const test = Deno.test.bind(Deno);

test("toTopologyOverrides: projects only the topology-identity fields, ignoring sensor slots and nic1/nic2 name fields", () => {
  const profile: HardwareProfile = {
    cpuTemperature: { chip: "coretemp", label: "Package id 0" },
    nic1: "eth0",
    nic2: null,
    hostingPath: "/srv/users",
    nicSlotDeviceIds: ["mac:a", "mac:b"],
    hostingFilesystemId: "fs:dev:/dev/sdb1",
    drivetempEnabled: true,
  };
  assertEquals(toTopologyOverrides(profile), {
    nicSlotDeviceIds: ["mac:a", "mac:b"],
    hostingFilesystemId: "fs:dev:/dev/sdb1",
    drivetempEnabled: true,
  });
});

test("toTopologyOverrides: an empty profile projects to all-null/false", () => {
  assertEquals(toTopologyOverrides({}), {
    nicSlotDeviceIds: [],
    hostingFilesystemId: null,
    drivetempEnabled: false,
  });
});

test("resolveTopologyOverrides: unset daemon state projects to EMPTY_TOPOLOGY_OVERRIDES", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await resolveTopologyOverrides(dir), EMPTY_TOPOLOGY_OVERRIDES);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("resolveTopologyOverrides: a written profile is projected into topology-override shape", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile({
      nicSlotDeviceIds: ["mac:aa"],
      hostingFilesystemId: "fs:dev:/dev/nvme0n1p2",
      drivetempEnabled: true,
    }, dir);
    assertEquals(await resolveTopologyOverrides(dir), {
      nicSlotDeviceIds: ["mac:aa"],
      hostingFilesystemId: "fs:dev:/dev/nvme0n1p2",
      drivetempEnabled: true,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
