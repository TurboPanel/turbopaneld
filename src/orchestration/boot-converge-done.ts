import { join } from "@std/path";

/**
 * Written to the run folder (`/run/turbopanel`, emptied on every boot) once the
 * daemon's boot converge on this boot has passed. The installer's last step
 * (`orchestration/scripts/tp-kernel-features installer-step`) waits for a copy
 * newer than the install's start marker before it restarts a new Raspberry Pi,
 * so the restart never cuts the first converge (and its apt tasks) short.
 */
export const BOOT_CONVERGE_DONE_FILE = "boot-converge-done";

/**
 * Write the marker. Does nothing when the run folder is missing (it is never
 * created here). The file is written under a temporary name and renamed, so
 * a reader never sees half of it.
 */
export async function recordBootConvergeDone(
  runDir: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    if (!(await Deno.stat(runDir)).isDirectory) return false;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
  const path = join(runDir, BOOT_CONVERGE_DONE_FILE);
  const temporary = `${path}.tmp`;
  await Deno.writeTextFile(
    temporary,
    `${JSON.stringify({ finishedAt: now.toISOString() })}\n`,
    { mode: 0o644 },
  );
  await Deno.rename(temporary, path);
  return true;
}
