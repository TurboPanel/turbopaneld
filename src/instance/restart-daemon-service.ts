import type { UpdateRestartReport } from "../contracts/cell-messages.ts";
import { logWarn } from "../util/logger.ts";

import { hostSudoArgs } from "../permissions/host-sudo.ts";
export const DEFAULT_DAEMON_UNIT = "turbopaneld";

function stripLogInjection(text: string): string {
  return text.replace(/[\r\n\t]/g, " ");
}

/** sudo -n systemctl invocations after dev-sync or UI update. */
export function buildDaemonRestartSystemctlArgs(
  unit = DEFAULT_DAEMON_UNIT,
): string[][] {
  return [
    ["-n", "systemctl", "enable", unit],
    // `--no-block`: this call runs INSIDE the unit it is restarting. A plain
    // `restart` blocks until the job finishes, but finishing means stopping
    // the old unit first — which kills every process in its cgroup,
    // including this very sudo/systemctl child, before the job can be
    // observed as done. The blocked call then reads as a failure (killed,
    // not exited 0) even though the restart went on to succeed, and the
    // daemon reports a false "restart failed" with the old process's dying
    // breath. `--no-block` only waits for systemd to *accept and queue* the
    // job, which happens before the old unit starts stopping, so this call
    // returns (truthfully) well before any risk of being torn down.
    // Whether the new process actually comes up on the right commit is
    // confirmed separately, after restart, by the update-guard/attach flow
    // (`update-guard.ts`) — not by this call.
    ["-n", "systemctl", "restart", "--no-block", unit],
  ];
}

export function resolveDaemonServiceUnit(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const trimmed = env.TURBOPANEL_SERVICE_NAME?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DAEMON_UNIT;
}

/** What one `sudo systemctl` call returned. */
export type SystemctlRun = {
  success: boolean;
  stderr: string;
  /** Exit code; 128 + signal number when the child was ended by a signal. */
  code?: number | null;
  /** Signal that ended the child, when one did. */
  signal?: string | null;
};

/**
 * How the restart went, for the update step detail. Sent to the control plane
 * only when the restart is reported as failed, so the next failure can be
 * diagnosed without shell access to the host.
 */
export type DaemonRestartReport = {
  ok: boolean;
  /**
   * The restart command was ended by SIGTERM/SIGKILL: systemd had already begun
   * stopping this unit, so the restart took effect and the exit status says
   * nothing about it.
   */
  endedByRestart: boolean;
  /** `enable` or `restart`: the command that failed (or was ended). */
  command?: string;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  /** Times the failing command was run (2 after the single retry); on success, the most any command needed. */
  attempts: number;
  elapsedMs: number;
};

/** 143 and 137: the shell-style exit codes for SIGTERM and SIGKILL. */
const KILLED_EXIT_CODES: ReadonlySet<number> = new Set([143, 137]);
const KILLED_SIGNALS: ReadonlySet<string> = new Set(["SIGTERM", "SIGKILL"]);

/** Wait before the single retry of a failed command. */
export const RESTART_RETRY_DELAY_MS = 1000;

/** True when systemd tore the process down (the unit is stopping), not when the command failed. */
export function endedByUnitStop(run: SystemctlRun): boolean {
  if (run.signal && KILLED_SIGNALS.has(run.signal)) return true;
  return typeof run.code === "number" && KILLED_EXIT_CODES.has(run.code);
}

/**
 * Only the `restart` call stops this unit, so only a killed `restart` means
 * the restart happened. A killed `enable` came before any restart was queued
 * and is a real failure.
 */
function restartTookEffect(args: string[], run: SystemctlRun): boolean {
  return args[2] === "restart" && endedByUnitStop(run);
}

type RestartOptions = {
  unit?: string;
  runSystemctl?: (args: string[]) => Promise<SystemctlRun>;
  /** Pause before the retry; tests pass 0. */
  retryDelayMs?: number;
  /** Receives the full report once, whatever the outcome. */
  onReport?: (report: DaemonRestartReport) => void;
};

