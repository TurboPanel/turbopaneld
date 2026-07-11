import { join } from "@std/path";
import { injectHostingLabels } from "../../deploy/compose-labels.ts";
import { ensureDocker } from "../../deploy/ensure-docker.ts";
import {
  ensureHostingIngress,
  rewriteHostingCaddySites,
} from "../../deploy/ingress.ts";
import { logInfo } from "../../logger.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  type EnvironmentDeployPayload,
  type EnvironmentDeployResult,
  parseEnvironmentDeployPayload,
} from "./contracts.ts";

const SAFE_PATH_ID_RE = /^[A-Za-z0-9_-]+$/;
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;
const decoder = new TextDecoder();

function assertSafeDeploymentIdentifiers(
  payload: EnvironmentDeployPayload,
): void {
  if (!SAFE_PATH_ID_RE.test(payload.environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }
  if (!COMPOSE_PROJECT_RE.test(payload.projectName)) {
    throw new Error("projectName must be a valid Docker Compose project name");
  }
}

async function composeUp(
  projectName: string,
  composePath: string,
): Promise<void> {
  const result = await new Deno.Command("/usr/bin/docker", {
    args: [
      "compose",
      "-p",
      projectName,
      "-f",
      composePath,
      "up",
      "-d",
      "--remove-orphans",
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const stderr = decoder.decode(result.stderr).trim();
    throw new Error(stderr || "Docker Compose deployment failed");
  }
}

export async function handleEnvironmentDeploy(
  payload: EnvironmentDeployPayload,
  daemonReceivedAt: string,
): Promise<EnvironmentDeployResult> {
  const parsedPayload = parseEnvironmentDeployPayload(payload);
  assertSafeDeploymentIdentifiers(parsedPayload);
  const labeledCompose = injectHostingLabels(parsedPayload);
  const layout = resolveLayout(Deno.env.toObject());

  await ensureDocker();
  await ensureHostingIngress(layout);

  const deploymentDir = join(
    layout.stateDir,
    "deployments",
    parsedPayload.environmentId,
  );
  await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
  const composePath = join(deploymentDir, "docker-compose.yml");
  await Deno.writeTextFile(composePath, labeledCompose.composeYaml, {
    mode: 0o640,
  });
  await composeUp(parsedPayload.projectName, composePath);
  await rewriteHostingCaddySites(layout, parsedPayload);

  const summary =
    `Deployed ${labeledCompose.services.length} service(s) for environment ${parsedPayload.environmentId}`;
  logInfo(
    "commands",
    `environment.deploy completed project=${parsedPayload.projectName} received=${daemonReceivedAt}`,
  );
  return {
    projectName: parsedPayload.projectName,
    summary,
    ...(labeledCompose.services.length > 0
      ? { services: labeledCompose.services }
      : {}),
  };
}
