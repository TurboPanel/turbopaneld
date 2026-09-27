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
 */
export async function restartDaemonService(
  options: {
    unit?: string;
    runSystemctl?: (
      args: string[],
    ) => Promise<{ success: boolean; stderr: string }>;
  } = {},
): Promise<boolean> {
  const unit = options.unit ?? resolveDaemonServiceUnit();
  const runSystemctl = options.runSystemctl ??
    (async (args: string[]) => {
      const result = await new Deno.Command("sudo", {
        args: hostSudoArgs(args),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        success: result.success,
        stderr: new TextDecoder().decode(result.stderr).trim(),
      };
    });

  for (const args of buildDaemonRestartSystemctlArgs(unit)) {
    const result = await runSystemctl(args);
    if (!result.success) {
      const safeUnit = stripLogInjection(unit);
      const safeArgs = stripLogInjection(args.join(" "));
      const safeStderr = stripLogInjection(result.stderr || "unknown error");
      logWarn(
        "daemon",
        "sudo",
        safeArgs,
        safeUnit,
        "failed:",
        safeStderr,
      );
      return false;
    }
  }
  return true;
}
