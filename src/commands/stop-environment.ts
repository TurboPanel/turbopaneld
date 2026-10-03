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
  principalHomePath,
  resolveLayout,
  siteRoot,
} from "../paths/layout.ts";
import type { RunFn } from "../deploy/ensure-principal.ts";
import { runPrivileged } from "../deploy/release/release-layout.ts";
import { retirePrincipals } from "../deploy/retire-principals.ts";
import type { SshApplyResult } from "../deploy/ssh/apply.ts";
import {
  pruneFabricStateNetworks,
  removeFabricDockerNetworks,
} from "./fabric.ts";
import {
  type EnvironmentStopPayload,
  type EnvironmentStopResult,
  parseEnvironmentStopPayload,
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
  /** Test seam — the `sshd` drop-in re-render after principals are retired. */
  applySshAccess?: () => Promise<SshApplyResult>;
};

/**
 * Reclaim `<principalHome>/sites/<serviceId>` for every service the payload
 * names.
 *
 * Generic on purpose: this is the tree the Git release engine publishes into
 * (`releases/`, `current`, `shared/`) and the one native apps run out of — not
 * a site artifact. It is root-owned by design, so
 * the daemon cannot unlink it itself; removal goes through the same privileged
 * runner the release engine uses to seal and prune.
 *
 * Best-effort per entry, matching the rest of this handler: a stop must still
 * tear the stack down when one leftover tree refuses to go.
 */
async function removeEnvironmentSiteReleases(
  layout: LayoutPaths,
  environmentId: string,
  siteReleases: ReadonlyArray<{ serviceId: string; username: string }>,
  runFn: RunFn,
): Promise<void> {
  await forEachSequential(siteReleases, async (entry) => {
    const path = siteRoot(
      principalHomePath(layout, entry.username),
      entry.serviceId,
    );
    try {
      const result = await runFn(
        "sudo",
        hostSudoArgs(["-n", "rm", "-rf", "--", path]),
      );
      if (!result.success) {
        logWarn(
          "commands",
          `environment.stop site release reclaim failed env=${environmentId} path=${path}: ${result.stderr}`,
        );
      }
    } catch (err) {
      logWarn(
        "commands",
        `environment.stop site release reclaim failed env=${environmentId} path=${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
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
  const run = deps?.runDocker ?? defaultRunDocker;
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

  if (hasCompose) {
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
      `environment.stop compose missing project=${parsedPayload.projectName} env=${parsedPayload.environmentId}; treating as already stopped`,
    );
  }

  const fabricNetworks = parsedPayload.fabricNetworks ?? [];
  if (fabricNetworks.length > 0) {
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
  await removeEnvironmentSiteReleases(
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
  return {
    projectName: parsedPayload.projectName,
    summary,
    containers: [],
  };
}
