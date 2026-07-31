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
  type EnvironmentDeployPrincipalMaterial,
  type EnvironmentDeployResult,
  type EnvironmentDeployTraditionalWebSite,
  parseEnvironmentDeployPayload,
} from "./contracts.ts";
import type { LayoutPaths } from "../../paths/layout.ts";

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

/** Sets up Traefik/Docker ingress for container deploys, or the hosting-Caddy-only
 * runtime for traditional-web-only environments. */
async function ensureDeployIngress(
  layout: LayoutPaths,
  environmentId: string,
  hasContainers: boolean,
  containerHostings: EnvironmentDeployHosting[],
): Promise<void> {
  if (!hasContainers) {
    // Traditional-web-only: hosting Caddy without Traefik/Docker.
    await ensureHostingCaddyRuntime(layout);
    return;
  }
  await ensureDocker();
  const tcpUdpEntries = buildTcpUdpIngressEntries(containerHostings);
  const mergedTcpUdpEntries = await syncTcpUdpIngressEntries(
    layout,
    environmentId,
    tcpUdpEntries,
  );
  await ensureHostingIngress(layout, mergedTcpUdpEntries);
}

async function ensureDeployPrincipals(
  layout: LayoutPaths,
  principalMaterial: EnvironmentDeployPrincipalMaterial[],
): Promise<void> {
  if (principalMaterial.length === 0) return;
  await ensureSystemPrincipals(
    layout,
    principalMaterial.map((principal) => ({
      principalId: principal.principalId,
      username: principal.username,
      uid: principal.uid,
      gid: principal.gid,
      home: principal.home,
      shell: principal.shell,
    })),
  );
}

