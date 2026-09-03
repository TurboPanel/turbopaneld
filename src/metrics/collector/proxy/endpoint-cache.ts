/**
 * Retry-bounded wrapper for a fallible loopback endpoint probe — same idiom
 * as `createCachedDockerDataRoot` (`../index.ts`), but for a value that must
 * be re-read every tick rather than cached forever: a successful scrape is
 * never remembered (traffic counters change every interval), only a
 * *failure* is remembered, so a stopped Caddy/ProxySQL is not re-dialed every
 * tick forever, while a freshly-started one is picked up within one retry
 * window.
 */

/** Minimum wait before re-probing an endpoint after a failed scrape. */
export const PROXY_ENDPOINT_RETRY_MS = 5 * 60_000;

export function createRetryBoundedProbe<T>(
  probe: () => Promise<T | null>,
  now: () => number = () => Date.now(),
): () => Promise<T | null> {
  let lastFailureAtMs: number | null = null;
  return async () => {
    if (
      lastFailureAtMs !== null &&
      now() - lastFailureAtMs < PROXY_ENDPOINT_RETRY_MS
    ) {
      return null;
    }
    const result = await probe();
    lastFailureAtMs = result === null ? now() : null;
    return result;
  };
}
