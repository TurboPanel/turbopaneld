/**
 * The hash of the last deploy this host finished, kept beside the deployment's
 * compose files, so a redeploy that would change nothing can be recognised and
 * skipped.
 *
 * The control plane builds the hash from everything that decides what runs:
 * the compiled compose document, each source's commit and build inputs, the
 * variables, the hosts and apps. This module only stores and compares it.
 *
 * The record is cleared as soon as a deploy that will do work starts and is
 * written again only once that deploy has finished, so a deploy that failed
 * (or was cancelled) never counts as applied and the next try runs in full.
 */

import { join } from "node:path";
import { getBuildInfo } from "../build-info.ts";
import { DAEMON_VERSION } from "../version.ts";

const APPLIED_HASH_FILENAME = "applied-deploy-hash";

/**
 * The daemon build that wrote the record. A new build may render units, sites
 * and compose files differently, so a hash recorded by another build never
 * matches: the first redeploy after a daemon update always runs in full.
 */
export function daemonRenderStamp(): string {
  return `${DAEMON_VERSION}+${getBuildInfo().commit}`;
}

function appliedHashPath(deploymentDir: string): string {
  return join(deploymentDir, APPLIED_HASH_FILENAME);
}

/** The recorded hash, or `null` when none was recorded or it cannot be read. */
export async function readAppliedDeployHash(
  deploymentDir: string,
): Promise<string | null> {
  try {
    const [stamp, hash] = (await Deno.readTextFile(
      appliedHashPath(deploymentDir),
    )).trim().split("\n");
    if (stamp !== daemonRenderStamp() || !hash) return null;
    return hash;
  } catch {
    return null;
  }
}

/** Forget the recorded hash. Nothing to forget is fine. */
export async function clearAppliedDeployHash(
  deploymentDir: string,
): Promise<void> {
  try {
    await Deno.remove(appliedHashPath(deploymentDir));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/** Record that a deploy with this hash finished. */
export async function writeAppliedDeployHash(
  deploymentDir: string,
  hash: string,
): Promise<void> {
  await Deno.writeTextFile(
    appliedHashPath(deploymentDir),
    `${daemonRenderStamp()}\n${hash}\n`,
    {
      mode: 0o640,
    },
  );
}
