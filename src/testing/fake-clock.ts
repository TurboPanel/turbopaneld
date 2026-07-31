/**
 * Test-only helpers — do not import from production code.
 *
 * Deterministic wall clock + delay scheduler for hermetic timing tests.
 * IdlePresence already accepts injectable idleCheckIntervalMs /
 * idleThresholdMs / minPresenceIntervalMs / staleConnectionMs /
 * maxConnectionAgeMs — shrink those constructor options
 * (e.g. idleCheckIntervalMs: 20) rather than mocking Date.now. Keep setInterval
 * real but small; faking setInterval globally is out of scope (Deno's resource
 * sanitizer already flags unflushed intervals).
 *
 * For client.ts backoff/session timers and token-manager.ts's retry delay,
 * install() wires the same clock into installClientTimeSource() and
 * installTokenManagerTimeSource() so advance() resolves pending delay()
 * promises without real sleeps.
 */

import { installClientTimeSource } from "../instance/client.ts";
import { installTokenManagerTimeSource } from "../instance/token-manager.ts";

type ScheduledDelay = {
  dueAt: number;
  resolve: () => void;
};

export type FakeClock = {
  now(): number;
  /** Queue a promise resolved when {@link advance} reaches `now + ms`. */
  delay(ms: number): Promise<void>;
  /** Advance wall time and resolve due {@link delay} promises. */
  advance(ms: number): Promise<void>;
  /**
   * Patch `Date.now` and wire client/token-manager `now`/`delay` to this clock.
   * Returns a restore function.
   */
  install(): () => void;
};

export function createFakeClock(options: { now?: number } = {}): FakeClock {
  let current = options.now ?? Date.now();
  const scheduled: ScheduledDelay[] = [];

  function now(): number {
    return current;
  }

  function delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      scheduled.push({ dueAt: current + ms, resolve });
    });
  }

  async function advance(ms: number): Promise<void> {
    if (ms < 0) {
      throw new TypeError("advance(ms) requires a non-negative duration");
    }
    current += ms;
    const due = scheduled
      .filter((entry) => entry.dueAt <= current)
      .sort((a, b) => a.dueAt - b.dueAt);
    for (const entry of due) {
      const index = scheduled.indexOf(entry);
      if (index >= 0) scheduled.splice(index, 1);
      entry.resolve();
    }
    await flushMicrotasks();
  }

  function install(): () => void {
    const originalNow = Date.now;
    Date.now = () => current;
    const restoreClient = installClientTimeSource({ now, delay });
    const restoreTokenManager = installTokenManagerTimeSource({ now, delay });
    return () => {
      Date.now = originalNow;
      restoreClient();
      restoreTokenManager();
    };
  }

  return { now, delay, advance, install };
}

/** Drain pending microtasks (Promise jobs) without advancing wall time. */
export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
