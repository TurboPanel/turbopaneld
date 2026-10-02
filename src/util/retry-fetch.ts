/**
 * Bounded retry for the update path's HTTP reads. GitHub answers 502/503/504
 * now and then; one blip should not fail a whole automatic update when the
 * same request succeeds seconds later.
 *
 * Only transient failures are retried: HTTP 502/503/504, 429 (honouring a
 * capped `Retry-After`), and connection reset / timeout style network errors.
 * Every other response, including 4xx and anything wrong with the body or its
 * signature (which is checked after this returns), is handed back untouched,
 * and when the attempts run out the last response or error is returned as-is so
 * callers keep their original error text.
 */

export type RetryFetchOptions = {
  /** Total attempts including the first. Default 4. */
  attempts?: number;
  /** Wait before retry n (1-based). Default 2 s, 4 s, 8 s. */
  delayMs?: (retry: number) => number;
  /** Longest wait a `Retry-After` header may impose. Default 10 s. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_NETWORK_RE =
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|connection (?:reset|closed)|timed? ?out|timeout|broken pipe|temporary failure in name resolution|dns error/i;

function defaultDelayMs(retry: number): number {
  return 2000 * 2 ** (retry - 1);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorChainText(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name} ${err.message} ${errorChainText(err.cause)}`;
  }
  return typeof err === "string" ? err : "";
}

/** True for a thrown fetch error that looks like a dropped or timed-out connection. */
export function isTransientNetworkError(err: unknown): boolean {
  return TRANSIENT_NETWORK_RE.test(errorChainText(err));
}

/** `Retry-After` as milliseconds (seconds or HTTP date), or null when absent/unusable. */
export function parseRetryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - now);
}

function waitBeforeRetry(
  status: number | null,
  retryAfterHeader: string | null,
  retry: number,
  options: RetryFetchOptions,
): number {
  const base = (options.delayMs ?? defaultDelayMs)(retry);
  if (status !== 429) return base;
  const asked = parseRetryAfterMs(retryAfterHeader);
  if (asked === null) return base;
  return Math.min(asked, options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS);
}

/** What the retry loop needs to know about a result of type `T`. */
export type RetryView<T> = {
  status: (result: T) => number;
  retryAfter: (result: T) => string | null;
  /** Release a result that is about to be discarded for a retry. */
  discard?: (result: T) => Promise<unknown> | void;
};

/** Run `doFetch`, retrying transient failures; see the file comment. */
export function retryTransient<T>(
  doFetch: () => Promise<T>,
  view: RetryView<T>,
  options: RetryFetchOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;

  const again = async (n: number, result: T | null): Promise<T> => {
    const status = result === null ? null : view.status(result);
    const header = result === null ? null : view.retryAfter(result);
    if (result !== null) await view.discard?.(result);
    await sleep(waitBeforeRetry(status, header, n, options));
    return attempt(n + 1);
  };

  const attempt = async (n: number): Promise<T> => {
    let result: T;
    try {
      result = await doFetch();
    } catch (err) {
      if (n >= attempts || !isTransientNetworkError(err)) throw err;
      return again(n, null);
    }
    if (n >= attempts || !TRANSIENT_STATUSES.has(view.status(result))) {
      return result;
    }
    return again(n, result);
  };

  return attempt(1);
}

/** {@link retryTransient} for a `fetch` Response. */
export function fetchWithRetry(
  doFetch: () => Promise<Response>,
  options: RetryFetchOptions = {},
): Promise<Response> {
  return retryTransient(doFetch, {
    status: (res) => res.status,
    retryAfter: (res) => res.headers.get("retry-after"),
    discard: (res) => res.body?.cancel(),
  }, options);
}
