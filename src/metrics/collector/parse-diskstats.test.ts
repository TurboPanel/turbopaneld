import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  isDiskPartition,
  isVirtualDiskDevice,
  parseDiskstats,
} from "./parse-diskstats.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseDiskstats filters virtual devices and partitions", () => {
  const disk = parseDiskstats(fixture("proc-diskstats.txt"));
  assertEquals(disk !== null, true);
  assertEquals(Object.keys(disk!.devices).sort((a, b) => a.localeCompare(b)), [
    "nvme0n1",
    "sda",
    "sdb",
  ]);
  assertEquals(disk!.devices.sda, {
    readsCompleted: 1000,
    sectorsRead: 30000,
    writesCompleted: 500,
    sectorsWritten: 70000,
  });
  assertEquals(disk!.devices.nvme0n1, {
    readsCompleted: 2000,
    sectorsRead: 60000,
    writesCompleted: 1000,
    sectorsWritten: 140000,
  });
  assertEquals(disk!.devices.sdb, {
    readsCompleted: 500,
    sectorsRead: 15000,
    writesCompleted: 250,
    sectorsWritten: 35000,
  });
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

it("parseDiskstats returns null for empty input", () => {
  assertEquals(parseDiskstats(""), null);
});

it("parseDiskstats skips short and non-finite rows", () => {
  assertEquals(
    parseDiskstats("   8       0 sda 1000\n"),
    null,
  );
  assertEquals(
    parseDiskstats(
      "   8       0 sda NaN 200 30000 400 500 600 70000 800 0 0 0 0 0 0\n",
    ),
    null,
  );
});

it("parseDiskstats drops remaining virtual prefixes", () => {
  const row = (name: string) =>
    `   8       0 ${name} 1000 200 30000 400 500 600 70000 800 0 0 0 0 0 0`;
  const disk = parseDiskstats(
    ["zram0", "fd0", "md0", "dcssblk0", "sr0", "nbd0", "sda"].map(row).join(
      "\n",
    ),
  );
  if (!disk) throw new TypeError("expected sda after virtual filters");
  assertEquals(Object.keys(disk.devices), ["sda"]);
});

it("parseDiskstats returns null when only virtual devices remain", () => {
  const text = [
    "   7       0 loop0 50 10 1500 20 25 30 3500 40 0 0 0 0 0 0",
    " 253       0 dm-0 300 60 9000 120 150 180 21000 240 0 0 0 0 0 0",
    "",
  ].join("\n");
  assertEquals(parseDiskstats(text), null);
});

it("isDiskPartition ignores shorter-or-equal candidate parents", () => {
  assertEquals(isDiskPartition("sda", ["sda", "sda1"]), false);
  assertEquals(isDiskPartition("sda", ["sdb"]), false);
});
