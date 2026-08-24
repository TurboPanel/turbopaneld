/**
 * Command execution-log transcript contracts.
 *
 * One {@link CommandOutputEvent} per captured line. Events are redacted before
 * they touch the spool file (see `redactor.ts`), spooled as NDJSON under
 * `<stateDir>/spool/execution-logs/<commandId>.log`, and uploaded in batches to
 * `POST /api/daemon/v1/commands/:commandId/log`.
 */

import { normalizeDenySet, redactCommandSummary } from "./redactor.ts";

export type CommandLogStream = "stdout" | "stderr";

/**
 * Scrubs a **command summary** — the process stdout/stderr a handler turns into
 * an error message. Summaries bypass the per-line transcript path entirely and
 * end up in persisted command history, so they need the same deny-set the
 * transcript gets.
 */
export type CommandSummaryRedactor = (text: string) => string;

export interface CommandOutputEvent {
  commandId: string;
  /** Monotonic per command, starting at 1. */
  sequence: number;
  timestamp: string;
  stream: CommandLogStream;
  phase: string;
  message: string;
}

/**
 * Phase names. The deploy steps mirror `src/deploy/AGENTS.md`; `hooks` covers
 * hook output that is not clearly pre/post, and `managed-apply` covers the
 * managed engine bring-up (`src/managed/AGENTS.md`).
 */
export const COMMAND_LOG_PHASES = {
  PREPARE: "prepare",
  PULL: "pull",
  /** Git checkout for a source-backed release (`src/deploy/release/`). */
  FETCH: "fetch",
  BUILD: "build",
  /** Staging + atomic `current` swap for a source-backed release. */
  RELEASE_PROMOTE: "release-promote",
  PRE_DEPLOY: "pre-deploy",
  COMPOSE_UP: "compose-up",
  HEALTH: "health",
  POST_DEPLOY: "post-deploy",
  HOOKS: "hooks",
  MANAGED_APPLY: "managed-apply",
  LIFECYCLE_START: "lifecycle-start",
  LIFECYCLE_STOP: "lifecycle-stop",
  LIFECYCLE_RESTART: "lifecycle-restart",
  STOP: "stop",
} as const;

export type CommandLogPhase =
  typeof COMMAND_LOG_PHASES[keyof typeof COMMAND_LOG_PHASES];

/** Phase for a `docker compose start|stop|restart` lifecycle action. */
export function lifecyclePhase(action: string): string {
  switch (action) {
    case "start":
      return COMMAND_LOG_PHASES.LIFECYCLE_START;
    case "stop":
      return COMMAND_LOG_PHASES.LIFECYCLE_STOP;
    case "restart":
      return COMMAND_LOG_PHASES.LIFECYCLE_RESTART;
    default:
      return COMMAND_LOG_PHASES.LIFECYCLE_START;
  }
}

/**
 * Sink handlers write transcript lines to. Every method is safe to call on the
 * no-op sink, and no method may ever throw into the command handler.
 */
export interface CommandOutputSink {
  /** Record one already-captured line (redaction happens inside the sink). */
  onLine(stream: CommandLogStream, message: string): void;
  /** Tag subsequent lines with a new phase. */
  setPhase(phase: string): void;
  /**
   * Extend the redaction deny-set with plaintext the handler just decrypted.
   * Values are matched literally — never a generic secret-scanning heuristic.
   */
  addSecrets(values: readonly (string | null | undefined)[]): void;
  /**
   * Scrub process output that is about to become a command **summary** (a
   * thrown error message / `command-outcome.error`) against the same deny-set
   * transcript lines get. Multi-line text is preserved as-is apart from the
   * redaction — never a substitute for `sanitizeForLog` at the log seam.
   *
   * Always safe to call, including on the no-op sink: redaction is a security
   * guarantee, transcript upload is not.
   */
  redactSummary(text: string): string;
  /** Flush + drop the spool file. Idempotent; never throws. */
  finalize(): Promise<void>;
}

/**
 * Default sink for every call site that has no command context (tests, CLI).
 *
 * Transcript capture is dropped, but redaction is **not**: the sink still
 * accumulates the deny-set it is handed so `redactSummary` scrubs a failure
 * summary even when no upload transport exists. A daemon without a control
 * plane must not be the configuration that leaks plaintext.
 */
export function createNoopCommandOutputSink(): CommandOutputSink {
  const secrets: string[] = [];
  return {
    onLine() {},
    setPhase() {},
    addSecrets(values) {
      for (const value of values) {
        if (typeof value === "string" && value.length > 0) secrets.push(value);
      }
    },
    redactSummary(text) {
      return redactCommandSummary(text, normalizeDenySet(secrets));
    },
    finalize() {
      return Promise.resolve();
    },
  };
}

/** Serialize one event as an NDJSON spool line (always newline-terminated). */
export function encodeCommandOutputEvent(event: CommandOutputEvent): string {
  return `${JSON.stringify(event)}\n`;
}
