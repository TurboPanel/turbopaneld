/**
 * Drive the release engine for a deploy's `sourceMaterial[]`.
 *
 * Per entry: ensure the release tree → checkout (`fetch` phase) → build
 * (`build` phase) → stage/probe/seal/cut over `current` (`release-promote`
 * phase) → prune superseded releases. The ephemeral checkout is removed
 * afterwards whether the release succeeded or not.
 *
 * An entry carrying `rollbackToReleaseId` takes the **rollback** branch
 * instead: fetch, build, and the whole staging half are skipped and `current`
 * is cut straight over to the named already-published release
 * ({@link rollbackOneRelease}). It rides the same `environment.deploy` payload
 * rather than a command type of its own, so every stage after the promote —
 * native-app supervision, `deployment.json`, retention — consumes it unchanged.
 *
 * A `build.kind: 'railpack'` entry takes a third branch
 * ({@link applyRailpackRelease}): checkout is identical, but the build produces
 * an **OCI image** rather than a tree, so nothing is staged, nothing is sealed,
 * and `current` never moves. The image tag is returned on the
 * {@link AppliedRelease} and `deploy-environment.ts` writes it into the compiled
 * runtime compose as `services.<name>.image` — from there it is an ordinary
 * container service. Because no filesystem tree is published, that branch does
 * **not** require a project principal: there is nothing for a Unix account to
 * own.
 *
 * The engine itself stays kind-agnostic. The one place a `serviceKind: node`
 * app is treated differently is the build output: a Next standalone tree is
 * folded and published in place of the whole checkout, and a statically
 * exported build publishes its `out/` tree and reports `staticExport`
 * ({@link prepareNativeAppBuildOutput}). Which service is a native app comes
 * from `payload.nativeAppServices[]` — this module never re-derives it, and it
 * never rewrites the payload: acting on `staticExport` (running the service on
 * the site static lane instead of a systemd unit) belongs to the
 * deploy handler that owns both lanes.
 */

import type { LayoutPaths } from "../../paths/layout.ts";
import {
  COMMAND_LOG_PHASES,
  type CommandOutputSink,
} from "../../logs/contracts.ts";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import type { DecryptSecretsFn } from "../materialize-tls.ts";
import type { RunFn } from "../ensure-principal.ts";
import { dirname } from "@std/path";
import {
  assertCheckoutCredentialsRemoved,
  checkoutRelease,
  type CheckoutResult,
  type ReleaseOutputHandler,
} from "./checkout.ts";
import {
  type NativeAppBuildOutput,
  prepareNativeAppBuildOutput,
  runReleaseBuild,
} from "./build.ts";
import {
  buildSandboxEnabled,
  type BuildSandboxMarkers,
  buildSpecCwd,
  type BuildWork,
  createBuildWorkDir,
  removeBuildWork,
  resolveBuildWork,
  sweepStaleBuildWork,
} from "./build-sandbox.ts";
import {
  nativeAppNodeBinary,
  nativeAppRuntimeGroup,
  resolveNativeAppNodeVersion,
} from "../native/unit.ts";
import {
  ensureBuildkitRailpack,
  railpackCacheKey,
  railpackImageTag,
  runRailpackBuild,
} from "./railpack-build.ts";
import {
  promoteExistingRelease,
  promoteRelease,
  readCurrentReleaseId,
  recordRailpackRelease,
} from "./promote.ts";
import { pruneReleases } from "./retention.ts";
import { definedFields } from "../../util/optional-fields.ts";
import { forEachSequential } from "../../util/sequential.ts";
import {
  readReleaseManifest,
  type ReleaseManifestV1,
  writeReleaseManifest,
} from "./deployment-json.ts";
import {
  ensureDaemonReleaseRecordDir,
  ensureReleaseTree,
  type ReleasePaths,
  removeReleaseScratchDir,
  resetReleaseScratchDir,
  resolveDaemonReleasePaths,
  resolveReleasePaths,
} from "./release-layout.ts";

