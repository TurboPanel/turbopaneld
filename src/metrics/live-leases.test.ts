import { assertEquals, assertThrows } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  LIVE_METRICS_INTERVAL_MS,
  LiveLeaseManager,
} from "./live-leases.ts";
import { METRICS_INTERVAL_MS } from "./scheduler.ts";

type TimerHandle = { id: number };
type TimeoutEntry = {
  id: number;
  due: number;
  fn: () => void;
  cleared: boolean;
};

/** Deterministic clock + timeout fake mirroring scheduler.test.ts. */
class FakeClock {
  #nowMs: number;
  #nextId = 1;
  readonly #timeouts: TimeoutEntry[] = [];

  constructor(startMs = 0) {
    this.#nowMs = startMs;
  }

  now = (): number => this.#nowMs;

  setTimeoutFn = (fn: () => void, ms: number): TimerHandle => {
    const id = this.#nextId++;
    this.#timeouts.push({ id, due: this.#nowMs + ms, fn, cleared: false });
    return { id };
  };

  clearTimeoutFn = (handle: TimerHandle | number): void => {
    const id = typeof handle === "number" ? handle : handle.id;
    const entry = this.#timeouts.find((t) => t.id === id);
    if (entry) entry.cleared = true;
  };

  advance(ms: number): void {
    const target = this.#nowMs + ms;
    while (true) {
      let soonest: TimeoutEntry | undefined;
      for (const t of this.#timeouts) {
        if (t.cleared) continue;
        if (soonest === undefined || t.due < soonest.due) soonest = t;
      }
      if (soonest === undefined || soonest.due > target) {
        this.#nowMs = target;
        return;
      }
      this.#nowMs = soonest.due;
      soonest.cleared = true;
      soonest.fn();
    }
  }
}

/** Scheduler stub recording every cadence change. */
function fakeScheduler(): {
  intervals: number[];
  setIntervalMs: (ms: number) => void;
} {
  const intervals: number[] = [];
  return {
    intervals,
    setIntervalMs(ms: number) {
      intervals.push(ms);
    },
  };
}

function makeManager(clock: FakeClock) {
  const scheduler = fakeScheduler();
  const manager = new LiveLeaseManager({
    scheduler,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn as unknown as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeoutFn as unknown as typeof clearTimeout,
  });
  return { scheduler, manager };
}

it("LiveLeaseManager start flips cadence 60s→10s", () => {
  const clock = new FakeClock();
  const { scheduler, manager } = makeManager(clock);

  assertEquals(manager.hasActiveLease(), false);
  assertEquals(manager.effectiveIntervalMs(), METRICS_INTERVAL_MS);
  assertEquals(manager.collectionMode(), "baseline");

  manager.start("lease-1", clock.now() + 60_000);
  assertEquals(manager.hasActiveLease(), true);
  assertEquals(manager.effectiveIntervalMs(), LIVE_METRICS_INTERVAL_MS);
  assertEquals(manager.collectionMode(), "live");
  assertEquals(scheduler.intervals, [LIVE_METRICS_INTERVAL_MS]);
});

it("LiveLeaseManager explicit stop returns to 60s immediately", () => {
  const clock = new FakeClock();
  const { scheduler, manager } = makeManager(clock);

  manager.start("lease-1", clock.now() + 60_000);
  clock.advance(10_000);
  manager.stop("lease-1");

  assertEquals(manager.hasActiveLease(), false);
  assertEquals(manager.collectionMode(), "baseline");
  assertEquals(scheduler.intervals, [
    LIVE_METRICS_INTERVAL_MS,
    METRICS_INTERVAL_MS,
  ]);
});

it("LiveLeaseManager lost stop: local expiry timer returns to 60s", () => {
  const clock = new FakeClock();
  const { scheduler, manager } = makeManager(clock);

  manager.start("lease-1", clock.now() + 60_000);
  assertEquals(manager.collectionMode(), "live");

  // No stop ever arrives — the local timer alone restores baseline.
  clock.advance(59_999);
  assertEquals(manager.collectionMode(), "live");
  clock.advance(1);
  assertEquals(manager.hasActiveLease(), false);
  assertEquals(manager.collectionMode(), "baseline");
  assertEquals(scheduler.intervals, [
    LIVE_METRICS_INTERVAL_MS,
    METRICS_INTERVAL_MS,
  ]);
});

