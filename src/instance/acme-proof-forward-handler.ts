/**
 * The helper side of central certificate issuance (feature `acme-issue-v1`):
 * `acme-proof-forward` starts passing the HTTP-proof path on to the issuing
 * server and is answered with `acme-proof-forward-ready` or `-failed`;
 * `acme-proof-forward-end` withdraws it. A forward also withdraws itself when
 * its stated time passes, and a sweep at start-up removes any that outlived a
 * restart, so a forward never stays behind.
 *
 * Old control planes never send these messages, so nothing changes for them.
 */

import type {
  AcmeProofForwardEndMessage,
  AcmeProofForwardMessage,
  AcmeProofForwardReportMessage,
} from "../contracts/cell-messages.ts";
import {
  validateAcmeProofForwardEndFields,
  validateAcmeProofForwardFields,
} from "../contracts/cell-messages.ts";
import {
  listProofForwards,
  startProofForward,
  withdrawProofForwards,
} from "../deploy/acme-proof-forward.ts";
import { withHostingSitesLock } from "../deploy/ingress.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";

export type ProofForwardHandlerDeps = {
  layout: LayoutPaths;
  /** Sends one message to the control plane; false when the link is down. */
  send: (message: AcmeProofForwardReportMessage) => boolean;
  now?: () => number;
  /** Test seam: schedules the expiry; returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  start?: typeof startProofForward;
  withdraw?: typeof withdrawProofForwards;
  list?: typeof listProofForwards;
};

/** A timer must not keep the daemon alive, and a delay past 24 days overflows. */
const MAX_TIMER_MS = 2_000_000_000;

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, Math.min(ms, MAX_TIMER_MS));
  Deno.unrefTimer(id);
  return () => clearTimeout(id);
}

export class ProofForwardHandler {
  readonly #deps: ProofForwardHandlerDeps;
  readonly #cancels = new Map<string, () => void>();

  constructor(deps: ProofForwardHandlerDeps) {
    this.#deps = deps;
  }

  #report(
    type: AcmeProofForwardReportMessage["type"],
    requestId: string,
    reason?: string,
  ): void {
    this.#deps.send({
      type,
      requestId,
      ...(reason === undefined ? {} : { reason }),
      at: new Date((this.#deps.now ?? Date.now)()).toISOString(),
    });
  }

  async handleForward(message: AcmeProofForwardMessage): Promise<void> {
    const problem = validateAcmeProofForwardFields(
      message as unknown as Record<string, unknown>,
    );
    if (problem !== null) {
      // Without a usable request id there is nothing to answer.
      if (typeof message.requestId === "string") {
        this.#report("acme-proof-forward-failed", message.requestId, problem);
      }
      return;
    }
    const start = this.#deps.start ?? startProofForward;
    let result;
    try {
      result = await withHostingSitesLock(() =>
        start(this.#deps.layout, message)
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      result = { ok: false as const, reason: text.slice(0, 300) };
    }
    if (!result.ok) {
      this.#report(
        "acme-proof-forward-failed",
        message.requestId,
        result.reason,
      );
      return;
    }
    this.#scheduleExpiry(message.requestId, message.expiresAtIso);
    this.#report("acme-proof-forward-ready", message.requestId);
  }

  async handleEnd(message: AcmeProofForwardEndMessage): Promise<void> {
    if (
      validateAcmeProofForwardEndFields(
        message as unknown as Record<string, unknown>,
      ) !== null
    ) return;
    this.#cancels.get(message.requestId)?.();
    this.#cancels.delete(message.requestId);
    await this.#withdraw({ requestId: message.requestId });
  }

  /**
   * After a restart: remove every forward whose time has passed and set an
   * expiry timer for each one still valid, so none outlives its stated time.
   */
  async sweepExpired(): Promise<void> {
    const now = (this.#deps.now ?? Date.now)();
    await this.#withdraw({ expiredBeforeMs: now });
    try {
      const list = this.#deps.list ?? listProofForwards;
      for (const item of await list(this.#deps.layout)) {
        if (item.expiresAtMs > now && !this.#cancels.has(item.requestId)) {
          this.#scheduleExpiry(
            item.requestId,
            new Date(item.expiresAtMs).toISOString(),
          );
        }
      }
    } catch (err) {
      logWarn("deploy", "listing proof forwards failed:", err);
    }
  }

  #scheduleExpiry(requestId: string, expiresAtIso: string): void {
    this.#cancels.get(requestId)?.();
    const delay = Math.max(
      0,
      Date.parse(expiresAtIso) - (this.#deps.now ?? Date.now)(),
    );
    const set = this.#deps.setTimer ?? defaultSetTimer;
    this.#cancels.set(
      requestId,
      set(() => {
        this.#cancels.delete(requestId);
        void this.#withdraw({ requestId });
      }, delay),
    );
  }

  async #withdraw(
    match: { requestId: string } | { expiredBeforeMs: number },
  ): Promise<void> {
    const withdraw = this.#deps.withdraw ?? withdrawProofForwards;
    try {
      await withHostingSitesLock(() => withdraw(this.#deps.layout, match));
    } catch (err) {
      logWarn("deploy", "withdrawing a proof forward failed:", err);
    }
  }
}
