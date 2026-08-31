import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  isDiskPartition,
  isVirtualDiskDevice,
  readBlockDevices,
} from "./block-devices.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("readBlockDevices filters virtual devices and partitions", () => {
  const disk = readBlockDevices(fixture("proc-diskstats.txt"));
  assertEquals(disk !== null, true);
  assertEquals(Object.keys(disk!.devices).sort((a, b) => a.localeCompare(b)), [
    "nvme0n1",
    "sda",
    "sdb",
  ]);
  assertEquals(disk!.devices.sda, {
    readsCompleted: 1000,
    sectorsRead: 30000,
    readTicksMs: 400,
    writesCompleted: 500,
    sectorsWritten: 70000,
    writeTicksMs: 800,
  });
});

it("readBlockDevices never counts an NVMe disk and its partitions twice", () => {
  const disk = readBlockDevices(fixture("proc-diskstats-nvme.txt"));
  if (!disk) throw new TypeError("expected NVMe whole disks");
  assertEquals(Object.keys(disk.devices).sort((a, b) => a.localeCompare(b)), [
    "nvme0n1",
    "nvme1n1",
  ]);
});

it("readBlockDevices excludes device-mapper rows on an LVM host", () => {
  // dm-* I/O is accounted on the underlying physical device — counting both
  // would double every LVM request.
  const disk = readBlockDevices(fixture("proc-diskstats-lvm.txt"));
  if (!disk) throw new TypeError("expected the physical disk to survive");
  assertEquals(Object.keys(disk.devices), ["sda"]);
});

it("isVirtualDiskDevice matches pseudo device prefixes", () => {
  assertEquals(isVirtualDiskDevice("loop0"), true);
  assertEquals(isVirtualDiskDevice("dm-0"), true);
  assertEquals(isVirtualDiskDevice("ram0"), true);
  assertEquals(isVirtualDiskDevice("zram0"), true);
  assertEquals(isVirtualDiskDevice("fd0"), true);
  assertEquals(isVirtualDiskDevice("md0"), true);
  assertEquals(isVirtualDiskDevice("dcssblk0"), true);
  assertEquals(isVirtualDiskDevice("sr0"), true);
  assertEquals(isVirtualDiskDevice("nbd0"), true);
  assertEquals(isVirtualDiskDevice("sda"), false);
  assertEquals(isVirtualDiskDevice("nvme0n1"), false);
});

it("isDiskPartition detects sda1 and nvme0n1p1 suffixes", () => {
  const names = ["sda", "sda1", "nvme0n1", "nvme0n1p1"];
  assertEquals(isDiskPartition("sda1", names), true);
  assertEquals(isDiskPartition("nvme0n1p1", names), true);
  assertEquals(isDiskPartition("sda", names), false);
});

it("isDiskPartition ignores shorter-or-equal candidate parents", () => {
  assertEquals(isDiskPartition("sda", ["sda", "sda1"]), false);
  assertEquals(isDiskPartition("sda", ["sdb"]), false);
});

it("readBlockDevices prefers disks backing the probed mounts over extra disks", () => {
  // Host with unrelated extra disks (sdb, sdc): when the probed system /
  // hosting / Docker mounts resolve to sda1 and nvme0n1p1, aggregation
  // narrows to their whole disks and the unrelated devices drop out.
  const disk = readBlockDevices(fixture("proc-diskstats-extra-disks.txt"), [
    "sda1",
    "nvme0n1p1",
  ]);
  if (!disk) throw new TypeError("expected mount-backed whole disks");
  assertEquals(Object.keys(disk.devices).sort((a, b) => a.localeCompare(b)), [
    "nvme0n1",
    "sda",
  ]);
});

it("readBlockDevices accepts whole-disk preferred names verbatim", () => {
  const disk = readBlockDevices(fixture("proc-diskstats-extra-disks.txt"), [
    "sdb",
  ]);
  if (!disk) throw new TypeError("expected the preferred whole disk");
  assertEquals(Object.keys(disk.devices), ["sdb"]);
});

it("readBlockDevices falls back to every whole disk when preference misses", () => {
  // Device-mapper style sources never match a diskstats name — the
  // host-wide whole-disk filter stays in charge.
  const all = ["nvme0n1", "sda", "sdb", "sdc"];
  const unmatched = readBlockDevices(
    fixture("proc-diskstats-extra-disks.txt"),
    ["vg-root"],
  );
  if (!unmatched) throw new TypeError("expected fallback whole disks");
  assertEquals(
    Object.keys(unmatched.devices).sort((a, b) => a.localeCompare(b)),
    all,
  );

  const empty = readBlockDevices(fixture("proc-diskstats-extra-disks.txt"), []);
  if (!empty) throw new TypeError("expected fallback whole disks");
  assertEquals(
    Object.keys(empty.devices).sort((a, b) => a.localeCompare(b)),
    all,
  );
});

it("readBlockDevices returns null for empty input", () => {
  assertEquals(readBlockDevices(""), null);
});

it("readBlockDevices drops remaining virtual prefixes", () => {
  const row = (name: string) =>
    `   8       0 ${name} 1000 200 30000 400 500 600 70000 800 0 0 0 0 0 0`;
  const disk = readBlockDevices(
    ["zram0", "fd0", "md0", "dcssblk0", "sr0", "nbd0", "sda"].map(row).join(
      "\n",
    ),
  );
  if (!disk) throw new TypeError("expected sda after virtual filters");
  assertEquals(Object.keys(disk.devices), ["sda"]);
});

it("readBlockDevices returns null when only virtual devices remain", () => {
  const text = [
    "   7       0 loop0 50 10 1500 20 25 30 3500 40 0 0 0 0 0 0",
    " 253       0 dm-0 300 60 9000 120 150 180 21000 240 0 0 0 0 0 0",
    "",
  ].join("\n");
  assertEquals(readBlockDevices(text), null);
});
