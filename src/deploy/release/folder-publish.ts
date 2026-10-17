/**
 * Publishing a release into the scope tree.
 *
 * The same two tp-host verbs as the older layout, given six words: the owner,
 * the scope, the service folder name, and the service, release and publish
 * ids. tp-host builds every path itself and checks the same names again, so
 * the daemon sends components and ids, never a path.
 *
 *   `publish-open` makes the daemon's staging leaf (named by the publish id),
 *   the daemon copies the build into it, `publish` seals it into
 *   `<service>/releases/<releaseId>` and swaps `current`.
 *
 * Nothing calls these yet: the serving code switches to them in a later
 * change, and the older three-word form keeps working until then.
 */

import {
  isPathId,
  parseFolderRefParts,
} from "../../contracts/directory-names.ts";
import type { FolderRefParts } from "../../contracts/directory-names.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { type LayoutPaths, publishStagingDir } from "../../paths/layout.ts";
import type { RunFn } from "../ensure-principal.ts";

/** The three UUIDs one publish names. */
export type FolderPublishIds = {
  serviceId: string;
  releaseId: string;
  publishId: string;
};

async function runFolderPublishVerb(
  verb: "publish-open" | "publish",
  parts: FolderRefParts,
  ids: FolderPublishIds,
  runFn: RunFn,
): Promise<void> {
  const ref = parseFolderRefParts(parts, "service");
  for (const [label, value] of Object.entries(ids)) {
    if (!isPathId(value)) throw new TypeError(`Invalid ${label}`);
  }
  const result = await runFn(
    "sudo",
    hostSudoArgs([
      "-n",
      verb,
      ref.owner,
      ref.scope,
      ref.slug,
      ids.serviceId,
      ids.releaseId,
      ids.publishId,
    ]),
  );
  if (!result.success) {
    throw new Error(
      result.stderr || `tp-host ${verb} failed for release ${ids.releaseId}`,
    );
  }
}

/** Ask tp-host for a fresh staging leaf. Returns its path, computed here from the publish id. */
export async function publishOpenInFolder(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  parts: FolderRefParts,
  ids: FolderPublishIds,
  runFn: RunFn,
): Promise<string> {
  await runFolderPublishVerb("publish-open", parts, ids, runFn);
  return publishStagingDir(layout, ids.publishId);
}

/** Seal the staged leaf into `releases/<releaseId>` and swap `current`. */
export async function publishInFolder(
  parts: FolderRefParts,
  ids: FolderPublishIds,
  runFn: RunFn,
): Promise<void> {
  await runFolderPublishVerb("publish", parts, ids, runFn);
}