async function resolveDeployMountPaths(
  layout: LayoutPaths,
  parsedPayload: EnvironmentDeployPayload,
  principalMaterial: EnvironmentDeployPrincipalMaterial[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<Map<string, string>> {
  const storageMaterial = parsedPayload.storageMaterial ?? [];
  if (storageMaterial.length === 0) return new Map();
  return await materializeStorageEntries(
    layout,
    parsedPayload.organizationId,
    storageMaterial,
    principalMaterial,
    decryptSecrets,
  );
}

/** Applies secret variables, storage volumes, and (for mixed deploys)
 * traditional-web Docker-reachability injection to the compose document.
 * Returns the resolved Docker host-gateway bind address, gated to non-null
 * only when the deploy actually mixes container + traditional-web services. */
async function resolveDeployComposeYaml(
  parsedPayload: EnvironmentDeployPayload,
  hasContainers: boolean,
  mountPaths: Map<string, string>,
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<{ composeYaml: string; dockerBindAddress: string | null }> {
  let composeYaml = parsedPayload.composeYaml;
  const variableMaterial = parsedPayload.variableMaterial ?? [];
  const storageMaterial = parsedPayload.storageMaterial ?? [];

  if (hasContainers && variableMaterial.length > 0) {
    if (!decryptSecrets) {
      throw new Error(
        "Variable material present but secrets decrypt is unavailable",
      );
    }
    composeYaml = await applySecretVariablesToCompose(
      composeYaml,
      variableMaterial,
      decryptSecrets,
    );
  }

  if (hasContainers && storageMaterial.length > 0) {
    composeYaml = applyStorageVolumesToCompose(
      composeYaml,
      storageMaterial,
      mountPaths,
    );
  }

  const mixedTraditionalAndContainers = hasContainers &&
    traditionalWebSites.length > 0;
  if (!mixedTraditionalAndContainers) {
    return { composeYaml, dockerBindAddress: null };
  }

  const dockerBindAddress = await resolveDockerHostGatewayAddress();
  composeYaml = injectTraditionalWebDockerReachability(
    composeYaml,
    traditionalWebSites,
  );
  return { composeYaml, dockerBindAddress };
}

async function applyDeployTraditionalWebSites(
  layout: LayoutPaths,
  environmentId: string,
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
  dockerBindAddress: string | null,
): Promise<void> {
  if (traditionalWebSites.length === 0) return;
  await applyTraditionalWebSites(layout, environmentId, traditionalWebSites, {
    dockerBindAddress,
  });
}

/** Labels + writes the compose file, runs deploy hooks, ensures external
 * networks, and brings the project up. Returns the labeled service names. */
async function deployContainerServices(
  parsedPayload: EnvironmentDeployPayload,
  composeYaml: string,
  containerHostings: EnvironmentDeployHosting[],
  composePath: string,
  deploymentDir: string,
): Promise<string[]> {
  const labeledCompose = injectHostingLabels({
    ...parsedPayload,
    composeYaml,
    hostings: containerHostings,
  });
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

  return labeledCompose.services;
}

/** Persists an empty compose marker so stop/idempotency paths stay consistent
 * for traditional-web-only deploys (no container services to label/deploy). */
async function writeDeployComposeMarker(
  composePath: string,
  composeYaml: string,
): Promise<string[]> {
  await Deno.writeTextFile(composePath, composeYaml, { mode: 0o640 });
  return [];
}

async function materializeDeployTls(
  layout: LayoutPaths,
  parsedPayload: EnvironmentDeployPayload,
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<Map<string, string> | undefined> {
  const tlsMaterial = parsedPayload.tlsMaterial ?? [];
  if (tlsMaterial.length === 0) return undefined;
  if (!decryptSecrets) {
    throw new Error(
      "TLS material present but secrets decrypt is unavailable",
    );
  }
  await materializeTlsCertificates(layout, tlsMaterial, decryptSecrets);
  return hostnameTlsMap(parsedPayload);
}

/** Pure result-shaping helper — exported for hermetic contract tests. */
export function buildDeploySummary(
  environmentId: string,
  labeledServices: string[],
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
): string {
  const traditionalCount = traditionalWebSites.length;
  const summaryParts = [
    `Deployed ${labeledServices.length} container service(s)`,
  ];
  if (traditionalCount > 0) {
    summaryParts.push(`${traditionalCount} traditional-web site(s)`);
  }
  return `${summaryParts.join(" + ")} for environment ${environmentId}`;
}

/** Pure result-shaping helper — exported for hermetic contract tests. */
export function buildDeployServiceNames(
  labeledServices: string[],
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
): string[] {
  return [
    ...labeledServices,
    ...traditionalWebSites.map((site) => site.composeServiceName),
  ].sort((a, b) => a.localeCompare(b));
}

/**
 * Builds the {@link EnvironmentDeployResult} returned after a successful deploy.
 * Exported for hermetic success-path shape coverage without Docker/ingress I/O.
 */
export function shapeEnvironmentDeployResult(input: {
  projectName: string;
  environmentId: string;
  labeledServices: string[];
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[];
  containers: EnvironmentDeployContainer[] | null;
}): EnvironmentDeployResult {
  const summary = buildDeploySummary(
    input.environmentId,
    input.labeledServices,
    input.traditionalWebSites,
  );
  const serviceNames = buildDeployServiceNames(
    input.labeledServices,
    input.traditionalWebSites,
  );
  return {
    projectName: input.projectName,
    summary,
    ...(serviceNames.length > 0 ? { services: serviceNames } : {}),
    // Include `containers: []` when collection succeeded with no rows; omit the
    // field entirely when collection failed (non-authoritative).
    ...(input.containers === null ? {} : { containers: input.containers }),
  };
}

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

  await ensureDeployIngress(
    layout,
    parsedPayload.environmentId,
    hasContainers,
    containerHostings,
  );

  const deploymentDir = join(
    layout.stateDir,
    "deployments",
    parsedPayload.environmentId,
  );
  await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

  const principalMaterial = parsedPayload.principalMaterial ?? [];
  await ensureDeployPrincipals(layout, principalMaterial);

  const mountPaths = await resolveDeployMountPaths(
    layout,
    parsedPayload,
    principalMaterial,
    deps?.decryptSecrets,
  );

  const { composeYaml, dockerBindAddress } = await resolveDeployComposeYaml(
    parsedPayload,
    hasContainers,
    mountPaths,
    traditionalWebSites,
    deps?.decryptSecrets,
  );

  await applyDeployTraditionalWebSites(
    layout,
    parsedPayload.environmentId,
    traditionalWebSites,
    dockerBindAddress,
  );

  const composePath = join(deploymentDir, "docker-compose.yml");
  const labeledServices = hasContainers
    ? await deployContainerServices(
      parsedPayload,
      composeYaml,
      containerHostings,
      composePath,
      deploymentDir,
    )
    : await writeDeployComposeMarker(composePath, composeYaml);

  const hostnameTls = await materializeDeployTls(
    layout,
    parsedPayload,
    deps?.decryptSecrets,
  );

  await rewriteHostingCaddySites(layout, parsedPayload, hostnameTls);

  const containers = hasContainers
    ? await collectDeployedContainers(
      parsedPayload.projectName,
      containerHostings,
    )
    : [];

  logInfo(
    "commands",
    `environment.deploy completed project=${parsedPayload.projectName} received=${daemonReceivedAt}`,
  );

  return shapeEnvironmentDeployResult({
    projectName: parsedPayload.projectName,
    environmentId: parsedPayload.environmentId,
    labeledServices,
    traditionalWebSites,
    containers,
  });
}
