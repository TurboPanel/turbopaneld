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
 * the traditional-web static lane instead of a systemd unit) belongs to the
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
} from "../../instance/commands/contracts.ts";
import type { DecryptSecretsFn } from "../materialize-tls.ts";
import type { RunFn } from "../ensure-principal.ts";
import { checkoutRelease, type ReleaseOutputHandler } from "./checkout.ts";
import { prepareNativeAppBuildOutput, runReleaseBuild } from "./build.ts";
import {
  ensureBuildkitRailpack,
  railpackCacheDir,
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
import { definedFields } from "../../optional-fields.ts";
import {
  readReleaseManifest,
  type ReleaseManifestV1,
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
   * `nativeAppServices[]` and onto the traditional-web static lane — there is no
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
 * The commit and the build-output shape are read back from the target release's
 * own `.turbopanel/release.json` rather than from the payload: the payload's
 * `commitSha` is a wire-shape placeholder on a rollback, and what the result has
 * to report is which commit — and which runtime lane — is now live.
 */
async function rollbackOneRelease(
  entry: EnvironmentDeploySource,
  paths: ReleasePaths,
  params: {
    serviceId: string;
    releaseId: string;
    logSink: CommandOutputSink;
  },
): Promise<AppliedRelease> {
  const { logSink } = params;
  logSink.setPhase(COMMAND_LOG_PHASES.RELEASE_PROMOTE);
  const previousReleaseId = await readCurrentReleaseId(paths);

  // A Railpack release published no tree, so there is no sealed directory to
  // validate and no `current` to swap: the manifest read straight off the
  // record directory *is* the rollback. Deciding from the manifest rather than
  // from `entry.build.kind` is deliberate — what matters is how the release
  // being restored was built, not what the payload asks for now, so flipping a
  // service's build mode never breaks rollback to a release from before the
  // switch.
  const recordedManifest = await readReleaseManifest(paths.releaseDir);
  if (recordedManifest?.imageTag) {
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

  const releaseDir = await promoteExistingRelease({
    paths,
    releaseId: params.releaseId,
  });
  const manifest = await readReleaseManifest(releaseDir);
  logSink.onLine(
    "stdout",
    `rolled ${entry.composeServiceName} back to release ${params.releaseId}` +
      (manifest ? ` (${manifest.commitSha})` : ""),
  );

  // The target release's own manifest is the authority on what is now live; the
  // payload only carries a stored copy of it for the control plane's benefit,
  // and carries nothing at all for a release published before this metadata
  // existed.
  const commitMessage = manifest?.commitMessage ?? entry.commitMessage;
  const commitAuthor = manifest?.commitAuthor ?? entry.commitAuthor;

  return {
    composeServiceName: entry.composeServiceName,
    serviceId: params.serviceId,
    releaseId: params.releaseId,
    commitSha: manifest?.commitSha ?? entry.commitSha,
    ...(commitMessage === undefined ? {} : { commitMessage }),
    ...(commitAuthor === undefined ? {} : { commitAuthor }),
    releaseDir,
    previousReleaseId,
    // The runtime lane a rollback restores is the one the original promote
    // established, so both come off that release's own manifest rather than
    // being re-derived (nothing was built here to derive them from). A
    // pre-manifest-field release reads back as `false`, which is the behavior
    // those releases already had.
    standaloneOutput: manifest?.standaloneOutput ?? false,
    staticExport: manifest?.staticExport ?? false,
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

  const tools = await ensureBuildkitRailpack(layout);
  const imageTag = railpackImageTag(serviceId, entry.releaseId);
  const built = await runRailpackBuild({
    build: entry.build,
    workingDir: params.buildWorkingDir,
    scratchDir: paths.scratchDir,
    cacheDir: railpackCacheDir(layout, payload.projectId),
    imageTag,
    tools,
    layout,
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
  const releaseDir = await recordRailpackRelease({ paths, manifest });
  logSink.onLine(
    "stdout",
    `built release ${entry.releaseId} (${params.commitSha}) for ${entry.composeServiceName} as ${built.imageTag}`,
  );

  const pruned = await pruneReleases({
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

/**
 * Which root holds the release a rollback is addressing.
 *
 * A Railpack release's history lives in the daemon-owned record root and a
 * native one's in the principal home, and the payload cannot say which: a
 * service that switched build modes since must still be able to roll back to a
 * release built the old way. So the record root is probed first and the
 * principal home is the fallback — the release that actually exists identifies
 * its own lane.
 */
async function resolveRollbackPaths(
  layout: LayoutPaths,
  params: {
    serviceId: string;
    releaseId: string;
    principalPaths: ReleasePaths | null;
  },
): Promise<ReleasePaths | null> {
  const recordPaths = resolveDaemonReleasePaths(layout, {
    serviceId: params.serviceId,
    releaseId: params.releaseId,
  });
  const recorded = await readReleaseManifest(recordPaths.releaseDir);
  if (recorded?.imageTag) return recordPaths;
  return params.principalPaths;
}

/** Clone one release's source into its scratch dir — identical on both lanes. */
async function checkoutForEntry(
  entry: EnvironmentDeploySource,
  paths: ReleasePaths,
  deps: ApplySourceReleasesDeps,
  onOutput: ReleaseOutputHandler,
) {
  const credential = await decryptCloneCredential(
    entry.credential,
    deps.decryptSecrets,
  );
  return await checkoutRelease(definedFields({
    cloneUrl: entry.cloneUrl,
    ref: entry.ref,
    commitSha: entry.commitSha,
    scratchDir: paths.scratchDir,
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

  await ensureDaemonReleaseRecordDir(paths);
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

  await ensureReleaseTree(paths, username, deps.runFn);
  await resetReleaseScratchDir(paths);
  try {
    logSink.setPhase(COMMAND_LOG_PHASES.FETCH);
    const checkout = await checkoutForEntry(entry, paths, deps, onOutput);

    logSink.setPhase(COMMAND_LOG_PHASES.BUILD);
    const buildWorkingDir = buildWorkingDirFor(entry, checkout.workingDir);
    await runReleaseBuild({
      build: entry.build,
      workingDir: buildWorkingDir,
      onOutput,
      redactSummary: (text) => logSink.redactSummary(text),
    });

    // An operator-declared `outputDirectory` always wins: they said where the
    // payload is, and second-guessing that would make the field a suggestion.
    const nativeApp = nativeAppForService(payload, entry.composeServiceName);
    const nativeOutput = nativeApp && entry.build.outputDirectory === undefined
      ? await prepareNativeAppBuildOutput({
        framework: nativeApp.framework,
        workingDir: buildWorkingDir,
        onOutput,
      })
      : {
        standaloneOutput: false as boolean,
        staticExport: false as boolean,
        outputDirectory: undefined,
      };

    logSink.setPhase(COMMAND_LOG_PHASES.RELEASE_PROMOTE);
    const previousReleaseId = await readCurrentReleaseId(paths);
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
    const releaseDir = await promoteRelease(definedFields({
      paths,
      workingDir: checkout.workingDir,
      username,
      manifest,
      subdirectory: entry.subdirectory,
      outputDirectory: entry.build.outputDirectory ??
        nativeOutput.outputDirectory,
      runFn: deps.runFn,
    }));
    logSink.onLine(
      "stdout",
      `promoted release ${entry.releaseId} (${checkout.commitSha}) for ${entry.composeServiceName}`,
    );

    const pruned = await pruneReleases(definedFields({
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
    await removeReleaseScratchDir(paths);
  }
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
    const rollbackPaths = await resolveRollbackPaths(layout, {
      serviceId,
      releaseId: entry.rollbackToReleaseId,
      principalPaths,
    });
    if (!rollbackPaths) {
      logSink.onLine(
        "stderr",
        `rollback skipped for ${entry.composeServiceName}: no project principal assigned`,
      );
      return null;
    }
    return await rollbackOneRelease(entry, rollbackPaths, {
      serviceId,
      releaseId: entry.rollbackToReleaseId,
      logSink,
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
  return await buildNativeRelease(payload, entry, paths, {
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
  for (const entry of material) {
    const result = await applyOneRelease(layout, payload, entry, deps);
    if (result) applied.push(result);
  }
  return applied;
}