it("two viewers: one cadence change up, one down on last stop", () => {
  const clock = new FakeClock();
  const { scheduler, manager } = makeManager(clock);

  manager.start("lease-1", clock.now() + 60_000);
  manager.start("lease-2", clock.now() + 90_000);
  // Both starts request live — the scheduler treats the repeat as a no-op,
  // so no extra cadence transition happens.
  assertEquals(scheduler.intervals, [
    LIVE_METRICS_INTERVAL_MS,
    LIVE_METRICS_INTERVAL_MS,
  ]);

  manager.stop("lease-1");
  // Second lease still active — cadence stays live.
  assertEquals(manager.collectionMode(), "live");
  assertEquals(scheduler.intervals.at(-1), LIVE_METRICS_INTERVAL_MS);

  manager.stop("lease-2");
  assertEquals(manager.collectionMode(), "baseline");
  assertEquals(scheduler.intervals.at(-1), METRICS_INTERVAL_MS);
});

it("two viewers: expiry of the longer lease un-cadences after the shorter stops", () => {
  const clock = new FakeClock();
  const { scheduler, manager } = makeManager(clock);

  manager.start("lease-1", clock.now() + 30_000);
  manager.start("lease-2", clock.now() + 60_000);

  clock.advance(30_000); // lease-1 expires locally; lease-2 keeps live
  assertEquals(manager.collectionMode(), "live");

  clock.advance(30_000); // lease-2 expires
  assertEquals(manager.collectionMode(), "baseline");
  assertEquals(scheduler.intervals.at(-1), METRICS_INTERVAL_MS);
});

it("no silent renewal: a start past expiresAt is rejected", () => {
  const clock = new FakeClock(100_000);
  const { manager } = makeManager(clock);

  manager.start("lease-1", clock.now() + 10_000);
  clock.advance(10_000);
  assertEquals(manager.collectionMode(), "baseline");

  // Renewing an expired lease requires a future expiry from a new explicit
  // control-plane call — a stale expiry never re-enters live mode.
  assertThrows(
    () => manager.start("lease-1", clock.now() - 1),
    TypeError,
  );
  assertThrows(() => manager.start("lease-1", Number.NaN), TypeError);
  assertEquals(manager.collectionMode(), "baseline");
});

it("explicit renewal with a future expiry extends the same lease", () => {
  const clock = new FakeClock();
  const { manager } = makeManager(clock);

  manager.start("lease-1", clock.now() + 10_000);
  clock.advance(5_000);
  manager.start("lease-1", clock.now() + 10_000);

  clock.advance(9_999);
  assertEquals(manager.collectionMode(), "live");
  clock.advance(1);
  assertEquals(manager.collectionMode(), "baseline");
});

it("dispose drops every lease and restores baseline", () => {
  const clock = new FakeClock();
  const { scheduler, manager } = makeManager(clock);

  manager.start("lease-1", clock.now() + 60_000);
  manager.start("lease-2", clock.now() + 60_000);
  manager.dispose();

  assertEquals(manager.hasActiveLease(), false);
  assertEquals(manager.collectionMode(), "baseline");
  assertEquals(scheduler.intervals.at(-1), METRICS_INTERVAL_MS);

  // No stray timer fires later.
  clock.advance(120_000);
  assertEquals(scheduler.intervals.at(-1), METRICS_INTERVAL_MS);
});

it("start rejects an empty leaseId", () => {
  const clock = new FakeClock();
  const { manager } = makeManager(clock);
  assertThrows(() => manager.start("", clock.now() + 1_000), TypeError);
});

it("full 10s live session against a real scheduler-shaped stub", () => {
  const clock = new FakeClock();
  const { scheduler, manager } = makeManager(clock);

  // 60s baseline → viewer opens the panel → 10s live for the session,
  // then a clean stop at the end.
  manager.start("viewer-lease", clock.now() + 10_000);
  assertEquals(scheduler.intervals, [LIVE_METRICS_INTERVAL_MS]);
  clock.advance(9_000);
  assertEquals(manager.collectionMode(), "live");
  manager.stop("viewer-lease");
  assertEquals(scheduler.intervals, [
    LIVE_METRICS_INTERVAL_MS,
    METRICS_INTERVAL_MS,
  ]);
});
