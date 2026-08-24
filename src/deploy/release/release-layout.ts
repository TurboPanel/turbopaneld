/**
 * On-host release tree layout and privileged directory creation.
 *
 * ```
 * <principalHomeRoot>/<username>/sites/            root:<username>-grp 0750
 *   <serviceId>/                                   root:<username>-grp 0750
 *     releases/                                    root:<username>-grp 0750
 *       <releaseId>/  staging 0750 → published 0550, root:<username>-grp
 *     current -> releases/<releaseId>
 *     shared/         <username>:<username>-grp 0750  (the one writable path)
 * ```
 *
 * **Ownership is the security property, not just the mode.** Everything on the
 * immutable side — `sites/<serviceId>`, `releases/`, and each release inside it
 * — is **root-owned**, group `<username>-grp`: the runtime user gets `r-x` so it
 * can traverse to `current` and read what it is running, and nothing more. A
 * principal-owned `releases/` would leave the app process able to rewrite the
 * code it runs (and to swap `current`), which turns any RCE into persistence and
 * defeats the point of immutable releases. `shared/` is the single
 * principal-owned, principal-writable directory, and a staging release is
 * root-writable only until {@link sealPublishedRelease} drops it to
 * {@link RELEASE_PUBLISHED_MODE}.
 *
 * Path shapes come from `src/paths/layout.ts` (`siteRoot` / `siteReleasesDir` /
 * `siteCurrentSymlink` / `siteSharedDir`) so the next phase's traditional-web
 * serving change addresses exactly the same tree. Directory creation goes
 * through `ensureDirectoryWithOwner` / `ensureDirectoryOwnedByPrincipal` — the
 * one `sudo -n install -d` seam in `../ensure-principal.ts`. This module never
 * invents a second privileged mkdir helper.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";
import {
  principalHomePath,
  siteCurrentSymlink,
  siteReleasesDir,
  siteRoot,
  siteSharedDir,
} from "../../paths/layout.ts";
import {
  ensureDirectoryOwnedByPrincipal,
  ensureDirectoryWithOwner,
  principalUnixGroupName,
  type RunFn,
} from "../ensure-principal.ts";

/** Scratch root for ephemeral checkouts — never inside the release tree. */
export const RELEASE_SCRATCH_DIRNAME = "release-build";

/** Per-release metadata directory written inside the published release. */
export const RELEASE_METADATA_DIRNAME = ".turbopanel";

/**
 * Daemon-owned release-history root, for releases that publish **no tree**.
 *
 * A Railpack release produces an OCI image; nothing is copied into a directory
 * and no runtime user ever reads one, so it needs no principal home — and
 * requiring one would mean refusing to build a container service just because
 * nobody assigned it a Unix account it would never use. Its manifest instead
 * lands under `<daemonStateDir>/release-records/sites/<serviceId>/releases/…`,
 * which is the same shape {@link resolveReleasePaths} produces so retention and
 * the manifest readers stay lane-agnostic.
 *
 * A Railpack service that *does* have a principal keeps using the principal
 * home tree — one service should not move its history between two roots
 * depending on an unrelated assignment.
 */
export const RELEASE_RECORDS_DIRNAME = "release-records";

/**
 * Modes for the release tree.
 *
 * `releases/` and each published release are group-readable but **not**
 * writable by the runtime user: a compromised app process must not be able to
 * rewrite the code it is running. `shared/` is the one writable path.
 *
 * {@link RELEASE_STAGING_MODE} is the same `0750` while the deploy engine is
 * still copying the build output in — owner-writable, group read-only — and
 * {@link sealPublishedRelease} tightens it to {@link RELEASE_PUBLISHED_MODE}
 * once the health probe passes.
 */
export const RELEASE_DIR_MODE = "0750";
export const RELEASE_PUBLISHED_MODE = 0o550;
export const RELEASE_SHARED_MODE = "0750";
export const RELEASE_STAGING_MODE = "0750";

/** Owner of every immutable path in the tree (`root:<username>-grp`). */
function releaseRootOwner(username: string): string {
  return `root:${principalUnixGroupName(username)}`;
}

/** Same id rule the wire parser enforces — defense in depth before any path join. */
const RELEASE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;
const SERVICE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

