import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  bootChanged,
  diskRates,
  membershipChanged,
  netRates,
  rate,
} from "./rates.ts";
import type { DiskCounters, NetInterfaceCounters } from "./types.ts";

function device(
  overrides: Partial<DiskCounters["devices"][string]> = {},
): DiskCounters["devices"][string] {
  return {
    readsCompleted: 1000,
    sectorsRead: 30000,
    readTicksMs: 400,
    writesCompleted: 500,
    sectorsWritten: 70000,
    writeTicksMs: 800,
    ...overrides,
  };
}

it("rate returns null on first sample, non-positive interval, or reset", () => {
  assertEquals(rate(undefined, 100, 60), null);
  assertEquals(rate(50, 100, 60), 50 / 60);
  assertEquals(rate(100, 50, 60), null);
  assertEquals(rate(50, 100, 0), null);
  assertEquals(rate(50, 100, -1), null);
});

it("diskRates computes throughput, IOPS, and latency per-second deltas", () => {
  const prev: DiskCounters = {
    devices: {
      sda: device(),
      nvme0n1: device({
        readsCompleted: 2000,
        sectorsRead: 60000,
        readTicksMs: 1000,
        writesCompleted: 1000,
        sectorsWritten: 140000,
        writeTicksMs: 2000,
      }),
    },
  };
  const curr: DiskCounters = {
    devices: {
      sda: device({
        readsCompleted: 1050,
        sectorsRead: 32500,
        readTicksMs: 500,
        writesCompleted: 525,
        sectorsWritten: 72500,
        writeTicksMs: 900,
      }),
      nvme0n1: device({
        readsCompleted: 2100,
        sectorsRead: 62500,
        readTicksMs: 1200,
        writesCompleted: 1050,
        sectorsWritten: 145000,
        writeTicksMs: 2300,
      }),
    },
  };
  const disk = diskRates(prev, curr, 10);
  assertEquals(disk.readOpsPerSecond, 15);
  assertEquals(disk.writeOpsPerSecond, 7.5);
  assertEquals(disk.readBytesPerSecond, (5000 * 512) / 10);
  assertEquals(disk.writeBytesPerSecond, (7500 * 512) / 10);
  // Weighted host-wide latency: Σticks / Σops across devices.
  assertEquals(disk.readLatencyMs, 300 / 150);
  assertEquals(disk.writeLatencyMs, 400 / 75);
});

it("diskRates nulls latency (not 0) when the interval had no ops", () => {
  const prev: DiskCounters = { devices: { sda: device() } };
  const curr: DiskCounters = { devices: { sda: device() } };
  const disk = diskRates(prev, curr, 10);
  assertEquals(disk.readOpsPerSecond, 0);
  assertEquals(disk.writeOpsPerSecond, 0);
  assertEquals(disk.readLatencyMs, null);
  assertEquals(disk.writeLatencyMs, null);
});

it("diskRates returns empty when snapshots or seconds are missing", () => {
  const disk: DiskCounters = { devices: { sda: device() } };
  assertEquals(diskRates(null, disk, 60).readOpsPerSecond, null);
  assertEquals(diskRates(disk, disk, 0).readOpsPerSecond, null);
  assertEquals(diskRates(disk, disk, 0).readLatencyMs, null);
});

it("diskRates returns null on any counter reset, ticks included", () => {
  const prev: DiskCounters = { devices: { sda: device() } };
  const writesReset: DiskCounters = {
    devices: { sda: device({ writesCompleted: 50 }) },
  };
  const ticksReset: DiskCounters = {
    devices: { sda: device({ readTicksMs: 10 }) },
  };
  assertEquals(diskRates(prev, writesReset, 60).writeOpsPerSecond, null);
  assertEquals(diskRates(prev, ticksReset, 60).readLatencyMs, null);
  assertEquals(diskRates(prev, ticksReset, 60).readBytesPerSecond, null);
});

