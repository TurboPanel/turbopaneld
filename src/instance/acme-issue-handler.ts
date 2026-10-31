/**
 * The issuing side of central certificate issuance (feature `acme-issue-v1`):
 * `acme-issue-request` starts a one-shot order from this server's own addresses
 * and is answered with `acme-issue-event` (`started`, then `issued` or `failed`
 * with a plain reason). The pair itself never rides a cell message: each name's
 * pair goes to `POST /api/daemon/v1/tls/issued` with the request id, over the
 * authenticated HTTPS channel, and the control plane seals it on arrival.
 *
 * Old control planes never send this message, so nothing changes for them.
 */

import type {
  AcmeIssueEventMessage,
  AcmeIssueRequestMessage,
} from "../contracts/cell-messages.ts";
import { validateAcmeIssueRequestFields } from "../contracts/cell-messages.ts";
import {
  issueTenantCertificates,
  sweepTenantAcme,
  type TenantIssueDeps,
} from "../deploy/tenant-acme-issue.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";

export type AcmeIssueHandlerDeps = {
  layout: LayoutPaths;
  /** Sends one message to the control plane; false when the link is down. */
  send: (message: AcmeIssueEventMessage) => boolean;
  /** `POST /api/daemon/v1/tls/issued`, with the request id. */
  report: TenantIssueDeps["report"];
  now?: () => number;
  issue?: typeof issueTenantCertificates;
  /** Start-up clean-up of issuers and files a restart left behind. */
  sweep?: () => Promise<void>;
};

const MAX_REASON_CHARS = 1000;

export class AcmeIssueHandler {
  readonly #deps: AcmeIssueHandlerDeps;
  readonly #open = new Set<string>();
  #ready: Promise<void> = Promise.resolve();

  constructor(deps: AcmeIssueHandlerDeps) {
    this.#deps = deps;
  }

  /**
   * Clear what a restart left behind. Requests wait for it, so the sweep can
   * never stop the issuer of an order this process has just taken.
   */
  start(): Promise<void> {
    const sweep = this.#deps.sweep ??
      (() => sweepTenantAcme(this.#deps.layout));
    this.#ready = sweep().catch((err) =>
      logWarn("deploy", "certificate issuer start-up sweep failed:", err)
    );
    return this.#ready;
  }

  #event(
    requestId: string,
    stage: AcmeIssueEventMessage["stage"],
    extra: { reason?: string; notAfterIso?: string } = {},
  ): boolean {
    return this.#deps.send({
      type: "acme-issue-event",
      requestId,
      stage,
      ...(extra.reason === undefined
        ? {}
        : { reason: extra.reason.slice(0, MAX_REASON_CHARS) }),
      ...(extra.notAfterIso === undefined
        ? {}
        : { notAfterIso: extra.notAfterIso }),
      at: new Date((this.#deps.now ?? Date.now)()).toISOString(),
    });
  }

  async handleRequest(message: AcmeIssueRequestMessage): Promise<void> {
    const problem = validateAcmeIssueRequestFields(
      message as unknown as Record<string, unknown>,
    );
    if (problem !== null) {
      // Without a usable request id there is nothing to answer.
      if (typeof message.requestId === "string") {
        this.#event(message.requestId, "failed", { reason: problem });
      }
      return;
    }
    await this.#ready;
    // The same request arriving twice (a re-send after a blip) is one order.
    if (this.#open.has(message.requestId)) return;
    this.#open.add(message.requestId);
    try {
      // A started report the link dropped is not a report: the control plane
      // will ask again (or another server), so nothing is begun here.
      if (!this.#event(message.requestId, "started")) return;
      const issue = this.#deps.issue ?? issueTenantCertificates;
      const outcome = await issue(this.#deps.layout, message, {
        report: this.#deps.report,
        now: this.#deps.now,
      });
      if (outcome.ok) {
        this.#event(message.requestId, "issued", {
          notAfterIso: outcome.notAfterIso,
        });
      } else {
        this.#event(message.requestId, "failed", { reason: outcome.reason });
      }
    } finally {
      this.#open.delete(message.requestId);
    }
  }
}
