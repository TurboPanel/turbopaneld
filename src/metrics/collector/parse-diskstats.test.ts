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
