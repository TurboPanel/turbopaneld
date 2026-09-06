import { assertEquals } from "@std/assert";
import { toTopologyOverrides } from "./overrides.ts";
import type { HardwareProfile } from "../collector/types.ts";

const test = Deno.test.bind(Deno);

test("toTopologyOverrides: projects only the topology-identity fields, ignoring sensor slots and nic1/nic2 name fields", () => {
  const profile: HardwareProfile = {
    cpuTemperature: { chip: "coretemp", label: "Package id 0" },
    nic1: "eth0",
    nic2: null,
    hostingPath: "/srv/users",
    nicSlot1DeviceId: "mac:a",
    nicSlot2DeviceId: null,
    hostingFilesystemId: "fs:dev:/dev/sdb1",
    drivetempEnabled: true,
  };
  assertEquals(toTopologyOverrides(profile), {
    nicSlot1DeviceId: "mac:a",
    nicSlot2DeviceId: null,
    hostingFilesystemId: "fs:dev:/dev/sdb1",
    drivetempEnabled: true,
  });
});

test("toTopologyOverrides: an empty profile projects to all-null/false", () => {
  assertEquals(toTopologyOverrides({}), {
    nicSlot1DeviceId: null,
    nicSlot2DeviceId: null,
    hostingFilesystemId: null,
    drivetempEnabled: false,
  });
});
