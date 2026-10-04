/**
 * Remembers recently seen command ids so a command-dispatch frame that is
 * delivered twice (a resend, or a frame replayed after a reconnect) is never
 * run twice.
 */
export class SeenCommandIds {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(ttlMs = 60 * 60_000, max = 2_000) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  /** True when `id` was already seen (and still remembered); records it otherwise. */
  seenBefore(id: string, now = Date.now()): boolean {
    this.#evict(now);
    if (this.#seen.has(id)) return true;
    this.#seen.set(id, now);
    return false;
  }

  #evict(now: number): void {
    for (const [id, at] of this.#seen) {
      if (now - at < this.#ttlMs && this.#seen.size <= this.#max) break;
      this.#seen.delete(id);
    }
  }
}
