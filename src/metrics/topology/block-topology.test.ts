import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import { collectBlockTopology } from "./block-topology.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

function fixtureText(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../collector/testdata/${name}`, import.meta.url),
  );
}

test("collectBlockTopology: NVMe naming — whole disks, partitions linked via parentDeviceId, partitions excluded from isServiceDevice", async () => {
  const devices = await collectBlockTopology({
    readProcFile: (path) =>
      path === "/proc/diskstats"
        ? fixtureText("proc-diskstats-nvme.txt")
        : undefined,
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("block-graph-nvme"),
    serviceDeviceNames: ["nvme0n1p1"],
  });

  const byName = new Map(devices.map((d) => [d.kernelName, d]));
  const wholeDisk = byName.get("nvme0n1")!;
  assertEquals(wholeDisk.deviceType, "physical");
  assertEquals(wholeDisk.isServiceDevice, true);
  assertEquals(wholeDisk.model, "NVMe SSD Model A");

  const partition1 = byName.get("nvme0n1p1")!;
  assertEquals(partition1.deviceType, "partition");
  assertEquals(partition1.parentDeviceId, wholeDisk.deviceId);
  assertEquals(partition1.isServiceDevice, false);

  const unrelatedDisk = byName.get("nvme1n1")!;
  assertEquals(unrelatedDisk.isServiceDevice, false);
});

test("collectBlockTopology: LVM/dm backing chain resolved via slaves/, dm/md represented as virtual devices (not excluded)", async () => {
  const devices = await collectBlockTopology({
    readProcFile: (path) =>
      path === "/proc/diskstats"
        ? fixtureText("proc-diskstats-lvm.txt")
        : undefined,
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("block-graph-lvm"),
    serviceDeviceNames: ["dm-0"],
  });

  const byName = new Map(devices.map((d) => [d.kernelName, d]));
  const sda = byName.get("sda")!;
  const dm0 = byName.get("dm-0")!;
  const dm1 = byName.get("dm-1")!;
  const sda1 = byName.get("sda1")!;

  assertEquals(sda.deviceType, "physical");
  assertEquals(dm0.deviceType, "virtual");
  assertEquals(dm1.deviceType, "virtual");
  assertEquals(dm0.parentDeviceId, sda.deviceId);
  assertEquals(dm1.parentDeviceId, sda1.deviceId);
  assertEquals(dm0.isServiceDevice, true);
  assertEquals(dm1.isServiceDevice, false);
  assertEquals(sda.isServiceDevice, false);
});

test("collectBlockTopology: excludes loop/ram/pseudo devices entirely", async () => {
  const devices = await collectBlockTopology({
    readProcFile: (path) =>
      path === "/proc/diskstats"
        ? "   7       0 loop0 10 0 100 0 0 0 0 0 0 0 0 0 0 0\n" +
          fixtureText("proc-diskstats-nvme.txt")
        : undefined,
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("block-graph-nvme"),
    serviceDeviceNames: [],
  });
  assertEquals(devices.some((d) => d.kernelName === "loop0"), false);
});
