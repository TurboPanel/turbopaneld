import {
  composeFileArgs,
  resolveDeployedComposePaths,
  resolveEnvironmentDeploymentDir,
} from "../../deploy/compose-files.ts";
import { removeSecretTree } from "../../deploy/secret-runtime.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../../deploy/docker-cli.ts";
import {
  removeEnvironmentTcpUdpServiceIngress,
  removeHostingCaddySite,
} from "../../deploy/ingress.ts";
import { removeTraditionalWebSites } from "../../deploy/traditional-web.ts";
import { logInfo } from "../../logger.ts";
import { resolveLayout } from "../../paths/layout.ts";
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
  run: RunDockerFn,
): Promise<void> {
  const result = await run([
    ...composeFileArgs(projectName, composePaths),
    "down",
    "--remove-orphans",
    "--volumes",
  ]);
  if (!result.success) {
    throw new Error(result.stderr || "Docker Compose stop failed");
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
  const layout = resolveLayout(Deno.env.toObject());

  const deploymentDir = await resolveEnvironmentDeploymentDir(
    layout,
    parsedPayload.projectId,
    parsedPayload.environmentId,
  );
  const composePaths = await resolveDeployedComposePaths(deploymentDir);
  const hasCompose = composePaths !== null;

  if (hasCompose) {
    await composeDown(parsedPayload.projectName, composePaths, run);
  } else {
    // Already torn down — still clear hosting site and report empty containers.
    logInfo(
      "commands",
      `environment.stop compose missing project=${parsedPayload.projectName} env=${parsedPayload.environmentId}; treating as already stopped`,
    );
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
