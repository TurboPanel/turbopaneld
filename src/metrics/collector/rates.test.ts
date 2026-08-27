import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  bootChanged,
  cpuPercentages,
  diskRates,
  membershipChanged,
  netRates,
  rate,
} from "./rates.ts";
import type { CpuCounters, DiskCounters, NetCounters } from "./types.ts";

it("rate returns null on first sample, non-positive interval, or reset", () => {
  assertEquals(rate(undefined, 100, 60), null);
  assertEquals(rate(50, 100, 60), 50 / 60);
  assertEquals(rate(100, 50, 60), null);
  assertEquals(rate(50, 100, 0), null);
  assertEquals(rate(50, 100, -1), null);
});

it("cpuPercentages computes usage from jiffie deltas", () => {
  const prev: CpuCounters = {
    user: 100,
    nice: 0,
    system: 50,
    idle: 800,
    iowait: 50,
    total: 1000,
    active: 150,
  };
  const curr: CpuCounters = {
    user: 200,
    nice: 0,
    system: 100,
    idle: 1500,
    iowait: 100,
    total: 1900,
    active: 300,
  };
  const pct = cpuPercentages(prev, curr, 60);
  const deltaTotal = 900;
  assertEquals(pct.usage, (150 / deltaTotal) * 100);
  assertEquals(pct.user, (100 / deltaTotal) * 100);
  assertEquals(pct.system, (50 / deltaTotal) * 100);
  assertEquals(pct.iowait, (50 / deltaTotal) * 100);
});

it("cpuPercentages returns nulls when interval or total delta is non-positive", () => {
  const prev: CpuCounters = {
    user: 100,
    nice: 0,
    system: 50,
    idle: 800,
    iowait: 50,
    total: 1000,
    active: 150,
  };
  const curr: CpuCounters = {
    user: 200,
    nice: 0,
    system: 100,
    idle: 1500,
    iowait: 100,
    total: 1900,
    active: 300,
  };
  assertEquals(cpuPercentages(prev, curr, 0).usage, null);
  assertEquals(cpuPercentages(prev, { ...curr, total: 1000 }, 60).usage, null);
});

it("cpuPercentages uses user-only delta when nice counters reset", () => {
  const prev: CpuCounters = {
    user: 100,
    nice: 50,
    system: 50,
    idle: 800,
    iowait: 50,
    total: 1000,
    active: 200,
  };
  const curr: CpuCounters = {
    user: 200,
    nice: 10,
    system: 100,
    idle: 1500,
    iowait: 100,
    total: 1900,
    active: 310,
  };
  const pct = cpuPercentages(prev, curr, 60);
  const deltaTotal = 900;
  assertEquals(pct.user, (100 / deltaTotal) * 100);
  assertEquals(pct.system, (50 / deltaTotal) * 100);
});

it("cpuPercentages returns nulls when no previous snapshot", () => {
  const curr: CpuCounters = {
    user: 100,
    total: 1000,
    active: 100,
  };
  const pct = cpuPercentages(null, curr, 60);
  assertEquals(pct.usage, null);
  assertEquals(pct.user, null);
});

it("diskRates and netRates compute per-second deltas", () => {
  const prevDisk: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1000,
        sectorsRead: 30000,
        writesCompleted: 500,
        sectorsWritten: 70000,
      },
      nvme0n1: {
        readsCompleted: 2000,
        sectorsRead: 60000,
        writesCompleted: 1000,
        sectorsWritten: 140000,
      },
    },
  };
  const currDisk: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1050,
        sectorsRead: 32500,
        writesCompleted: 525,
        sectorsWritten: 72500,
      },
      nvme0n1: {
        readsCompleted: 2100,
        sectorsRead: 62500,
        writesCompleted: 1050,
        sectorsWritten: 145000,
      },
    },
  };
  const disk = diskRates(prevDisk, currDisk, 10);
  assertEquals(disk.readOpsPerSecond, 15);
  assertEquals(disk.writeOpsPerSecond, 7.5);
  assertEquals(disk.readBytesPerSecond, (5000 * 512) / 10);
  assertEquals(disk.writeBytesPerSecond, (7500 * 512) / 10);

  const prevNet: NetCounters = {
    interfaces: {
      eth0: { receiveBytes: 1_000_000, transmitBytes: 500_000 },
      wlan0: { receiveBytes: 500_000, transmitBytes: 250_000 },
    },
  };
  const currNet: NetCounters = {
    interfaces: {
      eth0: { receiveBytes: 1_050_000, transmitBytes: 525_000 },
      wlan0: { receiveBytes: 550_000, transmitBytes: 275_000 },
    },
  };
  const net = netRates(prevNet, currNet, 10);
  assertEquals(net.receiveBytesPerSecond, 10_000);
  assertEquals(net.transmitBytesPerSecond, 5_000);
});

it("diskRates and netRates return empty when snapshots or seconds are missing", () => {
  const disk: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1000,
        sectorsRead: 30000,
        writesCompleted: 500,
        sectorsWritten: 70000,
      },
    },
  };
  const net: NetCounters = {
    interfaces: { eth0: { receiveBytes: 100, transmitBytes: 50 } },
  };
  assertEquals(diskRates(null, disk, 60).readOpsPerSecond, null);
  assertEquals(diskRates(disk, disk, 0).readOpsPerSecond, null);
  assertEquals(netRates(null, net, 60).receiveBytesPerSecond, null);
  assertEquals(netRates(net, net, 0).receiveBytesPerSecond, null);
});