export type AppliedRelease = {
  composeServiceName: string;
  serviceId: string;
  releaseId: string;
  /**
   * The commit that is now live for this service.
   *
   * For a fresh release this is what the checkout actually resolved to; for a
   * **rollback** it is read back out of the target release's own manifest, not
   * taken from the payload — the payload's `commitSha` is a stored placeholder
   * on that branch. `deployment.json` records this value, so the host's durable
   * record names the commit that is running rather than the one the control
   * plane happened to send.
   */
  commitSha: string;
  /** Commit subject / author for the same row, when either is known. */
  commitMessage?: string;
  commitAuthor?: string;
  releaseDir: string;
  /**
   * Railpack lane only: the OCI image this release resolved to, and the pinned
   * tools that produced it.
   *
   * Deliberately **not** on the wire payload — the image does not exist until
   * the daemon has built it, so the control plane has nothing to send. It rides
   * back on the result instead: `deploy-environment.ts` turns `imageTag` into
   * `services.<name>.image` before `docker compose config`, and the two version
   * fields are carried into the command result so the release-history surface
   * can name a Railpack release by its image rather than by a directory it does
   * not have. `undefined` on every native-lane release.
   */
  imageTag?: string;
  imageDigest?: string;
  railpackFrontendVersion?: string;
  railpackPlanVersion?: string;
  /**
   * Release `current` pointed at **before** this promote, or `null` on a first
   * deploy. The native-runtime apply rolls back to it when a promoted release
   * builds cleanly but never answers on its port — by then `promoteRelease`'s
   * own "leave `current` alone" guarantee has already been spent.
   */
  previousReleaseId: string | null;
  /** True when a Next standalone tree was published instead of the checkout. */
  standaloneOutput: boolean;
  /**
   * True when the build turned out to be a statically exported Next site
   * (`output: 'export'`). The deploy handler moves such a service off
   * `nativeAppServices[]` and onto the site static lane — there is no
   * server process to supervise, so no systemd unit is generated for it.
   */
  staticExport: boolean;
};

/**
 * Compose service name → TurboPanel service UUID, from the rows that carry it
 * (`hostings[]`, then `ingressServices[]`).
 *
 * A Git-backed service need not publish a hosting (a worker does not), so when
 * neither names it the compose service key is used as the directory segment.
 * It is unique within an environment and charset-safe, which is all the path
 * needs — nothing downstream parses this segment as a UUID.
 */
export function resolveReleaseServiceId(
  payload: EnvironmentDeployPayload,
  composeServiceName: string,
): string {
  for (const hosting of payload.hostings ?? []) {
    if (
      hosting.composeServiceName === composeServiceName && hosting.serviceId
    ) {
      return hosting.serviceId;
    }
  }
  for (const ingress of payload.ingressServices ?? []) {
    if (
      ingress.composeServiceName === composeServiceName && ingress.serviceId
    ) {
      return ingress.serviceId;
    }
  }
  return composeServiceName;
}

/**
 * Decrypt one clone credential.
 *
 * Goes through the caller's `decryptSecrets` seam, which `deploy-environment.ts`
 * wraps with `captureDecryptedSecrets` — so the token joins the transcript
 * deny-set *before* git ever runs, and a git error that echoes the remote is
 * redacted rather than leaked.
 */
