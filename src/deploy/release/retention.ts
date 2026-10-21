/**
 * Release retention, at two scales.
 *
 * **Within one service** — keep the most recent N published releases plus
 * whatever `current` points at, and remove the rest. `current` is never pruned,
 * even when it falls outside the newest N: a rollback re-points `current` at an
 * older release, and deleting that release for being old would delete the
 * running application.
 *
 * **Across services** — a service that no longer has a source at all keeps its
 * folder in place; {@link keptServiceFolders} reports it so the control plane
 * can mark it an orphan. The "previously deployed" side comes from the
 * `releases[]` rows in the environment's own `deployment.json`, which is the
 * host's durable record of what it published last time.
 *
 * **A Railpack release prunes to nothing but its manifest.** That lane publishes
 * an OCI image, so its release directory holds only `.turbopanel/release.json`
 * and there is no `current` symlink protecting anything. Removing one therefore
 * removes a *record*, not a running container — the container keeps running
 * under the still-tagged image until a later deploy supersedes it. What is lost
 * is the ability to roll back to that release id, which is exactly what pruning
 * a native release costs too.
 */

import { join } from "@std/path";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  assertSafeServiceId,
  RELEASE_RECORDS_DIRNAME,
  RELEASE_SCRATCH_DIRNAME,
  type ReleasePaths,
  removePublishedRelease,
  runPrivileged,
} from "./release-layout.ts";
import { readCurrentReleaseId } from "./promote.ts";
import type {
  FolderRef,
  FolderRefParts,
} from "../../contracts/directory-names.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import {
  assertNoSymlinkComponents,
  assetFolder,
  serviceTree,
} from "../../paths/layout.ts";
import {
  assertFolderRemovableBy,
  removeFolderRecord,
} from "../asset-folders.ts";

/** Published releases kept per service, in addition to `current`. */
export const DEFAULT_RELEASE_RETENTION = 5;

