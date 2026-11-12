/**
 * Live TurboFabric peer readings: while `tp0` exists, re-read
 * `wg show tp0 dump` every {@link FABRIC_PEER_REFRESH_INTERVAL_MS} so the
 * cached handshake times (`getLastObservedFabricPeers` in `fabric.ts`) never
 * go stale between reconciles. Without this the cache only moved when a
 * reconcile or path probe ran, and healthy tunnels read as `stale` a few
 * minutes after each apply.
 *
 * One timer per process, never two reads at once (a slow `wg` skips the next
 * tick instead of stacking). The timer starts only once the daemon has armed
 * it at boot (`entry/run.ts`), so tests that apply a fabric never leave an
 * interval behind; it stops as soon as a read finds no `tp0` (pause,
 * teardown, or the interface removed by hand). Listeners (the control-plane
 * reporter) hear every successful read.
 */

import type { FabricReconcileObservedPeer } from "../contracts/commands-contracts.ts";
import { logWarn } from "../util/logger.ts";

/** Refresh cadence while `tp0` exists. */
export const FABRIC_PEER_REFRESH_INTERVAL_MS = 60_000;

/**
 * A cached reading older than this (three missed refreshes) says nothing
 * about the tunnel now: readers treat it as no reading rather than `stale`.
 */
export const FABRIC_PEER_READING_MAX_AGE_MS = 3 *
  FABRIC_PEER_REFRESH_INTERVAL_MS;

/** One refreshed reading of every `tp0` peer. */
export type FabricPeerReading = {
  peers: FabricReconcileObservedPeer[];
  /** When the dump was read (ISO). */
  observedAt: string;
};

export type FabricPeerReadingListener = (reading: FabricPeerReading) => void;

export type FabricPeerRefresherOptions = {
  /** Re-reads the peers; `null` when `tp0` does not exist. */
  refresh: () => Promise<FabricPeerReading | null>;
  intervalMs?: number;
};

export class FabricPeerRefresher {
  readonly #refresh: () => Promise<FabricPeerReading | null>;
  readonly #intervalMs: number;
  readonly #listeners = new Set<FabricPeerReadingListener>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #armed = false;
  #inFlight = false;

  constructor(options: FabricPeerRefresherOptions) {
    this.#refresh = options.refresh;
    this.#intervalMs = options.intervalMs ?? FABRIC_PEER_REFRESH_INTERVAL_MS;
  }

  /** Allow {@link start} to run a timer (once, at daemon boot). */
  arm(): void {
    this.#armed = true;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  /** Start the timer when armed and not already running. Idempotent. */
  start(): void {
    if (!this.#armed || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    Deno.unrefTimer(this.#timer);
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Stop and disarm (tests). */
  reset(): void {
    this.stop();
    this.#armed = false;
    this.#listeners.clear();
  }

  subscribe(listener: FabricPeerReadingListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** One read; stops the timer when `tp0` is gone. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      const reading = await this.#refresh();
      if (reading === null) {
        this.stop();
        return;
      }
      this.#notify(reading);
    } catch (err) {
      logWarn(
        "commands",
        `TurboFabric peer refresh failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.#inFlight = false;
    }
  }

  #notify(reading: FabricPeerReading): void {
    for (const listener of this.#listeners) {
      try {
        listener(reading);
      } catch (err) {
        logWarn(
          "commands",
          `TurboFabric peer listener failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
