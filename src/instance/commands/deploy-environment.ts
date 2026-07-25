import { join } from "@std/path";
import { applySecretVariablesToCompose } from "../../deploy/apply-deploy-variables.ts";
import { applyStorageVolumesToCompose } from "../../deploy/apply-storage-volumes.ts";
import { injectHostingLabels } from "../../deploy/compose-labels.ts";
import { composeHasContainerServices } from "../../deploy/compose-services.ts";
import { runDocker } from "../../deploy/docker-cli.ts";
import { ensureDocker } from "../../deploy/ensure-docker.ts";
import { ensureSystemPrincipals } from "../../deploy/ensure-principal.ts";
import {
  buildTcpUdpIngressEntries,
  ensureHostingCaddyRuntime,
  ensureHostingIngress,
  rewriteHostingCaddySites,
  syncTcpUdpIngressEntries,
} from "../../deploy/ingress.ts";
import { materializeStorageEntries } from "../../deploy/materialize-storage.ts";
import {
  type DecryptSecretsFn,
  hostnameTlsMap,
  materializeTlsCertificates,
} from "../../deploy/materialize-tls.ts";
import {
  runDeployServiceHooks,
  runPostDeployHooks,
} from "../../deploy/run-deploy-hooks.ts";
import { applyTraditionalWebSites } from "../../deploy/traditional-web.ts";
import { ensureExternalDockerNetworks } from "../../deploy/ensure-docker-networks.ts";
import {
  injectTraditionalWebDockerReachability,
  resolveDockerHostGatewayAddress,
} from "../../deploy/traditional-web-docker.ts";
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
        `environment.deploy container collect failed project=${projectName}: ${
          result.stderr || "docker compose ps failed"
        }`,
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

export type EnvironmentDeployDeps = {
  decryptSecrets?: DecryptSecretsFn;
};