/** Directory entries under `releases/`, newest-modified first. */
async function listReleaseIds(
  releasesDir: string,
  runFn: RunFn,
): Promise<string[]> {
  const entries: Array<{ name: string; mtime: number }> = [];
  try {
    for await (const entry of Deno.readDir(releasesDir)) {
      if (!entry.isDirectory) continue;
      let mtime = 0;
      try {
        const stat = await Deno.stat(join(releasesDir, entry.name));
        mtime = stat.mtime?.getTime() ?? 0;
      } catch {
        // Racing removal — treat as oldest rather than failing the sweep.
      }
      entries.push({ name: entry.name, mtime });
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    if (err instanceof Deno.errors.PermissionDenied) {
      return await listReleaseIdsPrivileged(releasesDir, runFn);
    }
    throw err;
  }
  return entries
    .toSorted((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
    .map((entry) => entry.name);
}

async function listReleaseIdsPrivileged(
  releasesDir: string,
  runFn: RunFn,
): Promise<string[]> {
  const result = await runFn(
    "sudo",
    hostSudoArgs(["-n", "ls", "-1t", "--", releasesDir]),
  );
  if (!result.success) {
    if (
      result.stderr.toLowerCase().includes("no such file") ||
      result.stderr.toLowerCase().includes("not found")
    ) {
      return [];
    }
    throw new Error(result.stderr || `Failed to list ${releasesDir}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.length > 0);
}

/**
 * Pure selection rule, exported so the "never prune `current`" guarantee is
 * testable without a filesystem.
 */
export function releasesToPrune(
  releaseIds: readonly string[],
  currentReleaseId: string | null,
  keep: number,
): string[] {
  const kept = new Set(releaseIds.slice(0, Math.max(keep, 0)));
  if (currentReleaseId) kept.add(currentReleaseId);
  return releaseIds.filter((id) => !kept.has(id));
}

export type PruneReleasesParams = {
  paths: ReleasePaths;
  keep?: number;
  runFn?: RunFn;
  onOutput?: (stream: "stdout" | "stderr", line: string) => void;
};

/**
 * Remove superseded releases. Best-effort per entry: a release that refuses to
 * unlink is reported to the transcript, not raised — retention must never fail
 * a deploy that has already promoted successfully.
 */
export async function pruneReleases(
  params: PruneReleasesParams,
): Promise<string[]> {
  const keep = params.keep ?? DEFAULT_RELEASE_RETENTION;
  const runFn = params.runFn ?? runPrivileged;
  const releaseIds = await listReleaseIds(params.paths.releasesDir, runFn);
  const currentReleaseId = await readCurrentReleaseId(params.paths, runFn);
  const doomed = releasesToPrune(releaseIds, currentReleaseId, keep);

  const removed: string[] = [];
  // Deleted one at a time, in listing order: never concurrent with each other.
  await forEachSequential(doomed, async (releaseId) => {
    try {
      await removePublishedRelease(
        join(params.paths.releasesDir, releaseId),
        runFn,
      );
      removed.push(releaseId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.onOutput?.(
        "stderr",
        `release retention could not remove ${releaseId}: ${message}`,
      );
    }
  });
  return removed;
}

/** One release tree on disk: its service folder. */
export type ReleaseTreeRef = {
  serviceId: string;
  username: string;
  folder: FolderRefParts;
};

/**
 * Path segments are re-read from `deployment.json` before being handed to
 * `rm -rf`, so they are re-validated here rather than trusted for having been
 * daemon-written — a hand-edited manifest must not be able to name `..`.
 */
const RELEASE_TREE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function isSafeReleaseTreeRef(ref: ReleaseTreeRef): boolean {
  for (const segment of [ref.serviceId, ref.username]) {
    if (segment === "." || segment === "..") return false;
    if (!RELEASE_TREE_SEGMENT_RE.test(segment)) return false;
  }
  return true;
}

/**
 * Trees whose service is no longer sourced at all.
 *
 * Keyed on `serviceId` alone, deliberately: a service that is *still* sourced
 * is in use even if its owning principal changed. Unsafe segments are dropped
 * rather than repaired.
 */
export function releaseTreesToReclaim(
  previous: readonly ReleaseTreeRef[],
  currentServiceIds: ReadonlySet<string>,
): ReleaseTreeRef[] {
  const seen = new Set<string>();
  const out: ReleaseTreeRef[] = [];
  for (const ref of previous) {
    if (currentServiceIds.has(ref.serviceId)) continue;
    if (!isSafeReleaseTreeRef(ref)) continue;
    const key = `${ref.username}\u0000${ref.serviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Service folders whose service is no longer sourced: kept in place and
 * reported, so the control plane can mark them orphans.
 */
export function keptServiceFolders(
  previous: readonly ReleaseTreeRef[],
  currentServiceIds: ReadonlySet<string>,
): FolderRefParts[] {
  const kept: FolderRefParts[] = [];
  for (const ref of releaseTreesToReclaim(previous, currentServiceIds)) {
    kept.push(ref.folder);
  }
  return kept;
}

/** Where a reclaim reports why a folder stayed; nothing throws. */
export type ReclaimOutput = (
  stream: "stdout" | "stderr",
  line: string,
) => void;

/**
 * Remove one service's whole tree: its folder, the
 * record of the folder's components, and the daemon's own release records and
 * build scratch for the service. Returns the removed path, or `null` when the
 * tree could not be removed (the reason goes to `onOutput`; nothing throws).
 * The records and the folder record are kept when the tree stays, so a later
 * attempt finds the same state.
 */
export async function reclaimServiceTree(
  layout: Pick<LayoutPaths, "principalHomeRoot" | "daemonStateDir">,
  ref: ReleaseTreeRef,
  runFn: RunFn,
  onOutput?: ReclaimOutput | undefined,
): Promise<string | null> {
  let path: string;
  try {
    assertSafeServiceId(ref.serviceId);
    path = serviceTree(layout, ref).root;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.(
      "stderr",
      `release tree reclaim skipped ${ref.serviceId}: ${message}`,
    );
    return null;
  }
  if (!await removeTreeWithHelper(path, runFn, onOutput)) return null;
  // The folder is gone: a failure tidying the records is logged, not reported
  // as a folder that stayed.
  try {
    await removeFolderRecord(layout, ref.serviceId);
    await removeServiceStateDirs(layout, ref.serviceId, onOutput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.(
      "stderr",
      `release records for ${ref.serviceId} could not be removed: ${message}`,
    );
  }
  return path;
}

/**
 * Clear what a Destroy built up in one service's tree: every published release,
 * the `current` link, and the daemon's own release records and build scratch.
 * The service folder itself, its `shared/` uploads, its logs and the owner's
 * account stay; deleting the service is what removes the folder.
 *
 * Returns the number of releases removed. Best-effort and silent about
 * failures except through `onOutput`: a Destroy must still tear the rest down.
 */
export async function reclaimServiceReleases(
  layout: Pick<LayoutPaths, "principalHomeRoot" | "daemonStateDir">,
  ref: ReleaseTreeRef,
  runFn: RunFn,
  onOutput?: ReclaimOutput | undefined,
): Promise<number> {
  let tree: ReturnType<typeof serviceTree>;
  try {
    assertSafeServiceId(ref.serviceId);
    tree = serviceTree(layout, ref);
    await assertNoSymlinkComponents(layout.principalHomeRoot, tree.releasesDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.(
      "stderr",
      `release cleanup skipped ${ref.serviceId}: ${message}`,
    );
    return 0;
  }
  let removed = 0;
  try {
    const releaseIds = await listReleaseIds(tree.releasesDir, runFn);
    await forEachSequential(releaseIds, async (releaseId) => {
      try {
        await removePublishedRelease(join(tree.releasesDir, releaseId), runFn);
        removed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onOutput?.(
          "stderr",
          `release cleanup could not remove ${releaseId}: ${message}`,
        );
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.("stderr", `release cleanup could not list releases: ${message}`);
    return removed;
  }
  await removeTreeWithHelper(tree.currentLink, runFn, onOutput);
  await removeServiceStateDirs(layout, ref.serviceId, onOutput);
  return removed;
}

/**
 * Why a folder removal failed, as one plain sentence for the panel. The raw
 * line (which can carry host paths) stays in the daemon log.
 */
export function removalFailureReason(lines: readonly string[]): string {
  const text = lines.join(" ");
  if (text.includes("unreadable")) {
    return "The server could not read its records of this folder, so it was left alone.";
  }
  if (text.includes("folder_changed")) {
    return "The folder belongs to another service or volume, so it was left alone.";
  }
  if (text.includes("symbolic link") || text.includes("symlink")) {
    return "A link was found in the folder's path, so it was left alone.";
  }
  if (text.includes("refusing")) {
    return "The server refused to remove this folder.";
  }
  if (text.includes("skipped")) {
    return "The folder reference was not valid, so nothing was removed.";
  }
  return "The server could not remove the folder; see the server log.";
}

/**
 * `rm -rf` one folder through the root helper, which refuses a scope,
 * `services` or `volumes` folder, pins the parent and never follows a link.
 * Returns whether the folder is gone; the reason goes to `onOutput` and
 * nothing throws.
 */
async function removeTreeWithHelper(
  path: string,
  runFn: RunFn,
  onOutput?: ReclaimOutput | undefined,
): Promise<boolean> {
  try {
    const result = await runFn(
      "sudo",
      hostSudoArgs(["-n", "rm", "-rf", "--", path]),
    );
    if (!result.success) {
      onOutput?.(
        "stderr",
        `release tree reclaim could not remove ${path}: ${result.stderr}`,
      );
      return false;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.(
      "stderr",
      `release tree reclaim could not remove ${path}: ${message}`,
    );
    return false;
  }
  return true;
}

/**
 * Remove one asset folder (`<owner>/<scope>/{services,volumes}/<name>`) and the
 * record of its components, with no daemon state beyond that record. The same
 * helper and the same safety as a whole service tree: structural folders are
 * refused, a link is never followed, and nothing inside is re-owned. Returns
 * the removed path, or `null` when the folder stayed (the reason goes to
 * `onOutput`; nothing throws). The record is kept when the folder stays, so a
 * later attempt finds the same state.
 */
export async function reclaimAssetFolder(
  layout: Pick<LayoutPaths, "principalHomeRoot" | "daemonStateDir">,
  ref: FolderRef,
  assetId: string | undefined,
  runFn: RunFn,
  onOutput?: ReclaimOutput | undefined,
): Promise<string | null> {
  let path: string;
  try {
    path = assetFolder(layout, ref);
    if (assetId !== undefined) {
      await assertFolderRemovableBy(layout, assetId, ref);
    }
    await assertNoSymlinkComponents(layout.principalHomeRoot, path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.("stderr", `${ref.kind} folder reclaim skipped: ${message}`);
    return null;
  }
  if (!await removeTreeWithHelper(path, runFn, onOutput)) return null;
  if (assetId !== undefined) {
    try {
      await removeFolderRecord(layout, assetId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onOutput?.(
        "stderr",
        `folder record for ${assetId} could not be removed: ${message}`,
      );
    }
  }
  return path;
}

/**
 * Remove `<daemonStateDir>/release-records/<serviceId>` (the daemon-owned
 * rollback records of a service whose release tree was reclaimed) and
 * `<daemonStateDir>/release-build/<serviceId>` (build scratch). Both belong to
 * the daemon user, so no privilege is involved. `serviceId` has been through
 * {@link releaseTreesToReclaim}'s segment check or the folder rules.
 * Best-effort: a leftover record only fails a later rollback cleanly.
 */
async function removeServiceStateDirs(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  serviceId: string,
  onOutput: ReclaimOutput | undefined,
): Promise<void> {
  await forEachSequential([
    join(layout.daemonStateDir, RELEASE_RECORDS_DIRNAME, serviceId),
    join(layout.daemonStateDir, RELEASE_SCRATCH_DIRNAME, serviceId),
  ], async (dir) => {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      const message = err instanceof Error ? err.message : String(err);
      onOutput?.(
        "stderr",
        `release record reclaim could not remove ${dir}: ${message}`,
      );
    }
  });
}