export function assertSafeReleaseId(releaseId: string): string {
  if (!RELEASE_ID_RE.test(releaseId)) {
    throw new Error(`unsafe releaseId: ${releaseId}`);
  }
  return releaseId;
}

export function assertSafeServiceId(serviceId: string): string {
  if (!SERVICE_ID_RE.test(serviceId)) {
    throw new Error(`unsafe release serviceId: ${serviceId}`);
  }
  return serviceId;
}

export type ReleasePaths = {
  principalHome: string;
  /** `<principalHome>/sites` — parent of every per-service site tree. */
  sitesDir: string;
  siteDir: string;
  releasesDir: string;
  releaseDir: string;
  currentLink: string;
  sharedDir: string;
  /** Ephemeral checkout/build directory — removed after promote. */
  scratchDir: string;
};

/**
 * Resolve every path for one release. Pure — creates nothing.
 *
 * The scratch dir lives under `<daemonStateDir>/release-build/`, deliberately
 * outside the principal home: a half-finished checkout must never be reachable
 * through the tree a serving engine reads.
 */
export function resolveReleasePaths(
  layout: Pick<LayoutPaths, "principalHomeRoot" | "daemonStateDir">,
  params: { username: string; serviceId: string; releaseId: string },
): ReleasePaths {
  const serviceId = assertSafeServiceId(params.serviceId);
  const releaseId = assertSafeReleaseId(params.releaseId);
  const principalHome = principalHomePath(layout, params.username);
  return {
    principalHome,
    sitesDir: join(principalHome, "sites"),
    siteDir: siteRoot(principalHome, serviceId),
    releasesDir: siteReleasesDir(principalHome, serviceId),
    releaseDir: join(siteReleasesDir(principalHome, serviceId), releaseId),
    currentLink: siteCurrentSymlink(principalHome, serviceId),
    sharedDir: siteSharedDir(principalHome, serviceId),
    scratchDir: join(
      layout.daemonStateDir,
      RELEASE_SCRATCH_DIRNAME,
      serviceId,
      releaseId,
    ),
  };
}

/**
 * {@link resolveReleasePaths} against the daemon-owned release-history root.
 *
 * Same path shape, no principal home and no privileged ownership: every
 * directory here is created by the daemon user with {@link
 * ensureDaemonReleaseRecordDir}. Use this only for a lane that publishes no
 * tree — anything a runtime user reads belongs in the principal home, under the
 * root-owned ownership rules this module documents.
 */
export function resolveDaemonReleasePaths(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  params: { serviceId: string; releaseId: string },
): ReleasePaths {
  const serviceId = assertSafeServiceId(params.serviceId);
  const releaseId = assertSafeReleaseId(params.releaseId);
  const recordsHome = join(layout.daemonStateDir, RELEASE_RECORDS_DIRNAME);
  return {
    principalHome: recordsHome,
    sitesDir: join(recordsHome, "sites"),
    siteDir: siteRoot(recordsHome, serviceId),
    releasesDir: siteReleasesDir(recordsHome, serviceId),
    releaseDir: join(siteReleasesDir(recordsHome, serviceId), releaseId),
    currentLink: siteCurrentSymlink(recordsHome, serviceId),
    sharedDir: siteSharedDir(recordsHome, serviceId),
    scratchDir: join(
      layout.daemonStateDir,
      RELEASE_SCRATCH_DIRNAME,
      serviceId,
      releaseId,
    ),
  };
}

/**
 * Create the daemon-owned release-record directories for one release.
 *
 * Unprivileged on purpose — there is no principal, no `sudo`, and nothing here
 * is ever executed or served, so {@link ensureReleaseTree}'s ownership dance
 * has nothing to protect. `shared/` is not created: a lane that publishes no
 * tree has no cross-release writable state.
 */
export async function ensureDaemonReleaseRecordDir(
  paths: ReleasePaths,
): Promise<void> {
  for (
    const dir of [
      paths.principalHome,
      paths.sitesDir,
      paths.siteDir,
      paths.releasesDir,
      paths.releaseDir,
    ]
  ) {
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  }
}

