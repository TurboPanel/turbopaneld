import { assertEquals } from "@std/assert";
import { StandbyStreamingTracker } from "./standby-streaming.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` and would report Deno suites as empty.
 */
const test = Deno.test.bind(Deno);

const MEMBER = "00000000-0000-4000-8000-000000000001";
const AT = "2026-10-03T00:00:00.000Z";

test("tracker remembers the last streaming read and its monotonic age", () => {
  const tracker = new StandbyStreamingTracker();
  assertEquals(tracker.lastStreaming(MEMBER, 0), undefined);
  tracker.record(
    MEMBER,
    {
      state: "streaming",
      observedAt: AT,
      lagBytes: 8,
      lagSeconds: 1,
      receiveLagBytes: 512,
    },
    1_000,
  );
  assertEquals(tracker.lastStreaming(MEMBER, 4_000), {
    at: AT,
    ageMs: 3_000,
    lagBytes: 8,
    lagSeconds: 1,
    receiveLagBytes: 512,
  });
});

test("tracker ignores non-streaming and out-of-order reads", () => {
  const tracker = new StandbyStreamingTracker();
  tracker.record(MEMBER, { state: "streaming", observedAt: AT }, 5_000);
  tracker.record(MEMBER, { state: "stopped", observedAt: AT }, 9_000);
  tracker.record(
    MEMBER,
    { state: "streaming", observedAt: AT, lagBytes: 1 },
    2_000,
  );
  assertEquals(tracker.lastStreaming(MEMBER, 10_000), {
    at: AT,
    ageMs: 5_000,
  });
});

test("tracker never reports a negative age and forgets dropped members", () => {
  const tracker = new StandbyStreamingTracker();
  tracker.record(MEMBER, { state: "streaming", observedAt: AT }, 5_000);
  assertEquals(tracker.lastStreaming(MEMBER, 1_000)?.ageMs, 0);
  tracker.retain(new Set(["other"]));
  assertEquals(tracker.lastStreaming(MEMBER, 6_000), undefined);
});
