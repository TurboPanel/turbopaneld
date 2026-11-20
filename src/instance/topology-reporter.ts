/**
 * Periodic + event-driven `topology-report` emission over the daemon
 * WebSocket. Wraps `collectTopology()` with a per-attach "already collecting"
 * guard — the same drop-not-queue discipline `MetricsScheduler`'s
 * `#activeEmitGeneration` follows — so an interval tick racing a forced
 * recompute can never run two collects at once.
 *
 * Sends only when the collected topology's identity key differs from the last
 * one this attach reported (`../metrics/topology/identity-key.ts`) — cosmetic
 * re-collects (nothing changed) never resend — except the very first collect
 * after {@link TopologyReporter.attach}, which always sends so the control
 * plane records the topology on connect/startup without waiting for a later
 * phase.
 */
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import type { TopologySnapshot } from "../contracts/topology-types.ts";
import type { CollectedTopology } from "../metrics/topology/topology.ts";
import { topologyIdentityKey } from "../metrics/topology/identity-key.ts";

/** Steady recheck cadence — catches organic hardware changes with no operator override push. */
export const TOPOLOGY_REPORT_INTERVAL_MS = 60_000;

export type TopologyReport = {
  snapshot: TopologySnapshot;
  at: string;
};

export type TopologyReportSink = (report: TopologyReport) => void;

/** The reported snapshot: the collected topology without the local boot generation. */
export function topologyForReport(
  collected: CollectedTopology,
): TopologySnapshot {
  const { bootGeneration: _bootGeneration, ...snapshot } = collected;
  return snapshot;
}

export type TopologyReporterOptions = {
  collectTopology: () => Promise<CollectedTopology>;
  intervalMs?: number;
  now?: () => string;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onLog?: (message: string) => void;
};

export class TopologyReporter {
  readonly #collectTopology: () => Promise<CollectedTopology>;
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #setIntervalFn: typeof setInterval;
  readonly #clearIntervalFn: typeof clearInterval;
  readonly #onLog: (message: string) => void;

  #send: TopologyReportSink | undefined;
  #intervalTimer: ReturnType<typeof setInterval> | undefined;
  #lastReportedKey: string | undefined;
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
   * the "last reported" key so the new session always gets an initial report,
   * even if this process already reported that same topology on a prior
   * session.
   */
  attach(send: TopologyReportSink): void {
    this.detach();
    this.#send = send;
    this.#lastReportedKey = undefined;
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
   * Force an out-of-band recompute, so a change is reported without waiting
   * for the next scheduled tick. A no-op when not attached, or when a collect
   * from the timer (or a previous call) is still in flight.
   */
  async reportNow(): Promise<void> {
    const send = this.#send;
    if (!send) return;
    if (this.#collecting) return;
    this.#collecting = true;
    try {
      const snapshot = topologyForReport(await this.#collectTopology());
      if (this.#send !== send) return; // detached mid-collect
      const key = topologyIdentityKey(snapshot);
      if (key === this.#lastReportedKey) return;
      this.#lastReportedKey = key;
      send({ snapshot, at: this.#now() });
    } catch (err) {
      this.#onLog(`collect failed: ${sanitizeForLog(err)}`);
    } finally {
      this.#collecting = false;
    }
  }
}
