import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  cpuBusyPercentV5,
  cpuIrqPercentV5,
  EMPTY_CPU_PERCENTAGES_V5,
  saturatedCoreCountV5,
} from "./cpu.ts";
import { parseStat } from "./parse-stat.ts";
import type { CpuCounters } from "./types.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

/**
 * A `/proc/stat` per-core snapshot carrying `busy` active ticks and `idle`
 * idle ticks. `busyPercent` is derived as `100 - idle% - iowait% - steal%`
 * against the `total` delta, so all four must be present for a clean read.
 */
function cpuCounters(busy: number, idle = 0): CpuCounters {
  return {
    user: busy,
    idle,
    iowait: 0,
    steal: 0,
    active: busy,
    total: busy + idle,
  };
}

it("cpuBusyPercentV5 de-duplicates guest/guest_nice out of user/nice", () => {
  const prev = parseStat(fixture("proc-stat-guest-fields-1.txt"));
  const curr = parseStat(fixture("proc-stat-guest-fields-2.txt"));
  const pct = cpuBusyPercentV5(prev, curr, 60);

  const deltaTotal = 8800;
  const idlePercent = (7200 / deltaTotal) * 100;
  const iowaitPercent = (180 / deltaTotal) * 100;
  const stealPercent = (40 / deltaTotal) * 100;
  const expectedBusy = 100 - idlePercent - iowaitPercent - stealPercent;
  const expectedUser = ((900 - 50) / deltaTotal) * 100 +
    ((50 - 10) / deltaTotal) * 100;

  assertEquals(pct.busyPercent, expectedBusy);
  assertEquals(pct.userPercent, expectedUser);
  assertEquals(pct.systemPercent, (300 / deltaTotal) * 100);
  assertEquals(pct.iowaitPercent, iowaitPercent);
  assertEquals(pct.stealPercent, stealPercent);
  assertEquals(pct.softirqPercent, (80 / deltaTotal) * 100);
});

it("cpuBusyPercentV5 defines busy as 100 - idle - iowait - steal, not 100 - idle alone", () => {
  const prev: CpuCounters = {
    user: 0,
    idle: 0,
    iowait: 0,
    steal: 0,
    total: 0,
    active: 0,
  };
  const curr: CpuCounters = {
    user: 100,
    idle: 700,
    iowait: 100,
    steal: 100,
    total: 1000,
    active: 300,
  };
  const pct = cpuBusyPercentV5(prev, curr, 60);
  // idle=70%, iowait=10%, steal=10% -> busy = 100 - 70 - 10 - 10 = 10%, NOT 30%.
  assertEquals(pct.busyPercent, 10);
});

it("cpuBusyPercentV5 nulls without both snapshots or a positive interval", () => {
  const counters: CpuCounters = { user: 100, total: 1000, active: 100 };
  assertEquals(cpuBusyPercentV5(null, counters, 60), EMPTY_CPU_PERCENTAGES_V5);
  assertEquals(cpuBusyPercentV5(counters, null, 60), EMPTY_CPU_PERCENTAGES_V5);
  assertEquals(
    cpuBusyPercentV5(counters, counters, 0),
    EMPTY_CPU_PERCENTAGES_V5,
  );
});

it("cpuIrqPercentV5 sums irq+softirq deltas over the same deltaTotal denominator", () => {
  const prev = parseStat(fixture("proc-stat-full-fields-1.txt"));
  const curr = parseStat(fixture("proc-stat-full-fields-2.txt"));
  const pct = cpuIrqPercentV5(prev, curr);
  // Deltas: irq 50, softirq 80, deltaTotal 8800 (see the percentages test above).
  assertEquals(pct, ((50 + 80) / 8800) * 100);
});

it("cpuIrqPercentV5 nulls without both snapshots or a non-positive deltaTotal", () => {
  const counters: CpuCounters = { user: 100, total: 1000, active: 100 };
  assertEquals(cpuIrqPercentV5(null, counters), null);
  assertEquals(cpuIrqPercentV5(counters, null), null);
  assertEquals(cpuIrqPercentV5(counters, counters), null);
});

it("saturatedCoreCountV5 counts only cores at or above the saturation threshold", () => {
  const prevCores = {
    "0": cpuCounters(0),
    "1": cpuCounters(0),
    "2": cpuCounters(0),
  };
  const currCores = {
    "0": cpuCounters(6000, 0),
    "1": cpuCounters(600, 5400),
    "2": cpuCounters(5400, 600),
  };
  assertEquals(saturatedCoreCountV5(prevCores, currCores, 60), 2);
});

it("saturatedCoreCountV5 ignores a core missing from either snapshot", () => {
  const prevCores = { "0": cpuCounters(0) };
  const currCores = { "0": cpuCounters(6000, 0), "1": cpuCounters(6000, 0) };
  assertEquals(saturatedCoreCountV5(prevCores, currCores, 60), 1);
});

it("saturatedCoreCountV5 returns null when zero cores compute cleanly, never 0", () => {
  assertEquals(saturatedCoreCountV5({}, {}, 60), null);
});

it("saturatedCoreCountV5 reports 0 on a fully idle host", () => {
  const prevCores = { "0": cpuCounters(0) };
  const currCores = { "0": cpuCounters(0, 6000) };
  assertEquals(saturatedCoreCountV5(prevCores, currCores, 60), 0);
});
