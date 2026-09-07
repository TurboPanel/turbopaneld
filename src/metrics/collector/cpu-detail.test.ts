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
    currCores: parseStatPerCoreLines(statText),
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
    currCores: {},
    tracker,
    bootGeneration: 0,
    seconds: 60,
  });
  assertEquals(sample, null);
});