async function decryptCloneCredential(
  envelope: string | undefined,
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<string | undefined> {
  if (!envelope) return undefined;
  if (!decryptSecrets) {
    throw new Error(
      "sourceMaterial carries a clone credential but secrets decrypt is unavailable",
    );
  }
  const [plaintext] = await decryptSecrets([envelope]);
  if (!plaintext) throw new Error("clone credential could not be decrypted");
  return plaintext;
}

/** The `nativeAppServices[]` row for one compose service, when it has one. */
function nativeAppForService(
  payload: EnvironmentDeployPayload,
  composeServiceName: string,
) {
  return (payload.nativeAppServices ?? []).find(
    (app) => app.composeServiceName === composeServiceName,
  );
}

export type ApplySourceReleasesDeps = {
  logSink: CommandOutputSink;
  decryptSecrets: DecryptSecretsFn | undefined;
  /** Privileged runner seam (`sudo -n …`); tests inject a fake. */
  runFn?: RunFn;
  /** ISO timestamp stamped on each release manifest. */
  now?: () => string;
  /** Test seam — defaults to {@link checkoutRelease}. */
  checkoutReleaseFn?: typeof checkoutRelease;
  /** Test seam — defaults to {@link runReleaseBuild}. */
  runReleaseBuildFn?: typeof runReleaseBuild;
  /** Test seam — defaults to {@link prepareNativeAppBuildOutput}. */
  prepareNativeAppBuildOutputFn?: typeof prepareNativeAppBuildOutput;
  /** Test seam — defaults to {@link promoteRelease}. */
  promoteReleaseFn?: typeof promoteRelease;
  /** Test seam — defaults to {@link promoteExistingRelease}. */
  promoteExistingReleaseFn?: typeof promoteExistingRelease;
  /** Test seam — defaults to {@link pruneReleases}. */
  pruneReleasesFn?: typeof pruneReleases;
  /** Test seam — defaults to {@link recordRailpackRelease}. */
  recordRailpackReleaseFn?: typeof recordRailpackRelease;
  /** Test seam — defaults to {@link runRailpackBuild}. */
  runRailpackBuildFn?: typeof runRailpackBuild;
  /** Test seam — defaults to {@link ensureBuildkitRailpack}. */
  ensureBuildkitRailpackFn?: typeof ensureBuildkitRailpack;
  /** Test seam — defaults to {@link ensureReleaseTree}. */
  ensureReleaseTreeFn?: typeof ensureReleaseTree;
  /** Test seam — defaults to {@link ensureDaemonReleaseRecordDir}. */
  ensureDaemonReleaseRecordDirFn?: typeof ensureDaemonReleaseRecordDir;
  /**
   * Whether native builds run in the build sandbox. Defaults to
   * {@link buildSandboxEnabled} (every managed host).
   */
  sandboxedBuilds?: boolean;
  /** Test seam — the root-owned facts {@link buildSandboxEnabled} checks. */
  buildSandboxMarkers?: BuildSandboxMarkers;
  /** Test seam — the build-user role's tree (`/var/lib/turbopanel-build`). */
  buildSandboxRoot?: string;
};

/**
 * Promote an already-published release for one service — the rollback lane.
 *
 * Deliberately *not* a variation threaded through the build path: it must not
 * run `ensureReleaseTree` (which would repair the sealed release directory back
 * to staging mode and hand the runtime user a writable copy of the code it is
 * running), must not touch the scratch dir, and emits no `fetch` / `build`
 * phase lines because neither happened. What it does share is everything after
 * the promote — the same {@link AppliedRelease} shape, so the native-app apply,
 * `deployment.json`, and retention consume a rollback exactly as they consume a
 * fresh deploy.
 *
 * The commit and the build-output shape come from the daemon-owned record of
 * the target release ({@link resolveRollbackTarget}) rather than from the
 * payload: the payload's `commitSha` is a wire-shape placeholder on a rollback,
 * and what the result has to report is which commit — and which runtime lane —
 * is now live. Nothing is read back out of the principal's tree, which its
 * owner can rewrite.
 */
async function rollbackOneRelease(
  entry: EnvironmentDeploySource,
  target: RollbackTarget,
  params: {
    serviceId: string;
    releaseId: string;
    logSink: CommandOutputSink;
    deps: ApplySourceReleasesDeps;
  },
): Promise<AppliedRelease> {
  const { logSink, deps } = params;
  const { paths, manifest: recordedManifest } = target;
  logSink.setPhase(COMMAND_LOG_PHASES.RELEASE_PROMOTE);
  const previousReleaseId = await readCurrentReleaseId(paths, deps.runFn);

  // A Railpack release published no tree, so there is no sealed directory to
  // validate and no `current` to swap: the daemon record *is* the rollback.
  // Deciding from the record rather than from `entry.build.kind` is deliberate
  // — what matters is how the release being restored was built, not what the
  // payload asks for now, so flipping a service's build mode never breaks
  // rollback to a release from before the switch.
  if (recordedManifest.imageTag) {
    logSink.onLine(
      "stdout",
      `rolled ${entry.composeServiceName} back to release ${params.releaseId} ` +
        `(image ${recordedManifest.imageTag})`,
    );
    return {
      composeServiceName: entry.composeServiceName,
      serviceId: params.serviceId,
      releaseId: params.releaseId,
      commitSha: recordedManifest.commitSha,
      ...(recordedManifest.commitMessage === undefined
        ? {}
        : { commitMessage: recordedManifest.commitMessage }),
      ...(recordedManifest.commitAuthor === undefined
        ? {}
        : { commitAuthor: recordedManifest.commitAuthor }),
      releaseDir: paths.releaseDir,
      imageTag: recordedManifest.imageTag,
      ...(recordedManifest.imageDigest === undefined
        ? {}
        : { imageDigest: recordedManifest.imageDigest }),
      ...(recordedManifest.railpackFrontendVersion === undefined ? {} : {
        railpackFrontendVersion: recordedManifest.railpackFrontendVersion,
      }),
      ...(recordedManifest.railpackPlanVersion === undefined
        ? {}
        : { railpackPlanVersion: recordedManifest.railpackPlanVersion }),
      previousReleaseId,
      standaloneOutput: false,
      staticExport: false,
    };
  }

  const releaseDir =
    await (deps.promoteExistingReleaseFn ?? promoteExistingRelease)({
      paths,
      releaseId: params.releaseId,
      ...(deps.runFn === undefined ? {} : { runFn: deps.runFn }),
    });
  logSink.onLine(
    "stdout",
    `rolled ${entry.composeServiceName} back to release ${params.releaseId} ` +
      `(${recordedManifest.commitSha})`,
  );

  // The daemon's record of the target release is the authority on what is now
  // live; the payload only carries a stored copy of it for the control plane's
  // benefit, and carries nothing at all for metadata recorded before it existed.
  const commitMessage = recordedManifest.commitMessage ?? entry.commitMessage;
  const commitAuthor = recordedManifest.commitAuthor ?? entry.commitAuthor;

  return {
    composeServiceName: entry.composeServiceName,
    serviceId: params.serviceId,
    releaseId: params.releaseId,
    commitSha: recordedManifest.commitSha,
    ...(commitMessage === undefined ? {} : { commitMessage }),
    ...(commitAuthor === undefined ? {} : { commitAuthor }),
    releaseDir,
    previousReleaseId,
    // The runtime lane a rollback restores is the one the original promote
    // established, so both come off that release's own manifest rather than
    // being re-derived (nothing was built here to derive them from). A
    // pre-manifest-field release reads back as `false`, which is the behavior
    // those releases already had.
    standaloneOutput: recordedManifest.standaloneOutput ?? false,
    staticExport: recordedManifest.staticExport ?? false,
  };
}

/**
 * Build one Railpack release: checkout → image → manifest.
 *
 * Everything the native lane does after the build is deliberately *not* done
 * here. There is no tree to stage, seal, or link `shared` into, and no `current`
 * symlink to swap — the cutover is `docker compose up` picking up the new
 * `image:` tag that {@link AppliedRelease.imageTag} carries back to
 * `deploy-environment.ts`. What is kept is the per-release manifest, so both
 * lanes' history lives in one place and rollback can restore this release by
 * re-running its tag instead of re-cloning and rebuilding.
 *
 * The scratch checkout is removed in the caller's `finally`, exactly as on the
 * native lane — a clone never lands anywhere but scratch.
 */
async function applyRailpackRelease(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  entry: EnvironmentDeploySource,
  paths: ReleasePaths,
  params: {
    serviceId: string;
    buildWorkingDir: string;
    commitSha: string;
    deps: ApplySourceReleasesDeps;
    onOutput: ReleaseOutputHandler;
  },
): Promise<AppliedRelease> {
  const { deps, onOutput, serviceId } = params;
  const { logSink } = deps;

  const tools = await (deps.ensureBuildkitRailpackFn ?? ensureBuildkitRailpack)(
    layout,
  );
  const imageTag = railpackImageTag(serviceId, entry.releaseId);
  const built = await (deps.runRailpackBuildFn ?? runRailpackBuild)({
    build: entry.build,
    workingDir: params.buildWorkingDir,
    scratchDir: paths.scratchDir,
    cacheKey: railpackCacheKey(payload.projectId),
    imageTag,
    tools,
    onOutput,
    redactSummary: (text) => logSink.redactSummary(text),
  });

  logSink.setPhase(COMMAND_LOG_PHASES.RELEASE_PROMOTE);
  const manifest: ReleaseManifestV1 = {
    version: 1,
    serviceId,
    composeServiceName: entry.composeServiceName,
    releaseId: entry.releaseId,
    sourceId: entry.sourceId,
    commitSha: params.commitSha,
    ...(entry.commitMessage === undefined
      ? {}
      : { commitMessage: entry.commitMessage }),
    ...(entry.commitAuthor === undefined
      ? {}
      : { commitAuthor: entry.commitAuthor }),
    ref: entry.ref,
    promotedAt: (deps.now ?? (() => new Date().toISOString()))(),
    imageTag: built.imageTag,
    ...(built.imageDigest === undefined
      ? {}
      : { imageDigest: built.imageDigest }),
    railpackFrontendVersion: built.railpackFrontendVersion,
    railpackPlanVersion: built.railpackPlanVersion,
  };
  const releaseDir =
    await (deps.recordRailpackReleaseFn ?? recordRailpackRelease)({
      paths,
      manifest,
    });
  logSink.onLine(
    "stdout",
    `built release ${entry.releaseId} (${params.commitSha}) for ${entry.composeServiceName} as ${built.imageTag}`,
  );

  const pruned = await (deps.pruneReleasesFn ?? pruneReleases)({
    paths,
    onOutput,
    ...(deps.runFn === undefined ? {} : { runFn: deps.runFn }),
  });
  if (pruned.length > 0) {
    logSink.onLine("stdout", `pruned ${pruned.length} superseded release(s)`);
  }

  return {
    composeServiceName: entry.composeServiceName,
    serviceId,
    releaseId: entry.releaseId,
    commitSha: params.commitSha,
    ...(entry.commitMessage === undefined
      ? {}
      : { commitMessage: entry.commitMessage }),
    ...(entry.commitAuthor === undefined
      ? {}
      : { commitAuthor: entry.commitAuthor }),
    releaseDir,
    imageTag: built.imageTag,
    ...(built.imageDigest === undefined
      ? {}
      : { imageDigest: built.imageDigest }),
    railpackFrontendVersion: built.railpackFrontendVersion,
    railpackPlanVersion: built.railpackPlanVersion,
    // A Railpack release never moved `current`, so there is nothing for the
    // native-runtime apply to roll back to — and nothing that would supervise
    // it if there were.
    previousReleaseId: null,
    standaloneOutput: false,
    staticExport: false,
  };
}

/** What a rollback restores: the release paths and the daemon's record of it. */
type RollbackTarget = { paths: ReleasePaths; manifest: ReleaseManifestV1 };

/**
 * The release a rollback is addressing, as this host's daemon recorded it.
 *
 * Every published release — native or Railpack — leaves a manifest under the
 * daemon-owned record root ({@link resolveDaemonReleasePaths}), and that record
 * is the **only** thing a rollback trusts. The copy inside a native release
 * tree lives in the principal's home, which the principal owns and can
 * rearrange, so neither the lane (`imageTag`) nor the commit is ever taken from
 * it. A release with no record — one published before records were kept, or on
 * another host — fails here with the fix spelled out, rather than falling back
 * to that tree.
 *
 * The record also identifies the lane: an `imageTag` means a Railpack release,
 * restored from the record root itself; anything else is a native tree in the
 * principal home (`null` when there is no principal to own one).
 */
async function resolveRollbackTarget(
  layout: LayoutPaths,
  params: {
    composeServiceName: string;
    serviceId: string;
    releaseId: string;
    principalPaths: ReleasePaths | null;
  },
): Promise<RollbackTarget | null> {
  const recordPaths = resolveDaemonReleasePaths(layout, {
    serviceId: params.serviceId,
    releaseId: params.releaseId,
  });
  const manifest = await readReleaseManifest(recordPaths.releaseDir);
  const matches = manifest?.serviceId === params.serviceId &&
    manifest.releaseId === params.releaseId;
  if (!manifest || !matches) {
    throw new Error(
      `cannot roll ${params.composeServiceName} back to release ` +
        `${params.releaseId}: this host has no release record for it — ` +
        `redeploy that release instead`,
    );
  }
  if (manifest.imageTag) return { paths: recordPaths, manifest };
  return params.principalPaths
    ? { paths: params.principalPaths, manifest }
    : null;
}

/**
 * Record a promoted native release under the daemon-owned record root, so a
 * later rollback can restore it without reading the principal's tree.
 *
 * Written only after the promote succeeded — the record is this host's
 * statement that the release was sealed and published. The cutover has already
 * happened by then, so a failure is reported rather than failing a deploy that
 * is live; a rollback to this release then says its record is missing.
 */
async function recordNativeRelease(
  layout: LayoutPaths,
  manifest: ReleaseManifestV1,
  deps: ApplySourceReleasesDeps,
): Promise<void> {
  const recordPaths = resolveDaemonReleasePaths(layout, {
    serviceId: manifest.serviceId,
    releaseId: manifest.releaseId,
  });
  try {
    await (deps.ensureDaemonReleaseRecordDirFn ?? ensureDaemonReleaseRecordDir)(
      recordPaths,
    );
    await writeReleaseManifest(recordPaths.releaseDir, manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logSink.onLine(
      "stderr",
      `release ${manifest.releaseId} is live but its rollback record could not be written: ${message}`,
    );
  }
}

/** Clone one release's source into its scratch dir — identical on both lanes. */
async function checkoutForEntry(
  entry: EnvironmentDeploySource,
  paths: ReleasePaths,
  deps: ApplySourceReleasesDeps,
  onOutput: ReleaseOutputHandler,
  checkoutDir?: string,
) {
  const credential = await decryptCloneCredential(
    entry.credential,
    deps.decryptSecrets,
  );
  return await (deps.checkoutReleaseFn ?? checkoutRelease)(definedFields({
    cloneUrl: entry.cloneUrl,
    ref: entry.ref,
    commitSha: entry.commitSha,
    scratchDir: paths.scratchDir,
    checkoutDir,
    onOutput,
    redactSummary: (text: string) => deps.logSink.redactSummary(text),
    credential,
    // An SSH deploy key and an HTTPS token are handed to git in completely
    // different ways; the control plane tags which one this is.
    credentialKind: entry.credentialKind,
    // The username half of an HTTPS credential, when the control plane's
    // provider named one. Carried through opaquely — the checkout prints it,
    // nothing here reads it.
    credentialUsername: entry.credentialUsername,
  }));
}

/** Where the build runs: the checkout root, or the declared subdirectory in it. */
function buildWorkingDirFor(
  entry: EnvironmentDeploySource,
  workingDir: string,
): string {
  return entry.subdirectory
    ? `${workingDir}/${entry.subdirectory}`
    : workingDir;
}

/**
 * The Railpack lane: check out, then build an OCI image. It publishes no
 * filesystem tree, so the record root is daemon-owned and the scratch dir is
 * the only thing to clean up.
 */
async function buildRailpackRelease(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  entry: EnvironmentDeploySource,
  paths: ReleasePaths,
  params: {
    serviceId: string;
    deps: ApplySourceReleasesDeps;
    onOutput: ReleaseOutputHandler;
  },
): Promise<AppliedRelease> {
  const { deps, onOutput, serviceId } = params;
  const { logSink } = deps;

  await (deps.ensureDaemonReleaseRecordDirFn ?? ensureDaemonReleaseRecordDir)(
    paths,
  );
  await resetReleaseScratchDir(paths);
  try {
    logSink.setPhase(COMMAND_LOG_PHASES.FETCH);
    const checkout = await checkoutForEntry(entry, paths, deps, onOutput);

    // Same `build` phase the native lane uses — an operator reading the
    // transcript should not have to learn a second phase name to find out why
    // their image did not build.
    logSink.setPhase(COMMAND_LOG_PHASES.BUILD);
    return await applyRailpackRelease(layout, payload, entry, paths, {
      serviceId,
      buildWorkingDir: buildWorkingDirFor(entry, checkout.workingDir),
      commitSha: checkout.commitSha,
      deps,
      onOutput,
    });
  } finally {
    await removeReleaseScratchDir(paths);
  }
}

/**
 * The native lane: check out, build, then promote a directory release into the
 * project principal's home and prune what it superseded.
 */
async function buildNativeRelease(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  entry: EnvironmentDeploySource,
  paths: ReleasePaths,
  params: {
    serviceId: string;
    username: string;
    deps: ApplySourceReleasesDeps;
    onOutput: ReleaseOutputHandler;
  },
): Promise<AppliedRelease> {
  const { deps, onOutput, serviceId, username } = params;
  const { logSink } = deps;

  await (deps.ensureReleaseTreeFn ?? ensureReleaseTree)(
    paths,
    username,
    deps.runFn,
  );
  await resetReleaseScratchDir(paths);
  let work: BuildWork | null = null;
  try {
    work = await prepareBuildWork(payload, entry, serviceId, deps);
    logSink.setPhase(COMMAND_LOG_PHASES.FETCH);
    const checkout = await checkoutForEntry(
      entry,
      paths,
      deps,
      onOutput,
      work?.checkoutDir,
    );

    logSink.setPhase(COMMAND_LOG_PHASES.BUILD);
    if (work) await assertCheckoutCredentialsRemoved(paths.scratchDir);
    const nativeOutput = await buildNativeTree(layout, payload, entry, {
      checkout,
      work,
      deps,
      onOutput,
    });

    logSink.setPhase(COMMAND_LOG_PHASES.RELEASE_PROMOTE);
    const previousReleaseId = await readCurrentReleaseId(paths, deps.runFn);
    const manifest: ReleaseManifestV1 = definedFields({
      version: 1,
      serviceId,
      composeServiceName: entry.composeServiceName,
      releaseId: entry.releaseId,
      sourceId: entry.sourceId,
      commitSha: checkout.commitSha,
      commitMessage: entry.commitMessage,
      commitAuthor: entry.commitAuthor,
      ref: entry.ref,
      promotedAt: (deps.now ?? (() => new Date().toISOString()))(),
      // Recorded so a rollback to this release restores the same runtime lane
      // without rebuilding — see `ReleaseManifestV1`.
      standaloneOutput: nativeOutput.standaloneOutput,
      staticExport: nativeOutput.staticExport,
    });
    const releaseDir = await (deps.promoteReleaseFn ?? promoteRelease)(
      definedFields({
        paths,
        workingDir: checkout.workingDir,
        username,
        manifest,
        subdirectory: entry.subdirectory,
        outputDirectory: entry.build.outputDirectory ??
          nativeOutput.outputDirectory,
        containmentRoot: work?.workDir,
        runFn: deps.runFn,
      }),
    );
    logSink.onLine(
      "stdout",
      `promoted release ${entry.releaseId} (${checkout.commitSha}) for ${entry.composeServiceName}`,
    );
    await recordNativeRelease(layout, manifest, deps);

    const pruned = await (deps.pruneReleasesFn ?? pruneReleases)(definedFields({
      paths,
      onOutput,
      runFn: deps.runFn,
    }));
    if (pruned.length > 0) {
      logSink.onLine("stdout", `pruned ${pruned.length} superseded release(s)`);
    }

    return definedFields({
      composeServiceName: entry.composeServiceName,
      serviceId,
      releaseId: entry.releaseId,
      commitSha: checkout.commitSha,
      commitMessage: entry.commitMessage,
      commitAuthor: entry.commitAuthor,
      releaseDir,
      previousReleaseId,
      standaloneOutput: nativeOutput.standaloneOutput,
      staticExport: nativeOutput.staticExport,
    });
  } finally {
    if (work) await removeBuildWork(work, onOutput);
    await removeReleaseScratchDir(paths);
  }
}

/**
 * The sandbox work tree for a native build, created empty for the clone, or
 * `null` where builds run unsandboxed (a development install).
 */
async function prepareBuildWork(
  payload: EnvironmentDeployPayload,
  entry: EnvironmentDeploySource,
  serviceId: string,
  deps: ApplySourceReleasesDeps,
): Promise<BuildWork | null> {
  const sandboxed = deps.sandboxedBuilds ??
    await buildSandboxEnabled(deps.buildSandboxMarkers);
  if (!sandboxed) return null;
  await sweepStaleBuildWork(deps.buildSandboxRoot, {
    runFn: deps.runFn,
    onOutput: (stream, line) => deps.logSink.onLine(stream, line),
  });
  const work = await resolveBuildWork(
    { serviceId, releaseId: entry.releaseId, projectId: payload.projectId },
    deps.buildSandboxRoot,
  );
  await createBuildWorkDir(work, deps.runFn);
  return work;
}

/**
 * Run the build (sandboxed when `work` is set), then decide what the release
 * payload is. Only after the sandbox handed the tree back does anything here
 * read it.
 */
async function buildNativeTree(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  entry: EnvironmentDeploySource,
  params: {
    checkout: CheckoutResult;
    work: BuildWork | null;
    deps: ApplySourceReleasesDeps;
    onOutput: ReleaseOutputHandler;
  },
): Promise<NativeAppBuildOutput> {
  const { checkout, work, deps, onOutput } = params;
  const nativeApp = nativeAppForService(payload, entry.composeServiceName);
  const buildWorkingDir = buildWorkingDirFor(entry, checkout.workingDir);
  await (deps.runReleaseBuildFn ?? runReleaseBuild)(definedFields({
    build: entry.build,
    workingDir: buildWorkingDir,
    // A native app builds with its own runtime on PATH and its declared
    // NODE_ENV, so the derived install command and the build both run on
    // the series the app will execute on.
    nativeRuntime: nativeApp
      ? definedFields({
        nodeBinDir: dirname(nativeAppNodeBinary(
          layout,
          resolveNativeAppNodeVersion(nativeApp),
        )),
        nodeEnv: nativeApp.appMode ?? "production",
        runtimeGroup: nativeAppRuntimeGroup(
          resolveNativeAppNodeVersion(nativeApp),
        ),
      })
      : undefined,
    sandbox: work
      ? definedFields({
        work,
        cwd: buildSpecCwd(entry.subdirectory),
        runFn: deps.runFn,
      })
      : undefined,
    onOutput,
    redactSummary: (text: string) => deps.logSink.redactSummary(text),
  }));

  // An operator-declared `outputDirectory` always wins: they said where the
  // payload is, and second-guessing that would make the field a suggestion.
  if (!nativeApp || entry.build.outputDirectory !== undefined) {
    return { standaloneOutput: false, staticExport: false };
  }
  return await (deps.prepareNativeAppBuildOutputFn ??
    prepareNativeAppBuildOutput)(definedFields({
      framework: nativeApp.framework,
      workingDir: buildWorkingDir,
      containmentRoot: work?.workDir,
      onOutput,
    }));
}

async function applyOneRelease(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  entry: EnvironmentDeploySource,
  deps: ApplySourceReleasesDeps,
): Promise<AppliedRelease | null> {
  const { logSink } = deps;
  const onOutput: ReleaseOutputHandler = (stream, line) =>
    logSink.onLine(stream, line);

  const railpack = entry.build.kind === "railpack";
  const principal = entry.principal;

  // Without a project principal there is no home to publish a release into.
  // Skip loudly rather than inventing an owner — ownership is assigned in the
  // control plane, not guessed on the host.
  //
  // The Railpack lane is exempt, and deliberately so: it publishes an OCI image
  // and no filesystem tree, so there is nothing for a Unix account to own. The
  // built image runs as an ordinary container under whatever service-level
  // limits already apply to it, and refusing to build one because nobody
  // assigned a host account it would never use would be a guard protecting
  // nothing.
  if (!principal && !railpack) {
    logSink.onLine(
      "stderr",
      `release skipped for ${entry.composeServiceName}: no project principal assigned`,
    );
    return null;
  }

  const serviceId = resolveReleaseServiceId(payload, entry.composeServiceName);
  // A rollback addresses the tree it is rolling back *to*, not the id the
  // control plane would have allocated for a fresh build.
  const targetReleaseId = entry.rollbackToReleaseId ?? entry.releaseId;
  const principalPaths = principal
    ? resolveReleasePaths(layout, {
      username: principal.username,
      serviceId,
      releaseId: targetReleaseId,
    })
    : null;
  // Railpack history is always daemon-owned, principal or not: one service must
  // not move its release history between two roots because an unrelated
  // ownership assignment changed.
  const paths = railpack
    ? resolveDaemonReleasePaths(layout, {
      serviceId,
      releaseId: targetReleaseId,
    })
    : principalPaths;

  if (entry.rollbackToReleaseId) {
    const rollbackTarget = await resolveRollbackTarget(layout, {
      composeServiceName: entry.composeServiceName,
      serviceId,
      releaseId: entry.rollbackToReleaseId,
      principalPaths,
    });
    if (!rollbackTarget) {
      logSink.onLine(
        "stderr",
        `rollback skipped for ${entry.composeServiceName}: no project principal assigned`,
      );
      return null;
    }
    return await rollbackOneRelease(entry, rollbackTarget, {
      serviceId,
      releaseId: entry.rollbackToReleaseId,
      logSink,
      deps,
    });
  }

  if (!paths) {
    // Unreachable — the guard above returns for a native entry with no
    // principal, and the Railpack branch always resolves a record root.
    throw new Error(
      `release for ${entry.composeServiceName} has no release paths`,
    );
  }

  if (railpack) {
    return await buildRailpackRelease(layout, payload, entry, paths, {
      serviceId,
      deps,
      onOutput,
    });
  }

  if (!principal) {
    // Unreachable — the native lane's principal guard returned above.
    throw new Error(
      `release for ${entry.composeServiceName} lost its principal`,
    );
  }
  return await buildNativeRelease(layout, payload, entry, paths, {
    serviceId,
    username: principal.username,
    deps,
    onOutput,
  });
}

/**
 * Apply every `sourceMaterial[]` entry, in payload order. A failure fails the
 * deploy: a release that could not be built is not something to proceed past
 * quietly. Entries with no owning principal are skipped, not failed.
 */
export async function applySourceReleases(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  deps: ApplySourceReleasesDeps,
): Promise<AppliedRelease[]> {
  const material = payload.sourceMaterial ?? [];
  if (material.length === 0) return [];

  const applied: AppliedRelease[] = [];
  // Builds run one at a time, in payload order, stopping at the first failure.
  await forEachSequential(material, async (entry) => {
    const result = await applyOneRelease(layout, payload, entry, deps);
    if (result) applied.push(result);
  });
  return applied;
}
