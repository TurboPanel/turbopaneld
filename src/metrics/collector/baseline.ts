/**
 * Generic, reusable counter-baseline layer for v5 collectors.
 *
 * Every cumulative-counter source in the v5 phase (diskstats, softnet, TCP
 * retransmission, vmstat, PSI totals, per-NIC directional counters) routes
 * through one `CounterBaselineTracker` instance instead of ad hoc
 * reset/first-sample handling scattered per module. Keys are caller-assembled
 * as `source:entity:counter` so every source shares one baseline map.
 *
 * Semantics, in order: no prior entry → `null` (first observation); a boot
 * generation change → re-baseline, `null` (never a fake spike across a
 * reboot); a value decrease with the same boot generation → re-baseline,
 * `null` (counter wrap, source restart, device replaced); otherwise the
 * delta (or the delta divided by `seconds` for `rate`).
 *
 * Membership-churn special-casing (a whole set of entities appearing/
 * vanishing together) stays the caller's job — baseline keys are per-entity,
 * not per-snapshot-set.
 */

type BaselineEntry = {
  value: number;
  bootGeneration: number;
  /** Tick time (ms) the value was read at; `null` when no tick time was set. */
  atMs: number | null;
};

export class CounterBaselineTracker {
  readonly #entries = new Map<string, BaselineEntry>();
  readonly #elapsedMs = new Map<string, number>();
  #tickMs: number | null = null;

  /**
   * Set the wall-clock time (ms) of the tick about to read counters. Each
   * baseline remembers the tick time it was stored at, so a rate can divide
   * by that counter's real elapsed time ({@link elapsedSeconds}) even when
   * ticks or reads were missed in between.
   */
  beginTick(nowMs: number): void {
    this.#tickMs = nowMs;
  }

  /**
   * Seconds between `key`'s previous baseline and its latest computed
   * {@link delta}; `fallbackSeconds` when no tick time was set or no delta
   * was computed yet.
   */
  elapsedSeconds(key: string, fallbackSeconds: number): number {
    const ms = this.#elapsedMs.get(key);
    return ms === undefined || ms <= 0 ? fallbackSeconds : ms / 1000;
  }

  /**
   * Per-interval delta for `key` given `currentValue`/`currentBootGeneration`.
   * `null` on first observation, boot-generation change, or a value decrease
   * (wrap/reset) — in every `null` case the baseline is re-stored under the
   * current value/generation so the *next* tick computes cleanly.
   */
  delta(
    key: string,
    currentValue: number,
    currentBootGeneration: number,
  ): number | null {
    const prior = this.#entries.get(key);
    this.#entries.set(key, {
      value: currentValue,
      bootGeneration: currentBootGeneration,
      atMs: this.#tickMs,
    });
    this.#elapsedMs.delete(key);

    if (!prior) return null;
    if (prior.bootGeneration !== currentBootGeneration) return null;
    if (currentValue < prior.value) return null;
    if (prior.atMs !== null && this.#tickMs !== null) {
      this.#elapsedMs.set(key, this.#tickMs - prior.atMs);
    }
    return currentValue - prior.value;
  }

  /** Same contract as {@link delta}, divided by `seconds`; `null` when `seconds <= 0`. */
  rate(
    key: string,
    currentValue: number,
    currentBootGeneration: number,
    seconds: number,
  ): number | null {
    const delta = this.delta(key, currentValue, currentBootGeneration);
    if (delta === null) return null;
    if (seconds <= 0) return null;
    return delta / seconds;
  }

  /**
   * Drop `key`'s baseline. Call this whenever a cumulative source/entity is
   * absent or unreadable this tick — an unreadable tick must never leave a
   * stale pre-gap baseline in place, since the *next* readable tick would
   * otherwise diff against it and compress however many missed intervals
   * elapsed into one fabricated rate. The next `delta`/`rate` call for `key`
   * then behaves exactly like a first observation: `null`, re-baselined.
   */
  invalidate(key: string): void {
    this.#entries.delete(key);
    this.#elapsedMs.delete(key);
  }

  /**
   * {@link invalidate} for a whole key namespace at once. For a key space
   * that fans out per-sub-entity at read time (e.g. one entry per GPU
   * engine name, discovered fresh every tick) the invalidating caller
   * cannot enumerate every live sub-key up front — dropping everything
   * under `prefix` gives the same "next read re-origins" guarantee without
   * requiring that enumeration.
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.invalidate(key);
    }
  }
}

/** Production-wiring default instance — one per collector lifetime, mirroring `#previous`. */
export const defaultCounterBaseline = new CounterBaselineTracker();