export async function handleEnvironmentDeploy(
  payload: EnvironmentDeployPayload,
  daemonReceivedAt: string,
  deps?: EnvironmentDeployDeps,
): Promise<EnvironmentDeployResult> {
  const parsedPayload = parseEnvironmentDeployPayload(payload);
  assertSafeDeploymentIdentifiers(parsedPayload);
  const layout = resolveLayout(Deno.env.toObject());

  const traditionalWebSites = parsedPayload.traditionalWebSites ?? [];
  const traditionalNames = new Set(
    traditionalWebSites.map((site) => site.composeServiceName),
  );
  const hasContainers = composeHasContainerServices(parsedPayload.composeYaml);
  const containerHostings = parsedPayload.hostings.filter(
    (hosting) => !traditionalNames.has(hosting.composeServiceName),
  );

  if (hasContainers) {
    await ensureDocker();
    const tcpUdpEntries = buildTcpUdpIngressEntries(containerHostings);
    const mergedTcpUdpEntries = await syncTcpUdpIngressEntries(
      layout,
      parsedPayload.environmentId,
      tcpUdpEntries,
    );
    await ensureHostingIngress(layout, mergedTcpUdpEntries);
  } else {
    // Traditional-web-only: edge Caddy without Traefik/Docker.
    await ensureHostingCaddyRuntime(layout);
  }

  const deploymentDir = join(
    layout.stateDir,
    "deployments",
    parsedPayload.environmentId,
  );
  await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

  const principalMaterial = parsedPayload.principalMaterial ?? [];
  if (principalMaterial.length > 0) {
    await ensureSystemPrincipals(
      layout,
      principalMaterial.map((principal) => ({
        principalId: principal.principalId,
        username: principal.username,
        uid: principal.uid,
        gid: principal.gid,
        home: principal.home,
      })),
    );
  }

  let mountPaths = new Map<string, string>();
  if (parsedPayload.storageMaterial && parsedPayload.storageMaterial.length > 0) {
    mountPaths = await materializeStorageEntries(
      layout,
      parsedPayload.organizationId,
      parsedPayload.storageMaterial,
      principalMaterial,
      deps?.decryptSecrets,
    );
  }

  let composeYaml = parsedPayload.composeYaml;
  const variableMaterial = parsedPayload.variableMaterial ?? [];
  if (variableMaterial.length > 0 && hasContainers) {
    if (!deps?.decryptSecrets) {
      throw new Error(
        "Variable material present but secrets decrypt is unavailable",
      );
    }
    composeYaml = await applySecretVariablesToCompose(
      composeYaml,
      variableMaterial,
      deps.decryptSecrets,
    );
  }

  if (
    parsedPayload.storageMaterial &&
    parsedPayload.storageMaterial.length > 0 &&
    hasContainers
  ) {
    composeYaml = applyStorageVolumesToCompose(
      composeYaml,
      parsedPayload.storageMaterial,
      mountPaths,
    );
  }

  const mixedTraditionalAndContainers = hasContainers &&
    traditionalWebSites.length > 0;
  let dockerBindAddress: string | null = null;
  if (mixedTraditionalAndContainers) {
    dockerBindAddress = await resolveDockerHostGatewayAddress();
    composeYaml = injectTraditionalWebDockerReachability(
      composeYaml,
      traditionalWebSites,
    );
  }

  if (traditionalWebSites.length > 0) {
    await applyTraditionalWebSites(
      layout,
      parsedPayload.environmentId,
      traditionalWebSites,
      { dockerBindAddress: mixedTraditionalAndContainers ? dockerBindAddress : null },
    );
  }

  let labeledServices: string[] = [];
  const composePath = join(deploymentDir, "docker-compose.yml");
  if (hasContainers) {
    const labeledCompose = injectHostingLabels({
      ...parsedPayload,
      composeYaml,
      hostings: containerHostings,
    });
    labeledServices = labeledCompose.services;
    await Deno.writeTextFile(composePath, labeledCompose.composeYaml, {
      mode: 0o640,
    });

    const serviceHooks = parsedPayload.serviceHooks ?? [];
    if (serviceHooks.length > 0) {
      await runDeployServiceHooks(serviceHooks, {
        projectName: parsedPayload.projectName,
        composePath,
        deploymentDir,
      });
    }

    const externalNetworks = parsedPayload.dockerExternalNetworks ?? [];
    if (externalNetworks.length > 0) {
      await ensureExternalDockerNetworks(externalNetworks);
    }

    await composeUp(parsedPayload.projectName, composePath);

    if (serviceHooks.length > 0) {
      await runPostDeployHooks(serviceHooks, deploymentDir);
    }
  } else {
    // Persist an empty compose marker so stop/idempotency paths stay consistent.
    await Deno.writeTextFile(composePath, composeYaml, { mode: 0o640 });
  }

  let hostnameTls: Map<string, string> | undefined;
  const tlsMaterial = parsedPayload.tlsMaterial ?? [];
  if (tlsMaterial.length > 0) {
    if (!deps?.decryptSecrets) {
      throw new Error(
        "TLS material present but secrets decrypt is unavailable",
      );
    }
    await materializeTlsCertificates(
      layout,
      tlsMaterial,
      deps.decryptSecrets,
    );
    hostnameTls = hostnameTlsMap(parsedPayload);
  }

  await rewriteHostingCaddySites(layout, parsedPayload, hostnameTls);

  const containers = hasContainers
    ? await collectDeployedContainers(
      parsedPayload.projectName,
      containerHostings,
    )
    : [];

  const traditionalCount = traditionalWebSites.length;
  const summaryParts = [
    `Deployed ${labeledServices.length} container service(s)`,
  ];
  if (traditionalCount > 0) {
    summaryParts.push(`${traditionalCount} traditional-web site(s)`);
  }
  const summary =
    `${summaryParts.join(" + ")} for environment ${parsedPayload.environmentId}`;
  logInfo(
    "commands",
    `environment.deploy completed project=${parsedPayload.projectName} received=${daemonReceivedAt}`,
  );

  const serviceNames = [
    ...labeledServices,
    ...traditionalWebSites.map((site) => site.composeServiceName),
  ].sort((a, b) => a.localeCompare(b));

  return {
    projectName: parsedPayload.projectName,
    summary,
    ...(serviceNames.length > 0 ? { services: serviceNames } : {}),
    // Include `containers: []` when collection succeeded with no rows; omit the
    // field entirely when collection failed (non-authoritative).
    ...(containers === null ? {} : { containers }),
  };
}
