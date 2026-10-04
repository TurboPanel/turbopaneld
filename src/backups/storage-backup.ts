/**
 * `storage.backup`: a manual backup of one storage copy (`create`), or the
 * removal of one of its archives (`delete`). A create takes the copy's lock
 * (shared with scheduled runs), so a manual and a scheduled backup never
 * archive the same copy at once; unlike a scheduled run it may pull the
 * pinned helper image first.
 */

import type {
  StorageBackupPayload,
  StorageBackupResult,
} from "../contracts/commands-contracts.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { removeIfExists } from "../managed/backup.ts";
import { withCopyTargetLock } from "../managed/target-lock.ts";
import {
  copyBackupArtifactPath,
  type CopyBackupDeps,
  createCopyBackupArtifact,
} from "./copy-backup.ts";

export type StorageBackupHandlerDeps = CopyBackupDeps & {
  layout?: LayoutPaths;
  now?: () => Date;
};

export async function handleStorageBackup(
  payload: StorageBackupPayload,
  daemonReceivedAt: string,
  deps: StorageBackupHandlerDeps = {},
): Promise<StorageBackupResult> {
  const layout = deps.layout ?? resolveLayout(Deno.env.toObject());
  const now = deps.now ?? (() => new Date());

  if (payload.action === "delete") {
    await removeIfExists(
      copyBackupArtifactPath(
        layout,
        payload.copyId,
        payload.backupId,
        payload.policyId,
      ),
    );
    return {
      backupId: payload.backupId,
      deleted: true,
      completedAt: now().toISOString(),
    };
  }

  const artifact = await withCopyTargetLock(
    layout,
    payload.copyId,
    () =>
      createCopyBackupArtifact(
        layout,
        { source: payload, backupId: payload.backupId },
        deps,
      ),
  );
  return {
    backupId: payload.backupId,
    path: artifact.path,
    sizeBytes: artifact.sizeBytes,
    checksum: artifact.checksum,
    completedAt: now().toISOString(),
    summary:
      `storage.backup completed for ${payload.copyId} (received ${daemonReceivedAt})`,
  };
}
