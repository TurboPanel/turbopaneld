import { logWarn } from "../logger.ts";

export const DEFAULT_DAEMON_UNIT = "turbopanel-daemon";

function stripLogInjection(text: string): string {
  return text.replace(/[\r\n\t]/g, " ");
}

/** Args passed to systemctl when restarting after dev-sync or UI update. */
export function buildDaemonRestartSystemctlArgs(
  unit = DEFAULT_DAEMON_UNIT,
): string[][] {
  return [
    ["enable", unit],
    ["restart", unit],
  ];
}

export function resolveDaemonServiceUnit(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const trimmed = env.TURBOPANEL_SERVICE_NAME?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DAEMON_UNIT;
}

/**
 * Enable and restart the daemon systemd unit.
 *
 * Uses `enable` then `restart` (not `enable --now`) so an already-active unit
 * is replaced with a new process after `--no-start` reconcile. `enable --now`
 * alone leaves a running daemon on old code.
 */
export async function restartDaemonService(
  options: {
    unit?: string;
    runSystemctl?: (args: string[]) => Promise<{ success: boolean; stderr: string }>;
  } = {},
): Promise<boolean> {
  const unit = options.unit ?? resolveDaemonServiceUnit();
  const runSystemctl = options.runSystemctl ??
    (async (args: string[]) => {
      const result = await new Deno.Command("systemctl", {
        args,
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
        "systemctl",
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
