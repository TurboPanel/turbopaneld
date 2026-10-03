/**
 * Files the daemon keeps directly in the config and state roots.
 *
 * `/etc/turbopanel` and `/var/lib/turbopanel` are root-owned on a managed host
 * (P1-1): the daemon account can write inside its own folders (the leaves in
 * `src/paths/layout.ts`) but cannot create, rename or remove an entry in the
 * root itself. The few files that live at that level (`instance-ca.pem`,
 * `firewall*.v4|v6`, `server.id`, the server key, `update-guard-disarm.json`)
 * are written here: first the way the daemon always did (stage next to the
 * file and rename it in, which works while the root is writable and in
 * development), and when the OS says no, through `tp-host install` / `rm`,
 * which creates the file as the daemon account's own and replaces it
 * atomically. The path never changes.
 */
import { hostSudoArgs } from "./host-sudo.ts";

/** The daemon's own account and group (`tp:tp`), the owner `tp-host` hands the file to. */
export const DAEMON_ACCOUNT = "tp";

function needsRoot(err: unknown): boolean {
  return err instanceof Deno.errors.PermissionDenied ||
    err instanceof Deno.errors.NotCapable;
}

export type HostRun = (args: string[]) => Promise<void>;

async function runHost(args: string[]): Promise<void> {
  const result = await new Deno.Command("sudo", {
    args: hostSudoArgs(["-n", ...args]),
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() ||
        `sudo ${args[0]} failed`,
    );
  }
}

function modeOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

/**
 * Write `text` to `path` so a reader never sees half a file, owned by the
 * daemon account with `mode` (never group- or world-writable: `tp-host`
 * refuses that outside a principal's home).
 */
export async function writeDaemonFile(
  path: string,
  text: string,
  mode: number,
  run: HostRun = runHost,
): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await Deno.writeTextFile(tmp, text, { mode });
    await Deno.rename(tmp, path);
    return;
  } catch (err) {
    await removeQuietly(tmp);
    if (!needsRoot(err)) throw err;
  }
  const staging = await Deno.makeTempFile({ prefix: "tp-daemon-file-" });
  try {
    await Deno.writeTextFile(staging, text);
    // tp-host never installs a group- or world-writable file here; the
    // writable bits only mattered while the folder itself was writable.
    await run([
      "install",
      "-m",
      modeOctal(mode & 0o755),
      "-o",
      DAEMON_ACCOUNT,
      "-g",
      DAEMON_ACCOUNT,
      staging,
      path,
    ]);
  } finally {
    await removeQuietly(staging);
  }
}

/** Remove `path` if present; through `tp-host rm` when its folder is root's. */
export async function removeDaemonFile(
  path: string,
  run: HostRun = runHost,
): Promise<void> {
  try {
    await Deno.remove(path);
    return;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    if (!needsRoot(err)) throw err;
  }
  await run(["rm", "-f", "--", path]);
}

/**
 * Create `dir` (and parents) when missing. A root-owned directory that
 * already exists is fine: the installer made it and the daemon only fills it.
 */
export async function ensureDaemonDir(
  dir: string,
  mode = 0o750,
): Promise<void> {
  try {
    await Deno.mkdir(dir, { recursive: true, mode });
  } catch (err) {
    if (!needsRoot(err)) throw err;
    if (!(await Deno.stat(dir)).isDirectory) throw err;
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // best effort: a staging file that never got written
  }
}
