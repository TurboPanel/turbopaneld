/**
 * One lock per backup target, shared by everything that dumps or restores
 * it: for a managed engine, the `managed.backup` / `managed.restore` command
 * handlers in the long-running daemon and the scheduled `backup-run` one-shot
 * (a separate process started by a systemd timer); for a storage copy, the
 * `storage.backup` handler and the same one-shot.
 *
 * The lock is an advisory `flock` on `<runDir>/managed-locks/<managedId>.lock`
 * (or `<runDir>/copy-locks/<copyId>.lock`)
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

/** Hold the non-blocking flock on `path` (under `dir`) while `fn` runs; `busy()` is thrown when it is taken. */
async function withTargetLock<T>(
  dir: string,
  path: string,
  busy: () => Error,
  fn: () => Promise<T>,
): Promise<T> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o770 });
  const file = await Deno.open(path, {
    create: true,
    write: true,
    mode: 0o660,
  });
  try {
    if (!(await file.tryLock(true))) {
      throw busy();
    }
    return await fn();
  } finally {
    // Closing the descriptor releases the flock; no separate unlock needed.
    file.close();
  }
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
  return await withTargetLock(
    join(layout.runDir, "managed-locks"),
    managedTargetLockPath(layout, managedId),
    () => new ManagedTargetBusyError(managedId),
    fn,
  );
}

/** `<runDir>/managed-locks/<managedId>.lifecycle.lock`; `managedId` is re-validated because it becomes a filename. */
export function managedLifecycleLockPath(
  layout: Pick<LayoutPaths, "runDir">,
  managedId: string,
): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(layout.runDir, "managed-locks", `${managedId}.lifecycle.lock`);
}

/**
 * Run `fn` while holding the engine's create/remove lock, waiting (not
 * refusing) when another holder has it. `managed.apply` and `managed.destroy`
 * share it so one can never re-create what the other is removing. A separate
 * file from {@link withManagedTargetLock}: an apply can run for minutes and
 * must not make a scheduled backup report the engine busy.
 */
export async function withManagedLifecycleLock<T>(
  layout: Pick<LayoutPaths, "runDir">,
  managedId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = join(layout.runDir, "managed-locks");
  await Deno.mkdir(dir, { recursive: true, mode: 0o770 });
  const file = await Deno.open(managedLifecycleLockPath(layout, managedId), {
    create: true,
    write: true,
    mode: 0o660,
  });
  try {
    await file.lock(true);
    return await fn();
  } finally {
    // Closing the descriptor releases the flock.
    file.close();
  }
}

/**
 * Like {@link withManagedLifecycleLock}, but does not wait: returns `false`
 * without running `fn` when apply/destroy already holds the lock. The demoted
 * member guard uses this so a resync apply is not stopped mid-run.
 */
export async function tryWithManagedLifecycleLock(
  layout: Pick<LayoutPaths, "runDir">,
  managedId: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const dir = join(layout.runDir, "managed-locks");
  await Deno.mkdir(dir, { recursive: true, mode: 0o770 });
  const file = await Deno.open(managedLifecycleLockPath(layout, managedId), {
    create: true,
    write: true,
    mode: 0o660,
  });
  try {
    if (!(await file.tryLock(true))) return false;
    await fn();
    return true;
  } finally {
    file.close();
  }
}

/** Another backup or restore holds this storage copy's lock. */
export class CopyTargetBusyError extends Error {
  constructor(copyId: string) {
    super(
      `storage copy ${copyId} is busy: another backup or restore is running`,
    );
    this.name = "CopyTargetBusyError";
  }
}

/** `<runDir>/copy-locks/<copyId>.lock`; `copyId` is re-validated because it becomes a filename. */
export function copyTargetLockPath(
  layout: Pick<LayoutPaths, "runDir">,
  copyId: string,
): string {
  if (!SAFE_MANAGED_ID_RE.test(copyId)) {
    throw new Error("copyId contains unsupported characters");
  }
  return join(layout.runDir, "copy-locks", `${copyId}.lock`);
}

/**
 * Run `fn` while holding the storage copy's lock — shared by the scheduled
 * run, a manual `storage.backup` and a restore of that copy. Throws
 * {@link CopyTargetBusyError} without running `fn` when another holder has it.
 */
export async function withCopyTargetLock<T>(
  layout: Pick<LayoutPaths, "runDir">,
  copyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await withTargetLock(
    join(layout.runDir, "copy-locks"),
    copyTargetLockPath(layout, copyId),
    () => new CopyTargetBusyError(copyId),
    fn,
  );
}
