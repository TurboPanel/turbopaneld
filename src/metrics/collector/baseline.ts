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
};

export class CounterBaselineTracker {
  readonly #entries = new Map<string, BaselineEntry>();

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
    });

    if (!prior) return null;
    if (prior.bootGeneration !== currentBootGeneration) return null;
    if (currentValue < prior.value) return null;
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
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }
}

/** Production-wiring default instance — one per collector lifetime, mirroring `#previous`. */
export const defaultCounterBaseline = new CounterBaselineTracker();
