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
import type { RunFn } from "../ensure-principal.ts";
import {
  type ReleasePaths,
  removePublishedRelease,
  runPrivileged,
} from "./release-layout.ts";
import { readCurrentReleaseId } from "./promote.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { principalHomePath, siteRoot } from "../../paths/layout.ts";

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
  const result = await runFn("sudo", ["-n", "ls", "-1t", "--", releasesDir]);
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
  for (const releaseId of doomed) {
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
  }
  return removed;
}

/** One release tree on disk: `<principalHomeRoot>/<username>/sites/<serviceId>`. */
export type ReleaseTreeRef = {
  serviceId: string;
  username: string;
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
  layout: Pick<LayoutPaths, "principalHomeRoot">;
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
 * runner sealing and per-release pruning use. Best-effort per entry, for the
 * same reason retention is: a leftover directory must never fail a deploy that
 * has already promoted. Returns the paths actually removed.
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
  for (const ref of doomed) {
    const path = siteRoot(
      principalHomePath(
        { principalHomeRoot: params.layout.principalHomeRoot },
        ref.username,
      ),
      ref.serviceId,
    );
    try {
      const result = await runFn("sudo", ["-n", "rm", "-rf", "--", path]);
      if (!result.success) {
        params.onOutput?.(
          "stderr",
          `release tree reclaim could not remove ${path}: ${result.stderr}`,
        );
        continue;
      }
      removed.push(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.onOutput?.(
        "stderr",
        `release tree reclaim could not remove ${path}: ${message}`,
      );
    }
  }
  return removed;
}
