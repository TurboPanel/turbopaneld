/**
 * `server.reboot` command handler.
 *
 * Returns `{ scheduled: true }` immediately so the `command-outcome` WS frame
 * flushes before the host goes down. The actual `sudo -n systemctl reboot`
 * runs after {@link REBOOT_HANDOFF_DELAY_MS}. The executor is injectable via
 * {@link setRebootExecutorForTests} for unit tests.
 */
import { logInfo, logWarn } from "../../logger.ts";
import {
  parseRebootPayload,
  type RebootPayload,
  type RebootResult,
} from "./contracts.ts";

export const REBOOT_HANDOFF_DELAY_MS = 2_000;

type RunReboot = () => Promise<{ success: boolean; stderr: string }>;

let rebootExecutorOverride: RunReboot | null = null;

/** Test-only override; pass `null` to restore the default executor. */
export function setRebootExecutorForTests(fn: RunReboot | null): void {
  rebootExecutorOverride = fn;
}

function stripLogInjection(text: string): string {
  return text.replaceAll("\n", "_").replaceAll("\r", "_").replaceAll("\t", "_");
}

const runRebootDefault: RunReboot = async () => {
  const result = await new Deno.Command("sudo", {
    args: ["-n", "systemctl", "reboot"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
};

export async function handleReboot(
  payload: RebootPayload,
  _daemonReceivedAt: string,
): Promise<RebootResult> {
  parseRebootPayload(payload);

  logInfo("commands", "scheduling system reboot");

  const executor = rebootExecutorOverride ?? runRebootDefault;

  setTimeout(async () => {
    const result = await executor();
    if (!result.success) {
      logWarn(
        "commands",
        "reboot failed:",
        stripLogInjection(result.stderr),
      );
    }
  }, REBOOT_HANDOFF_DELAY_MS);

  return { scheduled: true };
}
