import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { BlockDeviceSample } from "../../contracts/metrics-contract.ts";
import {
  buildHostExtended,
  mdArrayCounts,
  pidLimitUsedPercent,
  rootDiskOpsPerSecond,
} from "./extended-host.ts";

const LOADAVG = "0.48 0.37 0.35 1/306 151909\n";

const DISK: BlockDeviceSample = {
  deviceId: "blk:sda",
  readBytesPerSecond: null,
  writeBytesPerSecond: null,
  readOpsPerSecond: 3,
  writeOpsPerSecond: 4.5,
  readLatencyMs: null,
  writeLatencyMs: null,
  utilizationPercent: null,
  queueDepth: 0.25,
};

Deno.test("pidLimitUsedPercent divides all tasks by the smaller kernel limit", () => {
  assertAlmostEquals(
    pidLimitUsedPercent(LOADAVG, "4194304\n", "7040\n") ?? NaN,
    (306 / 7040) * 100,
  );
  assertAlmostEquals(
    pidLimitUsedPercent(LOADAVG, "32768\n", "999999\n") ?? NaN,
    (306 / 32768) * 100,
  );
});

Deno.test("pidLimitUsedPercent works with one limit, clamps, and is null when unknown", () => {
  assertAlmostEquals(
    pidLimitUsedPercent(LOADAVG, undefined, "612\n") ?? NaN,
    50,
  );
  assertEquals(pidLimitUsedPercent(LOADAVG, "100\n", undefined), 100);
  assertEquals(pidLimitUsedPercent(LOADAVG, undefined, undefined), null);
  assertEquals(pidLimitUsedPercent(LOADAVG, "0\n", "junk"), null);
  assertEquals(pidLimitUsedPercent(undefined, "4096\n", "4096\n"), null);
  assertEquals(pidLimitUsedPercent("garbage", "4096\n", "4096\n"), null);
});

const MDSTAT = `Personalities : [raid1]
md0 : active raid1 sdb1[1] sda1[0]
      976630336 blocks super 1.2 [2/2] [UU]

md1 : active raid1 sdd1[1]
      976630336 blocks super 1.2 [2/1] [U_]
      [==>..................]  recovery = 12.6% (123/976) finish=50.0min speed=100K/sec

md2 : active raid1 sdf1[1] sde1[0]
      1000 blocks super 1.2 [2/2] [UU]
      [=>...................]  resync = 5.0% (50/1000) finish=5min speed=100K/sec

unused devices: <none>
`;

Deno.test("mdArrayCounts counts degraded and resyncing arrays separately", () => {
  assertEquals(mdArrayCounts(MDSTAT), { degraded: 1, resyncing: 2 });
  assertEquals(mdArrayCounts("Personalities :\nunused devices: <none>\n"), {
    degraded: 0,
    resyncing: 0,
  });
});

Deno.test("mdArrayCounts reports zero arrays when there is no mdstat file", () => {
  assertEquals(mdArrayCounts(undefined), { degraded: 0, resyncing: 0 });
});

Deno.test("rootDiskOpsPerSecond adds reads and writes, null unless both are known", () => {
  assertEquals(rootDiskOpsPerSecond(DISK), 7.5);
  assertEquals(
    rootDiskOpsPerSecond({ ...DISK, writeOpsPerSecond: null }),
    null,
  );
  assertEquals(rootDiskOpsPerSecond(undefined), null);
});

Deno.test("buildHostExtended keeps only what is known and never invents zeros", () => {
  assertEquals(
    buildHostExtended({
      loadavgText: LOADAVG,
      pidMaxText: "612\n",
      threadsMaxText: undefined,
      mdstatText: undefined,
      oomKills: 2,
      rootDisk: DISK,
    }),
    {
      pidLimitUsedPercent: 50,
      oomKills: 2,
      rootDiskQueueDepth: 0.25,
      rootDiskOpsPerSecond: 7.5,
      mdArraysDegraded: 0,
      mdArraysResyncing: 0,
    },
  );
  assertEquals(
    buildHostExtended({
      loadavgText: undefined,
      pidMaxText: undefined,
      threadsMaxText: undefined,
      mdstatText: undefined,
      oomKills: null,
      rootDisk: undefined,
    }),
    { mdArraysDegraded: 0, mdArraysResyncing: 0 },
  );
});

Deno.test("buildHostExtended carries IRQ pressure when the kernel reports it and leaves it out when it does not", () => {
  const base = {
    loadavgText: undefined,
    pidMaxText: undefined,
    threadsMaxText: undefined,
    mdstatText: undefined,
    oomKills: null,
    rootDisk: undefined,
  };
  assertEquals(
    buildHostExtended({ ...base, irqPressureFullPercent: 1.5 })
      ?.irqPressureFullPercent,
    1.5,
  );
  assertEquals(
    "irqPressureFullPercent" in
      (buildHostExtended({ ...base, irqPressureFullPercent: null }) ?? {}),
    false,
  );
});
