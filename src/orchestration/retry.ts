import { logWarn } from "../logger.ts";

export interface RetryOptions {
  /** Total number of attempts, including the first. Defaults to 3. */
  attempts?: number;
  /** Base delay before the first retry, in ms. Defaults to 1000. */
  baseDelayMs?: number;
  /** Upper bound on the backoff delay, in ms. Defaults to 8000. */
  maxDelayMs?: number;
  /** Short description used in the retry log line, e.g. "download uv archive". */
  label: string;
}

function delayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  // Full jitter (AWS backoff guidance): avoids every retrying host/process
  // hammering the same endpoint in lockstep after a shared blip. Not
  // security-sensitive — only spaces out retry timing.
  return Math.random() * backoff; // NOSONAR typescript:S2245 — jitter timing only, not a security context
}

/**
 * Retry a flaky async operation (network fetch, subprocess) with exponential
 * backoff and full jitter.
 *
 * Bootstrap-time network calls (uv/PyPI/Galaxy downloads) run once per host
 * with no cached fallback, so a single transient DNS hiccup, TCP reset, or
 * upstream 5xx fails the entire install even though the network is otherwise
 * fine (e.g. an unrelated already-established SSH session keeps working).
 * Retrying absorbs that class of blip; a genuinely broken/offline host still
 * fails after the final attempt with the last real error.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 8000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      const message = err instanceof Error ? err.message : String(err);
      const wait = delayMs(attempt, baseDelayMs, maxDelayMs);
      logWarn(
        "orchestration",
        `${opts.label} failed (attempt ${attempt}/${attempts}): ${message} — retrying in ${
          Math.round(wait)
        }ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastErr;
}
