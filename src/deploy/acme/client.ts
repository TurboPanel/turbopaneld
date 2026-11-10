/**
 * A small ACME v2 client (RFC 8555) for the daemon's own certificate orders.
 * `fetch` is injected so tests never reach a real certificate authority, and
 * every call is one plain request. The account key never leaves the object
 * that holds it.
 *
 * Every address the client contacts must be `https:` on the directory's own
 * host: an authority answer that names any other host (an order, an
 * authorization, a certificate link) is refused before anything is sent. The
 * daemon's network grant cannot be narrowed to the authority's hosts (it also
 * reaches the control plane and tenant names), so this is where the limit is
 * kept.
 */
import { encodeBase64Url } from "@std/encoding/base64url";
import {
  type AcmeAccountKey,
  dnsChallengeValue,
  keyAuthorization,
  signJws,
} from "./jws.ts";
import {
  type AcmeDirectory,
  type AcmeSession,
  isThrottleStatus,
  parseRetryAfterMs,
  sessionFor,
} from "./session.ts";

export type { AcmeDirectory } from "./session.ts";

const REQUEST_TIMEOUT_MS = 20_000;
/** A rate limit without a `Retry-After` waits this long. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 3_600_000;

export type AcmeErrorCode =
  | "rate_limited"
  | "already_replaced"
  | "unauthorized"
  | "account_gone"
  | "rejected_name"
  | "caa"
  | "dns"
  | "connection"
  | "incorrect_response"
  | "tls"
  | "malformed"
  | "server"
  | "unreachable"
  | "foreign_address"
  | "timeout"
  | "unsupported"
  | "unknown";

/** A refusal or failure from the certificate authority. */
export class AcmeError extends Error {
  readonly code: AcmeErrorCode;
  /** How long to wait before asking again, when the authority said (or a rate limit). */
  readonly retryAfterMs: number | null;
  /** The HTTP status of the answer; null when there was none. */
  readonly status: number | null;
  /** The name a failed check was for, when the failure is about one name. */
  readonly identifier: string | null;
  constructor(
    code: AcmeErrorCode,
    message: string,
    retryAfterMs: number | null = null,
    status: number | null = null,
    identifier: string | null = null,
  ) {
    super(message);
    this.name = "AcmeError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
    this.identifier = identifier;
  }
}

export type AcmeProblem = {
  type?: string;
  detail?: string;
  subproblems?: { detail?: string }[];
};

const PROBLEM_CODES: Record<string, AcmeErrorCode> = {
  rateLimited: "rate_limited",
  alreadyReplaced: "already_replaced",
  accountDoesNotExist: "account_gone",
  unauthorized: "unauthorized",
  rejectedIdentifier: "rejected_name",
  caa: "caa",
  dns: "dns",
  connection: "connection",
  incorrectResponse: "incorrect_response",
  tls: "tls",
  malformed: "malformed",
  serverInternal: "server",
};

/** The error code an RFC 8555 problem document names; `unknown` for any other. */
export function problemCode(problem: AcmeProblem | null | undefined) {
  const suffix = problem?.type?.split(":").pop() ?? "";
  return PROBLEM_CODES[suffix] ?? "unknown";
}

/** The problem's detail with its first subproblem's, when it has one. */
export function problemDetail(
  problem: AcmeProblem | null | undefined,
  fallback: string,
): string {
  const detail = problem?.detail ?? fallback;
  const sub = problem?.subproblems?.find((p) => p.detail)?.detail;
  return sub ? `${detail} (${sub})` : detail;
}

function waitAsked(code: AcmeErrorCode, response: Response): number | null {
  const limited = code === "rate_limited";
  if (!limited && !isThrottleStatus(response.status)) return null;
  const asked = parseRetryAfterMs(response.headers.get("retry-after"));
  if (asked !== null) return asked;
  return limited ? DEFAULT_RATE_LIMIT_WAIT_MS : null;
}

/** A failed answer on a plain endpoint (the directory, the nonce). */
function statusError(response: Response): AcmeError {
  const limited = response.status === 429;
  return new AcmeError(
    limited ? "rate_limited" : "server",
    `The certificate authority answered ${response.status}`,
    waitAsked(limited ? "rate_limited" : "server", response),
    response.status,
  );
}

