/**
 * Stage a built release and cut `current` over to it atomically.
 *
 * Same staged-write / validated-cutover contract `../compose-files.ts` uses for
 * `compose.yaml`: everything is assembled off to the side, validated, and only
 * then published in one indivisible step. Concretely:
 *
 * 1. copy the build output from the ephemeral checkout into
 *    `releases/<releaseId>/` (still writable at this point);
 * 2. link `shared` at the release root to the site's `shared/` directory, so
 *    `current/shared` is a stable writable path for every release-backed
 *    service;
 * 3. run the health probe against the staged tree;
 * 4. seal the tree (`root:<username>-grp`, mode `0550`);
 * 5. create `current.tmp.<releaseId>` as a symlink and `rename()` it over
 *    `current` — atomic within the filesystem, so a reader either sees the old
 *    release or the new one, never a missing link.
 *
 * Any failure before step 5 leaves `current` exactly where it was. There is no
 * partial publish.
 *
 * {@link promoteExistingRelease} is the rollback entry point: step 5 alone,
 * against a tree that was already published by an earlier promote.
 */

import { basename, join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import {
  RELEASE_METADATA_DIRNAME,
  RELEASE_PUBLISHED_MODE,
  type ReleasePaths,
  runPrivileged,
  sealPublishedRelease,
} from "./release-layout.ts";
import {
  type ReleaseManifestV1,
  writeReleaseManifest,
} from "./deployment-json.ts";

/** Never copied into a release — build metadata, not shipped artifacts. */
const EXCLUDED_TREE_ENTRIES = new Set([".git"]);

/**
 * `Deno.stat` with "the path is absent" as a return value rather than an
 * exception. Callers then separate *missing* from *wrong kind* with plain
 * `if`s, instead of throwing from inside a `try` whose own `catch` has to
 * re-raise them.
 */
async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/**
 * Validation gate between staging and cutover.
 *
 * Caller-supplied so callers can swap in a real check. The native runtime
 * probes the started process *after* promote (`../native/`), because a process
 * cannot be started out of a tree that is not yet published; the traditional-web
 * path probes the document root. It must throw to reject the release.
 */
export type ReleaseHealthProbe = (releaseDir: string) => Promise<void>;

/**
 * This phase's probe: assert the staged tree contains the paths the release is
 * supposed to have produced. A build that "succeeded" while emitting nothing is
 * the failure mode worth catching before `current` moves.
 */
export function expectedPathsProbe(
  relativePaths: readonly string[],
): ReleaseHealthProbe {
  return async (releaseDir: string) => {
    for (const relative of relativePaths) {
      const target = relative.length === 0
        ? releaseDir
        : join(releaseDir, relative);
      try {
        await Deno.stat(target);
      } catch {
        throw new Error(
          `release health probe failed: missing ${relative || "release root"}`,
        );
      }
    }
  };
}

/**
 * Recursive copy without `@std/fs` (not a dependency of this daemon).
 * Symlinks are recreated as symlinks so a `node_modules/.bin` tree survives.
 *
 * Exported because the native-app build path reuses it to fold `.next/static`
 * and `public/` into a Next standalone tree — one copy implementation with one
 * symlink policy, rather than a second one that drifts.
 */
export async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true, mode: 0o750 });
  for await (const entry of Deno.readDir(from)) {
    if (EXCLUDED_TREE_ENTRIES.has(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymlink) {
      const linkTarget = await Deno.readLink(source);
      await Deno.symlink(linkTarget, target);
      continue;
    }
    if (entry.isDirectory) {
      await copyTree(source, target);
      continue;
    }
    await Deno.copyFile(source, target);
  }
}

export type StageReleaseParams = {
  paths: ReleasePaths;
  /** Checked-out working tree from `checkoutRelease`. */
  workingDir: string;
  /** Repo-relative checkout subdirectory, when the source declares one. */
  subdirectory?: string;
  /** Build output directory relative to the checkout root (or subdirectory). */
  outputDirectory?: string;
};

