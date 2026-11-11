/**
 * A small file in a release's daemon-owned record folder saying its post-deploy
 * commands passed. Without it a re-sent release that is already `current`
 * cannot be told from one whose commands never ran (a first deploy that failed
 * after publishing), so the commands would be skipped for good.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";
import { resolveDaemonReleasePaths } from "../release/release-layout.ts";

const MARKER_FILE = "post-deploy-passed";

function markerPath(
  layout: LayoutPaths,
  serviceId: string,
  releaseId: string,
): string {
  return join(
    resolveDaemonReleasePaths(layout, { serviceId, releaseId }).releaseDir,
    MARKER_FILE,
  );
}

/** True when the release's commands passed on this host. */
export async function postDeployPassed(
  layout: LayoutPaths,
  serviceId: string,
  releaseId: string,
): Promise<boolean> {
  try {
    await Deno.stat(markerPath(layout, serviceId, releaseId));
    return true;
  } catch {
    return false;
  }
}

/** Record that the commands passed (the record folder exists once the release is recorded). Best effort: a miss only means they run again on a re-send. */
export async function markPostDeployPassed(
  layout: LayoutPaths,
  serviceId: string,
  releaseId: string,
): Promise<void> {
  try {
    const path = markerPath(layout, serviceId, releaseId);
    await Deno.writeTextFile(path, "passed\n");
  } catch {
    // Best effort, see above.
  }
}
