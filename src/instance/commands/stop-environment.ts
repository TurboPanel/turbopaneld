import { join } from "@std/path";
import { runDocker } from "../../deploy/docker-cli.ts";
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

function assertSafeStopIdentifiers(payload: EnvironmentStopPayload): void {
  if (!SAFE_PATH_ID_RE.test(payload.environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }
  if (!COMPOSE_PROJECT_RE.test(payload.projectName)) {
    throw new Error("projectName must be a valid Docker Compose project name");
  }
}

async function composeFileExists(composePath: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(composePath);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function composeDown(
  projectName: string,
  composePath: string,
): Promise<void> {
  const result = await runDocker([
    "compose",
    "-p",
    projectName,
    "-f",
    composePath,
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
): Promise<EnvironmentStopResult> {
  const parsedPayload = parseEnvironmentStopPayload(payload);
  assertSafeStopIdentifiers(parsedPayload);
  const layout = resolveLayout(Deno.env.toObject());

  const deploymentDir = join(
    layout.stateDir,
    "deployments",
    parsedPayload.environmentId,
  );
  const composePath = join(deploymentDir, "docker-compose.yml");
  const hasCompose = await composeFileExists(composePath);

  if (hasCompose) {
    await composeDown(parsedPayload.projectName, composePath);
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
