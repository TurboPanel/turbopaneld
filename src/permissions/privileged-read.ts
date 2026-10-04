/**
 * Reads of host paths the daemon account may not be able to open itself.
 *
 * Several trees the daemon used to read directly are now root-owned with an
 * engine or principal group: `/etc/turbopanel/caddy` can be root-owned
 * `0750`, and principal homes under
 * `/srv/users` are `0750` to their own group. A direct `Deno.*` call there
 * fails with PermissionDenied, which used to read as "absent". These helpers
 * try the direct call first and only then ask tp-host, which refuses any path
 * with a symlink component.
 */
import { hostSudoArgs } from "./host-sudo.ts";
import { runPrivileged } from "../deploy/release/release-layout.ts";

export type PrivilegedReadRun = (
  command: string,
  args: string[],
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

function needsRoot(err: unknown): boolean {
  return err instanceof Deno.errors.PermissionDenied ||
    err instanceof Deno.errors.NotCapable;
}

function isAbsent(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("no such file") || text.includes("not found");
}

/**
 * Contents of a text file, or `null` when it does not exist. Falls back to
 * tp-host `cat` when the daemon may not open it.
 */
export async function readTextFileOrNull(
  path: string,
  run: PrivilegedReadRun = runPrivileged,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    if (!needsRoot(err)) throw err;
  }
  const read = await run("sudo", hostSudoArgs(["-n", "cat", "--", path]));
  if (read.success) return read.stdout;
  if (isAbsent(read.stderr)) return null;
  throw new Error(read.stderr || `failed to read ${path}`);
}

/**
 * Whether `path` is a directory, answered by `stat` when the daemon can reach
 * it. Behind a directory it may not traverse, tp-host's `test -e` answers
 * presence only: nothing inside the other owner's tree is read.
 */
export async function directoryExists(
  path: string,
  run: PrivilegedReadRun = runPrivileged,
): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    if (!needsRoot(err)) throw err;
  }
  const test = await run("sudo", hostSudoArgs(["-n", "test", "-e", path]));
  return test.success;
}
