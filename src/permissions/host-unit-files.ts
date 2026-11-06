/**
 * Helpers shared by every feature that installs a systemd unit through
 * `tp-host` and keeps a private file the daemon stages for root to copy.
 *
 * `/etc/systemd/system` is root-owned and the daemon is not root, so the unit
 * text is staged in a folder the daemon owns, compared with the installed file
 * through the privileged runner, and installed only when the bytes differ. A
 * file that carries a secret is created `0600` and renamed into place, so it is
 * never on disk with a wider mode, even briefly.
 */
import { join } from "@std/path";
import type { RunFn } from "../deploy/ensure-principal.ts";
import { hostSudoArgs } from "./host-sudo.ts";

/**
 * True when `installedPath` already holds exactly the staged bytes.
 *
 * A `cmp` that cannot answer reports **changed**, so the worst case is a
 * redundant install.
 */
export async function installedFileMatches(
  run: RunFn,
  stagedPath: string,
  installedPath: string,
): Promise<boolean> {
  const cmp = await run(
    "sudo",
    hostSudoArgs(["-n", "cmp", "-s", "--", stagedPath, installedPath]),
  );
  return cmp.success;
}

/**
 * Stage `contents`, diff it against the installed unit, and install only on a
 * real difference. Returns whether the installed file **changed**.
 */
export async function installUnitFile(
  run: RunFn,
  params: { stagedPath: string; installedPath: string; contents: string },
): Promise<boolean> {
  await Deno.writeTextFile(params.stagedPath, params.contents, { mode: 0o640 });
  if (
    await installedFileMatches(run, params.stagedPath, params.installedPath)
  ) {
    return false;
  }
  const install = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "install",
      "-m",
      "0644",
      "-o",
      "root",
      "-g",
      "root",
      params.stagedPath,
      params.installedPath,
    ]),
  );
  if (!install.success) {
    throw new Error(
      install.stderr || `Failed to install unit ${params.installedPath}`,
    );
  }
  return true;
}

/**
 * Write `text` to `<dir>/<name>` through a `0600` temp file and a rename, so a
 * reader never sees a half-written file and the mode is never wider than 0600.
 */
export async function writePrivateFileAtomic(
  dir: string,
  name: string,
  text: string,
): Promise<string> {
  const path = join(dir, name);
  const tmp = join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(tmp, text, { mode: 0o600, createNew: true });
    await Deno.rename(tmp, path);
  } catch (err) {
    await Deno.remove(tmp).catch(() => undefined);
    throw err;
  }
  return path;
}
