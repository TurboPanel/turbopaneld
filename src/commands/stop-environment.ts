import { dirname } from "node:path";
import {
  composeFileArgs,
  readDeploymentManifest,
  resolveDeployedComposePaths,
  resolveEnvironmentDeploymentDir,
} from "../deploy/compose-files.ts";
import { projectsForCommand } from "../deploy/deployment-generations.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { removeSecretTree } from "../deploy/secret-runtime.ts";
import {
  createStreamedRunner,
  dockerBinaryInstalled,
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
  type RunDockerStreamedFn,
} from "../deploy/docker-cli.ts";
import {
  COMMAND_LOG_PHASES,
  type CommandOutputSink,
  createNoopCommandOutputSink,
} from "../logs/contracts.ts";
import {
  removeEnvironmentTcpUdpServiceIngress,
  removeHostingCaddySite,
} from "../deploy/ingress.ts";
import { removeSites } from "../deploy/site.ts";
import { removeNativeAppServices } from "../deploy/native/apply-native-apps.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import {
  fabricNetworkDir,
  type LayoutPaths,
  resolveLayout,
} from "../paths/layout.ts";
import type { RunFn } from "../deploy/ensure-principal.ts";
import { runPrivileged } from "../deploy/release/release-layout.ts";
import { reclaimServiceTree } from "../deploy/release/retention.ts";
import {
  actOnEarlierContainers,
  earlierRecordedProjects,
} from "../deploy/retire-previous-projects.ts";
import { retirePrincipals } from "../deploy/retire-principals.ts";
import type { SshApplyResult } from "../deploy/ssh/apply.ts";
import {
  pruneFabricStateNetworks,
  removeFabricDockerNetworks,
} from "./fabric.ts";
import {
  type EnvironmentStopFolderState,
  type EnvironmentStopPayload,
  type EnvironmentStopResult,
  parseEnvironmentStopPayload,
  type StopSiteRelease,
} from "../contracts/commands-contracts.ts";

const SAFE_PATH_ID_RE = /^[A-Za-z0-9_-]+$/;
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type EnvironmentStopHandlerDeps = {
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
  /** Execution-log transcript sink (`src/logs/`); defaults to a no-op sink. */
  logSink?: CommandOutputSink;
  /** Test seam — defaults to {@link removeFabricDockerNetworks}. */
  removeFabricNetworks?: (names: readonly string[]) => Promise<void>;
  /** Test seam — privileged `sudo -n …` runner for release-tree removal. */
  runPrivileged?: RunFn;
  /** Test seam — defaults to a `/usr/bin/docker` probe when `runDocker` is not injected. */
  dockerInstalled?: () => Promise<boolean>;
  /** Test seam — the `sshd` drop-in re-render after principals are retired. */
  applySshAccess?: () => Promise<SshApplyResult>;
};

/**
 * Reclaim the tree of every service the payload names: its service folder
 * (`<owner>/<scope>/services/<name>`), or `<principalHome>/sites/<serviceId>`
 * for an entry with no folder, plus the daemon's records of the service.
 *
 * Only a delete (or a server leaving the environment) sends `siteReleases`; a
 * plain stop sends none, so every folder, including `shared/` uploads, stays.
 * The folder is root-owned by design, so the daemon cannot unlink it itself;
 * removal goes through the same privileged runner the release engine uses to
 * seal and prune.
 *
 * Best-effort per entry, matching the rest of this handler: a stop must still
 * tear the stack down when one leftover tree refuses to go. Each entry that
 * carries a folder is reported back with whether the folder is gone, so the
 * control plane can settle its row.
 */
async function removeEnvironmentSiteReleases(
  layout: LayoutPaths,
  environmentId: string,
  siteReleases: readonly StopSiteRelease[],
  runFn: RunFn,
): Promise<EnvironmentStopFolderState[]> {
  const states: EnvironmentStopFolderState[] = [];
  await forEachSequential(siteReleases, async (entry) => {
    const path = await reclaimServiceTree(layout, entry, runFn, (_, line) => {
      logWarn(
        "commands",
        `environment.stop site release reclaim env=${environmentId}: ${line}`,
      );
    });
    if (entry.folder !== undefined) {
      states.push({
        owner: entry.folder.owner,
        scope: entry.folder.scope,
        kind: "service",
        slug: entry.folder.slug,
        removed: path !== null,
      });
    }
  });
  return states;
}

/**
 * Remove this environment's native app units. Best-effort, like every other
 * reclaim step here: a stop must still tear the stack down when one leftover
 * unit refuses to go.
 */
