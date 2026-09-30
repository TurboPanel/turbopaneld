/**
 * One lock per managed engine, shared by everything that dumps or restores
 * it: the `managed.backup` / `managed.restore` command handlers in the
 * long-running daemon and the scheduled `backup-run` one-shot (a separate
 * process started by a systemd timer).
 *
 * The lock is an advisory `flock` on `<runDir>/managed-locks/<managedId>.lock`
 * taken with `tryLock`: a second holder is refused at once rather than queued,
 * and the kernel drops the lock when the holding process exits, so a crashed
 * run can never leave a stale lock behind. `runDir` is tmpfs, so the lock
 * files themselves are gone after a reboot.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { SAFE_MANAGED_ID_RE } from "./engine-paths.ts";

/** Another backup or restore holds this engine's lock. */
export class ManagedTargetBusyError extends Error {
  constructor(managedId: string) {
    super(
      `managed engine ${managedId} is busy: another backup or restore is running`,
    );
    this.name = "ManagedTargetBusyError";
  }
}

/** `<runDir>/managed-locks/<managedId>.lock`; `managedId` is re-validated because it becomes a filename. */
export function managedTargetLockPath(
  layout: Pick<LayoutPaths, "runDir">,
  managedId: string,
): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(layout.runDir, "managed-locks", `${managedId}.lock`);
}

/**
 * Run `fn` while holding the engine's lock. Throws {@link ManagedTargetBusyError}
 * without running `fn` when another holder has it.
 */
export async function withManagedTargetLock<T>(
  layout: Pick<LayoutPaths, "runDir">,
  managedId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const path = managedTargetLockPath(layout, managedId);
  await Deno.mkdir(join(layout.runDir, "managed-locks"), {
    recursive: true,
    mode: 0o770,
  });
  const file = await Deno.open(path, {
    create: true,
    write: true,
    mode: 0o660,
  });
  try {
    if (!(await file.tryLock(true))) {
      throw new ManagedTargetBusyError(managedId);
    }
    return await fn();
  } finally {
    // Closing the descriptor releases the flock; no separate unlock needed.
    file.close();
  }
}
