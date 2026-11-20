/**
 * A local build context must exist where the build will read it.
 *
 * Compose resolves a relative `build:` against the folder of its compose file,
 * and the deploy only writes the compiled compose file (and the files the plan
 * lists) into the deployment directory: it does not copy a repository's files
 * there. A context such as `./vpn` therefore points at a folder that is not on
 * the host, and the builder's own error ("path not found" deep in a build
 * step) does not say why. This names it before anything is built.
 *
 * Contexts are resolved on the staged file, so a path under the staging
 * directory is looked up at the same place under the live deployment
 * directory, where the published compose file will run the build. Paths
 * outside both are not this check's business: `compose-host-paths.ts` refuses
 * them.
 */

import { join, relative } from "@std/path";
import type { ComposeHostPathScan } from "./compose-host-paths.ts";

export class ComposeBuildContextMissingError extends Error {
  constructor(readonly missing: readonly string[], fromRepository = false) {
    super(
      fromRepository
        ? `compose deploy refused — build context not found in the repository checkout: ${
          missing.join("; ")
        }. The folder is not in the repository at the commit the compose file was read from`
        : `compose deploy refused — build context not found in the deployment directory: ${
          missing.join("; ")
        }. The deploy does not copy repository files to the host, so a local build context has nothing to build from; use a remote context or build the service from its repository source`,
    );
    this.name = "ComposeBuildContextMissingError";
  }
}

export type BuildContextDirs = {
  /** Where the staged compose file (and so its relative contexts) resolve. */
  stageDir: string;
  /** Where the published compose file runs the build. */
  deploymentDir: string;
  /**
   * The repository checkout of a Git Compose project (`compose-checkout.ts`).
   * Contexts under it resolve where they are; they are not staged.
   */
  checkoutRoot?: string;
};

export type IsDirectoryFn = (path: string) => Promise<boolean>;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Labels of the service build contexts (not Dockerfiles or named extras). */
function isServiceBuildContext(what: string): boolean {
  return /^service \S+ build context$/.test(what);
}

/** True when `rel` (from `relative`) leaves the directory it is relative to. */
function escapesDir(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || rel.startsWith("/");
}

/**
 * Service build contexts under the staging directory (looked up at the same
 * place under the live deployment directory) or under the checkout (looked up
 * where they are), as the path to look at.
 */
function stagedContexts(
  scans: readonly ComposeHostPathScan[],
  dirs: BuildContextDirs,
): Array<{ label: string; path: string }> {
  const out: Array<{ label: string; path: string }> = [];
  for (const entry of scans.flatMap((scan) => scan.entries)) {
    if (!entry.build || !isServiceBuildContext(entry.what)) continue;
    const inCheckout = dirs.checkoutRoot !== undefined &&
      !escapesDir(relative(dirs.checkoutRoot, entry.path));
    const base = inCheckout ? dirs.checkoutRoot! : dirs.stageDir;
    const rel = relative(base, entry.path);
    if (escapesDir(rel)) continue;
    const shown = rel === "" ? "." : `./${rel}`;
    out.push({
      label: `${entry.what} ${shown}`,
      path: inCheckout ? entry.path : join(dirs.deploymentDir, rel),
    });
  }
  return out;
}

/**
 * Throws {@link ComposeBuildContextMissingError} when a service's local build
 * context is not a folder in the deployment directory.
 */
export async function assertBuildContextsPresent(
  scans: readonly ComposeHostPathScan[],
  dirs: BuildContextDirs,
  exists: IsDirectoryFn = isDirectory,
): Promise<void> {
  const contexts = stagedContexts(scans, dirs);
  const present = await Promise.all(
    contexts.map(({ path }) => exists(path)),
  );
  const missing = contexts.filter((_, i) => !present[i]).map((c) => c.label);
  if (missing.length > 0) {
    throw new ComposeBuildContextMissingError(
      missing,
      dirs.checkoutRoot !== undefined,
    );
  }
}