/**
 * Resolve which directory of the checkout becomes the release payload:
 * `<workingDir>/<subdirectory?>/<outputDirectory?>`.
 */
export function resolveReleaseSourceDir(params: StageReleaseParams): string {
  let dir = params.workingDir;
  if (params.subdirectory) dir = join(dir, params.subdirectory);
  if (params.outputDirectory) dir = join(dir, params.outputDirectory);
  return dir;
}

/** Copy the build output into the (still writable) release directory. */
export async function stageRelease(
  params: StageReleaseParams,
): Promise<string> {
  const sourceDir = resolveReleaseSourceDir(params);
  const stat = await statOrNull(sourceDir);
  if (stat === null) {
    throw new Error(`release output directory not found: ${sourceDir}`);
  }
  if (!stat.isDirectory) {
    throw new Error(`release output is not a directory: ${sourceDir}`);
  }
  await copyTree(sourceDir, params.paths.releaseDir);
  return params.paths.releaseDir;
}

/**
 * Relative link name and target for the per-release `shared` convenience link.
 *
 * `<siteRoot>/releases/<releaseId>/shared` → `../../shared`, i.e. the site's own
 * `shared/` directory. Relative for the same reason `current` is: the tree
 * survives being moved or bind-mounted under a different prefix.
 */
export const RELEASE_SHARED_LINK_NAME = "shared";
export const RELEASE_SHARED_LINK_TARGET = join("..", "..", "shared");

/**
 * Create the `shared` symlink at the top of a staged release.
 *
 * Generic on purpose — every release-backed service reaches its writable state
 * through the same `current/shared` path, so the traditional-web serving path
 * (PHP `open_basedir`, uploads) and the native runtime (`../native/`) do not
 * each invent their own convention, and the *content* of a generated vhost never has
 * to change when a promote swaps `current`.
 *
 * A build that emits its own `shared` entry is replaced rather than merged: the
 * link is part of the release layout contract, not shipped payload.
 */