it("diskRates returns null when device membership changes", () => {
  const prev: DiskCounters = {
    devices: { sda: device(), sdb: device() },
  };
  const removed: DiskCounters = {
    devices: { sda: device({ readsCompleted: 1100, readTicksMs: 440 }) },
  };
  const removedRates = diskRates(prev, removed, 60);
  assertEquals(removedRates.readBytesPerSecond, null);
  assertEquals(removedRates.writeOpsPerSecond, null);
  assertEquals(removedRates.readLatencyMs, null);
});

it("netRates sums per-second deltas over the given interface set", () => {
  const prev: Record<string, NetInterfaceCounters> = {
    eth0: { receiveBytes: 1_000_000, transmitBytes: 500_000 },
    wlan0: { receiveBytes: 500_000, transmitBytes: 250_000 },
  };
  const curr: Record<string, NetInterfaceCounters> = {
    eth0: { receiveBytes: 1_050_000, transmitBytes: 525_000 },
    wlan0: { receiveBytes: 550_000, transmitBytes: 275_000 },
  };
  const net = netRates(prev, curr, 10);
  assertEquals(net.receiveBytesPerSecond, 10_000);
  assertEquals(net.transmitBytesPerSecond, 5_000);
});

it("netRates returns null for missing snapshots, empty sets, or zero seconds", () => {
  const set: Record<string, NetInterfaceCounters> = {
    eth0: { receiveBytes: 100, transmitBytes: 50 },
  };
  assertEquals(netRates(null, set, 60).receiveBytesPerSecond, null);
  assertEquals(netRates(set, null, 60).receiveBytesPerSecond, null);
  assertEquals(netRates(set, set, 0).receiveBytesPerSecond, null);
  // No interfaces means no measurement, not zero traffic.
  assertEquals(netRates({}, {}, 60).receiveBytesPerSecond, null);
});

it("netRates returns null when interface membership changes", () => {
  const prev: Record<string, NetInterfaceCounters> = {
    eth0: { receiveBytes: 5_000_000, transmitBytes: 3_000_000 },
    wlan0: { receiveBytes: 2_000_000, transmitBytes: 1_500_000 },
  };
  const curr: Record<string, NetInterfaceCounters> = {
    eth0: { receiveBytes: 5_100_000, transmitBytes: 3_100_000 },
  };
  const rates = netRates(prev, curr, 60);
  assertEquals(rates.receiveBytesPerSecond, null);
  assertEquals(rates.transmitBytesPerSecond, null);
});

it("netRates returns null when any interface counter resets", () => {
  const prev: Record<string, NetInterfaceCounters> = {
    eth0: { receiveBytes: 5_000_000, transmitBytes: 3_000_000 },
  };
  const rxReset: Record<string, NetInterfaceCounters> = {
    eth0: { receiveBytes: 100_000, transmitBytes: 3_100_000 },
  };
  const txReset: Record<string, NetInterfaceCounters> = {
    eth0: { receiveBytes: 5_100_000, transmitBytes: 100_000 },
  };
  assertEquals(netRates(prev, rxReset, 60).receiveBytesPerSecond, null);
  assertEquals(netRates(prev, txReset, 60).transmitBytesPerSecond, null);
});

it("membershipChanged detects added or removed members", () => {
  assertEquals(membershipChanged({ a: 1 }, { a: 1 }), false);
  assertEquals(membershipChanged({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
  assertEquals(membershipChanged({ a: 1, b: 2 }, { a: 1 }), true);
  assertEquals(membershipChanged({ a: 1 }, { a: 1, c: 3 }), true);
  assertEquals(membershipChanged({ a: 1 }, { b: 1 }), true);
});

it("bootChanged detects reboot via boot_id mismatch", () => {
  assertEquals(bootChanged("a", "b"), true);
  assertEquals(bootChanged("a", "a"), false);
  assertEquals(bootChanged(null, "a"), false);
  assertEquals(bootChanged("a", null), false);
});

it("long interval averages rate correctly", () => {
  assertEquals(rate(0, 6000, 120), 50);
});
