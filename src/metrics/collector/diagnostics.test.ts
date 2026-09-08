import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "./baseline.ts";
import { buildDiagnosticsSample, type DiagnosticsDeps } from "./diagnostics.ts";
import { parseStat, parseStatPerCoreLines } from "./parse-stat.ts";
import type { SensorIo } from "./sensors/discovery.ts";

const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

function memoryIo(files: Record<string, string | undefined>): SensorIo {
  return {
    listDir: () => [],
    readFile: (path: string) => files[path],
  };
}

const CPUFREQ_IO = memoryIo({
  "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq": "2400000",
  "/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq": "3200000",
});

/** Every dep defaulted to "nothing readable"; each test overrides only what it exercises. */
function deps(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    io: CPUFREQ_IO,
    sysRoot: "/sys",
    statText: undefined,
    memText: undefined,
    vmstatText: undefined,
    prevCpu: null,
    currCpu: null,
    currCores: {},
    tracker: new CounterBaselineTracker(),
    bootGeneration: 0,
    seconds: 60,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CPU half
// ---------------------------------------------------------------------------

test("buildDiagnosticsSample falls back to cpuinfo_cur_freq when scaling_cur_freq is absent", async () => {
  const statText = fixture("proc-stat-percore-1.txt");
  const sample = await buildDiagnosticsSample(deps({
    io: memoryIo({
      "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq": "1800000",
      "/sys/devices/system/cpu/cpu1/cpufreq/cpuinfo_cur_freq": "1800000",
    }),
    statText,
    currCpu: parseStat(statText),
    currCores: parseStatPerCoreLines(statText),
  }));
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.cpu.averageFrequencyMHz, 1800);
});

test("buildDiagnosticsSample keeps CPU scheduling rates null when /proc/stat is unreadable", async () => {
  const sample = await buildDiagnosticsSample(deps({
    vmstatText: fixture("proc-vmstat-reclaim-1.txt"),
  }));
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.cpu.contextSwitchesPerSecond, null);
  assertEquals(sample.cpu.interruptsPerSecond, null);
  assertEquals(sample.cpu.forksPerSecond, null);
});

// ---------------------------------------------------------------------------
// Memory half
// ---------------------------------------------------------------------------

test("buildDiagnosticsSample passes the meminfo gauges through and rates default null on first observation", async () => {
  const sample = await buildDiagnosticsSample(deps({
    memText: fixture("proc-meminfo-detail.txt"),
    vmstatText: fixture("proc-vmstat-reclaim-1.txt"),
  }));
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.memory.memoryFreeBytes, 2000000 * 1024);
  assertEquals(sample.memory.pageScanDirectPerSecond, null);
  assertEquals(sample.memory.pageScanKswapdPerSecond, null);
  assertEquals(sample.memory.compactionStallsPerSecond, null);
});

test("buildDiagnosticsSample computes reclaim/compaction rates from the second observation", async () => {
  const tracker = new CounterBaselineTracker();
  await buildDiagnosticsSample(deps({
    memText: fixture("proc-meminfo-detail.txt"),
    vmstatText: fixture("proc-vmstat-reclaim-1.txt"),
    tracker,
  }));
  const sample = await buildDiagnosticsSample(deps({
    memText: fixture("proc-meminfo-detail.txt"),
    vmstatText: fixture("proc-vmstat-reclaim-2.txt"),
    tracker,
  }));
  if (!sample) throw new TypeError("expected a sample");
  // pgscan_direct: 2400 - 2000 = 400 over 60s.
  assertEquals(sample.memory.pageScanDirectPerSecond, 400 / 60);
  // pgscan_kswapd: 10600 - 10000 = 600 over 60s.
  assertEquals(sample.memory.pageScanKswapdPerSecond, 600 / 60);
  // compact_stall: 100 - 40 = 60 over 60s.
  assertEquals(sample.memory.compactionStallsPerSecond, 1);
});

test("buildDiagnosticsSample keeps every meminfo gauge null when only vmstat is readable", async () => {
  const sample = await buildDiagnosticsSample(deps({
    vmstatText: fixture("proc-vmstat-reclaim-1.txt"),
  }));
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.memory.memoryFreeBytes, null);
  assertEquals(sample.memory.cachedBytes, null);
  assertEquals(sample.memory.anonPagesBytes, null);
  assertEquals(sample.memory.slabReclaimableBytes, null);
  assertEquals(sample.memory.slabUnreclaimableBytes, null);
  assertEquals(sample.memory.dirtyBytes, null);
  assertEquals(sample.memory.writebackBytes, null);
  assertEquals(sample.memory.shmemBytes, null);
  assertEquals(sample.memory.committedAsBytes, null);
  assertEquals(sample.memory.pageScanDirectPerSecond, null);
});

test("buildDiagnosticsSample still resolves gauge fields when only vmstat is unreadable", async () => {
  const sample = await buildDiagnosticsSample(deps({
    memText: fixture("proc-meminfo-detail.txt"),
  }));
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.memory.memoryFreeBytes, 2000000 * 1024);
  assertEquals(sample.memory.pageScanDirectPerSecond, null);
});

// ---------------------------------------------------------------------------
// Whole-family gating — the halves degrade independently, and only a tick
// with no readable source at all drops the row.
// ---------------------------------------------------------------------------

test("buildDiagnosticsSample returns null only when stat, meminfo and vmstat are all unreadable", async () => {
  assertEquals(await buildDiagnosticsSample(deps()), null);
});

test("buildDiagnosticsSample still reports the CPU half when only /proc/stat is readable", async () => {
  const statText = fixture("proc-stat-percore-1.txt");
  const sample = await buildDiagnosticsSample(deps({
    statText,
    currCpu: parseStat(statText),
    currCores: parseStatPerCoreLines(statText),
  }));
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.cpu.averageFrequencyMHz, 2800);
  assertEquals(sample.memory.memoryFreeBytes, null);
});
