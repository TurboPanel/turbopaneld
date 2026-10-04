/**
 * Cancelling a running `environment.deploy` — the daemon side.
 *
 * The control plane sends `deploy-cancel { commandId }` over the cell wire; the
 * command queue cannot carry it, because a running deploy holds the queue slot
 * for the whole run. The deploy handler checks a {@link DeployCancelToken} at
 * its checkpoints and hands the token's signal to the processes it spawns
 * (git, the build, `docker compose build`), so a cancel stops the work promptly.
 *
 * **The cutover rule.** A cancel is honoured only while nothing the old version
 * depends on has changed. The first step that changes what is serving (a release
 * `current` swap, a site or native app apply, the cron sweep, retiring an
 * earlier compose project, stopping the old containers, `compose up`) calls
 * {@link DeployCancelToken.commit}. From then on the deploy runs to its normal
 * end and a cancel answers `too_late`. Before it, a cancel throws
 * {@link DeployCancelledError} and the deploy's own `finally` blocks clean up
 * the scratch checkout, the build work tree and the compose stage directory, so
 * the previous version keeps serving untouched.
 *
 * The error text starts with `cancelled: `; that prefix is the contract the
 * control plane reads out of the command outcome (the outcome carries only a
 * string), the same way `rolled_back: ` / `needs_attention: ` work.
 */

/** Prefix of every cancelled-deploy error message (the wire contract). */
export const CANCELLED_PREFIX = "cancelled: ";

/** A deploy that stopped because it was cancelled before it switched over. */
export class DeployCancelledError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`${CANCELLED_PREFIX}${detail}`);
    this.name = "DeployCancelledError";
    this.detail = detail;
  }
}

/** What a `deploy-cancel` request found. */
export type DeployCancelOutcome = "cancelling" | "too_late" | "not_running";

export interface DeployCancelToken {
  /** Aborted when a cancel is accepted; hand it to spawned processes. */
  readonly signal: AbortSignal;
  /** True once the deploy passed its point of no return. */
  readonly committed: boolean;
  /** Throws {@link DeployCancelledError} when a cancel was accepted. */
  throwIfCancelled(where: string): void;
  /**
   * Mark the cutover. Synchronous and atomic with the abort check: either the
   * cancel already landed (this throws) or it can no longer land (it answers
   * `too_late`). Safe to call again.
   */
  commit(where: string): void;
  /** Ask the deploy to stop. */
  cancel(): "cancelling" | "too_late";
}

function cancelledMessage(where: string): string {
  return `stopped ${where}; nothing was switched over, the previous version is still serving`;
}

/** Throws {@link DeployCancelledError} when `signal` carries a cancel. */
export function throwIfAborted(
  signal: AbortSignal | undefined,
  where: string,
): void {
  if (signal?.aborted) throw new DeployCancelledError(cancelledMessage(where));
}

export function createDeployCancelToken(): DeployCancelToken {
  const controller = new AbortController();
  let committed = false;
  return {
    signal: controller.signal,
    get committed() {
      return committed;
    },
    throwIfCancelled(where) {
      throwIfAborted(controller.signal, where);
    },
    commit(where) {
      throwIfAborted(controller.signal, where);
      committed = true;
    },
    cancel() {
      if (committed) return "too_late";
      controller.abort();
      return "cancelling";
    },
  };
}

/** Test seams for {@link DeployCancelRegistry}. */
export type DeployCancelRegistryOptions = {
  now?: () => number;
  /** How long a cancel for an unknown deploy is remembered. */
  rememberMs?: number;
  /** Most remembered cancels; the oldest are dropped first. */
  maxRemembered?: number;
};

export const CANCEL_REMEMBER_MS = 15 * 60 * 1000;
export const CANCEL_REMEMBER_MAX = 256;

/**
 * Live deploys by command id, plus a short memory of cancels that found no live
 * deploy. The control plane may cancel a command it has sent but whose dispatch
 * the daemon has not started yet; remembering the id makes that dispatch fail at
 * once instead of running a deploy nobody wants.
 */
export class DeployCancelRegistry {
  readonly #live = new Map<string, DeployCancelToken>();
  readonly #remembered = new Map<string, number>();
  readonly #now: () => number;
  readonly #rememberMs: number;
  readonly #maxRemembered: number;

  constructor(options: DeployCancelRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#rememberMs = options.rememberMs ?? CANCEL_REMEMBER_MS;
    this.#maxRemembered = options.maxRemembered ?? CANCEL_REMEMBER_MAX;
  }

  /**
   * Register a deploy about to run. Throws {@link DeployCancelledError} when a
   * cancel for this id arrived first.
   */
  begin(commandId: string): DeployCancelToken {
    this.#prune();
    if (this.#remembered.delete(commandId)) {
      throw new DeployCancelledError(
        "cancelled before it started; nothing was changed",
      );
    }
    const token = createDeployCancelToken();
    this.#live.set(commandId, token);
    return token;
  }

  /** Forget a deploy that finished, however it ended. */
  end(commandId: string): void {
    this.#live.delete(commandId);
  }

  cancel(commandId: string): DeployCancelOutcome {
    const token = this.#live.get(commandId);
    if (token) return token.cancel();
    this.#remember(commandId);
    return "not_running";
  }

  #remember(commandId: string): void {
    this.#prune();
    this.#remembered.delete(commandId);
    this.#remembered.set(commandId, this.#now() + this.#rememberMs);
    while (this.#remembered.size > this.#maxRemembered) {
      const oldest = this.#remembered.keys().next();
      if (oldest.done) break;
      this.#remembered.delete(oldest.value);
    }
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, expiresAt] of this.#remembered) {
      if (expiresAt <= now) this.#remembered.delete(id);
    }
  }
}

/** The process-wide registry the command router and the cell handler share. */
export const deployCancels = new DeployCancelRegistry();