export type AcmeIdentifier = { type: "dns"; value: string };
export type AcmeOrderStatus =
  | "pending"
  | "ready"
  | "processing"
  | "valid"
  | "invalid";
export type AcmeOrder = {
  url: string;
  status: AcmeOrderStatus;
  identifiers: AcmeIdentifier[];
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: AcmeProblem;
  /** The `Retry-After` of the answer, for a caller that polls. */
  retryAfterMs: number | null;
};
export type AcmeChallenge = {
  type: string;
  url: string;
  token: string;
  status: string;
  error?: AcmeProblem;
};
export type AcmeAuthorization = {
  url: string;
  status:
    | "pending"
    | "valid"
    | "invalid"
    | "deactivated"
    | "expired"
    | "revoked";
  identifier: AcmeIdentifier;
  wildcard?: boolean;
  challenges: AcmeChallenge[];
  /** The `Retry-After` of the answer, for a caller that polls. */
  retryAfterMs: number | null;
};

export type AcmeClientOptions = {
  directoryUrl: string;
  key: AcmeAccountKey;
  /** Set once the account exists; found again with {@link AcmeClient.ensureAccount} otherwise. */
  accountUrl?: string | null;
  fetch?: typeof fetch;
};

const networkFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

/**
 * The URL as a normalized link when it is `https:` on `host`; an
 * {@link AcmeError} otherwise. Nothing is sent to an address that fails.
 */
