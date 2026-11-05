/**
 * The control plane address list of a pinned server.
 *
 * The pin file's `urls=` (written by the installer from the install command,
 * later only by `tp-host panel-identity-write` from a verified identity
 * document) names every address this server may dial, URL 0 first. Only a
 * pinned server uses more than one address: each address must prove the
 * pinned key (its identity document, then its signed hello) before anything
 * identifying is sent to it, so trying the next one discloses nothing. An
 * unpinned server keeps dialing `TURBOPANEL_INSTANCE_URL` alone.
 *
 * Order: URL 0 first. A failed connect moves to the next address at once; the
 * first contact with an address has a short timeout ({@link URL_CONNECT_TIMEOUT_MS})
 * through the system resolver, so a name that does not resolve or connect is
 * skipped quickly. When the whole list has failed, the next pass waits a
 * full-jitter backoff (base 5 s, cap 5 min).
 */
import type { ClassifiedConnectFailure } from "./connect-failure.ts";
import { stripTrailingSlashes } from "./sockets.ts";

/** First contact with an address in a list of several: give up after this. */
export const URL_CONNECT_TIMEOUT_MS = 3_000;
export const URL_WRAP_BASE_MS = 5_000;
export const URL_WRAP_CAP_MS = 5 * 60_000;
/** Never retry a used-up list sooner than this. */
export const URL_WRAP_FLOOR_MS = 1_000;

/**
 * `https://host[:port]`: a DNS name, IPv4 or bracketed IPv6 literal and an
 * optional port, nothing else (the same allow-list root applies in tp-host).
 */
const ORIGIN =
  /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** One address as the pin and the identity document carry it, or null. */
export function normalizePanelUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = stripTrailingSlashes(value.trim());
  return ORIGIN.test(url) ? url : null;
}

/**
 * The addresses to try, in order: the pin's list, then the installer's
 * `TURBOPANEL_INSTANCE_URL` when the list does not hold it (a list the
 * document rewrote may have dropped the address this server was installed
 * with; it is still worth a try, and it must prove the key like any other).
 */
export function panelUrlCandidates(
  pinUrls: readonly string[],
  envUrl: string | undefined,
): string[] {
  const out: string[] = [];
  for (const value of [...pinUrls, envUrl]) {
    const url = normalizePanelUrl(value);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** The `urls` of an identity document body, or null when absent, empty or malformed. */
export function identityDocumentUrls(body: string): string[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  const urls = (doc as { urls?: unknown } | null)?.urls;
  if (!Array.isArray(urls) || urls.length === 0) return null;
  const out: string[] = [];
  for (const value of urls) {
    // The pin keeps the document's exact text: tp-host writes it as signed.
    if (typeof value !== "string" || normalizePanelUrl(value) !== value) {
      return null;
    }
    // A repeated entry would never compare equal to the pin tp-host writes.
    if (out.includes(value)) return null;
    out.push(value);
  }
  return out;
}

/** Whether two address lists differ (order counts: URL 0 is tried first). */
export function urlListsDiffer(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length !== b.length || a.some((url, i) => url !== b[i]);
}

/** Full-jitter wait before pass `passes` (1 = after the first full failed pass). */
export function urlWrapDelayMs(
  passes: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(passes - 1, 16));
  const ceiling = Math.min(URL_WRAP_CAP_MS, URL_WRAP_BASE_MS * 2 ** exponent);
  return URL_WRAP_FLOOR_MS +
    Math.floor(random() * (ceiling - URL_WRAP_FLOOR_MS + 1)); // NOSONAR typescript:S2245 — jitter timing only, not a security context
}

/**
 * Connect failures that move on to the next address, mildest first; the
 * others stay global. A pass that ended badly anywhere reports its worst.
 */
const FAIL_OVER_KINDS: readonly string[] = [
  "transient",
  "tls-trust",
  "panel-identity",
];

/** Where the connect loop goes after a failure on the active address. */
export type UrlFailover =
  | { kind: "next"; url: string }
  | {
    kind: "wrapped";
    url: string;
    delayMs: number;
    worst: ClassifiedConnectFailure;
  }
  | { kind: "none" };

/** The address list and which entry is active. */
export class PanelUrlRotation {
  #urls: string[];
  #index = 0;
  #passes = 0;
  #worst: ClassifiedConnectFailure | undefined;
  /** A failure of this pass that only says the address was unreachable. */
  #mild: ClassifiedConnectFailure | undefined;
  readonly #random: () => number;

  constructor(urls: readonly string[], random: () => number = Math.random) {
    if (urls.length === 0) throw new TypeError("no control plane address");
    this.#urls = [...urls];
    this.#random = random;
  }

  get active(): string {
    return this.#urls[this.#index];
  }

  get urls(): readonly string[] {
    return this.#urls;
  }

  /**
   * After a failure of `kind` on the active address: the next address at
   * once, or, when the list is used up, URL 0 again after a jittered wait. A
   * one-address list, or a failure that is not about the address, changes
   * nothing (the caller keeps its own backoff and parking).
   */
  failOver(failure: ClassifiedConnectFailure): UrlFailover {
    const rank = FAIL_OVER_KINDS.indexOf(failure.kind);
    if (this.#urls.length < 2 || rank < 0) return { kind: "none" };
    if (rank === 0) this.#mild ??= failure;
    else if (
      !this.#worst || rank >= FAIL_OVER_KINDS.indexOf(this.#worst.kind)
    ) {
      this.#worst = failure;
    }
    this.#index += 1;
    if (this.#index < this.#urls.length) {
      return { kind: "next", url: this.active };
    }
    // Only a pass in which every address refused trust or identity parks; an
    // address that was merely unreachable makes it a pass to retry.
    const worst = this.#mild ?? this.#worst ?? failure;
    this.#index = 0;
    this.#passes += 1;
    this.#worst = undefined;
    this.#mild = undefined;
    return {
      kind: "wrapped",
      url: this.active,
      delayMs: urlWrapDelayMs(this.#passes, this.#random),
      worst,
    };
  }

  /** A session opened: the next connect starts again at URL 0 with no backoff. */
  restart(): void {
    this.#index = 0;
    this.#passes = 0;
    this.#worst = undefined;
    this.#mild = undefined;
  }

  /** A new list (the pin changed); the active address stays when it is still listed. */
  replace(urls: readonly string[]): void {
    if (urls.length === 0) return;
    const active = this.active;
    this.#urls = [...urls];
    this.#index = Math.max(0, this.#urls.indexOf(active));
  }
}
