/**
 * Per-release manifest: `releases/<releaseId>/.turbopanel/release.json`.
 *
 * Written **inside the release tree**, not next to `deployment.json`, because
 * it answers a per-release question ("which commit is this directory?") that
 * has to survive independently of the environment-level manifest. Lifecycle,
 * rehydrate, and (later) rollback resolve the applied release from here without
 * asking the control plane — a daemon that lost its connection still knows what
 * it is running.
 *
 * Written through {@link writeComposeFileAtomic} (temp file, fsync, rename) so a
 * crash never leaves a truncated record and the mode is forced rather than
 * left to the process umask, the same rule every other daemon-authored
 * deployment file follows.
 */

import { join } from "@std/path";
import { writeComposeFileAtomic } from "../compose-files.ts";
import { RELEASE_METADATA_DIRNAME } from "./release-layout.ts";
import {
  isNativeAppStart,
  type NativeAppStart,
} from "../native/start-entry.ts";

export const RELEASE_MANIFEST_FILENAME = "release.json";

export type ReleaseManifestV1 = {
  version: 1;
  serviceId: string;
  composeServiceName: string;
  releaseId: string;
  sourceId: string;
  commitSha: string;
  /**
   * Commit subject and author, as the control plane resolved them.
   *
   * Recorded so a **rollback** can report which change it is putting back
   * without a provider round trip — the payload that carried this metadata is
   * long gone by then, and the daemon reads it straight back out of the target
   * release's own manifest ({@link readReleaseManifest}). Optional for the same
   * reason `standaloneOutput` is: a manifest written before these were recorded
   * is still a valid version-1 manifest.
   */
  commitMessage?: string;
  commitAuthor?: string;
  ref: string;
  /** ISO-8601 instant the release was staged for promotion. */
  promotedAt: string;
  /**
   * How the build output was shaped, recorded so a later **rollback** can
   * restore the same runtime lane without rebuilding.
   *
   * `staticExport` in particular decides whether the service is supervised as a
   * systemd unit or served as files (`resolveHostNativeLanes`); a rollback that
   * guessed `false` would try to run a statically exported site as a process.
   * Both are optional: a manifest written before these were recorded is still a
   * valid version-1 manifest and reads back as `undefined`.
   */
  standaloneOutput?: boolean;
  staticExport?: boolean;
  /**
   * How the unit starts this release when its author typed no start command
   * (`../native/start-entry.ts`), decided from the built tree. Recorded for the
   * same reason as the two above: a rollback cannot look inside the release
   * (it is readable only by the site owner's Linux user), and must restart the
   * old release the way it ran when it was live. Optional: an older record
   * reads back as `undefined`, which means `node server.js`.
   */
  nativeStart?: NativeAppStart;
  /**
   * Which runtime the unit ran this release on. Written only for `deno`; a
   * record without it ran on Node (every record written before Deno apps
   * existed, and every Node release since, so Node manifests are unchanged).
   * A rollback reads it to put back the unit of the runtime that release ran
   * on, not the runtime the newer payload asks for, so a site switched from
   * Node to Deno (or back) is restored to the runtime its old release needs.
   */
  runtime?: "node" | "deno";
  /**
   * The author's start command and startup file when this release was built,
   * so a rollback after a failed health check starts this release the way it
   * ran, not with whatever the newer deploy asked for. Absent when unset.
   */
  startCommand?: string;
  startupFile?: string;
  /**
   * Railpack lane only: the OCI image this release produced, and the pinned
   * tools that produced it.
   *
   * A Railpack release has **no promoted code tree** — nothing is copied into
   * the release directory and `current` never moves for it. The manifest is
   * still written here so release history lives in exactly one place for both
   * lanes, and these fields are what make it useful: a rollback reads
   * `imageTag` straight back out and re-runs that image instead of re-cloning
   * and rebuilding, and the two version fields say which frontend and plan
   * schema built it (the image itself is opaque about that, and an upgrade to
   * either changes build output).
   *
   * Optional for the same reason `standaloneOutput` is — a manifest written by
   * the native lane, or before these existed, is still a valid version-1
   * manifest and reads back as `undefined`.
   */
  imageTag?: string;
  imageDigest?: string;
  railpackFrontendVersion?: string;
  railpackPlanVersion?: string;
};

/** Every named field is absent or passes `ok`. */
function optionalFieldsOk(
  record: Record<string, unknown>,
  keys: readonly string[],
  ok: (field: unknown) => boolean,
): boolean {
  return keys.every((key) => record[key] === undefined || ok(record[key]));
}

function isReleaseManifestV1(value: unknown): value is ReleaseManifestV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  const required = [
    "serviceId",
    "composeServiceName",
    "releaseId",
    "sourceId",
    "commitSha",
    "ref",
    "promotedAt",
  ];
  const requiredOk = required.every((key) => {
    const field = record[key];
    return typeof field === "string" && field.length > 0;
  });
  if (!requiredOk) return false;
  return optionalFieldsOk(
    record,
    ["standaloneOutput", "staticExport"],
    (field) => typeof field === "boolean",
  ) &&
    optionalFieldsOk(record, ["nativeStart"], isNativeAppStart) &&
    optionalFieldsOk(
      record,
      ["runtime"],
      (field) => field === "node" || field === "deno",
    ) &&
    optionalFieldsOk(
      record,
      [
        "commitMessage",
        "commitAuthor",
        "startCommand",
        "startupFile",
        "imageTag",
        "imageDigest",
        "railpackFrontendVersion",
        "railpackPlanVersion",
      ],
      (field) => typeof field === "string",
    );
}

/** `<releaseDir>/.turbopanel/release.json`. */
export function releaseManifestPath(releaseDir: string): string {
  return join(releaseDir, RELEASE_METADATA_DIRNAME, RELEASE_MANIFEST_FILENAME);
}

/**
 * Write the manifest into the **staged** release, before it is sealed — the
 * published tree is read-only, so this is the last moment it can be written.
 */
export async function writeReleaseManifest(
  releaseDir: string,
  manifest: ReleaseManifestV1,
): Promise<void> {
  await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
    recursive: true,
    mode: 0o750,
  });
  const body = JSON.stringify(manifest, null, 2) + "\n";
  await writeComposeFileAtomic(releaseManifestPath(releaseDir), body);
}

/** `null` when absent or not a version-1 manifest. */
export async function readReleaseManifest(
  releaseDir: string,
): Promise<ReleaseManifestV1 | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(releaseManifestPath(releaseDir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isReleaseManifestV1(parsed) ? parsed : null;
}