export function authorityUrl(value: unknown, host: string): string {
  let url: URL | null = null;
  try {
    url = typeof value === "string" ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (url?.protocol !== "https:" || url.host !== host) {
    throw new AcmeError(
      "foreign_address",
      "The certificate authority named an address outside its own site",
    );
  }
  return url.href;
}

async function sendTimed(
  send: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await send(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "request failed";
    throw new AcmeError(
      "unreachable",
      `The certificate authority could not be reached: ${reason}`,
    );
  }
}

function optionalHttps(value: unknown): string | null {
  try {
    const url = typeof value === "string" ? new URL(value) : null;
    return url?.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The authority's directory, from the session's cache while it is fresh. */
async function loadDirectory(
  directoryUrl: string,
  send: typeof fetch,
  session: AcmeSession,
): Promise<AcmeDirectory> {
  const cached = session.directory(directoryUrl);
  if (cached) return cached;
  const host = new URL(directoryUrl).host;
  const response = await sendTimed(send, authorityUrl(directoryUrl, host), {
    method: "GET",
  });
  if (!response.ok) throw statusError(response);
  const body = (await response.json()) as Record<string, unknown> & {
    meta?: { termsOfService?: unknown };
  };
  if (!body.newNonce || !body.newAccount || !body.newOrder) {
    throw new AcmeError(
      "server",
      "The certificate authority sent an incomplete directory",
    );
  }
  const terms = optionalHttps(body.meta?.termsOfService);
  const directory: AcmeDirectory = {
    newNonce: authorityUrl(body.newNonce, host),
    newAccount: authorityUrl(body.newAccount, host),
    newOrder: authorityUrl(body.newOrder, host),
    ...(body.renewalInfo
      ? { renewalInfo: authorityUrl(body.renewalInfo, host) }
      : {}),
    ...(terms ? { termsOfService: terms } : {}),
  };
  session.rememberDirectory(directoryUrl, directory);
  return directory;
}

function retryAfterOf(response: Response): number | null {
  return parseRetryAfterMs(response.headers.get("retry-after"));
}

export class AcmeClient {
  readonly #directoryUrl: string;
  readonly #host: string;
  readonly #key: AcmeAccountKey;
  readonly #fetch: typeof fetch;
  readonly #session: AcmeSession;
  #accountUrl: string | null;

  constructor(options: AcmeClientOptions) {
    this.#directoryUrl = options.directoryUrl;
    this.#host = new URL(options.directoryUrl).host;
    this.#key = options.key;
    this.#accountUrl = options.accountUrl ?? null;
    this.#fetch = options.fetch ?? networkFetch;
    this.#session = sessionFor(options.fetch);
  }

  get accountUrl(): string | null {
    return this.#accountUrl;
  }

  /** The authority's directory (cached for an hour). */
  directory(): Promise<AcmeDirectory> {
    return loadDirectory(this.#directoryUrl, this.#fetch, this.#session);
  }

  #request(url: string, init: RequestInit): Promise<Response> {
    return sendTimed(this.#fetch, authorityUrl(url, this.#host), init);
  }

  /** A spare nonce from an earlier answer, or a fresh one from the authority. */
  async #takeNonce(): Promise<string> {
    const spare = this.#session.takeNonce(this.#directoryUrl);
    if (spare) return spare;
    const directory = await this.directory();
    const response = await this.#request(directory.newNonce, {
      method: "HEAD",
    });
    if (!response.ok) throw statusError(response);
    const nonce = response.headers.get("replay-nonce");
    if (!nonce) {
      throw new AcmeError("server", "The certificate authority sent no nonce");
    }
    return nonce;
  }

  async #postOnce(
    url: string,
    payload: unknown,
    withKid: boolean,
  ): Promise<Response> {
    const target = authorityUrl(url, this.#host);
    const nonce = await this.#takeNonce();
    const body = await signJws(this.#key, {
      url: target,
      nonce,
      payload,
      ...(withKid && this.#accountUrl ? { kid: this.#accountUrl } : {}),
    });
    const response = await this.#request(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/jose+json",
        Accept: "application/json",
      },
      body,
    });
    // Every answer carries the next nonce, errors included.
    this.#session.rememberNonce(
      this.#directoryUrl,
      response.headers.get("replay-nonce"),
    );
    return response;
  }

  async #failure(response: Response): Promise<AcmeError> {
    let problem: AcmeProblem | null = null;
    try {
      problem = (await response.json()) as AcmeProblem;
    } catch {
      problem = null;
    }
    const raw = response.status === 429 ? "rate_limited" : problemCode(problem);
    // An account the authority has switched off is refused as unauthorized.
    const code = raw === "unauthorized" &&
        /deactivat|not valid|revoked/i.test(problem?.detail ?? "")
      ? "account_gone"
      : raw;
    const detail = problemDetail(
      problem,
      `The certificate authority answered ${response.status}`,
    );
    return new AcmeError(
      code,
      detail,
      waitAsked(code, response),
      response.status,
    );
  }

  /** POST a signed request; a stale nonce is replaced and tried once more. */
  async #post(url: string, payload: unknown, withKid = true) {
    let response = await this.#postOnce(url, payload, withKid);
    if (response.status === 400) {
      const problem = (await response.clone().json().catch(() => null)) as
        | AcmeProblem
        | null;
      if (problem?.type?.endsWith(":badNonce")) {
        response = await this.#postOnce(url, payload, withKid);
      }
    }
    if (!response.ok) throw await this.#failure(response);
    return response;
  }

  /** Create the account, or find the one this key already has. */
  async ensureAccount(contact?: readonly string[]): Promise<string> {
    if (this.#accountUrl) return this.#accountUrl;
    const directory = await this.directory();
    const response = await this.#post(
      directory.newAccount,
      {
        termsOfServiceAgreed: true,
        ...(contact && contact.length > 0 ? { contact } : {}),
      },
      false,
    );
    const location = response.headers.get("location");
    if (!location) {
      throw new AcmeError(
        "server",
        "The certificate authority sent no account address",
      );
    }
    this.#accountUrl = authorityUrl(location, this.#host);
    return this.#accountUrl;
  }

  /**
   * Open an order. `replaces` is the renewal-information identifier of the
   * certificate this one renews (RFC 9773); it is only sent to an authority
   * that offers renewal information.
   */
  async newOrder(
    names: readonly string[],
    options: { replaces?: string } = {},
  ): Promise<AcmeOrder> {
    const directory = await this.directory();
    const identifiers = names.map((value) => ({ type: "dns" as const, value }));
    const replaces = directory.renewalInfo ? options.replaces : undefined;
    const response = await this.#post(directory.newOrder, {
      identifiers,
      ...(replaces ? { replaces } : {}),
    });
    const url = response.headers.get("location");
    if (!url) {
      throw new AcmeError(
        "server",
        "The certificate authority sent no order address",
      );
    }
    return await this.#readOrder(response, url);
  }

  async #readOrder(response: Response, url: string): Promise<AcmeOrder> {
    const body = (await response.json()) as Omit<
      AcmeOrder,
      "url" | "retryAfterMs"
    >;
    return {
      ...body,
      url: authorityUrl(url, this.#host),
      retryAfterMs: retryAfterOf(response),
    };
  }

  async getOrder(url: string): Promise<AcmeOrder> {
    return await this.#readOrder(await this.#post(url, ""), url);
  }

  async #readAuthorization(response: Response, url: string) {
    const body = (await response.json()) as Omit<
      AcmeAuthorization,
      "url" | "retryAfterMs"
    >;
    return { ...body, url, retryAfterMs: retryAfterOf(response) };
  }

  async getAuthorization(url: string): Promise<AcmeAuthorization> {
    return await this.#readAuthorization(await this.#post(url, ""), url);
  }

  /**
   * Give up an authorization this account will not complete (RFC 8555
   * §7.5.2), so it stops counting against the authority's pending limits.
   */
  async deactivateAuthorization(url: string): Promise<AcmeAuthorization> {
    const response = await this.#post(url, { status: "deactivated" });
    return await this.#readAuthorization(response, url);
  }

  /** The body that answers an HTTP-01 challenge with this `token`. */
  keyAuthorization(token: string): Promise<string> {
    return keyAuthorization(this.#key, token);
  }

  /** The TXT value that answers a DNS-01 challenge with this `token`. */
  dnsValue(token: string): Promise<string> {
    return dnsChallengeValue(this.#key, token);
  }

  /** Tell the authority the challenge answer is in place. */
  async answerChallenge(url: string): Promise<void> {
    await this.#post(url, {});
  }

  /** Send the certificate request; returns the order as it then stands. */
  async finalize(
    orderUrl: string,
    finalizeUrl: string,
    csr: Uint8Array,
  ): Promise<AcmeOrder> {
    const response = await this.#post(finalizeUrl, {
      csr: encodeBase64Url(csr),
    });
    return await this.#readOrder(response, orderUrl);
  }

  /** The certificate chain PEM of a valid order. */
  async downloadCertificate(url: string): Promise<string> {
    const response = await this.#post(url, "");
    return await response.text();
  }
}

