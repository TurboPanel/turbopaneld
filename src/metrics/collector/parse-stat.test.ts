import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  cpuLineFieldCount,
  parseStat,
  parseStatCpuLine,
  parseStatPerCoreLines,
  parseStatProcs,
  parseStatScalarCounters,
} from "./parse-stat.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseStat extracts aggregate cpu counters with iowait", () => {
  const cpu = parseStat(fixture("proc-stat-2.txt"));
  assertEquals(cpu !== null, true);
  assertEquals(cpu!.iowait, 1000);
  assertEquals(cpu!.irq, 500);
  assertEquals(cpu!.softirq, 200);
  assertEquals(cpu!.steal, 50);
});

it("parseStatCpuLine computes total and active", () => {
  const line = fixture("proc-stat-2.txt").split("\n")[0]!;
  const cpu = parseStatCpuLine(line);
  assertEquals(cpu !== null, true);
  const expectedTotal = 10109153 + 0 + 3419523 + 370685200 + 1000 + 500 + 200 +
    50;
  assertEquals(cpu!.total, expectedTotal);
  assertEquals(cpu!.active, expectedTotal - 370685200 - 1000);
});

it("parseStat tolerates short distro field sets", () => {
  const cpu = parseStat(fixture("proc-stat-short-fields.txt"));
  assertEquals(cpu !== null, true);
  assertEquals(cpu!.user, 5000);
  assertEquals(cpu!.idle, 10000);
  assertEquals(cpu!.iowait, undefined);
  assertEquals(cpu!.total, 5000 + 100 + 2000 + 10000);
});

it("cpuLineFieldCount reports jiffies field count", () => {
  const shortLine = fixture("proc-stat-short-fields.txt").split("\n")[0]!;
  assertEquals(cpuLineFieldCount(shortLine), 4);
  const fullLine = fixture("proc-stat-2.txt").split("\n")[0]!;
  assertEquals(cpuLineFieldCount(fullLine), 10);
});

it("parseStat returns null for invalid input", () => {
  assertEquals(parseStat(""), null);
  assertEquals(parseStat("\ncpu 1 2 3 4"), null);
  assertEquals(parseStat("not cpu line\n"), null);
  assertEquals(parseStatCpuLine("cpu nan nan nan nan"), null);
  assertEquals(parseStatCpuLine("cpu 1 2 3"), null);
  assertEquals(cpuLineFieldCount("cpu"), null);
  assertEquals(cpuLineFieldCount(""), null);
  assertEquals(cpuLineFieldCount("cpu0 1 2"), null);
});

it("parseStatCpuLine tolerates a non-finite trailing iowait field", () => {
  const cpu = parseStatCpuLine("cpu 1 2 3 4 nan");
  if (!cpu) throw new TypeError("expected counters with undefined iowait");
  assertEquals(cpu.user, 1);
  assertEquals(cpu.idle, 4);
  assertEquals(cpu.iowait, undefined);
  assertEquals(cpu.total, 10);
});

it("parseStatCpuLine captures guest/guest_nice without adding them to total", () => {
  const cpu = parseStat(fixture("proc-stat-guest-fields-1.txt"));
  if (!cpu) throw new TypeError("expected guest-field counters");
  assertEquals(cpu.guest, 100);
  assertEquals(cpu.guestNice, 20);
  // total sums only the eight base fields — guest ticks are already inside
  // user/nice per kernel accounting, so adding them again would double-count.
  assertEquals(cpu.total, 10000 + 500 + 3000 + 80000 + 1000 + 200 + 300 + 400);
});

it("parseStatPerCoreLines keys per-core counters by core index", () => {
  const cores = parseStatPerCoreLines(fixture("proc-stat-percore-1.txt"));
  assertEquals(Object.keys(cores).sort(), ["0", "1"]);
  assertEquals(cores["0"].user, 10000);
  assertEquals(cores["0"].idle, 89000);
  assertEquals(cores["1"].user, 10000);
  assertEquals(cores["1"].idle, 86000);
});

it("parseStatProcs parses procs_running/procs_blocked, defaulting to null", () => {
  assertEquals(
    parseStatProcs(fixture("proc-stat-percore-1.txt")),
    { running: 1, blocked: 0 },
  );
  assertEquals(parseStatProcs("cpu 1 2 3 4\n"), {
    running: null,
    blocked: null,
  });
});

it("parseStatScalarCounters parses ctxt/processes/intr", () => {
  const scalars = parseStatScalarCounters(fixture("proc-stat-percore-1.txt"));
  assertEquals(scalars.ctxt, 456);
  assertEquals(scalars.processes, 10);
  assertEquals(scalars.intr, 123);
});
