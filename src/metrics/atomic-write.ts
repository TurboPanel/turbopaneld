import { dirname } from "@std/path";
import { logWarn } from "../util/logger.ts";

/**
 * Write a metrics state file atomically: create the directory, write a temp
 * file with a name unique to this call, then rename it over the target.
 *
 * The temp name must be unique per call. Several collectors persist the same
 * file in one tick, and with a shared `<path>.tmp` the first rename moves the
 * file out from under the second writer, whose rename then fails with
 * "No such file".
 */
export async function writeTextFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(tmpPath, text);
    await Deno.rename(tmpPath, path);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => undefined);
    throw err;
  }
}

/** True when a write failed because the disk or quota has no space left. */
export function isNoSpaceError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" &&
    /no space left on device|disk quota exceeded/i.test(message);
}

/**
 * Persist comparison state that can be rebuilt on the next tick. A full disk
 * is logged and skipped (returns false) so the daemon keeps running and tries
 * again on the next call; every other failure still throws.
 */
export async function writeTextFileAtomicOrSkipWhenFull(
  path: string,
  text: string,
  write: (path: string, text: string) => Promise<void> = writeTextFileAtomic,
): Promise<boolean> {
  try {
    await write(path, text);
    return true;
  } catch (err) {
    if (!isNoSpaceError(err)) throw err;
    logWarn(
      "metrics",
      "disk is full, state file not saved, will retry:",
      path,
    );
    return false;
  }
}