export type RenewalWindow = { start: Date; end: Date };

/** What asking the authority about a certificate's renewal time came to (RFC 9773). */
export type RenewalInfo = {
  /** The suggested window; null when the authority gave none. */
  window: RenewalWindow | null;
  /** True when the authority answered (even "unknown certificate"), false when asking failed. */
  answered: boolean;
  /** The `Retry-After` of the answer: how long to wait before asking again. */
  retryAfterMs: number | null;
};

const NO_ANSWER: RenewalInfo = {
  window: null,
  answered: false,
  retryAfterMs: null,
};

function readWindow(
  body: { suggestedWindow?: { start?: string; end?: string } },
): RenewalWindow | null {
  const start = Date.parse(body.suggestedWindow?.start ?? "");
  const end = Date.parse(body.suggestedWindow?.end ?? "");
  return Number.isNaN(start) || Number.isNaN(end) || end < start
    ? null
    : { start: new Date(start), end: new Date(end) };
}

/**
 * Ask the authority when to renew a certificate (RFC 9773). Never throws: the
 * caller has its own fallback. `certId` comes from `renewalCertId`.
 */
export async function fetchRenewalInfo(options: {
  directoryUrl: string;
  certId: string;
  fetch?: typeof fetch;
}): Promise<RenewalInfo> {
  const send = options.fetch ?? networkFetch;
  try {
    const directory = await loadDirectory(
      options.directoryUrl,
      send,
      sessionFor(options.fetch),
    );
    if (!directory.renewalInfo) {
      return { window: null, answered: true, retryAfterMs: null };
    }
    const host = new URL(options.directoryUrl).host;
    const url = authorityUrl(
      `${directory.renewalInfo.replace(/\/$/, "")}/${options.certId}`,
      host,
    );
    const response = await sendTimed(send, url, { method: "GET" });
    const retryAfterMs = retryAfterOf(response);
    if (!response.ok) {
      // An unknown certificate is an answer; a throttle or an outage is not.
      await response.body?.cancel();
      return { window: null, answered: response.status === 404, retryAfterMs };
    }
    const window = readWindow(
      (await response.json()) as Parameters<typeof readWindow>[0],
    );
    return { window, answered: window !== null, retryAfterMs };
  } catch (err) {
    return err instanceof AcmeError
      ? { ...NO_ANSWER, retryAfterMs: err.retryAfterMs }
      : NO_ANSWER;
  }
}
