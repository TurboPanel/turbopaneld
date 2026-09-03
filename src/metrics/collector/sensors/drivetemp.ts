/**
 * `drivetemp` kernel module opt-in.
 *
 * SATA/SAS drive temperatures (`HardwareProfile.diskTemperature` slots via
 * the `drivetemp` hwmon chip, see `discovery.ts`) require the `drivetemp`
 * kernel module, which most distributions do not autoload. When an operator
 * flips `HardwareProfile.drivetempEnabled` to `true` (pushed over
 * `metrics-sensor-overrides-update`, see `../../../instance/client.ts`),
 * {@link ensureDrivetempLoaded} loads the module for the running kernel and
 * writes a `modules-load.d` drop-in so it survives a reboot too.
 *
 * One-shot command execution (same class as `reboot.ts`/`hostname.ts`), not
 * a per-interval subprocess — collection itself never spawns anything.
 */
import { logWarn } from "../../../logger.ts";

const MODULES_LOAD_DROPIN_PATH =
  "/etc/modules-load.d/turbopanel-drivetemp.conf";

export type DrivetempLoadResult = {
  loaded: boolean;
  summary?: string;
};

type RunModprobe = () => Promise<{ success: boolean; stderr: string }>;
type WriteDropin = (path: string, contents: string) => Promise<void>;

let modprobeExecutorOverride: RunModprobe | null = null;
let writeDropinOverride: WriteDropin | null = null;

/** Test-only override; pass `null` to restore the default executor. */
export function setDrivetempExecutorForTests(fn: RunModprobe | null): void {
  modprobeExecutorOverride = fn;
}

/** Test-only override; pass `null` to restore the default writer. */
export function setDrivetempDropinWriterForTests(
  fn: WriteDropin | null,
): void {
  writeDropinOverride = fn;
}

function stripLogInjection(text: string): string {
  return text.replaceAll("\n", "_").replaceAll("\r", "_").replaceAll("\t", "_");
}

const runModprobeDefault: RunModprobe = async () => {
  const result = await new Deno.Command("sudo", {
    args: ["-n", "modprobe", "drivetemp"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
};

const writeDropinDefault: WriteDropin = (path, contents) =>
  Deno.writeTextFile(path, contents);

/**
 * Load the `drivetemp` module now and register it for reboot durability.
 * Never throws — a failed load is logged and reported in the result so the
 * caller (the `metrics-sensor-overrides-update` handler) can proceed with
 * the already-acked profile write regardless.
 */
export async function ensureDrivetempLoaded(): Promise<DrivetempLoadResult> {
  const executor = modprobeExecutorOverride ?? runModprobeDefault;
  const writeDropin = writeDropinOverride ?? writeDropinDefault;

  let result: { success: boolean; stderr: string };
  try {
    result = await executor();
  } catch (err) {
    // Deno.Command.output() throws (not success:false) when the binary
    // can't be spawned at all — e.g. no `sudo` in a container image. The
    // caller fires this without awaiting, so a rejection here would surface
    // as an unhandled promise rejection and take the daemon process down.
    const summary = `modprobe drivetemp could not run: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logWarn("commands", summary);
    return { loaded: false, summary };
  }
  if (!result.success) {
    const summary = `modprobe drivetemp failed: ${
      stripLogInjection(result.stderr)
    }`;
    logWarn("commands", summary);
    return { loaded: false, summary };
  }

  try {
    await writeDropin(MODULES_LOAD_DROPIN_PATH, "drivetemp\n");
  } catch (err) {
    const summary = `drivetemp loaded but modules-load.d drop-in failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logWarn("commands", summary);
    return { loaded: true, summary };
  }

  return { loaded: true };
}
