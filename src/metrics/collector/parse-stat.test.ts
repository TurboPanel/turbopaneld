import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  cpuLineFieldCount,
  parseStat,
  parseStatCpuLine,
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
