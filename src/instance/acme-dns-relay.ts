/**
 * The daemon's side of the DNS relay for server-placed certificate orders
 * (feature `acme-issue-dns-v1`).
 *
 * `acme-dns-publish` asks the control plane to publish the TXT records of one
 * order; it answers `acme-dns-published` once they read back at every
 * authoritative name server (or with a plain error). `acme-dns-remove` tells it
 * the order is over. The daemon holds no DNS credential: it only sends these
 * messages and waits.
 */
import type {
  AcmeDnsPublishedMessage,
  AcmeDnsPublishMessage,
  AcmeDnsRecord,
  AcmeDnsRemoveMessage,
} from "../contracts/cell-messages.ts";
import { validateAcmeDnsPublishedFields } from "../contracts/cell-messages.ts";
import { LocalAcmeError } from "../deploy/acme/client.ts";
import type { DnsRelay } from "../deploy/acme/dns01.ts";

export type AcmeDnsSend = (
  message: AcmeDnsPublishMessage | AcmeDnsRemoveMessage,
) => boolean;

const MAX_ERROR_CHARS = 300;
const LINK_DOWN =
  "this server lost its link to the control plane, so the DNS record could not be requested";
const NOT_IN_TIME = "the control plane did not confirm the DNS record in time";
const REFUSED = "the control plane could not publish the DNS record";

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
};

export class AcmeDnsRelay implements DnsRelay {
  readonly #send: AcmeDnsSend;
  readonly #now: () => number;
  readonly #waiting = new Map<string, Waiter>();

  constructor(send: AcmeDnsSend, now: () => number = Date.now) {
    this.#send = send;
    this.#now = now;
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }

  publish(
    requestId: string,
    records: readonly AcmeDnsRecord[],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#waiting.has(requestId)) {
      return Promise.reject(
        new LocalAcmeError("relay", "a DNS request for this order is open"),
      );
    }
    if (signal.aborted) {
      return Promise.reject(new LocalAcmeError("relay", NOT_IN_TIME));
    }
    return new Promise<void>((resolve, reject) => {
      const done = (settle: () => void) => {
        signal.removeEventListener("abort", onAbort);
        this.#waiting.delete(requestId);
        settle();
      };
      const onAbort = () =>
        done(() => reject(new LocalAcmeError("relay", NOT_IN_TIME)));
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiting.set(requestId, {
        resolve: () => done(resolve),
        reject: (err) => done(() => reject(err)),
      });
      const sent = this.#send({
        type: "acme-dns-publish",
        requestId,
        records: records.map(({ name, value }) => ({ name, value })),
        at: this.#at(),
      });
      if (!sent) {
        this.#waiting.get(requestId)?.reject(
          new LocalAcmeError("relay", LINK_DOWN),
        );
      }
    });
  }

  remove(requestId: string): void {
    try {
      this.#send({
        type: "acme-dns-remove",
        requestId,
        at: this.#at(),
      });
    } catch {
      // Best effort: the control plane also removes leftovers by id.
    }
  }

  /** The control plane's answer; an answer nobody waits for is ignored. */
  handlePublished(message: AcmeDnsPublishedMessage): void {
    if (
      validateAcmeDnsPublishedFields(
        message as unknown as Record<string, unknown>,
      ) !== null
    ) {
      return;
    }
    const waiter = this.#waiting.get(message.requestId);
    if (waiter === undefined) return;
    if (message.ok) {
      waiter.resolve();
      return;
    }
    const text = typeof message.error === "string" && message.error.length > 0
      ? message.error.slice(0, MAX_ERROR_CHARS)
      : REFUSED;
    waiter.reject(new LocalAcmeError("relay", text));
  }

  /** True while a publish for this order waits for its answer. */
  isWaiting(requestId: string): boolean {
    return this.#waiting.has(requestId);
  }
}