it("diskRates returns null on write-side counter reset", () => {
  const prev: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1000,
        sectorsRead: 30000,
        writesCompleted: 500,
        sectorsWritten: 70000,
      },
    },
  };
  const writesReset: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1100,
        sectorsRead: 33000,
        writesCompleted: 50,
        sectorsWritten: 77000,
      },
    },
  };
  const sectorsReset: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1100,
        sectorsRead: 33000,
        writesCompleted: 550,
        sectorsWritten: 7000,
      },
    },
  };
  assertEquals(diskRates(prev, writesReset, 60).writeOpsPerSecond, null);
  assertEquals(diskRates(prev, sectorsReset, 60).writeBytesPerSecond, null);
});

it("diskRates returns null on counter reset", () => {
  const prev: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1000,
        sectorsRead: 30000,
        writesCompleted: 500,
        sectorsWritten: 70000,
      },
    },
  };
  const curr: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 100,
        sectorsRead: 3000,
        writesCompleted: 50,
        sectorsWritten: 7000,
      },
    },
  };
  const disk = diskRates(prev, curr, 60);
  assertEquals(disk.readOpsPerSecond, null);
  assertEquals(disk.readBytesPerSecond, null);
});

it("diskRates returns null when device membership changes", () => {
  const prev: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1000,
        sectorsRead: 30000,
        writesCompleted: 500,
        sectorsWritten: 70000,
      },
      sdb: {
        readsCompleted: 500,
        sectorsRead: 15000,
        writesCompleted: 250,
        sectorsWritten: 35000,
      },
    },
  };
  const removed: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1100,
        sectorsRead: 33000,
        writesCompleted: 550,
        sectorsWritten: 77000,
      },
    },
  };
  const added: DiskCounters = {
    devices: {
      sda: {
        readsCompleted: 1100,
        sectorsRead: 33000,
        writesCompleted: 550,
        sectorsWritten: 77000,
      },
      sdc: {
        readsCompleted: 100,
        sectorsRead: 3000,
        writesCompleted: 50,
        sectorsWritten: 7000,
      },
    },
  };

  const removedRates = diskRates(prev, removed, 60);
  assertEquals(removedRates.readBytesPerSecond, null);
  assertEquals(removedRates.writeBytesPerSecond, null);
  assertEquals(removedRates.readOpsPerSecond, null);
  assertEquals(removedRates.writeOpsPerSecond, null);

  const addedRates = diskRates(prev, added, 60);
  assertEquals(addedRates.readBytesPerSecond, null);
  assertEquals(addedRates.writeBytesPerSecond, null);
});

it("netRates returns null when interface membership changes", () => {
  const prev: NetCounters = {
    interfaces: {
      eth0: { receiveBytes: 5_000_000, transmitBytes: 3_000_000 },
      wlan0: { receiveBytes: 2_000_000, transmitBytes: 1_500_000 },
    },
  };
  const curr: NetCounters = {
    interfaces: {
      eth0: { receiveBytes: 5_100_000, transmitBytes: 3_100_000 },
    },
  };

  const rates = netRates(prev, curr, 60);
  assertEquals(rates.receiveBytesPerSecond, null);
  assertEquals(rates.transmitBytesPerSecond, null);
});

it("netRates returns null when any interface counter resets", () => {
  const prev: NetCounters = {
    interfaces: {
      eth0: { receiveBytes: 5_000_000, transmitBytes: 3_000_000 },
      wlan0: { receiveBytes: 2_000_000, transmitBytes: 1_500_000 },
    },
  };
  const curr: NetCounters = {
    interfaces: {
      eth0: { receiveBytes: 5_100_000, transmitBytes: 3_100_000 },
      wlan0: { receiveBytes: 100_000, transmitBytes: 1_600_000 },
    },
  };

  const rates = netRates(prev, curr, 60);
  assertEquals(rates.receiveBytesPerSecond, null);
  assertEquals(rates.transmitBytesPerSecond, null);
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

it("cpuPercentages nulls when current snapshot is missing", () => {
  const prev: CpuCounters = {
    user: 100,
    total: 1000,
    active: 100,
  };
  assertEquals(cpuPercentages(prev, null, 60).usage, null);
});

it("cpuPercentages nulls a field when that counter is undefined", () => {
  const prev: CpuCounters = {
    user: 100,
    system: 50,
    iowait: 10,
    total: 1000,
    active: 160,
  };
  const curr: CpuCounters = {
    user: 200,
    total: 1900,
    active: 310,
  };
  const pct = cpuPercentages(prev, curr, 60);
  assertEquals(pct.usage, (150 / 900) * 100);
  assertEquals(pct.system, null);
  assertEquals(pct.iowait, null);
});

it("netRates returns null on transmit-side counter reset", () => {
  const prev: NetCounters = {
    interfaces: {
      eth0: { receiveBytes: 5_000_000, transmitBytes: 3_000_000 },
    },
  };
  const curr: NetCounters = {
    interfaces: {
      eth0: { receiveBytes: 5_100_000, transmitBytes: 100_000 },
    },
  };
  const rates = netRates(prev, curr, 60);
  assertEquals(rates.receiveBytesPerSecond, null);
  assertEquals(rates.transmitBytesPerSecond, null);
});

it("long interval averages rate correctly", () => {
  assertEquals(rate(0, 6000, 120), 50);
});
