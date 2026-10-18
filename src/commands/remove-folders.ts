/**
 * `server.folders.remove`: take asset folders off the host once the panel has
 * deleted the service or volume they belong to.
 *
 * This is the only way a volume folder leaves the host. Stopping an
 * environment keeps its volumes, and a service that leaves the compose file
 * keeps its folder; both leave the files for the owner. A deleted asset is the
 * one case where the files go, and the panel says so by naming the folder here.
 *
 * Each folder is named by its four components, never by a path. A volume
 * folder goes through the same root helper as a service folder: structural
 * folders are refused, a link is never followed, and nothing inside is
 * re-owned. A folder whose record names other components (a reference that
 * belongs to another asset) is left alone. One folder that stays never stops
 * the rest; every folder is reported with whether it is gone, so the panel can
 * clear its record of it.
 */

import type {
  FolderRemoval,
  FolderRemovalState,
  FoldersRemovePayload,
  FoldersRemoveResult,
} from "../contracts/commands-contracts.ts";
import {
  assertNoSymlinkComponents,
  assetFolder,
  type LayoutPaths,
  resolveLayout,
} from "../paths/layout.ts";
import {
  assertFolderRemovableBy,
  findAssetIdByFolder,
} from "../deploy/asset-folders.ts";
import type { RunFn } from "../deploy/ensure-principal.ts";
import { runPrivileged } from "../deploy/release/release-layout.ts";
import {
  reclaimAssetFolder,
  reclaimServiceTree,
  removalFailureReason,
} from "../deploy/release/retention.ts";
import { parseFolderRefParts } from "../contracts/directory-names.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";

export type FoldersRemoveDeps = {
  resolveLayout?: () => LayoutPaths;
  /** Privileged runner for `tp-host rm`; test seam. */
  runPrivileged?: RunFn;
};

async function removeOne(
  layout: LayoutPaths,
  entry: FolderRemoval,
  runFn: RunFn,
): Promise<FolderRemovalState> {
  const ref = parseFolderRefParts(entry.folder, entry.kind);
  const state = {
    owner: ref.owner,
    scope: ref.scope,
    kind: ref.kind,
    slug: ref.slug,
  };
  const lines: string[] = [];
  const onOutput = (_stream: "stdout" | "stderr", line: string) => {
    lines.push(line);
    logWarn("commands", `server.folders.remove: ${line}`);
  };
  // The panel's row for a deleted asset has lost its id; the record of the
  // folder's components still knows it.
  let assetId = entry.assetId;
  if (assetId === undefined) {
    try {
      assetId = (await findAssetIdByFolder(layout, ref)) ?? undefined;
    } catch (err) {
      // A record that cannot be read might be the one that owns this folder:
      // leave the folder alone rather than guess.
      onOutput("stderr", `folder records unreadable: ${String(err)}`);
      return { ...state, removed: false, reason: removalFailureReason(lines) };
    }
  }
  let path: string | null;
  if (entry.kind === "service" && assetId !== undefined) {
    // The whole tree: the folder, its record and the daemon's release records.
    // The record check a volume gets applies here too, so a wrong reference
    // never removes another service's folder.
    try {
      await assertFolderRemovableBy(layout, assetId, ref);
      await assertNoSymlinkComponents(
        layout.principalHomeRoot,
        assetFolder(layout, ref),
      );
    } catch (err) {
      onOutput("stderr", err instanceof Error ? err.message : String(err));
      return { ...state, removed: false, reason: removalFailureReason(lines) };
    }
    path = await reclaimServiceTree(
      layout,
      { serviceId: assetId, username: ref.owner, folder: entry.folder },
      runFn,
      onOutput,
    );
  } else {
    path = await reclaimAssetFolder(layout, ref, assetId, runFn, onOutput);
  }
  return path === null
    ? { ...state, removed: false, reason: removalFailureReason(lines) }
    : { ...state, removed: true };
}

export async function handleFoldersRemove(
  payload: FoldersRemovePayload,
  _daemonReceivedAt: string,
  deps: FoldersRemoveDeps = {},
): Promise<FoldersRemoveResult> {
  const layout = (deps.resolveLayout ?? resolveLayout)();
  const runFn = deps.runPrivileged ?? runPrivileged;
  const folders: FolderRemovalState[] = [];
  await forEachSequential(payload.folders, async (entry) => {
    folders.push(await removeOne(layout, entry, runFn));
  });
  const removed = folders.filter((folder) => folder.removed).length;
  logInfo(
    "commands",
    `server.folders.remove removed ${removed} of ${folders.length} folder(s)`,
  );
  return {
    summary: `Removed ${removed} of ${folders.length} folder(s)`,
    folders,
  };
}
