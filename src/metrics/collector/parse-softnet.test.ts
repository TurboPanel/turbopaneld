import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "./baseline.ts";
import { parseSoftnetStat, softnetDropsPerSecond } from "./parse-softnet.ts";

const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

test("parseSoftnetStat sums the drop column across every CPU row", () => {
  assertEquals(parseSoftnetStat(fixture("proc-net-softnet-stat-1.txt")), 8);
  assertEquals(parseSoftnetStat(fixture("proc-net-softnet-stat-2.txt")), 17);
});

test("softnetDropsPerSecond computes correct rate math", () => {
  const tracker = new CounterBaselineTracker();
  softnetDropsPerSecond(8, 60, tracker, 0);
  const rate = softnetDropsPerSecond(17, 60, tracker, 0);
  assertEquals(rate, (17 - 8) / 60);
});

test("softnetDropsPerSecond nulls on first observation", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(softnetDropsPerSecond(8, 60, tracker, 0), null);
});

test("softnetDropsPerSecond re-baselines and nulls on a boot generation change", () => {
  const tracker = new CounterBaselineTracker();
  softnetDropsPerSecond(8, 60, tracker, 0);
  assertEquals(softnetDropsPerSecond(2, 60, tracker, 1), null);
  assertEquals(softnetDropsPerSecond(12, 60, tracker, 1), (12 - 2) / 60);
});
