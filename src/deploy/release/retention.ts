/**
 * Release retention, at two scales.
 *
 * **Within one service** — keep the most recent N published releases plus
 * whatever `current` points at, and remove the rest. `current` is never pruned,
 * even when it falls outside the newest N: a rollback re-points `current` at an
 * older release, and deleting that release for being old would delete the
 * running application.
 *
 * **Across services** — reclaim the whole `<principalHome>/sites/<serviceId>`
 * tree for a service that no longer has a source at all. Per-service pruning
 * only ever walks services the current deploy is still publishing, so without
 * this a service dropped from the compose (or one that lost its
 * `x-turbopanel.source` binding) would leave its releases, `current`, and
 * `shared/` on disk forever. The "previously deployed" side comes from the
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
import type { FolderRefParts } from "../../contracts/directory-names.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { serviceTree } from "../../paths/layout.ts";
import { removeFolderRecord } from "../asset-folders.ts";

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

/**
 * One release tree on disk: its service folder when it has one, else
 * `<principalHomeRoot>/<username>/sites/<serviceId>`.
 */
export type ReleaseTreeRef = {
  serviceId: string;
  username: string;
  folder?: FolderRefParts;
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
 * keeps its tree even if its owning principal changed, because reclaiming it
 * would delete the live `shared/` state of a service the deploy is still
 * publishing. Only disappearing from the source set reclaims the tree.
 * Unsafe segments are dropped rather than repaired.
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

export type ReclaimRemovedReleaseTreesParams = {
  layout: Pick<LayoutPaths, "principalHomeRoot" | "daemonStateDir">;
  /** Release rows the previous deploy recorded in `deployment.json`. */
  previous: readonly ReleaseTreeRef[];
  /** `serviceId`s this deploy still carries a `sourceMaterial[]` entry for. */
  currentServiceIds: ReadonlySet<string>;
  runFn?: RunFn;
  onOutput?: (stream: "stdout" | "stderr", line: string) => void;
};

/**
 * Remove the whole release tree for every service that lost its source.
 *
 * The tree is root-owned by design, so removal goes through the same privileged
 * runner sealing and per-release pruning use. Once a tree is gone, the
 * daemon's rollback records for that service go with it
 * ({@link removeServiceReleaseRecords}): a record outlives its tree nowhere.
 * Best-effort per entry, for the same reason retention is: a leftover directory
 * must never fail a deploy that has already promoted. Returns the tree paths
 * actually removed.
 */
export async function reclaimRemovedReleaseTrees(
  params: ReclaimRemovedReleaseTreesParams,
): Promise<string[]> {
  const doomed = releaseTreesToReclaim(
    params.previous,
    params.currentServiceIds,
  );
  if (doomed.length === 0) return [];

  const runFn = params.runFn ?? runPrivileged;
  const removed: string[] = [];
  await forEachSequential(doomed, async (ref) => {
    const path = await reclaimServiceTree(
      params.layout,
      ref,
      runFn,
      params.onOutput,
    );
    if (path !== null) removed.push(path);
  });
  return removed;
}

/**
 * Remove one service's whole tree: its folder (or `sites/<serviceId>`), the
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
  onOutput?: ReclaimRemovedReleaseTreesParams["onOutput"],
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
      return null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.(
      "stderr",
      `release tree reclaim could not remove ${path}: ${message}`,
    );
    return null;
  }
  // The folder is gone: a failure tidying the records is logged, not reported
  // as a folder that stayed.
  try {
    if (ref.folder !== undefined) {
      await removeFolderRecord(layout, ref.serviceId);
    }
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
  onOutput: ReclaimRemovedReleaseTreesParams["onOutput"],
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
