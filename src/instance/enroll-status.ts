import { join } from "@std/path";
import { assertTestRunMayWrite } from "../permissions/test-write-guard.ts";

/**
 * The daemon's latest answer from the control plane, for the installer.
 *
 * `run.sh` removes this file before it starts the daemon, then waits a short
 * while for it to say whether the control plane let this server in. It lives
 * in the runtime folder (`/run/turbopanel`), so it never outlives a reboot and
 * never sits in the root-owned state tree.
 *
 * Plain `key=value` lines, no quoting:
 *
 *   state=connected            a session opened (enrolled or signed in)
 *   state=parked               the daemon stopped trying for now
 *   kind=<parked kind>         only with state=parked
 *   reason=<one line>          only with state=parked; control plane text
 *   advice=<one line>          optional, what to do about it
 *
 * The installer reads it as root while the daemon account can write it, so
 * it never runs or sources it, and it strips control characters from the
 * reason before printing it.
 */
export const ENROLL_STATUS_FILE = "enroll-status";

export type EnrollStatus =
  | { state: "connected" }
  | { state: "parked"; kind: string; reason: string; advice?: string };

/** One printable line: control characters and line breaks become spaces. */
function oneLine(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.trim().slice(0, 600);
}

export function formatEnrollStatus(status: EnrollStatus): string {
  if (status.state === "connected") return "state=connected\n";
  const lines = [
    "state=parked",
    `kind=${oneLine(status.kind)}`,
    `reason=${oneLine(status.reason)}`,
  ];
  if (status.advice) lines.push(`advice=${oneLine(status.advice)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Replace the status file in `runDir`. Synchronous on purpose: the file is a
 * few bytes on a tmpfs, and a sync write keeps a park and a later session in
 * order and leaves nothing pending behind the caller. Best effort: a failure
 * is thrown for the caller to log at debug level and never stops the connect
 * loop.
 */
export function writeEnrollStatus(runDir: string, status: EnrollStatus): void {
  const path = join(runDir, ENROLL_STATUS_FILE);
  assertTestRunMayWrite(path);
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    Deno.writeTextFileSync(tmp, formatEnrollStatus(status), { mode: 0o640 });
    Deno.renameSync(tmp, path);
  } catch (err) {
    try {
      Deno.removeSync(tmp);
    } catch {
      // nothing was written
    }
    throw err;
  }
}
