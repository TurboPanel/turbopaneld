import { assertEquals } from "@std/assert";
import {
  MAX_STREAMING_RECEIPT_AGE_MS,
  StandbyStreamingTracker,
} from "./standby-streaming.ts";

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
      receiptAgeSeconds: 0,
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
  tracker.record(MEMBER, {
    state: "streaming",
    observedAt: AT,
    receiptAgeSeconds: 0,
  }, 5_000);
  tracker.record(MEMBER, { state: "stopped", observedAt: AT }, 9_000);
  tracker.record(
    MEMBER,
    { state: "streaming", observedAt: AT, lagBytes: 1, receiptAgeSeconds: 0 },
    2_000,
  );
  assertEquals(tracker.lastStreaming(MEMBER, 10_000), {
    at: AT,
    ageMs: 5_000,
  });
});

test("tracker never reports a negative age and forgets dropped members", () => {
  const tracker = new StandbyStreamingTracker();
  tracker.record(MEMBER, {
    state: "streaming",
    observedAt: AT,
    receiptAgeSeconds: 0,
  }, 5_000);
  assertEquals(tracker.lastStreaming(MEMBER, 1_000)?.ageMs, 0);
  tracker.retain(new Set(["other"]));
  assertEquals(tracker.lastStreaming(MEMBER, 6_000), undefined);
});

test("tracker refuses a 'streaming' read whose receiver has not heard from the primary lately", () => {
  const tracker = new StandbyStreamingTracker();
  // Silent link drop: still 'streaming', zero lag, but 20 s since a message.
  tracker.record(
    MEMBER,
    {
      state: "streaming",
      observedAt: AT,
      receiveLagBytes: 0,
      receiptAgeSeconds: 20,
    },
    9_000,
  );
  // An older daemon query (no receipt age) is not trusted either.
  tracker.record(MEMBER, { state: "streaming", observedAt: AT }, 9_000);
  assertEquals(tracker.lastStreaming(MEMBER, 10_000), undefined);
  assertEquals(MAX_STREAMING_RECEIPT_AGE_MS, 5_000);
});

test("tracker stamps the last receipt, not the read", () => {
  const tracker = new StandbyStreamingTracker();
  tracker.record(
    MEMBER,
    { state: "streaming", observedAt: AT, receiptAgeSeconds: 4 },
    10_000,
  );
  assertEquals(tracker.lastStreaming(MEMBER, 10_000)?.ageMs, 4_000);
});
