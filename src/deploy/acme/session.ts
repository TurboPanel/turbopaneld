/**
 * What clients of one authority can share inside the daemon process: the
 * directory (its addresses, which change rarely) and spare `Replay-Nonce`
 * values. Without it every step would fetch the directory and a nonce again,
 * which doubles the calls an order makes and hits the two endpoints with the
 * tightest per-address limits.
 *
 * Only a cache: nothing here is secret or tied to an account. A stale nonce is
 * answered with `badNonce`, which the client recovers from once. Sessions are
 * keyed by the `fetch` in use, so a test with its own fake authority never sees
 * another test's cache; the real network shares one session.
 */

/** The directory addresses the client reads. */
export type AcmeDirectory = {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  /** ACME Renewal Information (RFC 9773); absent on an authority without it. */
  renewalInfo?: string;
  /** `meta.termsOfService`: the agreement the authority asks subscribers to accept. */
  termsOfService?: string;
};

/** The directory is looked at again after this long. */
export const DIRECTORY_TTL_MS = 3_600_000;
/** A spare nonce older than this is dropped rather than risk a `badNonce`. */
export const NONCE_TTL_MS = 5 * 60_000;
/** Spare nonces kept per authority. */
const MAX_SPARE_NONCES = 4;

type Timed<T> = { value: T; at: number };

export class AcmeSession {
  readonly #directories = new Map<string, Timed<AcmeDirectory>>();
  readonly #nonces = new Map<string, Timed<string>[]>();

  directory(url: string, now: number = Date.now()): AcmeDirectory | null {
    const found = this.#directories.get(url);
    return found && now - found.at < DIRECTORY_TTL_MS ? found.value : null;
  }

  rememberDirectory(
    url: string,
    directory: AcmeDirectory,
    now: number = Date.now(),
  ): void {
    this.#directories.set(url, { value: directory, at: now });
  }

  /** A spare nonce for this authority, or null; each is handed out once. */
  takeNonce(url: string, now: number = Date.now()): string | null {
    const fresh = (this.#nonces.get(url) ?? []).filter((n) =>
      now - n.at < NONCE_TTL_MS
    );
    const taken = fresh.pop();
    this.#nonces.set(url, fresh);
    return taken?.value ?? null;
  }

  rememberNonce(
    url: string,
    nonce: string | null,
    now: number = Date.now(),
  ): void {
    if (!nonce) return;
    const kept = (this.#nonces.get(url) ?? []).filter((n) =>
      now - n.at < NONCE_TTL_MS
    );
    kept.push({ value: nonce, at: now });
    this.#nonces.set(url, kept.slice(-MAX_SPARE_NONCES));
  }
}

const sessions = new WeakMap<object, AcmeSession>();
/** Stands in for "the real network" as the key of the shared session. */
const NETWORK = {};

export function sessionFor(fetchFn: typeof fetch | undefined): AcmeSession {
  const key = fetchFn ?? NETWORK;
  let session = sessions.get(key);
  if (!session) {
    session = new AcmeSession();
    sessions.set(key, session);
  }
  return session;
}

/** Longest wait a `Retry-After` may ask for. */
export const MAX_RETRY_AFTER_MS = 86_400_000;

/**
 * The wait a `Retry-After` header asks for (RFC 9110): seconds or an HTTP
 * date, in milliseconds and never more than a day; null when absent or
 * unreadable.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  const text = header?.trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(text);
  return Number.isNaN(at)
    ? null
    : Math.min(Math.max(at - nowMs, 0), MAX_RETRY_AFTER_MS);
}

/** Statuses that mean "slow down". */
export function isThrottleStatus(status: number): boolean {
  return status === 429 || status === 503;
}
