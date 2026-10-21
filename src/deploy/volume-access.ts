/**
 * Access for a container that runs as a user other than the site owner.
 *
 * A volume folder belongs to the site owner (`<owner>:<owner> 0750`), and a
 * container with no `user:` of its own is run as the owner, so what it writes
 * belongs to the owner. A compose file that names another user is never
 * refused: the container runs as that user, and the folder gets an access
 * entry and a default entry for that one uid (`setfacl`), on the folder itself
 * only. The owner keeps ownership; nothing is re-owned to root and nothing
 * inside the folder is touched. The default entry means files the container
 * creates stay open to that uid.
 *
 * Some filesystems carry no access lists. Then the entry cannot be set, the
 * deploy goes on, and the log says plainly that the container may not be able
 * to write the folder (the fix is a filesystem that supports access lists, or
 * running the container as the owner's uid). The entry is set on every deploy,
 * because a later mode change on the folder drops it.
 */

import type { FolderRefParts } from "../contracts/directory-names.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { type LayoutPaths, volumeFolder } from "../paths/layout.ts";
import { forEachSequential } from "../util/sequential.ts";
import type { RunFn } from "./ensure-principal.ts";
import type {
  DeclaredVolumeUser,
  UndeclaredVolumeUser,
} from "./apply-storage-volumes.ts";

/** One line for the deploy log (`stdout`) or the daemon log. */
export type VolumeAccessLog = (line: string) => void;

/**
 * Give each declared user access to the volume it mounts. Never throws: a
 * failure is logged and the deploy continues.
 */
export async function applyVolumeAccess(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  folders: ReadonlyMap<string, FolderRefParts>,
  users: readonly DeclaredVolumeUser[],
  named: readonly UndeclaredVolumeUser[],
  runFn: RunFn,
  log: VolumeAccessLog,
): Promise<void> {
  for (const entry of named) {
    log(
      `service ${entry.composeServiceName} runs as the named user ${entry.user}; the host cannot map a name to an id, so its volume gets no access entry (use a numeric uid to have one set)`,
    );
  }
  await forEachSequential(users, async (entry) => {
    const folder = folders.get(entry.storageId);
    if (folder === undefined) return;
    try {
      const path = volumeFolder(layout, folder);
      const spec = `u:${entry.uid}:rwx,d:u:${entry.uid}:rwx`;
      const result = await runFn(
        "sudo",
        hostSudoArgs(["-n", "setfacl", "-m", spec, "--", path]),
      );
      if (result.success) {
        log(`gave uid ${entry.uid} access to the volume ${folder.slug}`);
        return;
      }
      log(
        `could not give uid ${entry.uid} access to the volume ${folder.slug} (${
          firstLine(result.stderr)
        }); the filesystem may not support access lists, so that container may not be able to write the folder`,
      );
    } catch (err) {
      log(
        `could not give uid ${entry.uid} access to the volume ${folder.slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

function firstLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim().length > 0);
  return (line ?? "no reason given").trim().slice(0, 200);
}
