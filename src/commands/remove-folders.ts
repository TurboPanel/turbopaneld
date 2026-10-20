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
import {
  type FolderRef,
  parseFolderRefParts,
} from "../contracts/directory-names.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";

export type FoldersRemoveDeps = {
  resolveLayout?: () => LayoutPaths;
  /** Privileged runner for `tp-host rm`; test seam. */
  runPrivileged?: RunFn;
};

type RemovalContext = {
  layout: LayoutPaths;
  runFn: RunFn;
  onOutput: (stream: "stdout" | "stderr", line: string) => void;
};

/**
 * The asset id a folder removal acts for: the one the panel sent, else the one
 * the daemon's own record of the folder names. Throws when the records cannot
 * be read, because an unreadable record might be the one that owns the folder.
 */
async function resolveAssetId(
  layout: LayoutPaths,
  entry: FolderRemoval,
  ref: FolderRef,
): Promise<string | undefined> {
  if (entry.assetId !== undefined) return entry.assetId;
  try {
    return (await findAssetIdByFolder(layout, ref)) ?? undefined;
  } catch (err) {
    throw new Error(`folder records unreadable: ${String(err)}`);
  }
}

/** A service with a known id: the whole tree, its record and the daemon's release records. */
async function removeServiceTree(
  ctx: RemovalContext,
  entry: FolderRemoval,
  ref: FolderRef,
  assetId: string,
): Promise<string | null> {
  // The record check a volume gets applies here too, so a wrong reference
  // never removes another service's folder.
  await assertFolderRemovableBy(ctx.layout, assetId, ref);
  await assertNoSymlinkComponents(
    ctx.layout.principalHomeRoot,
    assetFolder(ctx.layout, ref),
  );
  return await reclaimServiceTree(
    ctx.layout,
    { serviceId: assetId, username: ref.owner, folder: entry.folder },
    ctx.runFn,
    ctx.onOutput,
  );
}

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
  const ctx = { layout, runFn, onOutput };
  let path: string | null = null;
  try {
    const assetId = await resolveAssetId(layout, entry, ref);
    path = entry.kind === "service" && assetId !== undefined
      ? await removeServiceTree(ctx, entry, ref, assetId)
      : await reclaimAssetFolder(layout, ref, assetId, runFn, onOutput);
  } catch (err) {
    // Records that cannot be read, a reference that belongs to another asset
    // or a link in the path: leave the folder alone rather than guess.
    const text = err instanceof Error ? err.message : String(err);
    onOutput("stderr", text);
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
