/**
 * Presence gating for entities that exist but report nothing (a GPU whose
 * driver returns no values, a sensor signal stuck at `null`). An entity is
 * dropped once it has produced no value for {@link PRESENCE_WINDOW_SAMPLES}
 * consecutive samples and returns the moment it reports a value again.
 * This is not write-on-change suppression: a dropped entity is absent, not
 * unchanged, and `host.system` stays the liveness row.
 */

export const PRESENCE_WINDOW_SAMPLES = 5;

export class PresenceTracker {
  readonly #nullRuns = new Map<string, number>();

  /** Record one sample for `id`; `true` while it should still be reported. */
  observe(id: string, hasValue: boolean): boolean {
    if (hasValue) {
      this.#nullRuns.set(id, 0);
      return true;
    }
    const run = (this.#nullRuns.get(id) ?? 0) + 1;
    this.#nullRuns.set(id, run);
    return run < PRESENCE_WINDOW_SAMPLES;
  }

  /** Keep the items whose series is still present; every item is observed. */
  filter<T>(
    items: readonly T[],
    idOf: (item: T) => string,
    hasValue: (item: T) => boolean,
  ): T[] {
    return items.filter((item) => this.observe(idOf(item), hasValue(item)));
  }
}
