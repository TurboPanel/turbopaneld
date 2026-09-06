import { assertEquals } from "@std/assert";
import { buildCpuCoreLiveSamples } from "./cpu-core-live.ts";
import { parseStatPerCoreLines } from "./parse-stat.ts";

const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

/** Test-only stable-id stand-in — real ids come from `topology/cpu-topology.ts`. */
function coreIdOf(key: string): string {
  return `cpu:p0c${key}t0`;
}

test("buildCpuCoreLiveSamples emits one entry per online core, sorted by numeric index", () => {
  const prevCores = parseStatPerCoreLines(fixture("proc-stat-percore-1.txt"));
  const currCores = parseStatPerCoreLines(fixture("proc-stat-percore-2.txt"));
  const samples = buildCpuCoreLiveSamples(prevCores, currCores, 60, coreIdOf);

  assertEquals(samples.map((s) => s.coreId), ["cpu:p0c0t0", "cpu:p0c1t0"]);
  // cpu0: idle delta 2900/3000 -> busy = 100 - idle% (matches cpuBusyPercentV4's own computation, avoiding a separately-rounded expectation).
  assertEquals(samples[0].busyPercent, 100 - (2900 / 3000) * 100);
  assertEquals(samples[1].busyPercent, 100 - (100 / 3000) * 100);
});

test("buildCpuCoreLiveSamples drops a core missing from either snapshot", () => {
  const prevCores = parseStatPerCoreLines(fixture("proc-stat-percore-1.txt"));
  const currCores = {
    ...parseStatPerCoreLines(fixture("proc-stat-percore-2.txt")),
  };
  delete currCores["1"];
  const samples = buildCpuCoreLiveSamples(prevCores, currCores, 60, coreIdOf);
  assertEquals(samples.map((s) => s.coreId), ["cpu:p0c0t0"]);
});

test("buildCpuCoreLiveSamples sorts by the numeric /proc/stat key, not the stable id string", () => {
  const prevCores = parseStatPerCoreLines(fixture("proc-stat-percore-1.txt"));
  const currCores = parseStatPerCoreLines(fixture("proc-stat-percore-2.txt"));
  // A stable id that sorts lexicographically backwards from its numeric key
  // (e.g. "z1" < "z0" is false, but here we invert the mapping) still comes
  // out in numeric-key order, proving the sort key is the /proc/stat key.
  const reversedIdOf = (key: string) => `cpu:p0c${9 - Number(key)}t0`;
  const samples = buildCpuCoreLiveSamples(
    prevCores,
    currCores,
    60,
    reversedIdOf,
  );
  assertEquals(samples.map((s) => s.coreId), ["cpu:p0c9t0", "cpu:p0c8t0"]);
});

test("buildCpuCoreLiveSamples returns [] when zero cores compute cleanly", () => {
  assertEquals(buildCpuCoreLiveSamples({}, {}, 60, coreIdOf), []);
});
