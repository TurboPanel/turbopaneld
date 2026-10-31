/**
 * Report a changed package-source signing key to the control plane.
 *
 * The playbook runner remembers each change in the {@link RepoKeyLedger}
 * (`orchestration/repo-key-changes.ts`) as pending. This reporter sends one
 * `repo-key-changed` frame per pending change, only to a control plane
 * advertising `repo-key-report-v1`, and marks it sent only after the frame
 * went out on an open socket. A converge that ran before the socket was up, or
 * against an older control plane, therefore keeps its notice until a report
 * can be delivered. Fire-and-forget: the control plane sends no answer.
 */

import type { DaemonMessage } from "../contracts/cell-messages.ts";
import type {
  RepoKeyChange,
  RepoKeyLedger,
} from "../orchestration/repo-key-changes.ts";
import { forEachSequential } from "../util/sequential.ts";
import { logWarn } from "../util/logger.ts";

export type RepoKeyReporterOptions = {
  /** Send one frame; false when the socket is not open. */
  send: (message: DaemonMessage) => boolean;
  /** True while the control plane advertises `repo-key-report-v1`. */
  peerSupportsReport: () => boolean;
  ledger: () => RepoKeyLedger;
  nowMs?: () => number;
};

export class RepoKeyReporter {
  readonly #options: RepoKeyReporterOptions;
  #unsubscribe: (() => void) | undefined;
  #flushing: Promise<void> | undefined;
  #running = false;
  #again = false;

  constructor(options: RepoKeyReporterOptions) {
    this.#options = options;
  }

  /** Start reporting: flush what is waiting now and whatever the runner adds later. */
  attach(): void {
    this.detach();
    try {
      this.#unsubscribe = this.#options.ledger().subscribe(() => {
        void this.flush();
      });
    } catch (err) {
      logWarn("instance", "repo key reporter could not start:", String(err));
      return;
    }
    void this.flush();
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Send every pending change once. Safe to call often; never rejects. */
  flush(): Promise<void> {
    if (this.#running && this.#flushing !== undefined) {
      this.#again = true;
      return this.#flushing;
    }
    this.#running = true;
    const run = this.#flushLoop().finally(() => {
      this.#running = false;
    });
    this.#flushing = run;
    return run;
  }

  async #flushLoop(): Promise<void> {
    this.#again = true;
    while (this.#again) {
      this.#again = false;
      await this.#flushOnce().catch((err) =>
        logWarn("instance", "repo key report failed:", String(err))
      );
    }
  }

  async #flushOnce(): Promise<void> {
    if (!this.#options.peerSupportsReport()) return;
    const ledger = this.#options.ledger();
    const nowMs = this.#options.nowMs ?? Date.now;
    let open = true;
    await forEachSequential(await ledger.pending(), async (change) => {
      if (!open) return;
      open = this.#options.send(frameFor(change, nowMs()));
      if (open) await ledger.markSent(change);
    });
  }
}

function frameFor(change: RepoKeyChange, nowMs: number): DaemonMessage {
  return {
    type: "repo-key-changed",
    keyName: change.name,
    expected: change.expected,
    got: change.got,
    at: new Date(nowMs).toISOString(),
  };
}