async function defaultRunSystemctl(args: string[]): Promise<SystemctlRun> {
  const result = await new Deno.Command("sudo", {
    args: hostSudoArgs(args),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: new TextDecoder().decode(result.stderr).trim(),
    code: result.code,
    signal: result.signal ?? null,
  };
}

function logRestartFailure(
  unit: string,
  args: string[],
  run: SystemctlRun,
): void {
  logWarn(
    "daemon",
    "sudo",
    stripLogInjection(args.join(" ")),
    stripLogInjection(unit),
    "failed:",
    stripLogInjection(run.stderr || "unknown error"),
  );
}

/**
 * Enable and restart the daemon systemd unit via passwordless sudo.
 *
 * The daemon process runs as `turbopanel`, not root — plain `systemctl` fails.
 * Uses `enable` then `restart` (not `enable --now`) so an already-active unit
 * is replaced after `--no-start` reconcile.
 *
 * A `true` result means both commands were accepted by systemd, not that
 * the new process is up and healthy — the restart itself is `--no-block`
 * (see {@link buildDaemonRestartSystemctlArgs}), so it can't wait for that
 * without risking the exact race it exists to avoid. Callers that need to
 * know the new build actually came up rely on the update-guard/attach flow
 * (`update-guard.ts`), which runs in the *new* process and isn't subject to
 * the old one being torn down mid-check.
 *
 * `--no-block` returns once the job is queued, but systemd starts stopping
 * the unit at once and kills the whole cgroup, which still holds the exiting
 * `sudo` parent. On a slow host the parent can be ended by that SIGTERM after
 * `systemctl` already succeeded, so a command ended by SIGTERM/SIGKILL counts
 * as the restart having happened, not as a failure. That holds only for the
 * `restart` call: a killed `enable` is a real failure. A real failure is
 * retried once before it is reported.
 */
export async function restartDaemonService(
  options: RestartOptions = {},
): Promise<boolean> {
  const unit = options.unit ?? resolveDaemonServiceUnit();
  const runSystemctl = options.runSystemctl ?? defaultRunSystemctl;
  const retryDelayMs = options.retryDelayMs ?? RESTART_RETRY_DELAY_MS;
  const started = performance.now();
  const report = (partial: Partial<DaemonRestartReport>) => {
    const full: DaemonRestartReport = {
      ok: true,
      endedByRestart: false,
      exitCode: 0,
      signal: null,
      stderr: "",
      attempts: 1,
      elapsedMs: Math.round(performance.now() - started),
      ...partial,
    };
    options.onReport?.(full);
    return full.ok;
  };

  let mostAttempts = 1;
  for (const args of buildDaemonRestartSystemctlArgs(unit)) {
    let run = await runSystemctl(args);
    let attempts = 1;
    if (!run.success && !restartTookEffect(args, run)) {
      logRestartFailure(unit, args, run);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      run = await runSystemctl(args);
      attempts = 2;
    }
    mostAttempts = Math.max(mostAttempts, attempts);
    if (run.success) continue;
    const command = args[2];
    const failure = {
      command,
      exitCode: run.code ?? null,
      signal: run.signal ?? null,
      stderr: run.stderr,
      attempts,
    };
    if (restartTookEffect(args, run)) {
      return report({ ...failure, ok: true, endedByRestart: true });
    }
    logRestartFailure(unit, args, run);
    return report({ ...failure, ok: false });
  }
  return report({ attempts: mostAttempts });
}

/** One line for the step detail: command, exit status, stderr, tries and elapsed time. */
export function describeRestartReport(report: DaemonRestartReport): string {
  const status = report.signal
    ? `ended by ${report.signal}`
    : `exited ${report.exitCode ?? "without a status"}`;
  const stderr = stripLogInjection(report.stderr).slice(0, 300);
  return [
    `systemctl ${report.command ?? "restart"} ${status}`,
    stderr ? `stderr: ${stderr}` : "no stderr",
    `${report.attempts} ${report.attempts === 1 ? "try" : "tries"}`,
    `${report.elapsedMs} ms`,
  ].join(", ");
}

/** The error text the update result and the failed stage carry. */
export function restartFailureMessage(
  report: DaemonRestartReport | undefined,
): string {
  return report
    ? `daemon restart failed after reconcile (${describeRestartReport(report)})`
    : "daemon restart failed after reconcile";
}

/** The optional `restart` object on the failed stage frame (bounded, no control characters). */
export function toRestartWire(
  report: DaemonRestartReport,
): UpdateRestartReport {
  const stderr = stripLogInjection(report.stderr).slice(0, 500);
  return {
    ...(report.command ? { command: report.command } : {}),
    ...(report.exitCode === null ? {} : { exitCode: report.exitCode }),
    ...(report.signal ? { signal: report.signal } : {}),
    ...(stderr ? { stderr } : {}),
    attempts: report.attempts,
    elapsedMs: report.elapsedMs,
  };
}
