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

  // Partitions are never inventory; the whole disk backing them stays.
  assertEquals(byName.has("nvme0n1p1"), false);

  const unrelatedDisk = byName.get("nvme1n1")!;
  assertEquals(unrelatedDisk.isServiceDevice, false);
});

test("collectBlockTopology: LVM/dm backing chain resolved via slaves/, a mounted dm/md device stays as a virtual device, unmounted ones and partitions are dropped", async () => {
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

  assertEquals(sda.deviceType, "physical");
  assertEquals(dm0.deviceType, "virtual");
  assertEquals(byName.has("dm-1"), false);
  assertEquals(byName.has("sda1"), false);
  assertEquals(dm0.parentDeviceId, sda.deviceId);
  assertEquals(dm0.isServiceDevice, true);
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

test("collectBlockTopology: partitions of a kept whole disk are not inventory", async () => {
  const text = [
    "   8       0 sda 1 0 1 0 1 0 1 0 0 0 0 0 0 0 0 0 0",
    "   8       1 sda1 1 0 1 0 1 0 1 0 0 0 0 0 0 0 0 0 0",
    "   8       2 sda2 1 0 1 0 1 0 1 0 0 0 0 0 0 0 0 0 0",
  ].join("\n");
  const devices = await collectBlockTopology({
    readProcFile: (path) => path === "/proc/diskstats" ? text : undefined,
    io: defaultSensorIo(),
    sysRoot: "/nonexistent",
    serviceDeviceNames: ["sda1"],
  });
  assertEquals(devices.map((d) => d.kernelName), ["sda"]);
});

test("collectBlockTopology: dm-10 / md127 / nvme0n10 are whole devices, not partitions of dm-1 / md1 / nvme0n1", async () => {
  const names = [
    "dm-1",
    "dm-10",
    "md1",
    "md127",
    "nvme0n1",
    "nvme0n10",
    "nvme0n1p1",
    "sda",
    "sda1",
  ];
  const diskstats = names.map((name, i) =>
    `${259} ${i} ${name} 10 0 80 5 10 0 80 5 0 10 10`
  ).join("\n");
  const devices = await collectBlockTopology({
    readProcFile: (path) => path === "/proc/diskstats" ? diskstats : undefined,
    io: { listDir: () => [], readFile: () => undefined },
    sysRoot: "/nonexistent",
    serviceDeviceNames: ["dm-1", "dm-10", "md1", "md127", "nvme0n10", "sda1"],
  });
  const kept = devices.map((d) => d.kernelName).sort();
  assertEquals(kept, [
    "dm-1",
    "dm-10",
    "md1",
    "md127",
    "nvme0n1",
    "nvme0n10",
    "sda",
  ]);
  const byName = new Map(devices.map((d) => [d.kernelName, d]));
  assertEquals(byName.get("dm-10")?.isServiceDevice, true);
  assertEquals(byName.get("sda")?.isServiceDevice, true);
});
