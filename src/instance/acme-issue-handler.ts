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
  AcmeDnsPublishedMessage,
  AcmeIssueEventMessage,
  AcmeIssueRequestMessage,
} from "../contracts/cell-messages.ts";
import { validateAcmeIssueRequestFields } from "../contracts/cell-messages.ts";
import {
  forgetOpenDnsOrder,
  issueTenantCertificates,
  issueTenantCertificatesOverDns,
  listOpenDnsOrders,
  type TenantIssueDeps,
} from "../deploy/tenant-acme-issue.ts";
import { readHostedSiteNames } from "../deploy/ingress.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { AcmeDnsRelay, type AcmeDnsSend } from "./acme-dns-relay.ts";
import { checkNamesHosted } from "./acme-names-guard.ts";

export type AcmeIssueHandlerDeps = {
  layout: LayoutPaths;
  /** Sends one message to the control plane; false when the link is down. */
  send: (message: AcmeIssueEventMessage) => boolean;
  /** `POST /api/daemon/v1/tls/issued`, with the request id. */
  report: TenantIssueDeps["report"];
  now?: () => number;
  issue?: typeof issueTenantCertificates;
  /**
   * Sends the DNS relay messages (`acme-dns-publish`, `acme-dns-remove`) to the
   * control plane; false when the link is down. Without it a `dns-01` request
   * is refused.
   */
  sendDns?: AcmeDnsSend;
  /** Places a DNS-01 order (test seam). */
  issueDns?: typeof issueTenantCertificatesOverDns;
  /** The names this server's tenant sites answer on (test seam). */
  hostedNames?: () => Promise<ReadonlySet<string>>;
};

const DNS_UNAVAILABLE =
  "this server cannot ask the control plane for DNS records, so no certificate was ordered";
const SERVER_RESTARTED = "the server restarted";

const MAX_REASON_CHARS = 1000;

export class AcmeIssueHandler {
  readonly #deps: AcmeIssueHandlerDeps;
  readonly #open = new Set<string>();
  readonly #relay: AcmeDnsRelay | undefined;

  constructor(deps: AcmeIssueHandlerDeps) {
    this.#deps = deps;
    this.#relay = deps.sendDns === undefined
      ? undefined
      : new AcmeDnsRelay(deps.sendDns, deps.now);
  }

  /** The control plane's answer to an `acme-dns-publish`. */
  handleDnsPublished(message: AcmeDnsPublishedMessage): void {
    this.#relay?.handlePublished(message);
  }

  /**
   * DNS orders a restart cut short: the control plane still holds the request
   * open, so each gets a `failed` event ("the server restarted") and its
   * records are asked to go. Orders this process is running are left alone. A
   * marker stays until the link carried the event, so a later attach tries
   * again.
   */
  async sweepRestartedDnsOrders(): Promise<void> {
    const ids = await listOpenDnsOrders(this.#deps.layout);
    for (const requestId of ids) {
      if (this.#open.has(requestId)) continue;
      if (!this.#event(requestId, "failed", { reason: SERVER_RESTARTED })) {
        continue;
      }
      this.#relay?.remove(requestId);
      await forgetOpenDnsOrder(this.#deps.layout, requestId);
    }
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
    // The same request arriving twice (a re-send after a blip) is one order.
    if (this.#open.has(message.requestId)) return;
    this.#open.add(message.requestId);
    try {
      if (message.challenge === "dns-01") {
        await this.#handleDnsRequest(message);
        return;
      }
      // Only names a tenant site here answers on: nothing is started or
      // ordered for any other name.
      const notHosted = await checkNamesHosted(
        message.names,
        this.#deps.hostedNames ??
          (() => readHostedSiteNames(this.#deps.layout)),
        "no certificate was ordered",
      );
      if (notHosted !== null) {
        this.#event(message.requestId, "failed", { reason: notHosted });
        return;
      }
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
  /**
   * A `dns-01` order: no proof routes and no check that a site here answers on
   * the names (nothing is served for it, and a wildcard is no site name); the
   * control plane publishes the records through the relay.
   */
  async #handleDnsRequest(message: AcmeIssueRequestMessage): Promise<void> {
    if (this.#relay === undefined) {
      this.#event(message.requestId, "failed", { reason: DNS_UNAVAILABLE });
      return;
    }
    if (!this.#event(message.requestId, "started")) return;
    const issue = this.#deps.issueDns ?? issueTenantCertificatesOverDns;
    const outcome = await issue(this.#deps.layout, message, {
      relay: this.#relay,
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
  }
}
