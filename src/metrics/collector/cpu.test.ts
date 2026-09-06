import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  cpuBusyPercentV4,
  cpuIrqPercentV4,
  EMPTY_CPU_PERCENTAGES_V4,
  maxCoreBusyPercentV4,
} from "./cpu.ts";
import { parseStat, parseStatPerCoreLines } from "./parse-stat.ts";
import type { CpuCounters } from "./types.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("cpuBusyPercentV4 de-duplicates guest/guest_nice out of user/nice", () => {
  const prev = parseStat(fixture("proc-stat-guest-fields-1.txt"));
  const curr = parseStat(fixture("proc-stat-guest-fields-2.txt"));
  const pct = cpuBusyPercentV4(prev, curr, 60);

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

it("cpuBusyPercentV4 defines busy as 100 - idle - iowait - steal, not 100 - idle alone", () => {
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
  const pct = cpuBusyPercentV4(prev, curr, 60);
  // idle=70%, iowait=10%, steal=10% -> busy = 100 - 70 - 10 - 10 = 10%, NOT 30%.
  assertEquals(pct.busyPercent, 10);
});

it("cpuBusyPercentV4 nulls without both snapshots or a positive interval", () => {
  const counters: CpuCounters = { user: 100, total: 1000, active: 100 };
  assertEquals(cpuBusyPercentV4(null, counters, 60), EMPTY_CPU_PERCENTAGES_V4);
  assertEquals(cpuBusyPercentV4(counters, null, 60), EMPTY_CPU_PERCENTAGES_V4);
  assertEquals(
    cpuBusyPercentV4(counters, counters, 0),
    EMPTY_CPU_PERCENTAGES_V4,
  );
});

it("maxCoreBusyPercentV4 picks the correct saturated core, exposing hidden single-core saturation", () => {
  const prevCores = parseStatPerCoreLines(fixture("proc-stat-percore-1.txt"));
  const currCores = parseStatPerCoreLines(fixture("proc-stat-percore-2.txt"));
  const max = maxCoreBusyPercentV4(prevCores, currCores, 60);
  // cpu0 is ~3.33% busy, cpu1 is ~96.67% busy, aggregate looks like 50%.
  assertEquals(max, (2900 / 3000) * 100);
});

it("maxCoreBusyPercentV4 ignores a core missing from either snapshot", () => {
  const prevCores = parseStatPerCoreLines(fixture("proc-stat-percore-1.txt"));
  const currCores = {
    ...parseStatPerCoreLines(fixture("proc-stat-percore-2.txt")),
  };
  delete currCores["1"];
  const max = maxCoreBusyPercentV4(prevCores, currCores, 60);
  // Only cpu0 (~3.33% busy) remains comparable.
  assertEquals(max, 100 - (2900 / 3000) * 100);
});

it("maxCoreBusyPercentV4 returns null when zero cores compute cleanly", () => {
  assertEquals(maxCoreBusyPercentV4({}, {}, 60), null);
});

it("cpuIrqPercentV4 sums irq+softirq deltas over the same deltaTotal denominator", () => {
  const prev = parseStat(fixture("proc-stat-full-fields-1.txt"));
  const curr = parseStat(fixture("proc-stat-full-fields-2.txt"));
  const pct = cpuIrqPercentV4(prev, curr);
  // Deltas: irq 50, softirq 80, deltaTotal 8800 (see the percentages test above).
  assertEquals(pct, ((50 + 80) / 8800) * 100);
});

it("cpuIrqPercentV4 nulls without both snapshots or a non-positive deltaTotal", () => {
  const counters: CpuCounters = { user: 100, total: 1000, active: 100 };
  assertEquals(cpuIrqPercentV4(null, counters), null);
  assertEquals(cpuIrqPercentV4(counters, null), null);
  assertEquals(cpuIrqPercentV4(counters, counters), null);
});
