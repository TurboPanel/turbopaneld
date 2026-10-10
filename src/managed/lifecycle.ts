/**
 * Managed engine lifecycle: start / stop / restart.
 *
 * Status in the result is derived from observed `docker compose ps` state —
 * never from the requested action.
 */

import type {
  EnvironmentDeployContainer,
  ManagedLifecyclePayload,
  ManagedLifecycleResult,
} from "../contracts/commands-contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  collectManagedContainers,
  collectManagedMemberHealth,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import {
  managedComposePath,
  managedComposeProject,
  managedDir,
  SAFE_MANAGED_ID_RE,
} from "./engine-paths.ts";
import { readManagedComposeDataTarget } from "./compose.ts";
import {
  clearManagedDemotedMarker,
  isManagedMemberDemoted,
  writeManagedDemotedMarker,
} from "./demoted-marker.ts";
import {
  captureSwitchoverGtidBeforeStop,
  reactivatePrimaryAfterSwitchoverAbort,
} from "./lifecycle-switchover.ts";
import {
  buildNeedsResyncMember,
  stopManagedProjectForResync,
} from "./needs-resync.ts";
import {
  clearDemotedVolumeFence,
  persistDemotedVolumeFence,
} from "./demoted-fence-volume.ts";
import {
  enforceFencedMemberIfRunning,
  isFencedMemberStillWritable,
} from "./fenced-member-enforce.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;
type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type ManagedLifecycleHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
  /** Test seam — defaults to real docker setup. */
  ensureDocker?: () => Promise<void>;
};

