/**
 * On-host release tree layout and privileged directory creation.
 *
 * ```
 * <principalHomeRoot>/.tp-staging/                 root:tp 0710
 *   <publishId>/                                   tp 0700 while the daemon copies
 * <principalHomeRoot>/<owner>/<scope>/services/    root:<owner> 0750
 *   <name>/                                        root:<owner> 0750
 *     releases/                                    root:<owner> 0750
 *       <releaseId>/  root:<username>, 0550 top, nothing g/o-writable
 *     current -> releases/<releaseId>
 *     shared/         <username>:<username> 0750  (the one writable path)
 * ```
 *
 * **Ownership is the security property, not just the mode.** Everything on the
 * immutable side — the service folder, `releases/`, and each release inside it
 * — is **root-owned**, group `<username>`: the runtime user gets `r-x` so it
 * can traverse to `current` and read what it is running, and nothing more. A
 * principal-owned `releases/` would leave the app process able to rewrite the
 * code it runs (and to swap `current`), which turns any RCE into persistence and
 * defeats the point of immutable releases. `shared/` is the single
 * principal-owned, principal-writable directory.
 *
 * On a managed host a release never exists unsealed under `releases/`: the
 * daemon copies it into its own staging leaf ({@link ReleasePaths.stagingDir}),
 * and tp-host `publish` seals that leaf recursively, refuses hard links,
 * special files and symlinks that resolve outside it, and renames it into
 * place (`./promote.ts`). tp-host refuses to create anything under
 * `releases/<releaseId>` any other way.
 *
 * Path shapes come from `src/paths/layout.ts` (`serviceTree`) so the site
 * serving code addresses exactly the same tree. The folder and its
 * root-owned parents are made by `../asset-folders.ts` (`ensureAssetFolder`);
 * this module never invents a second privileged mkdir helper.
 */

import { dirname, join } from "@std/path";
import { isPathId } from "../../contracts/directory-names.ts";
import type { FolderRefParts } from "../../contracts/directory-names.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import {
  ownerRoot,
  publishStagingDir,
  serviceTree,
} from "../../paths/layout.ts";
import { principalUnixGroupName, type RunFn } from "../ensure-principal.ts";

/** Scratch root for ephemeral checkouts — never inside the release tree. */
export const RELEASE_SCRATCH_DIRNAME = "release-build";

/** Per-release metadata directory written inside the published release. */
export const RELEASE_METADATA_DIRNAME = ".turbopanel";

/**
 * Daemon-owned release-history root: the authoritative record of every release
 * this host published, and the home of releases that publish **no tree**.
 *
 * Every lane writes its manifest here, and rollback reads only this root. A
 * native release also keeps a copy inside its tree, but that tree sits in the
 * principal's home, which the principal owns — nothing privileged or
 * trust-bearing is ever read back out of it.
 *
 * An image-build release produces an OCI image; nothing is copied into a directory
 * and no runtime user ever reads one, so it needs no principal home — and
 * requiring one would mean refusing to build a container service just because
 * nobody assigned it a Unix account it would never use. Its manifest instead
 * lands under `<daemonStateDir>/release-records/<serviceId>/<releaseId>/`: one
 * folder per service, one per release, nothing else in the tree.
 *
 * An image-build service keeps its history here whether or not it has a principal
 * — one service should not move its history between two roots depending on an
 * unrelated assignment.
 */
export const RELEASE_RECORDS_DIRNAME = "release-records";

/**
 * Modes for the release tree.
 *
 * `releases/` and each published release are group-readable but **not**
 * writable by the runtime user: a compromised app process must not be able to
 * rewrite the code it is running. `shared/` is the one writable path.
 *
 * A published release's top directory is {@link RELEASE_PUBLISHED_MODE}.
 */
export const RELEASE_DIR_MODE = "0750";
export const RELEASE_PUBLISHED_MODE = 0o550;
export const RELEASE_SHARED_MODE = "0750";

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

/**
 * What the six-word tp-host publish needs: the folder's components and the
 * three ids. Absent on a daemon-owned release record, which publishes no tree.
 */
export type ReleasePublishRef = {
  folder: FolderRefParts;
  serviceId: string;
  releaseId: string;
  publishId: string;
};

