/**
 * Per-service run state the daemon reports on `hello` and change-detected
 * `heartbeat` (`services`). Twin of
 * `turbopanel/src/contracts/service-run-state.ts` (checked by
 * `scripts/check-contract-drift.ts`): keep field names and optionality aligned.
 *
 * One entry per TurboPanel service that has at least one container on this
 * host. `asOf` is when the daemon last saw this exact state change (not a
 * sample time), so an idle service reports a stable value and heartbeat change
 * detection stays quiet.
 */
export type ServiceRunState = {
  serviceId: string;
  /**
   * `running` only after the container has stayed up for the settle window;
   * `crashing` while Docker keeps restarting it; `stopped_after_crashes` once it
   * is down at or past the restart limit.
   */
  state:
    | "starting"
    | "running"
    | "unhealthy"
    | "crashing"
    | "stopped"
    | "stopped_after_crashes"
    | "unknown";
  restartCount: number;
  /** Last log line of the failing container, at most 400 characters. */
  lastError?: string;
  asOf: string;
};

export type ServiceRunStateName = ServiceRunState["state"];

/** Restarts after which a still-down service counts as stopped after crashes. */
export const SERVICE_CRASH_LIMIT = 10;

/** A container must stay up this long before its service is `running`. */
export const SERVICE_SETTLE_MS = 60_000;

/** Entries one frame may carry; the control plane enforces the same cap. */
export const MAX_SERVICE_RUN_STATES = 200;

/** `lastError` cap, shared with `lastLogReason`. */
export const MAX_SERVICE_LAST_ERROR_CHARS = 400;