export async function linkReleaseSharedDir(
  releaseDir: string,
): Promise<void> {
  const linkPath = join(releaseDir, RELEASE_SHARED_LINK_NAME);
  try {
    await Deno.remove(linkPath, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.symlink(RELEASE_SHARED_LINK_TARGET, linkPath);
}

/**
 * Point `current` at `releaseDir` atomically.
 *
 * The link target is **relative** (`releases/<releaseId>`) so the tree survives
 * being moved or bind-mounted under a different prefix.
 */
export async function swapCurrentSymlink(
  paths: ReleasePaths,
): Promise<void> {
  const releaseName = basename(paths.releaseDir);
  const target = join("releases", releaseName);
  const tmpLink = `${paths.currentLink}.tmp.${releaseName}`;
  try {
    await Deno.remove(tmpLink);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.symlink(target, tmpLink);
  try {
    // Same filesystem by construction (both under the site dir) — atomic.
    await Deno.rename(tmpLink, paths.currentLink);
  } catch (err) {
    try {
      await Deno.remove(tmpLink);
    } catch {
      // Leave cleanup best-effort; the original error is what matters.
    }
    throw err;
  }
}

/** Release `current` currently resolves to, or `null` when unpublished. */
export async function readCurrentReleaseId(
  paths: ReleasePaths,
): Promise<string | null> {
  try {
    const target = await Deno.readLink(paths.currentLink);
    const name = basename(target);
    return name.length > 0 ? name : null;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/**
 * Cut `current` over to a release that is **already published**.
 *
 * The rollback half of the engine. Nothing is fetched, built, staged, sealed,
 * or re-linked: the target tree was produced by an earlier successful promote,
 * so it already carries its `shared` link, its `.turbopanel/release.json`
 * manifest, and its sealed `root:<username>-grp 0550` ownership. Re-running any
 * of those steps would either fail against a read-only tree or quietly rewrite
 * history that a previous deploy recorded.
 *
 * What *is* reused is the health-probe contract {@link promoteRelease} honors —
 * the native runtime still has to start its unit against the target release and
 * answer on its port before the swap counts (`../native/`), while the
 * traditional-web lane needs no probe at all because the swap is nothing but a
 * symlink move.
 *
 * A missing target directory is an **error**, not a skip: "the release you
 * asked to roll back to was pruned on this host" is precisely the case an
 * operator must be told about rather than have silently succeed.
 */
export async function promoteExistingRelease(
  params: {
    paths: ReleasePaths;
    releaseId: string;
    healthProbe?: ReleaseHealthProbe;
  },
): Promise<string> {
  const releaseDir = params.paths.releaseDir;
  const stat = await statOrNull(releaseDir);
  if (stat === null) {
    throw new Error(
      `release ${params.releaseId} is not present on this host ` +
        `(${releaseDir}) — it was never published here, or retention has ` +
        `already removed it`,
    );
  }
  if (!stat.isDirectory) {
    throw new Error(`release ${params.releaseId} is not a directory`);
  }
  // Published releases are sealed; an unsealed tree at this path is a
  // half-staged directory from a promote that died, never something to run.
  const mode = stat.mode === null ? null : stat.mode & 0o7777;
  if (mode !== null && mode !== RELEASE_PUBLISHED_MODE) {
    throw new Error(
      `release ${params.releaseId} is not a sealed published release ` +
        `(mode ${mode.toString(8).padStart(4, "0")})`,
    );
  }

  if (params.healthProbe) await params.healthProbe(releaseDir);
  await swapCurrentSymlink(params.paths);
  return releaseDir;
}

/**
 * Record a Railpack release without publishing a tree.
 *
 * The Railpack lane produces an OCI image, not a directory: there is nothing to
 * stage, nothing to seal, and no `current` symlink to swap — the "cutover" is
 * `docker compose up` picking up the new `image:` tag. What it still needs is a
 * durable, per-release record, so the manifest is written into
 * `releases/<releaseId>/.turbopanel/release.json` exactly as the native lane
 * writes it. Keeping both lanes' history in one place is what lets rollback,
 * retention, and the release-history read model stay lane-agnostic.
 *
 * The directory is created unprivileged and left writable: nothing runs out of
 * it, so the "runtime user must not be able to rewrite what it runs" rule that
 * governs {@link sealPublishedRelease} has nothing to protect here.
 */
export async function recordRailpackRelease(
  params: { paths: ReleasePaths; manifest: ReleaseManifestV1 },
): Promise<string> {
  const releaseDir = params.paths.releaseDir;
  await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
    recursive: true,
    mode: 0o750,
  });
  await writeReleaseManifest(releaseDir, params.manifest);
  return releaseDir;
}

export type PromoteReleaseParams = StageReleaseParams & {
  username: string;
  /**
   * Written into the staged tree before the probe runs — the published tree is
   * read-only, so this is the last moment it can be written.
   */
  manifest?: ReleaseManifestV1;
  healthProbe?: ReleaseHealthProbe;
  runFn?: RunFn;
};

/**
 * Stage → `shared` link → manifest → probe → seal → cut over. Returns the
 * release directory.
 *
 * On any failure the staged directory is removed and `current` is left
 * untouched, so a failed promote is indistinguishable from one that never ran.
 */
export async function promoteRelease(
  params: PromoteReleaseParams,
): Promise<string> {
  const runFn = params.runFn ?? runPrivileged;
  try {
    const releaseDir = await stageRelease(params);
    await linkReleaseSharedDir(releaseDir);
    if (params.manifest) {
      await writeReleaseManifest(releaseDir, params.manifest);
    }
    const probe = params.healthProbe ??
      expectedPathsProbe([RELEASE_METADATA_DIRNAME]);
    await probe(releaseDir);
    await sealPublishedRelease(releaseDir, params.username, runFn);
    await swapCurrentSymlink(params.paths);
    return releaseDir;
  } catch (err) {
    // Never leave a half-staged release visible under `releases/`.
    try {
      await Deno.remove(params.paths.releaseDir, { recursive: true });
    } catch {
      // Already sealed root-owned, or never created — nothing more to do here.
    }
    throw err;
  }
}