export type ReleasePaths = {
  /** Set when the release lives in a service folder (every principal release). */
  publish?: ReleasePublishRef;
  principalHome: string;
  /** The folder that holds the service folder (`<scope>/services`). */
  sitesDir: string;
  siteDir: string;
  releasesDir: string;
  releaseDir: string;
  currentLink: string;
  sharedDir: string;
  /** Ephemeral checkout/build directory — removed after promote. */
  scratchDir: string;
  /**
   * The daemon's checked copy of the build output on a managed host: a leaf
   * under `<principalHomeRoot>/.tp-staging` that tp-host `publish` seals and
   * renames into {@link releaseDir}. Outside the scratch root on purpose — the
   * build controls every name under its own tree.
   */
  stagingDir: string;
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
  params: {
    username: string;
    serviceId: string;
    releaseId: string;
    /** The service folder the control plane planned. */
    folder: FolderRefParts;
    /** The staging leaf's name; a fresh UUID when absent (keep the one `paths` object from open to publish). */
    publishId?: string;
  },
): ReleasePaths {
  const serviceId = assertSafeServiceId(params.serviceId);
  const releaseId = assertSafeReleaseId(params.releaseId);
  // tp-host takes only canonical ids for a folder release; fail before the
  // build rather than at publish.
  for (const id of [serviceId, releaseId]) {
    if (!isPathId(id)) throw new Error(`unsafe folder release id: ${id}`);
  }
  const tree = serviceTree(layout, {
    serviceId,
    username: params.username,
    folder: params.folder,
  });
  const scratchDir = join(
    layout.daemonStateDir,
    RELEASE_SCRATCH_DIRNAME,
    serviceId,
    releaseId,
  );
  const publishId = params.publishId ?? crypto.randomUUID();
  return {
    publish: { folder: params.folder, serviceId, releaseId, publishId },
    siteDir: tree.root,
    releasesDir: tree.releasesDir,
    releaseDir: join(tree.releasesDir, releaseId),
    currentLink: tree.currentLink,
    sharedDir: tree.sharedDir,
    scratchDir,
    principalHome: ownerRoot(layout, params.username),
    sitesDir: dirname(tree.root),
    stagingDir: publishStagingDir(layout, publishId),
  };
}

/**
 * The paths of one release record under the daemon-owned release-history root:
 * `<daemonStateDir>/release-records/<serviceId>/<releaseId>`.
 *
 * Same fields as {@link resolveReleasePaths} so retention and the manifest
 * readers stay lane-agnostic, but no principal home and no privileged
 * ownership: every directory here is created by the daemon user with {@link
 * ensureDaemonReleaseRecordDir}. It holds release *records* (manifests) only —
 * anything a runtime user reads belongs in the principal home, under the
 * root-owned ownership rules this module documents. A record has no `current`
 * link, no `shared` folder and nothing staged: it is written in place, so those
 * fields name paths that are never created.
 */
export function resolveDaemonReleasePaths(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  params: { serviceId: string; releaseId: string },
): ReleasePaths {
  const serviceId = assertSafeServiceId(params.serviceId);
  const releaseId = assertSafeReleaseId(params.releaseId);
  const recordsHome = join(layout.daemonStateDir, RELEASE_RECORDS_DIRNAME);
  const serviceDir = join(recordsHome, serviceId);
  const releaseDir = join(serviceDir, releaseId);
  return {
    principalHome: recordsHome,
    sitesDir: recordsHome,
    siteDir: serviceDir,
    releasesDir: serviceDir,
    releaseDir,
    currentLink: join(serviceDir, "current"),
    sharedDir: join(serviceDir, "shared"),
    scratchDir: join(
      layout.daemonStateDir,
      RELEASE_SCRATCH_DIRNAME,
      serviceId,
      releaseId,
    ),
    // Never staged: a release record has no tree to publish.
    stagingDir: releaseDir,
  };
}

/**
 * Create the daemon-owned release-record directories for one release.
 *
 * Unprivileged on purpose — there is no principal, no `sudo`, and nothing here
 * is ever executed or served, so the privileged ownership dance of a folder release
 * has nothing to protect. `shared/` is not created: a lane that publishes no
 * tree has no cross-release writable state.
 */
export async function ensureDaemonReleaseRecordDir(
  paths: ReleasePaths,
): Promise<void> {
  // Outermost first, one at a time.
  await forEachSequential([
    paths.principalHome,
    paths.siteDir,
    paths.releaseDir,
  ], async (dir) => {
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  });
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
 * Seal a staged release: hand the tree to `root:<username>` and drop the
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
  const chown = await runFn(
    "sudo",
    hostSudoArgs(["-n", "chown", "-R", owner, releaseDir]),
  );
  if (!chown.success) {
    throw new Error(chown.stderr || `Failed to chown release ${releaseDir}`);
  }
  const mode = RELEASE_PUBLISHED_MODE.toString(8).padStart(4, "0");
  const chmod = await runFn(
    "sudo",
    hostSudoArgs(["-n", "chmod", mode, releaseDir]),
  );
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
  const result = await runFn(
    "sudo",
    hostSudoArgs(["-n", "rm", "-rf", "--", releaseDir]),
  );
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
