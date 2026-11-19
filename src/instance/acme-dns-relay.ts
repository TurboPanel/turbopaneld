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

const ESC = 0x1b;

function inRange(code: number, low: number, high: number): boolean {
  return code >= low && code <= high;
}

/** Where an escape sequence that starts at `start` (an ESC) ends, or -1 when it is not one. */
function ansiSequenceEnd(text: string, start: number): number {
  const first = text.charCodeAt(start + 1);
  // A two-character sequence: ESC and one of @-Z or \-_ (the "[" is excluded).
  if (inRange(first, 0x40, 0x5a) || inRange(first, 0x5c, 0x5f)) {
    return start + 2;
  }
  if (first !== 0x5b) return -1;
  // A control sequence: ESC [, parameters, intermediates, one final character.
  let at = start + 2;
  while (
    inRange(text.charCodeAt(at), 0x30, 0x39) || text[at] === ";" ||
    text[at] === "?"
  ) at += 1;
  while (inRange(text.charCodeAt(at), 0x20, 0x2f)) at += 1;
  return inRange(text.charCodeAt(at), 0x40, 0x7e) ? at + 1 : -1;
}

function replaceAnsiSequences(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const end = text.charCodeAt(at) === ESC ? ansiSequenceEnd(text, at) : -1;
    if (end === -1) {
      out += text[at];
      at += 1;
    } else {
      out += " ";
      at = end;
    }
  }
  return out;
}

/** C0 and C1 control characters, DEL, and the Unicode line and paragraph separators. */
export function isControlCodePoint(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 ||
    code === 0x2029;
}

function replaceControlCharacters(text: string): string {
  let out = "";
  for (const char of text) {
    out += isControlCodePoint(char.codePointAt(0) ?? 0) ? " " : char;
  }
  return out;
}

/**
 * The panel's sentence as plain words: ANSI codes, control characters and
 * line breaks gone, runs of whitespace collapsed, then capped.
 */
export function plainPanelError(value: unknown): string {
  if (typeof value !== "string") return REFUSED;
  const text = replaceControlCharacters(replaceAnsiSequences(value))
    .replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS).trim();
  return text.length > 0 ? text : REFUSED;
}

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

  /**
   * The control plane's answer; an answer nobody waits for is ignored. A
   * malformed answer for an order that waits fails that order as refused
   * rather than leaving it to wait out the deadline.
   */
  handlePublished(message: AcmeDnsPublishedMessage): void {
    const requestId = (message as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string") return;
    const waiter = this.#waiting.get(requestId);
    if (waiter === undefined) return;
    if (
      validateAcmeDnsPublishedFields(
        message as unknown as Record<string, unknown>,
      ) !== null
    ) {
      waiter.reject(new LocalAcmeError("relay", REFUSED));
      return;
    }
    if (message.ok) {
      waiter.resolve();
      return;
    }
    waiter.reject(new LocalAcmeError("relay", plainPanelError(message.error)));
  }

  /** True while a publish for this order waits for its answer. */
  isWaiting(requestId: string): boolean {
    return this.#waiting.has(requestId);
  }
}
