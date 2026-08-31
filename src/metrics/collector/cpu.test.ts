import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { cpuPercentagesV2, EMPTY_CPU_PERCENTAGES } from "./cpu.ts";
import { parseStat } from "./parse-stat.ts";
import type { CpuCounters } from "./types.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("cpuPercentagesV2 computes all eight percentages from jiffie deltas", () => {
  const prev = parseStat(fixture("proc-stat-full-fields-1.txt"));
  const curr = parseStat(fixture("proc-stat-full-fields-2.txt"));
  const pct = cpuPercentagesV2(prev, curr, 60);

  // Deltas: user 900, nice 50, system 300, idle 7200, iowait 180, irq 50,
  // softirq 80, steal 40 → total 8800.
  const deltaTotal = 8800;
  assertEquals(pct.userPercent, (900 / deltaTotal) * 100);
  assertEquals(pct.nicePercent, (50 / deltaTotal) * 100);
  assertEquals(pct.systemPercent, (300 / deltaTotal) * 100);
  assertEquals(pct.idlePercent, (7200 / deltaTotal) * 100);
  assertEquals(pct.iowaitPercent, (180 / deltaTotal) * 100);
  assertEquals(pct.irqPercent, (50 / deltaTotal) * 100);
  assertEquals(pct.softirqPercent, (80 / deltaTotal) * 100);
  assertEquals(pct.stealPercent, (40 / deltaTotal) * 100);
});

it("cpuPercentagesV2 never collapses user and nice into one field", () => {
  const prev: CpuCounters = {
    user: 100,
    nice: 50,
    system: 50,
    idle: 800,
    total: 1000,
    active: 200,
  };
  const curr: CpuCounters = {
    user: 300,
    nice: 150,
    system: 150,
    idle: 1400,
    total: 2000,
    active: 600,
  };
  const pct = cpuPercentagesV2(prev, curr, 60);
  assertEquals(pct.userPercent, 20);
  assertEquals(pct.nicePercent, 10);
});

it("cpuPercentagesV2 nulls everything without both snapshots or a positive interval", () => {
  const counters: CpuCounters = { user: 100, total: 1000, active: 100 };
  assertEquals(cpuPercentagesV2(null, counters, 60), EMPTY_CPU_PERCENTAGES);
  assertEquals(cpuPercentagesV2(counters, null, 60), EMPTY_CPU_PERCENTAGES);
  assertEquals(
    cpuPercentagesV2(counters, counters, 0),
    EMPTY_CPU_PERCENTAGES,
  );
});

it("cpuPercentagesV2 nulls when the total delta is non-positive", () => {
  const prev: CpuCounters = { user: 100, total: 1000, active: 100 };
  const curr: CpuCounters = { user: 100, total: 1000, active: 100 };
  assertEquals(cpuPercentagesV2(prev, curr, 60), EMPTY_CPU_PERCENTAGES);
});

it("cpuPercentagesV2 nulls a field when its counter is missing or reset", () => {
  const prev: CpuCounters = {
    user: 100,
    nice: 50,
    system: 50,
    idle: 800,
    total: 1000,
    active: 200,
  };
  const curr: CpuCounters = {
    user: 200,
    nice: 10, // reset — smaller than prev
    idle: 1690,
    total: 1900,
    active: 210,
  };
  const pct = cpuPercentagesV2(prev, curr, 60);
  assertEquals(pct.userPercent, (100 / 900) * 100);
  assertEquals(pct.nicePercent, null);
  assertEquals(pct.systemPercent, null);
  assertEquals(pct.iowaitPercent, null);
  assertEquals(pct.idlePercent, (890 / 900) * 100);
});

it("short /proc/stat lines still produce the four base percentages", () => {
  const prev = parseStat("cpu  5000 100 2000 10000\n");
  const curr = parseStat("cpu  5900 150 2300 17200\n");
  const pct = cpuPercentagesV2(prev, curr, 60);
  const deltaTotal = 8450;
  assertEquals(pct.userPercent, (900 / deltaTotal) * 100);
  assertEquals(pct.nicePercent, (50 / deltaTotal) * 100);
  assertEquals(pct.systemPercent, (300 / deltaTotal) * 100);
  assertEquals(pct.idlePercent, (7200 / deltaTotal) * 100);
  assertEquals(pct.iowaitPercent, null);
  assertEquals(pct.irqPercent, null);
  assertEquals(pct.softirqPercent, null);
  assertEquals(pct.stealPercent, null);
});