function statusFromContainers(
  containers: EnvironmentDeployContainer[],
): "ready" | "stopped" | "failed" {
  if (containers.length === 0) return "stopped";
  const states = containers.map((c) => c.status.toLowerCase());
  if (states.every((s) => s === "running")) return "ready";
  if (states.every((s) => s === "exited" || s === "dead" || s === "stopped")) {
    return "stopped";
  }
  if (states.includes("running")) return "ready";
  return "failed";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory || stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function readReplicaComposeTarget(
  layout: LayoutPaths,
  managedId: string,
): Promise<ReturnType<typeof readManagedComposeDataTarget>> {
  let composeYaml: string;
  try {
    composeYaml = await Deno.readTextFile(
      managedComposePath(layout, managedId),
    );
  } catch (err) {
    throw new Error(
      `managed.lifecycle cannot verify standby data: compose file unreadable (${
        sanitizeForLog(err instanceof Error ? err.message : String(err))
      })`,
    );
  }
  const target = readManagedComposeDataTarget(composeYaml);
  if (target.volumes.length === 0) {
    throw new Error(
      "managed.lifecycle cannot verify standby data: no data volume in compose",
    );
  }
  return target;
}

/**
 * A member recorded as a replica must never start from data that is not a
 * standby (e.g. a former primary demoted by failover): it would come up as a
 * second writable primary. Mirrors the `managed.apply` needs_resync guard —
 * stop the project and report needs_resync instead of starting it. Returns
 * `undefined` when start/restart may proceed.
 */
/**
 * A demoted (fenced) member must never be started writable. Refuse panel-driven
 * start/restart; switchover-abort reactivation is the only exception.
 */
async function refuseDemotedMemberStart(
  payload: ManagedLifecyclePayload,
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<ManagedLifecycleResult | undefined> {
  if (payload.action === "stop") return undefined;
  if (payload.reactivateAfterSwitchoverAbort === true) return undefined;
  if (
    !(await isManagedMemberDemoted(
      layout,
      payload.managedId,
      payload.memberId,
    ))
  ) {
    return undefined;
  }

  const redact = (text: string) => sanitizeForLog(text);
  const engine = payload.engine ?? "postgres";
  await persistDemotedVolumeFence(layout, payload.managedId, engine, run);
  await enforceFencedMemberIfRunning(layout, payload.managedId, engine, run);
  await stopManagedProjectForResync(payload.managedId, redact, run);
  return {
    status: "needs_resync",
    summary:
      `managed ${payload.action} refused: member is fenced (needs resync)`,
    ...(payload.memberId
      ? { member: buildNeedsResyncMember(payload.memberId) }
      : {}),
  };
}

async function refuseNonStandbyReplicaStart(
  payload: ManagedLifecyclePayload,
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<ManagedLifecycleResult | undefined> {
  if (payload.role !== "replica" || payload.action === "stop") {
    return undefined;
  }
  const engine = getManagedEngineRuntime(payload.engine ?? "postgres");
  if (!engine.replication) return undefined;

  const target = await readReplicaComposeTarget(layout, payload.managedId);
  const state = await engine.replication.probeStandbyData({
    image: target.image,
    volumes: target.volumes,
    containerUser: engine.containerUser,
    runDocker: (argv) => run(argv),
  });
  if (state !== "not_standby") return undefined;

  const redact = (text: string) => sanitizeForLog(text);
  await stopManagedProjectForResync(payload.managedId, redact, run);
  return {
    status: "needs_resync",
    summary:
      `managed ${payload.action} refused: replica data is not a standby (needs resync)`,
    ...(payload.memberId
      ? { member: buildNeedsResyncMember(payload.memberId) }
      : {}),
  };
}

async function recordDemotedFenceOnLifecycleStop(
  payload: ManagedLifecyclePayload,
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<void> {
  if (payload.action !== "stop" || payload.demoted !== true) return;
  const demotedAt = new Date().toISOString();
  const engine = payload.engine ?? "postgres";
  await writeManagedDemotedMarker(
    layout,
    payload.managedId,
    payload.memberId ?? "",
    demotedAt,
    engine,
  );
  await persistDemotedVolumeFence(layout, payload.managedId, engine, run);
  await enforceFencedMemberIfRunning(layout, payload.managedId, engine, run);
}

/** Post-compose safety net when a fenced member was started outside refuseDemotedMemberStart. */
function fencedWritableRefusalSummary(
  payload: ManagedLifecyclePayload,
): ManagedLifecycleResult {
  return {
    status: "needs_resync",
    summary: `managed ${payload.action} refused: fenced member stayed writable`,
    ...(payload.memberId
      ? { member: buildNeedsResyncMember(payload.memberId) }
      : {}),
  };
}

export async function refuseWritableFencedAfterComposeStart(
  payload: ManagedLifecyclePayload,
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<ManagedLifecycleResult | undefined> {
  if (payload.action !== "start" && payload.action !== "restart") {
    return undefined;
  }
  if (payload.reactivateAfterSwitchoverAbort === true) return undefined;
  if (
    !(await isManagedMemberDemoted(
      layout,
      payload.managedId,
      payload.memberId,
    ))
  ) {
    return undefined;
  }
  const engine = payload.engine ?? "postgres";
  await enforceFencedMemberIfRunning(layout, payload.managedId, engine, run);
  const stillWritable = await isFencedMemberStillWritable(
    layout,
    payload.managedId,
    engine,
    run,
  );
  if (!stillWritable) return undefined;
  await stopManagedProjectForResync(
    payload.managedId,
    (text) => sanitizeForLog(text),
    run,
  );
  return fencedWritableRefusalSummary(payload);
}

async function observeManagedLifecycleOutcome(
  payload: ManagedLifecyclePayload,
  project: string,
  run: RunDockerFn,
  switchoverPrimaryExecutedGtidSet: string | undefined,
): Promise<ManagedLifecycleResult> {
  const withGtid = switchoverPrimaryExecutedGtidSet
    ? { switchoverPrimaryExecutedGtidSet }
    : {};

  if (payload.memberId) {
    const engine = getManagedEngineRuntime(payload.engine ?? "postgres");
    const collected = await collectManagedMemberHealth(project, engine, {
      memberId: payload.memberId,
      role: payload.role ?? "primary",
      redact: (text) => sanitizeForLog(text),
    }, run);
    const containers = collected.containers ?? [];
    const status = statusFromContainers(containers);
    return {
      status,
      summary: `managed ${payload.action} observed status=${status}`,
      ...(collected.member !== undefined ? { member: collected.member } : {}),
      ...withGtid,
    };
  }

  const containers = (await collectManagedContainers(
    project,
    (text) => sanitizeForLog(text),
    run,
  )) ?? [];
  const status = statusFromContainers(containers);
  return {
    status,
    summary: `managed ${payload.action} observed status=${status}`,
    ...withGtid,
  };
}

async function runManagedComposeLifecycleAction(
  payload: ManagedLifecyclePayload,
  project: string,
  run: RunDockerFn,
): Promise<void> {
  const result = await run([
    "compose",
    "-p",
    project,
    payload.action,
  ]);
  if (!result.success) {
    throw new Error(
      `managed.lifecycle ${payload.action} failed: ${
        sanitizeForLog(result.stderr || "compose failed")
      }`,
    );
  }
}

async function finalizeManagedLifecycle(
  payload: ManagedLifecyclePayload,
  layout: LayoutPaths,
  project: string,
  run: RunDockerFn,
  engineDeps: ManagedLifecycleHandlerDeps & { runDocker: RunDockerFn },
  switchoverPrimaryExecutedGtidSet: string | undefined,
): Promise<ManagedLifecycleResult> {
  const writableFenced = await refuseWritableFencedAfterComposeStart(
    payload,
    layout,
    run,
  );
  if (writableFenced) return writableFenced;

  await reactivatePrimaryAfterSwitchoverAbort(payload, run, engineDeps);

  if (payload.action === "start" && payload.reactivateAfterSwitchoverAbort) {
    const engine = payload.engine ?? "postgres";
    await clearDemotedVolumeFence(layout, payload.managedId, engine, run);
    await clearManagedDemotedMarker(layout, payload.managedId);
  }

  return await observeManagedLifecycleOutcome(
    payload,
    project,
    run,
    switchoverPrimaryExecutedGtidSet,
  );
}

export async function handleManagedLifecycle(
  payload: ManagedLifecyclePayload,
  _daemonReceivedAt: string,
  deps?: ManagedLifecycleHandlerDeps,
): Promise<ManagedLifecycleResult> {
  if (!SAFE_MANAGED_ID_RE.test(payload.managedId)) {
    throw new Error("managedId contains unsupported characters");
  }

  const run = deps?.runDocker ?? defaultRunDocker;
  const layout = resolveLayout(Deno.env.toObject());
  const root = managedDir(layout, payload.managedId);
  if (!(await pathExists(root))) {
    return {
      status: "stopped",
      summary: "managed state absent — idempotent no-op",
    };
  }

  const demotedRefused = await refuseDemotedMemberStart(payload, layout, run);
  if (demotedRefused) return demotedRefused;

  const refused = await refuseNonStandbyReplicaStart(payload, layout, run);
  if (refused) return refused;

  const engineDeps = {
    runDocker: run,
    ...(deps?.ensureDocker ? { ensureDocker: deps.ensureDocker } : {}),
  };
  const switchoverPrimaryExecutedGtidSet =
    await captureSwitchoverGtidBeforeStop(
      payload,
      run,
      engineDeps,
    );

  await recordDemotedFenceOnLifecycleStop(payload, layout, run);

  const project = managedComposeProject(payload.managedId);
  await runManagedComposeLifecycleAction(payload, project, run);

  return await finalizeManagedLifecycle(
    payload,
    layout,
    project,
    run,
    engineDeps,
    switchoverPrimaryExecutedGtidSet,
  );
}
