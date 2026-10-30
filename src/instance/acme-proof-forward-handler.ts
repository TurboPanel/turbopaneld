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
  startProofForward,
  withdrawProofForwards,
} from "../deploy/acme-proof-forward.ts";
import { withInstanceAcmeWindowLock } from "../deploy/instance-acme-http01.ts";
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
      result = await withInstanceAcmeWindowLock(() =>
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

  /** Remove every forward whose time has passed, e.g. one left by a restart. */
  async sweepExpired(): Promise<void> {
    await this.#withdraw({
      expiredBeforeMs: (this.#deps.now ?? Date.now)(),
    });
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
      await withInstanceAcmeWindowLock(() =>
        withdraw(this.#deps.layout, match)
      );
    } catch (err) {
      logWarn("deploy", "withdrawing a proof forward failed:", err);
    }
  }
}
