import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "./baseline.ts";
import { buildCpuDetailSample } from "./cpu-detail.ts";
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

/** Test-only stable-id stand-in — real ids come from `topology/cpu-topology.ts`. */
function coreIdOf(key: string): string {
  return `cpu:p0c${key}t0`;
}

test("buildCpuDetailSample selects hotspots, frequency range, and scalar rates", async () => {
  const statText1 = fixture("proc-stat-percore-1.txt");
  const statText2 = fixture("proc-stat-percore-2.txt");
  const prevCores = parseStatPerCoreLines(statText1);
  const currCores = parseStatPerCoreLines(statText2);
  const tracker = new CounterBaselineTracker();

  await buildCpuDetailSample({
    io: CPUFREQ_IO,
    sysRoot: "/sys",
    statText: statText1,
    prevCpu: null,
    currCpu: parseStat(statText1),
    prevCores: {},
    currCores: prevCores,
    coreIdOf,
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });

  const sample = await buildCpuDetailSample({
    io: CPUFREQ_IO,
    sysRoot: "/sys",
    statText: statText2,
    prevCpu: parseStat(statText1),
    currCpu: parseStat(statText2),
    prevCores,
    currCores,
    coreIdOf,
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  if (!sample) throw new TypeError("expected a sample");

  assertEquals(sample.hotspots.map((h) => h.coreId), [
    "cpu:p0c1t0",
    "cpu:p0c0t0",
  ]);
  assertEquals(sample.averageFrequencyMHz, (2400 + 3200) / 2);
  assertEquals(sample.minimumFrequencyMHz, 2400);
  assertEquals(sample.maximumFrequencyMHz, 3200);
  // ctxt: 457 - 456 = 1 over 60s; processes: 11 - 10 = 1 over 60s; intr: 124 - 123 = 1 over 60s.
  assertEquals(sample.contextSwitchesPerSecond, 1 / 60);
  assertEquals(sample.forksPerSecond, 1 / 60);
  assertEquals(sample.interruptsPerSecond, 1 / 60);
});

test("buildCpuDetailSample falls back to cpuinfo_cur_freq when scaling_cur_freq is absent", async () => {
  const statText = fixture("proc-stat-percore-1.txt");
  const io = memoryIo({
    "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq": "1800000",
    "/sys/devices/system/cpu/cpu1/cpufreq/cpuinfo_cur_freq": "1800000",
  });
  const tracker = new CounterBaselineTracker();
  const sample = await buildCpuDetailSample({
    io,
    sysRoot: "/sys",
    statText,
    prevCpu: null,
    currCpu: parseStat(statText),
    prevCores: {},
    currCores: parseStatPerCoreLines(statText),
    coreIdOf,
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  if (!sample) throw new TypeError("expected a sample");
  assertEquals(sample.averageFrequencyMHz, 1800);
});

test("buildCpuDetailSample returns null when /proc/stat itself is unreadable", async () => {
  const tracker = new CounterBaselineTracker();
  const sample = await buildCpuDetailSample({
    io: CPUFREQ_IO,
    sysRoot: "/sys",
    statText: undefined,
    prevCpu: null,
    currCpu: null,
    prevCores: {},
    currCores: {},
    coreIdOf,
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  assertEquals(sample, null);
});
