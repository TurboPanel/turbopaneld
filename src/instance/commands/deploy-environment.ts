import { join } from "@std/path";
import { injectHostingLabels } from "../../deploy/compose-labels.ts";
import { runDocker } from "../../deploy/docker-cli.ts";
import { ensureDocker } from "../../deploy/ensure-docker.ts";
import {
  ensureHostingIngress,
  rewriteHostingCaddySites,
} from "../../deploy/ingress.ts";
import { logInfo } from "../../logger.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  type EnvironmentDeployContainer,
  type EnvironmentDeployHosting,
  type EnvironmentDeployPayload,
  type EnvironmentDeployResult,
  parseEnvironmentDeployPayload,
} from "./contracts.ts";

const SAFE_PATH_ID_RE = /^[A-Za-z0-9_-]+$/;
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseComposePsEntries(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord);
    }
    if (isRecord(parsed)) {
      return [parsed];
    }
  } catch {
    // Fall through to NDJSON.
  }

  const entries: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (row.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(row);
      if (isRecord(parsed)) entries.push(parsed);
    } catch {
      return [];
    }
  }
  return entries;
}

/**
 * Best-effort `docker compose ps --format json` after a successful compose up.
 * Never throws. Returns `null` when collection fails (non-authoritative — omit
 * `containers` from the deploy result). Returns `[]` when `ps` succeeds with no
 * rows so the instance can clear stale container pins.
 */
async function collectDeployedContainers(
  projectName: string,
  hostings: EnvironmentDeployHosting[],
): Promise<EnvironmentDeployContainer[] | null> {
  try {
    const result = await runDocker([
      "compose",
      "-p",
      projectName,
      "ps",
      "--format",
      "json",
    ]);
    if (!result.success) {
      logInfo(
        "commands",
        `environment.deploy container collect failed project=${projectName}: ${result.stderr || "docker compose ps failed"}`,
      );
      return null;
    }

    const entries = parseComposePsEntries(result.stdout);

    const serviceIdByComposeName = new Map<string, string>();
    for (const hosting of hostings) {
      serviceIdByComposeName.set(hosting.composeServiceName, hosting.serviceId);
    }

    const containers: EnvironmentDeployContainer[] = [];
    for (const entry of entries) {
      const containerId = entry.ID;
      const containerName = entry.Name;
      const composeServiceName = entry.Service;
      const status = entry.State;
      if (
        typeof containerId !== "string" ||
        containerId.length === 0 ||
        typeof containerName !== "string" ||
        containerName.length === 0 ||
        typeof composeServiceName !== "string" ||
        composeServiceName.length === 0 ||
        typeof status !== "string" ||
        status.length === 0
      ) {
        continue;
      }
      const serviceId = serviceIdByComposeName.get(composeServiceName);
      containers.push({
        composeServiceName,
        containerId,
        containerName,
        status,
        ...(serviceId === undefined ? {} : { serviceId }),
      });
    }
    return containers;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInfo(
      "commands",
      `environment.deploy container collect failed project=${projectName}: ${message}`,
    );
    return null;
  }
}

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
  const result = await runDocker([
    "compose",
    "-p",
    projectName,
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!result.success) {
    throw new Error(result.stderr || "Docker Compose deployment failed");
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

  // On-demand: Docker Engine (+ docker group) and hosting Caddy for hostnames.
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
  const containers = await collectDeployedContainers(
    parsedPayload.projectName,
    parsedPayload.hostings,
  );

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
    // Include `containers: []` when collection succeeded with no rows; omit the
    // field entirely when collection failed (non-authoritative).
    ...(containers === null ? {} : { containers }),
  };
}
