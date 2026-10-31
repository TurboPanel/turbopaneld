/**
 * A boot converge that failed used to leave the daemon without a verified
 * runtime until its next restart (no Docker monitor, fabric restore or PHP
 * reconcile). This retries it in the background with a growing, bounded pause
 * and keeps the outcome where the rest of the daemon can read it.
 */

import { trackBootConverge } from "./boot-converge-gate.ts";

/** Pauses before retry 1..N; the list length is the retry budget (about 33 minutes in all). */
export const BOOT_CONVERGE_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  120_000,
  300_000,
  600_000,
  900_000,
];

export type RuntimeVerification = "verified" | "retrying" | "not-verified";

let state: RuntimeVerification = "verified";

/** Whether the runtime is verified, being retried, or gave up (restart or a command converge fixes it). */
export function runtimeVerification(): RuntimeVerification {
  return state;
}

/** Called when the first boot attempt failed, before any retry is scheduled. */
export function markRuntimeUnverified(): void {
  state = "retrying";
}

/** Test seam. */
export function resetRuntimeVerificationForTests(): void {
  state = "verified";
}

export type BootConvergeRetryOptions = {
  /** Tools bootstrap plus boot converge; resolves true when both worked. */
  attempt: () => Promise<boolean>;
  /** Runs once after a retry finally worked (the steps that need a converged host). */
  onRecovered: () => Promise<void>;
  signal: AbortSignal;
  /** Resolves after the pause, or at once when aborted. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (message: string) => void;
  delaysMs?: readonly number[];
};

/** Real timer pause that ends early on abort. */
export function abortableSleep(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Retry after a failed boot attempt. Each attempt is registered with the
 * command gate, so commands wait only while a playbook is really running and
 * not during the pauses. Returns true when an attempt worked.
 */
export async function retryBootConverge(
  opts: BootConvergeRetryOptions,
): Promise<boolean> {
  const delays = opts.delaysMs ?? BOOT_CONVERGE_RETRY_DELAYS_MS;
  state = "retrying";
  for (let i = 0; i < delays.length; i++) {
    await opts.sleep(delays[i]!, opts.signal);
    if (opts.signal.aborted) return false;
    opts.log(
      `retrying the boot converge (attempt ${i + 1} of ${delays.length})`,
    );
    const run = opts.attempt().catch(() => false);
    trackBootConverge(run);
    if (await run) {
      state = "verified";
      opts.log("boot converge succeeded on retry");
      try {
        await opts.onRecovered();
      } catch (err) {
        opts.log(
          `start-up steps after the retried converge failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return true;
    }
  }
  state = "not-verified";
  opts.log(
    "boot converge still failing after every retry; the runtime stays unverified until the next restart",
  );
  return false;
}