async function removeEnvironmentNativeApps(
  layout: LayoutPaths,
  environmentId: string,
): Promise<void> {
  try {
    const removed = await removeNativeAppServices(layout, environmentId);
    if (removed > 0) {
      logInfo(
        "commands",
        `environment.stop removed ${removed} native app unit(s) env=${environmentId}`,
      );
    }
  } catch (err) {
    logWarn(
      "commands",
      `environment.stop native app teardown failed env=${environmentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * `deployments/<projectId>/<environmentId>` is gone by now; drop the
 * `<projectId>` parent too once no other environment lives in it. A plain
 * (non-recursive) remove, so a sibling environment's tree is never touched.
 */
async function removeEmptyProjectDeploymentDir(
  deploymentDir: string,
): Promise<void> {
  try {
    await Deno.remove(dirname(deploymentDir));
  } catch (err) {
    // Not empty (sibling environment) or already gone: both are fine.
    logInfo(
      "commands",
      `environment.stop project deployment dir kept: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Remove `deployments/<projectId>/<environmentId>`.
 *
 * Containers write bind mounts (`./data`) as root, so the unprivileged daemon
 * can hit EACCES on nested entries. Only then is the removal routed through
 * `tp-host rm -rf`, which accepts the path only beneath the managed state root,
 * pins the parent with `cd -P` and unlinks without following symlinks. A
 * deployment dir that is itself a symlink is never handed to the privileged
 * runner.
 */
async function removeDeploymentDir(
  deploymentDir: string,
  runFn: RunFn,
): Promise<void> {
  try {
    await Deno.remove(deploymentDir, { recursive: true });
    return;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
  }
  const info = await Deno.lstat(deploymentDir).catch(() => null);
  if (info === null) return;
  if (!info.isDirectory) {
    throw new Error(`deployment path is not a directory: ${deploymentDir}`);
  }
  const result = await runFn(
    "sudo",
    hostSudoArgs(["-n", "rm", "-rf", "--", deploymentDir]),
  );
  if (!result.success) {
    throw new Error(
      `deployment dir removal failed: ${result.stderr || "tp-host rm failed"}`,
    );
  }
}

function retirementSummary(
  stopped: string,
  retirement: { retired: string[]; failed: Array<{ username: string }> },
): string {
  const parts = [stopped];
  if (retirement.retired.length > 0) {
    parts.push(`retired principals: ${retirement.retired.join(", ")}`);
  }
  if (retirement.failed.length > 0) {
    parts.push(
      `principals kept: ${
        retirement.failed.map((entry) => entry.username).join(", ")
      }`,
    );
  }
  return parts.join("; ");
}

function assertSafeStopIdentifiers(payload: EnvironmentStopPayload): void {
  if (!SAFE_PATH_ID_RE.test(payload.environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }
  if (!SAFE_PATH_ID_RE.test(payload.projectId)) {
    throw new Error("projectId contains unsupported characters");
  }
  if (!COMPOSE_PROJECT_RE.test(payload.projectName)) {
    throw new Error("projectName must be a valid Docker Compose project name");
  }
}

async function composeDown(
  projectName: string,
  composePaths: readonly string[],
  runStreamed: RunDockerStreamedFn,
  logSink: CommandOutputSink,
): Promise<void> {
  const result = await runStreamed([
    ...composeFileArgs(projectName, composePaths),
    "down",
    "--remove-orphans",
    "--volumes",
    // Only images built for this stack (no `image:` tag of their own); pulled
    // or explicitly tagged images (base/shared) are never touched.
    "--rmi",
    "local",
  ], {
    onLine: (event) => logSink.onLine(event.stream, event.line),
  });
  if (!result.success) {
    throw new Error(
      logSink.redactSummary(result.stderr) || "Docker Compose stop failed",
    );
  }
}

/**
 * A host without Docker (site-only) has no containers or networks to stop, so
 * Docker steps are skipped. An injected `runDocker` means "Docker is there".
 */
async function dockerAvailableForStop(
  deps?: EnvironmentStopHandlerDeps,
): Promise<boolean> {
  if (deps?.dockerInstalled) return await deps.dockerInstalled();
  return deps?.runDocker !== undefined || await dockerBinaryInstalled();
}

const noDocker: RunDockerFn = () =>
  Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });

/**
 * A stack still running under an earlier, project-wide name: Compose acts on a
 * whole project, and sibling environments shared that name, so only this
 * environment's own containers are removed (volumes are kept).
 */
async function removeEarlierNamedContainers(
  payload: EnvironmentStopPayload,
  deploymentDir: string,
  run: RunDockerFn,
): Promise<void> {
  const earlier = await earlierRecordedProjects(
    deploymentDir,
    payload.projectName,
  );
  const removed = await actOnEarlierContainers(earlier, run, {
    environmentId: payload.environmentId,
    deploymentDir,
  }, "remove");
  if (removed.length > 0) {
    logInfo(
      "commands",
      `environment.stop removed containers started under earlier compose project ${
        removed.join(",")
      } env=${payload.environmentId}`,
    );
  }
}

/**
 * Tear down a deployed environment stack (compose down + volumes + hosting site
 * + per-service release trees). Idempotent when the compose file is already
 * gone.
 */
export async function handleEnvironmentStop(
  payload: EnvironmentStopPayload,
  daemonReceivedAt: string,
  deps?: EnvironmentStopHandlerDeps,
): Promise<EnvironmentStopResult> {
  const parsedPayload = parseEnvironmentStopPayload(payload);
  assertSafeStopIdentifiers(parsedPayload);
  const dockerPresent = await dockerAvailableForStop(deps);
  const run = dockerPresent ? (deps?.runDocker ?? defaultRunDocker) : noDocker;
  const runStreamed = createStreamedRunner(deps?.runDocker);
  const logSink = deps?.logSink ?? createNoopCommandOutputSink();
  logSink.setPhase(COMMAND_LOG_PHASES.STOP);
  const layout = resolveLayout(Deno.env.toObject());

  const deploymentDir = resolveEnvironmentDeploymentDir(
    layout,
    parsedPayload.projectId,
    parsedPayload.environmentId,
  );
  const composePaths = await resolveDeployedComposePaths(deploymentDir);
  const hasCompose = composePaths !== null;

  if (hasCompose && !dockerPresent) {
    logInfo(
      "commands",
      `environment.stop Docker not installed; skipping compose down project=${parsedPayload.projectName} env=${parsedPayload.environmentId}`,
    );
  } else if (hasCompose) {
    // Every generation the deployment owns comes down, not just the named one.
    const projects = projectsForCommand(
      await readDeploymentManifest(deploymentDir),
      parsedPayload.projectName,
      "all",
    );
    await forEachSequential(
      projects,
      (projectName) =>
        composeDown(projectName, composePaths, runStreamed, logSink),
    );
  } else {
    // Already torn down — still clear hosting site and report empty containers.
    logInfo(
      "commands",
      `environment.stop compose missing project=${parsedPayload.projectName} env=${parsedPayload.environmentId}; no compose files to take down`,
    );
  }

  if (dockerPresent) {
    await removeEarlierNamedContainers(parsedPayload, deploymentDir, run);
  }

  const fabricNetworks = parsedPayload.fabricNetworks ?? [];
  if (fabricNetworks.length > 0 && dockerPresent) {
    try {
      const removeNetworks = deps?.removeFabricNetworks ??
        removeFabricDockerNetworks;
      await removeNetworks(fabricNetworks);
      await pruneFabricStateNetworks(
        fabricNetworkDir(layout),
        fabricNetworks,
      );
    } catch (err) {
      logWarn(
        "commands",
        `environment.stop fabric network reclaim failed env=${parsedPayload.environmentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  await removeHostingCaddySite(layout, parsedPayload.environmentId);
  await removeSites(layout, parsedPayload.environmentId);
  // Disable + remove the generated app units before the release trees they run
  // out of are reclaimed, so systemd never restarts a unit whose
  // `WorkingDirectory` has just been deleted. The per-principal slice is
  // deliberately left behind — other environments of the same account still
  // reference it.
  await removeEnvironmentNativeApps(layout, parsedPayload.environmentId);
  const folders = await removeEnvironmentSiteReleases(
    layout,
    parsedPayload.environmentId,
    parsedPayload.siteReleases ?? [],
    deps?.runPrivileged ?? runPrivileged,
  );

  // Union payload ingressServices with daemon-persisted environment index so
  // a hosting deleted (or flipped to HTTP) before stop still tears down the
  // per-service Traefik project + published ports.
  await removeEnvironmentTcpUdpServiceIngress(
    layout,
    parsedPayload.environmentId,
    (parsedPayload.ingressServices ?? []).map((ingress) => ingress.serviceId),
    { runDocker: run },
  );

  await removeDeploymentDir(
    deploymentDir,
    deps?.runPrivileged ?? runPrivileged,
  );

  await removeEmptyProjectDeploymentDir(deploymentDir);

  await removeSecretTree(
    layout,
    parsedPayload.projectId,
    parsedPayload.environmentId,
  );

  // Last, once every unit, site and release tree above is gone: tp-host
  // refuses an account the host still references.
  const retirement = await retirePrincipals(
    (parsedPayload.retirePrincipals ?? []).map((entry) => entry.username),
    {
      runFn: deps?.runPrivileged ?? runPrivileged,
      ...(deps?.applySshAccess ? { applySshAccess: deps.applySshAccess } : {}),
    },
  );

  const stopped = hasCompose
    ? `Stopped environment ${parsedPayload.environmentId}`
    : `Environment ${parsedPayload.environmentId} already stopped`;
  const summary = retirementSummary(stopped, retirement);
  logInfo(
    "commands",
    `environment.stop completed project=${parsedPayload.projectName} received=${daemonReceivedAt}`,
  );
  return stopResult(parsedPayload.projectName, summary, folders);
}

/** The stop result; `folders` is present only when folders were named. */
function stopResult(
  projectName: string,
  summary: string,
  folders: EnvironmentStopFolderState[],
): EnvironmentStopResult {
  return {
    projectName,
    summary,
    containers: [],
    ...(folders.length > 0 ? { folders } : {}),
  };
}
