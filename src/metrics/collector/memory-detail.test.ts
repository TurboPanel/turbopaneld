import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "./baseline.ts";
import { buildMemoryDetailSample } from "./memory-detail.ts";

const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

test("buildMemoryDetailSample passes the 16 meminfo gauges through and rates default null on first observation", () => {
  const tracker = new CounterBaselineTracker();
  const sample = buildMemoryDetailSample({
    memText: fixture("proc-meminfo-detail.txt"),
    vmstatText: fixture("proc-vmstat-reclaim-1.txt"),
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.memoryFreeBytes, 2000000 * 1024);
  assertEquals(sample.activeAnonBytes, 700000 * 1024);
  assertEquals(sample.pageScanDirectPerSecond, null);
  assertEquals(sample.pageScanKswapdPerSecond, null);
  assertEquals(sample.compactionStallsPerSecond, null);
});

test("buildMemoryDetailSample computes reclaim/compaction rates from the second observation", () => {
  const tracker = new CounterBaselineTracker();
  buildMemoryDetailSample({
    memText: fixture("proc-meminfo-detail.txt"),
    vmstatText: fixture("proc-vmstat-reclaim-1.txt"),
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  const sample = buildMemoryDetailSample({
    memText: fixture("proc-meminfo-detail.txt"),
    vmstatText: fixture("proc-vmstat-reclaim-2.txt"),
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  if (!sample) throw new TypeError("expected a sample");
  // pgscan_direct: 2400 - 2000 = 400 over 60s.
  assertEquals(sample.pageScanDirectPerSecond, 400 / 60);
  // pgscan_kswapd: 10600 - 10000 = 600 over 60s.
  assertEquals(sample.pageScanKswapdPerSecond, 600 / 60);
  // compact_stall: 100 - 40 = 60 over 60s.
  assertEquals(sample.compactionStallsPerSecond, 1);
});

test("buildMemoryDetailSample returns null only when both /proc/meminfo and /proc/vmstat are unreadable", () => {
  const tracker = new CounterBaselineTracker();
  const sample = buildMemoryDetailSample({
    memText: undefined,
    vmstatText: undefined,
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  assertEquals(sample, null);
});

test("buildMemoryDetailSample still resolves gauge fields when only vmstat is unreadable", () => {
  const tracker = new CounterBaselineTracker();
  const sample = buildMemoryDetailSample({
    memText: fixture("proc-meminfo-detail.txt"),
    vmstatText: undefined,
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.memoryFreeBytes, 2000000 * 1024);
  assertEquals(sample.pageScanDirectPerSecond, null);
});
