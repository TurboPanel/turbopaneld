/**
 * Which native releases ever passed their health check on this host.
 *
 * A failed health check rolls `current` back to the release before it — but
 * only a release that once answered is worth going back to. Restoring one that
 * never came up (it crash-looped too) just trades one dead app for another and
 * tells the operator it "rolled back". So the native apply marks a release
 * healthy in the daemon's own release record (`resolveDaemonReleasePaths`,
 * which only the daemon writes) the moment its probe answers, and a rollback
 * target must carry that mark.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";
import { resolveDaemonReleasePaths } from "./release-layout.ts";
import {
  readReleaseManifest,
  type ReleaseManifestV1,
} from "./deployment-json.ts";

/** Present in a record dir from before the promote until it has finished. */
export const PENDING_RECORD_MARKER = ".pending";

/** Present once the release has answered its health check on this host. */
export const HEALTHY_RECORD_MARKER = ".healthy";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Mark a release healthy. `false` when it has no record (published before
 * records were kept), which leaves it ineligible as a rollback target.
 */
export async function markReleaseHealthy(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  serviceId: string,
  releaseId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<boolean> {
  const { releaseDir } = resolveDaemonReleasePaths(layout, {
    serviceId,
    releaseId,
  });
  if (!(await exists(releaseDir))) return false;
  await Deno.writeTextFile(
    join(releaseDir, HEALTHY_RECORD_MARKER),
    `${now()}\n`,
  );
  return true;
}

/**
 * The record of a release this host published **and** saw answer its health
 * check, or `null`. A pending record (its promote never finished), a missing
 * one, or one never marked healthy all mean "do not roll back to this".
 */
export async function readHealthyRelease(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  serviceId: string,
  releaseId: string,
): Promise<ReleaseManifestV1 | null> {
  const { releaseDir } = resolveDaemonReleasePaths(layout, {
    serviceId,
    releaseId,
  });
  const [pending, healthy] = await Promise.all([
    exists(join(releaseDir, PENDING_RECORD_MARKER)),
    exists(join(releaseDir, HEALTHY_RECORD_MARKER)),
  ]);
  if (pending || !healthy) return null;
  const manifest = await readReleaseManifest(releaseDir);
  return manifest?.serviceId === serviceId && manifest.releaseId === releaseId
    ? manifest
    : null;
}