/**
 * Create `sites/<serviceId>/{releases,shared}` and the staging release dir,
 * each with the ownership its role requires.
 *
 * - `sites/`, `sites/<serviceId>/`, `releases/` — **root-owned**, group
 *   `<username>-grp`, {@link RELEASE_DIR_MODE}. The runtime user may traverse
 *   and read; it may not create, rename, or unlink anything, so it can neither
 *   plant a release nor repoint `current`.
 * - `shared/` — principal-owned and writable: the one path an app may write
 *   that survives a promote.
 * - `releases/<releaseId>/` — root-owned and **writable** at
 *   {@link RELEASE_STAGING_MODE} while the build output is copied in;
 *   {@link sealPublishedRelease} drops it to {@link RELEASE_PUBLISHED_MODE}
 *   after the health probe passes, so a failed build never leaves a read-only
 *   half-release behind and the principal is never able to write a release at
 *   all.
 *
 * `install -d` repairs as well as creates, so a tree laid down by the earlier
 * principal-owned layout converges to this one on the next deploy.
 */
export async function ensureReleaseTree(
  paths: ReleasePaths,
  username: string,
  runFn?: RunFn,
): Promise<void> {
  const group = principalUnixGroupName(username);
  const owner = releaseRootOwner(username);
  for (const dir of [paths.sitesDir, paths.siteDir, paths.releasesDir]) {
    await ensureDirectoryWithOwner(dir, RELEASE_DIR_MODE, owner, runFn);
  }
  await ensureDirectoryOwnedByPrincipal(
    paths.sharedDir,
    username,
    group,
    runFn,
  );
  await ensureDirectoryWithOwner(
    paths.releaseDir,
    RELEASE_STAGING_MODE,
    owner,
    runFn,
  );
}

/**
 * Default privileged runner: `sudo -n …`, same shape `ensure-principal.ts`
 * uses. Tests inject a {@link RunFn} instead of touching the host.
 */
export async function runPrivileged(
  command: string,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const decoder = new TextDecoder();
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

/**
 * Seal a staged release: hand the tree to `root:<username>-grp` and drop the
 * release directory to {@link RELEASE_PUBLISHED_MODE}.
 *
 * A published release must be **read-only to the runtime user** — an app
 * process that can rewrite its own code turns any RCE into persistence. This
 * runs only after the health probe passes; a failed build never reaches it, so
 * a half-written tree is never sealed into place.
 */
export async function sealPublishedRelease(
  releaseDir: string,
  username: string,
  runFn: RunFn = runPrivileged,
): Promise<void> {
  const owner = `root:${principalUnixGroupName(username)}`;
  const chown = await runFn("sudo", ["-n", "chown", "-R", owner, releaseDir]);
  if (!chown.success) {
    throw new Error(chown.stderr || `Failed to chown release ${releaseDir}`);
  }
  const mode = RELEASE_PUBLISHED_MODE.toString(8).padStart(4, "0");
  const chmod = await runFn("sudo", ["-n", "chmod", mode, releaseDir]);
  if (!chmod.success) {
    throw new Error(chmod.stderr || `Failed to chmod release ${releaseDir}`);
  }
}

/**
 * Remove one published release directory.
 *
 * Sealed releases are root-owned, so this goes through the privileged runner
 * rather than `Deno.remove` — the daemon user cannot unlink them itself.
 */
export async function removePublishedRelease(
  releaseDir: string,
  runFn: RunFn = runPrivileged,
): Promise<void> {
  const result = await runFn("sudo", ["-n", "rm", "-rf", "--", releaseDir]);
  if (!result.success) {
    throw new Error(result.stderr || `Failed to remove release ${releaseDir}`);
  }
}

/** Recreate an empty scratch directory for this release's checkout. */
export async function resetReleaseScratchDir(
  paths: ReleasePaths,
): Promise<string> {
  await removeReleaseScratchDir(paths);
  await Deno.mkdir(paths.scratchDir, { recursive: true, mode: 0o700 });
  return paths.scratchDir;
}

/** Best-effort scratch removal. Never throws for a missing directory. */
export async function removeReleaseScratchDir(
  paths: ReleasePaths,
): Promise<void> {
  try {
    await Deno.remove(paths.scratchDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}
