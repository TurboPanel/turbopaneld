/**
 * Live-metrics leases — enforced entirely on the daemon.
 *
 * The control plane grants a lease (`metrics-live-start`) with an explicit
 * expiry it computed from the admin session cap; this manager tracks lease
 * expiry locally and drives the scheduler cadence: any active lease means the
 * live interval, none means baseline. A local expiry timer returns cadence to
 * baseline even when the paired `metrics-live-stop` is lost, so no external
 * nudge is ever required. Leases are never persisted — a daemon restart or
 * socket reconnect constructs a fresh manager and starts at baseline.
 */
import type { MetricsCollectionMode } from "./contract.ts";
import { METRICS_INTERVAL_MS } from "./scheduler.ts";

/** Live cadence while at least one lease is active. */
export const LIVE_METRICS_INTERVAL_MS = 10_000;

/** The one scheduler surface this manager drives. */
export type LiveLeaseSchedulerLike = {
  setIntervalMs(ms: number): void;
};

export type LiveLeaseManagerOptions = {
  scheduler: LiveLeaseSchedulerLike;
  liveIntervalMs?: number;
  baselineIntervalMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

export class LiveLeaseManager {
  readonly #scheduler: LiveLeaseSchedulerLike;
  readonly #liveIntervalMs: number;
  readonly #baselineIntervalMs: number;
  readonly #now: () => number;
  readonly #setTimeoutFn: typeof setTimeout;
  readonly #clearTimeoutFn: typeof clearTimeout;

  readonly #leases = new Map<string, { expiresAtMs: number }>();
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: LiveLeaseManagerOptions) {
    this.#scheduler = options.scheduler;
    this.#liveIntervalMs = options.liveIntervalMs ?? LIVE_METRICS_INTERVAL_MS;
    this.#baselineIntervalMs = options.baselineIntervalMs ??
      METRICS_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.#clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  /**
   * Start (or renew — every renewal is an explicit call, never automatic) a
   * lease with the control-plane-computed expiry. An already-past expiry is
   * rejected so an expired lease cannot silently re-enter live cadence.
   */
  start(leaseId: string, expiresAtMs: number): void {
    if (typeof leaseId !== "string" || leaseId.length === 0) {
      throw new TypeError("leaseId must be a non-empty string");
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.#now()) {
      throw new TypeError("expiresAtMs must be in the future");
    }
    this.#leases.set(leaseId, { expiresAtMs });
    this.#applyCadence();
    this.#armExpiryTimer();
  }

  /** Stop a lease; the last stop returns cadence to baseline immediately. */
  stop(leaseId: string): void {
    this.#leases.delete(leaseId);
    this.#applyCadence();
    this.#armExpiryTimer();
  }

  /** Drop every lease and return to baseline (socket close / client stop). */
  dispose(): void {
    this.#leases.clear();
    this.#applyCadence();
    this.#armExpiryTimer();
  }

  hasActiveLease(): boolean {
    const now = this.#now();
    for (const lease of this.#leases.values()) {
      if (lease.expiresAtMs > now) return true;
    }
    return false;
  }

  effectiveIntervalMs(): number {
    return this.hasActiveLease()
      ? this.#liveIntervalMs
      : this.#baselineIntervalMs;
  }

  collectionMode(): MetricsCollectionMode {
    return this.hasActiveLease() ? "live" : "baseline";
  }

  #applyCadence(): void {
    this.#scheduler.setIntervalMs(this.effectiveIntervalMs());
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [leaseId, lease] of this.#leases) {
      if (lease.expiresAtMs <= now) this.#leases.delete(leaseId);
    }
  }

  /** (Re)arm the local expiry timer for the earliest-expiring lease. */
  #armExpiryTimer(): void {
    if (this.#expiryTimer !== undefined) {
      this.#clearTimeoutFn(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    let earliestMs: number | undefined;
    for (const lease of this.#leases.values()) {
      if (earliestMs === undefined || lease.expiresAtMs < earliestMs) {
        earliestMs = lease.expiresAtMs;
      }
    }
    if (earliestMs === undefined) return;
    const delayMs = Math.max(0, earliestMs - this.#now());
    this.#expiryTimer = this.#setTimeoutFn(() => {
      this.#expiryTimer = undefined;
      this.#purgeExpired();
      this.#applyCadence();
      this.#armExpiryTimer();
    }, delayMs);
  }
}
