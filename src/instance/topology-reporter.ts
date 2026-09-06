/**
 * Periodic + event-driven `topology-report` emission over the daemon
 * WebSocket. Wraps `collectTopology()` (which itself persists/re-stamps the
 * topology generation on every call, see `../metrics/topology/generation.ts`)
 * with a per-attach "already collecting" guard — the same drop-not-queue
 * discipline `MetricsScheduler`'s `#activeEmitGeneration` follows — so an
 * interval tick racing a forced recompute (right after
 * `topology-overrides-update`) can never make `resolveTopologyGeneration`'s
 * tmp-write+rename race itself.
 *
 * Sends only when the collected generation differs from the last one this
 * attach reported — cosmetic re-collects (nothing changed) never resend —
 * except the very first collect after {@link TopologyReporter.attach}, which
 * always sends so the control plane starts recording generations on
 * connect/startup without waiting for a later phase.
 */
import { logWarn, sanitizeForLog } from "../logger.ts";
import type { TopologySnapshot } from "../metrics/topology/types.ts";

/** Steady recheck cadence — catches organic hardware changes with no operator override push. */
export const TOPOLOGY_REPORT_INTERVAL_MS = 60_000;

export type TopologyReport = {
  generation: number;
  bootGeneration: number;
  snapshot: TopologySnapshot;
  at: string;
};

export type TopologyReportSink = (report: TopologyReport) => void;

export type TopologyReporterOptions = {
  collectTopology: () => Promise<TopologySnapshot>;
  intervalMs?: number;
  now?: () => string;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onLog?: (message: string) => void;
};

export class TopologyReporter {
  readonly #collectTopology: () => Promise<TopologySnapshot>;
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #setIntervalFn: typeof setInterval;
  readonly #clearIntervalFn: typeof clearInterval;
  readonly #onLog: (message: string) => void;

  #send: TopologyReportSink | undefined;
  #intervalTimer: ReturnType<typeof setInterval> | undefined;
  #lastReportedGeneration: number | undefined;
  /** `true` while a collect is in flight — an overlapping call is dropped, never queued. */
  #collecting = false;

  constructor(options: TopologyReporterOptions) {
    this.#collectTopology = options.collectTopology;
    this.#intervalMs = options.intervalMs ?? TOPOLOGY_REPORT_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#setIntervalFn = options.setIntervalFn ?? setInterval;
    this.#clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.#onLog = options.onLog ??
      ((message) => logWarn("topology-report", message));
  }

  /**
   * Begin reporting to `send`: an immediate report (connect/startup), then a
   * steady recheck every `intervalMs`. Re-attaching (e.g. a reconnect) resets
   * the "last reported generation" so the new session always gets an initial
   * report, even if this process already reported that same generation on a
   * prior session.
   */
  attach(send: TopologyReportSink): void {
    this.detach();
    this.#send = send;
    this.#lastReportedGeneration = undefined;
    void this.reportNow();
    this.#intervalTimer = this.#setIntervalFn(() => {
      void this.reportNow();
    }, this.#intervalMs);
  }

  detach(): void {
    if (this.#intervalTimer !== undefined) {
      this.#clearIntervalFn(this.#intervalTimer);
      this.#intervalTimer = undefined;
    }
    this.#send = undefined;
  }

  /**
   * Force an out-of-band recompute — e.g. right after an operator override
   * push, so a slot reassignment is reported without waiting for the next
   * scheduled tick. A no-op when not attached, or when a collect from the
   * timer (or a previous call) is still in flight.
   */
  async reportNow(): Promise<void> {
    const send = this.#send;
    if (!send) return;
    if (this.#collecting) return;
    this.#collecting = true;
    try {
      const snapshot = await this.#collectTopology();
      if (this.#send !== send) return; // detached mid-collect
      if (snapshot.generation === this.#lastReportedGeneration) return;
      this.#lastReportedGeneration = snapshot.generation;
      send({
        generation: snapshot.generation,
        bootGeneration: snapshot.bootGeneration,
        snapshot,
        at: this.#now(),
      });
    } catch (err) {
      this.#onLog(`collect failed: ${sanitizeForLog(err)}`);
    } finally {
      this.#collecting = false;
    }
  }
}
