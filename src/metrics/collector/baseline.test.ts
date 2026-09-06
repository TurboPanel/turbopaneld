import { assertEquals } from "@std/assert";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

import { CounterBaselineTracker } from "./baseline.ts";

test("delta returns null on first observation and stores the baseline", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(tracker.delta("k", 100, 0), null);
  assertEquals(tracker.delta("k", 150, 0), 50);
});

test("delta computes a normal increase", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("k", 1000, 0);
  assertEquals(tracker.delta("k", 1400, 0), 400);
});

test("delta re-baselines and returns null on a boot generation change", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("k", 1000, 0);
  assertEquals(tracker.delta("k", 5, 1), null);
  // Next tick after the reboot computes cleanly from the new baseline.
  assertEquals(tracker.delta("k", 25, 1), 20);
});

test("delta re-baselines and returns null on a value decrease without a boot change", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("k", 1000, 0);
  assertEquals(tracker.delta("k", 100, 0), null);
  assertEquals(tracker.delta("k", 300, 0), 200);
});

test("independent keys never interfere", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("a", 100, 0);
  tracker.delta("b", 5000, 0);
  assertEquals(tracker.delta("a", 150, 0), 50);
  assertEquals(tracker.delta("b", 5100, 0), 100);
});

test("rate divides the delta by seconds", () => {
  const tracker = new CounterBaselineTracker();
  tracker.rate("k", 1000, 0, 10);
  assertEquals(tracker.rate("k", 1600, 0, 60), 10);
});

test("rate returns null when seconds <= 0, still re-baselining", () => {
  const tracker = new CounterBaselineTracker();
  tracker.rate("k", 1000, 0, 10);
  assertEquals(tracker.rate("k", 1600, 0, 0), null);
  assertEquals(tracker.rate("k", 1700, 0, 10), 10);
});

test("rate returns null on first observation", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(tracker.rate("k", 1000, 0, 60), null);
});

test("invalidate clears the baseline so the next tick is null, re-baselined, not a fabricated multi-interval rate", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("k", 1000, 0);
  tracker.invalidate("k");
  // A gap tick (source unreadable) is skipped entirely by the caller — no
  // delta()/rate() call happens for it, only invalidate().
  assertEquals(tracker.delta("k", 1400, 0), null);
  assertEquals(tracker.delta("k", 1500, 0), 100);
});

test("invalidate on an unknown key is a no-op", () => {
  const tracker = new CounterBaselineTracker();
  tracker.invalidate("never-seen");
  assertEquals(tracker.delta("never-seen", 100, 0), null);
});

test("invalidate only affects its own key", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("a", 100, 0);
  tracker.delta("b", 100, 0);
  tracker.invalidate("a");
  assertEquals(tracker.delta("a", 150, 0), null);
  assertEquals(tracker.delta("b", 150, 0), 50);
});

test("invalidatePrefix clears every key sharing the prefix, leaving others untouched", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("gpu:sysfs:g1:engine:rcs0", 1000, 0);
  tracker.delta("gpu:sysfs:g1:engine:bcs0", 2000, 0);
  tracker.delta("gpu:sysfs:g2:engine:rcs0", 3000, 0);
  tracker.invalidatePrefix("gpu:sysfs:g1:engine:");
  assertEquals(tracker.delta("gpu:sysfs:g1:engine:rcs0", 1400, 0), null);
  assertEquals(tracker.delta("gpu:sysfs:g1:engine:bcs0", 2400, 0), null);
  // A different gpuId sharing the "gpu:sysfs:" namespace is unaffected.
  assertEquals(tracker.delta("gpu:sysfs:g2:engine:rcs0", 3400, 0), 400);
});

test("invalidatePrefix with no matching keys is a no-op", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("a", 100, 0);
  tracker.invalidatePrefix("never-seen:");
  assertEquals(tracker.delta("a", 150, 0), 50);
});
