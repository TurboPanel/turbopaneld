import {
  composeFileArgs,
  resolveDeployedComposePaths,
  resolveEnvironmentDeploymentDir,
} from "../../deploy/compose-files.ts";
import { removeSecretTree } from "../../deploy/secret-runtime.ts";
import {
  createStreamedRunner,
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
  type RunDockerStreamedFn,
} from "../../deploy/docker-cli.ts";
import {
  COMMAND_LOG_PHASES,
  type CommandOutputSink,
  createNoopCommandOutputSink,
} from "../../logs/contracts.ts";
import {
  removeEnvironmentTcpUdpServiceIngress,
  removeHostingCaddySite,
} from "../../deploy/ingress.ts";
import { removeTraditionalWebSites } from "../../deploy/traditional-web.ts";
import { logInfo, logWarn } from "../../logger.ts";
import { fabricNetworkDir, resolveLayout } from "../../paths/layout.ts";
import {
  pruneFabricStateNetworks,
  removeFabricDockerNetworks,
} from "./fabric.ts";
import {
  type EnvironmentStopPayload,
  type EnvironmentStopResult,
  parseEnvironmentStopPayload,
} from "./contracts.ts";

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
};

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
 * Tear down a deployed environment stack (compose down + volumes + hosting site).
 * Idempotent when the compose file is already gone.
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
    await composeDown(
      parsedPayload.projectName,
      composePaths,
      runStreamed,
      logSink,
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
  await removeTraditionalWebSites(layout, parsedPayload.environmentId);

  // Union payload ingressServices with daemon-persisted environment index so
  // a hosting deleted (or flipped to HTTP) before stop still tears down the
  // per-service Traefik project + published ports.
  await removeEnvironmentTcpUdpServiceIngress(
    layout,
    parsedPayload.environmentId,
    (parsedPayload.ingressServices ?? []).map((ingress) => ingress.serviceId),
    { runDocker: run },
  );

  try {
    await Deno.remove(deploymentDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  await removeSecretTree(
    layout,
    parsedPayload.projectId,
    parsedPayload.environmentId,
  );

  const summary = hasCompose
    ? `Stopped environment ${parsedPayload.environmentId}`
    : `Environment ${parsedPayload.environmentId} already stopped`;
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
