import { buildStorageVolumesFragment } from "../../deploy/apply-storage-volumes.ts";
import { buildHostingLabelsFragment } from "../../deploy/compose-labels.ts";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import {
  composeFileArgs,
  type DeploymentManifestSecret,
  type DeploymentManifestV2,
  environmentDeploymentDir,
  legacyDeploymentDir,
  pruneStaleComposeLayerFiles,
  publishStagedRuntimeCompose,
  removeComposeEnvFile,
  removeComposeStageDir,
  resetComposeStageDir,
  RUNTIME_COMPOSE_FILENAME,
  writeComposeEnvFile,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "../../deploy/compose-files.ts";
import {
  mergeComposeOverlayFragments,
  mergeOverlayIntoComposeYaml,
} from "../../deploy/compose-overlay.ts";
import {
  parseComposePsEntries,
  readComposePsContainer,
} from "../../deploy/compose-ps.ts";
import {
  composeFilesHaveContainerServices,
  resolveComposeModel,
  validateComposeConfig,
} from "../../deploy/compose-services.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../../deploy/docker-cli.ts";
import { ensureDocker as defaultEnsureDocker } from "../../deploy/ensure-docker.ts";
import { ensureSystemPrincipals } from "../../deploy/ensure-principal.ts";
import {
  buildTcpUdpIngressEntries,
  cleanupStaleTcpUdpServiceIngress,
  ensureHostingCaddyRuntime,
  ensureHostingIngress,
  ensureServiceIngress,
  rewriteHostingCaddySites,
  serviceIngressComposePath,
  serviceIngressProject,
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
import { ensureExternalDockerNetworks as defaultEnsureExternalDockerNetworks } from "../../deploy/ensure-docker-networks.ts";
import {
  ensureFabricDockerNetworks as defaultEnsureFabricDockerNetworks,
  FABRIC_DEFAULT_MTU,
} from "./fabric.ts";
import { ensureManagedIngressNetwork } from "../../managed/networks.ts";
import {
  buildTraditionalWebReachabilityFragment,
  resolveDockerHostGatewayAddress,
} from "../../deploy/traditional-web-docker.ts";
import { logInfo } from "../../logger.ts";
import {
  materializeSecretFiles,
  rewriteComposeSecretFilePaths,
} from "../../deploy/secret-runtime.ts";
import {
  type EnvironmentDeployComposeFile,
  type EnvironmentDeployContainer,
  type EnvironmentDeployFabricNetwork,
  type EnvironmentDeployHosting,
  type EnvironmentDeployIngressService,
  type EnvironmentDeployPayload,
  type EnvironmentDeployPrincipalMaterial,
  type EnvironmentDeployResult,
  type EnvironmentDeployTraditionalWebSite,
  parseEnvironmentDeployPayload,
} from "./contracts.ts";
import { type LayoutPaths, resolveLayout } from "../../paths/layout.ts";

const SAFE_PATH_ID_RE = /^[A-Za-z0-9_-]+$/;
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/**
 * Best-effort `docker compose ps --format json` after a successful compose up.
 * Never throws. Returns `null` when collection fails (non-authoritative — omit
 * `containers` from the deploy result). Returns `[]` when `ps` succeeds with no
 * rows so the instance can clear stale container pins.
 */
async function collectDeployedContainers(
  projectName: string,
  hostings: EnvironmentDeployHosting[],
  composePaths: readonly string[],
  run: RunDockerFn,
): Promise<EnvironmentDeployContainer[] | null> {
  try {
    const result = await run([
      ...composeFileArgs(projectName, composePaths),
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
      const row = readComposePsContainer(entry, "service");
      if (row === null) continue;
      const serviceId = serviceIdByComposeName.get(row.composeServiceName);
      containers.push({
        ...row,
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

/**
 * Best-effort `docker compose ps` for one per-service Traefik project.
 * Never throws — soft-fails with a log line like service-container collection.
 */
async function collectServiceIngressContainer(
  ingress: EnvironmentDeployIngressService,
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<EnvironmentDeployContainer | null> {
  try {
    const composePath = serviceIngressComposePath(layout, ingress.serviceId);
    const project = serviceIngressProject(ingress.serviceId);
    const result = await run([
      "compose",
      "-p",
      project,
      "-f",
      composePath,
      "ps",
      "--format",
      "json",
    ]);
    if (!result.success) {
      logInfo(
        "commands",
        `environment.deploy ingress collect failed service=${ingress.serviceId}: ${
          result.stderr || "docker compose ps failed"
        }`,
      );
      return null;
    }
    const entries = parseComposePsEntries(result.stdout);
    for (const entry of entries) {
      const row = readComposePsContainer(entry, "ingress");
      if (row === null) continue;
      return {
        ...row,
        serviceId: ingress.serviceId,
      };
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInfo(
      "commands",
      `environment.deploy ingress collect failed service=${ingress.serviceId}: ${message}`,
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
  if (!SAFE_PATH_ID_RE.test(payload.projectId)) {
    throw new Error("projectId contains unsupported characters");
  }
  if (!COMPOSE_PROJECT_RE.test(payload.projectName)) {
    throw new Error("projectName must be a valid Docker Compose project name");
  }
}

export type EnvironmentDeployDeps = {
  decryptSecrets?: DecryptSecretsFn;
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
  /**
   * Test seam — defaults to {@link defaultEnsureDocker}. Avoids real Docker/
   * Ansible install on hermetic suite paths that still exercise compose.
   */
  ensureDocker?: () => Promise<void>;
  /**
   * Test seam — defaults to {@link defaultEnsureExternalDockerNetworks}.
   * When omitted, the default uses `runDocker` from these deps.
   */
  ensureExternalDockerNetworks?: (
    names: readonly string[],
  ) => Promise<void>;
  /**
   * Test seam — defaults to {@link defaultEnsureFabricDockerNetworks}.
   * Deploy self-ensures routed fabric bridges so compose up does not depend
   * on `server.fabric.reconcile` having landed first.
   */
  ensureFabricDockerNetworks?: (
    networks: readonly EnvironmentDeployFabricNetwork[],
    defaultMtu: number,
  ) => Promise<void>;
};

/**
 * True when any container hosting routes HTTP hostnames through the shared
 * loopback Traefik (`turbopanel-ingress`). Empty hostnames and `tcp`/`udp`
 * hostings do not need the shared proxy — per-service Traefik covers raw ports.
 */
export function containerHostingsNeedSharedHttpIngress(
  hostings: readonly EnvironmentDeployHosting[],
): boolean {
  for (const hosting of hostings) {
    if (hosting.protocol === "tcp" || hosting.protocol === "udp") continue;
    if (hosting.hostnames.length > 0) return true;
  }
  return false;
}

/** Sets up Traefik/Docker ingress for container deploys, or the hosting-Caddy-only
 * runtime for traditional-web-only environments. Shared Traefik is HTTP-only and
 * starts only when an HTTP hosting actually routes hostnames; per-service
 * Traefik projects handle tcp/udp via `ingressServices[]`.
 *
 * Services that previously published raw ports but are absent from the new
 * `ingressServices[]` (e.g. tcp/udp → HTTP-only redeploy) are torn down here
 * so a later `environment.stop` does not depend on current hostings to find
 * stale claim files / Traefik projects.
 */
async function ensureDeployIngress(
  layout: LayoutPaths,
  environmentId: string,
  hasContainers: boolean,
  containerHostings: EnvironmentDeployHosting[],
  allHostings: readonly EnvironmentDeployHosting[],
  ingressServices: readonly EnvironmentDeployIngressService[],
  ensureDockerFn: () => Promise<void>,
): Promise<void> {
  const activeIngressServiceIds = new Set(
    ingressServices.map((ingress) => ingress.serviceId),
  );
  const environmentServiceIds = new Set(
    allHostings.map((h) => h.serviceId),
  );

  if (!hasContainers) {
    // Traditional-web-only: hosting Caddy without Traefik/Docker.
    await cleanupStaleTcpUdpServiceIngress(
      layout,
      environmentId,
      environmentServiceIds,
      activeIngressServiceIds,
    );
    await ensureHostingCaddyRuntime(layout);
    return;
  }
  await ensureDockerFn();

  // Shared loopback Traefik only when something HTTP actually needs it —
  // bare nginx/workload deploys must not create the platform `-in` proxy.
  if (containerHostingsNeedSharedHttpIngress(containerHostings)) {
    await ensureHostingIngress(layout);
  }

  await cleanupStaleTcpUdpServiceIngress(
    layout,
    environmentId,
    environmentServiceIds,
    activeIngressServiceIds,
  );

  for (const ingress of ingressServices) {
    const hostingsForService = containerHostings.filter(
      (h) => h.serviceId === ingress.serviceId,
    );
    const entries = buildTcpUdpIngressEntries(hostingsForService);
    const ownEntries = await syncTcpUdpIngressEntries(
      layout,
      ingress.serviceId,
      entries,
    );
    await ensureServiceIngress(layout, ingress.serviceId, ownEntries, {
      serviceId: ingress.serviceId,
      composeServiceName: ingress.composeServiceName,
      containerName: ingress.containerName,
    });
  }
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
      ...(principal.uid === undefined ? {} : { uid: principal.uid }),
      ...(principal.gid === undefined ? {} : { gid: principal.gid }),
      ...(principal.home === undefined ? {} : { home: principal.home }),
      ...(principal.shell === undefined ? {} : { shell: principal.shell }),
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

/**
 * Payload compose files when present; otherwise a single compiled
 * `compose.yaml` from `composeYaml`.
 */
export function resolveDeployComposeFiles(
  payload: EnvironmentDeployPayload,
): EnvironmentDeployComposeFile[] {
  if (payload.composeFiles && payload.composeFiles.length > 0) {
    return payload.composeFiles;
  }
  return [{
    filename: RUNTIME_COMPOSE_FILENAME,
    role: "runtime",
    source: "inline",
    content: payload.composeYaml,
  }];
}

function resolveRuntimeComposeYaml(
  payload: EnvironmentDeployPayload,
  files: readonly EnvironmentDeployComposeFile[],
): string {
  const runtime = files.find((file) =>
    file.role === "runtime" && file.filename === RUNTIME_COMPOSE_FILENAME
  );
  if (runtime) return runtime.content;
  if (files.length === 1) return files[0]!.content;
  return payload.composeYaml;
}

async function sha256HexUtf8(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return encodeHex(new Uint8Array(digest));
}

function replicaCountsForManifest(
  payload: EnvironmentDeployPayload,
  serviceNames: readonly string[],
): Record<string, { replicas: number }> {
  const counts = payload.replicaCounts ?? {};
  const services: Record<string, { replicas: number }> = {};
  for (const name of serviceNames) {
    const replicas = counts[name];
    services[name] = {
      replicas: typeof replicas === "number" && replicas >= 1 ? replicas : 1,
    };
  }
  for (const [name, replicas] of Object.entries(counts)) {
    if (name in services) continue;
    if (replicas >= 1) services[name] = { replicas };
  }
  return services;
}

async function buildDeploymentManifest(
  payload: EnvironmentDeployPayload,
  composeYaml: string,
  serviceNames: readonly string[],
): Promise<DeploymentManifestV2> {
  const secrets = secretPlanToManifest(payload.secretPlan ?? []);
  return {
    version: 2,
    projectId: payload.projectId,
    environmentId: payload.environmentId,
    serverId: payload.serverId ?? "",
    generation: payload.generation ?? 0,
    projectName: payload.projectName,
    composeSha256: await sha256HexUtf8(composeYaml),
    services: replicaCountsForManifest(payload, serviceNames),
    ...(secrets.length > 0 ? { secrets } : {}),
  };
}

function secretPlanToManifest(
  plan: EnvironmentDeployPayload["secretPlan"],
): DeploymentManifestSecret[] {
  if (!plan || plan.length === 0) return [];
  return plan.map((entry) => ({
    source: entry.source,
    target: entry.target,
    relativePath: entry.relativePath,
    composeServiceName: entry.composeServiceName,
    forBuild: entry.forBuild,
    key: entry.key,
    forRuntime: entry.forRuntime,
  }));
}

async function persistComposeEnvFile(
  dir: string,
  envFile: string | undefined,
): Promise<void> {
  if (envFile && envFile.length > 0) {
    await writeComposeEnvFile(dir, envFile);
    return;
  }
  await removeComposeEnvFile(dir);
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

function buildDaemonOverlayFragment(
  parsedPayload: EnvironmentDeployPayload,
  containerHostings: EnvironmentDeployHosting[],
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
  mountPaths: Map<string, string>,
  resolved: Awaited<ReturnType<typeof resolveComposeModel>>,
): ReturnType<typeof mergeComposeOverlayFragments> {
  const storageMaterial = parsedPayload.storageMaterial ?? [];

  const storageFragment = buildStorageVolumesFragment(
    storageMaterial,
    mountPaths,
    resolved,
  );

  const traditionalFragment = traditionalWebSites.length > 0
    ? buildTraditionalWebReachabilityFragment(traditionalWebSites, resolved)
    : {};

  const labelsFragment = buildHostingLabelsFragment({
    payload: parsedPayload,
    hostings: containerHostings,
    resolved,
  });

  return mergeComposeOverlayFragments([
    storageFragment,
    traditionalFragment,
    labelsFragment,
  ]);
}

type DeployContainerServicesInput = {
  layout: LayoutPaths;
  parsedPayload: EnvironmentDeployPayload;
  files: EnvironmentDeployComposeFile[];
  containerHostings: EnvironmentDeployHosting[];
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[];
  mountPaths: Map<string, string>;
  deploymentDir: string;
  run: RunDockerFn;
  decryptSecrets: DecryptSecretsFn | undefined;
  ensureExternalNetworks: (names: readonly string[]) => Promise<void>;
  ensureFabricDockerNetworks: (
    networks: readonly EnvironmentDeployFabricNetwork[],
    defaultMtu: number,
  ) => Promise<void>;
};

async function materializeDeploySecrets(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<void> {
  const plan = payload.secretPlan ?? [];
  if (plan.length === 0) return;
  if (!decryptSecrets) {
    throw new Error("Secret plan present but secrets decrypt is unavailable");
  }
  await materializeSecretFiles(
    layout,
    payload.projectId,
    payload.environmentId,
    plan,
    payload.variableMaterial ?? [],
    decryptSecrets,
  );
}

function applySecretFilePaths(
  yaml: string,
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
): string {
  return rewriteComposeSecretFilePaths(
    yaml,
    layout,
    payload.projectId,
    payload.environmentId,
    payload.secretPlan ?? [],
  );
}

/**
 * Writes one compiled `compose.yaml` (daemon overlay merged in), validates
 * Docker config, publishes `compose.yaml` + `deployment.json` + `.env`, then
 * runs deploy hooks / external networks / compose up. Secret files under
 * `/run` are written before `config`/`up`. A failure before publish leaves
 * the previous live files intact.
 */
async function deployContainerServices(
  input: DeployContainerServicesInput,
): Promise<{ serviceNames: string[]; composePaths: string[] }> {
  const {
    layout,
    parsedPayload,
    files,
    containerHostings,
    traditionalWebSites,
    mountPaths,
    deploymentDir,
    run,
    decryptSecrets,
    ensureExternalNetworks,
    ensureFabricDockerNetworks,
  } = input;
  const stageDir = await resetComposeStageDir(deploymentDir);
  try {
    const stagedPath = join(stageDir, RUNTIME_COMPOSE_FILENAME);
    let yaml = applySecretFilePaths(
      resolveRuntimeComposeYaml(parsedPayload, files),
      layout,
      parsedPayload,
    );
    await writeComposeFileSecure(stagedPath, yaml);
    await persistComposeEnvFile(stageDir, parsedPayload.envFile);
    await materializeDeploySecrets(layout, parsedPayload, decryptSecrets);

    const resolved = await resolveComposeModel(
      parsedPayload.projectName,
      [stagedPath],
      run,
    );

    const fragment = buildDaemonOverlayFragment(
      parsedPayload,
      containerHostings,
      traditionalWebSites,
      mountPaths,
      resolved,
    );
    yaml = applySecretFilePaths(
      mergeOverlayIntoComposeYaml(yaml, fragment),
      layout,
      parsedPayload,
    );
    await writeComposeFileSecure(stagedPath, yaml);

    const labeledServices = [...resolved.serviceNames].sort((a, b) =>
      a.localeCompare(b)
    );
    const manifest = await buildDeploymentManifest(
      parsedPayload,
      yaml,
      labeledServices,
    );

    if (resolved.serviceNames.length === 0) {
      const livePaths = await publishStagedRuntimeCompose(
        deploymentDir,
        stageDir,
        manifest,
      );
      await persistComposeEnvFile(deploymentDir, parsedPayload.envFile);
      logInfo(
        "commands",
        `environment.deploy resolved zero services project=${parsedPayload.projectName}; skipping compose up`,
      );
      return { serviceNames: [], composePaths: livePaths };
    }

    await validateComposeConfig(parsedPayload.projectName, [stagedPath], run);

    const chain = await publishStagedRuntimeCompose(
      deploymentDir,
      stageDir,
      manifest,
    );
    await persistComposeEnvFile(deploymentDir, parsedPayload.envFile);

    const serviceHooks = parsedPayload.serviceHooks ?? [];
    if (serviceHooks.length > 0) {
      await runDeployServiceHooks(serviceHooks, {
        projectName: parsedPayload.projectName,
        composePaths: chain,
        deploymentDir,
        runDocker: run,
      });
    }

    const externalNetworks = parsedPayload.dockerExternalNetworks ?? [];
    if (externalNetworks.length > 0) {
      await ensureExternalNetworks(externalNetworks);
    }

    const fabricNetworks = parsedPayload.fabricNetworks ?? [];
    if (fabricNetworks.length > 0) {
      // Belt-and-braces for the race between reconcile and deploy: a deploy
      // must never depend on `server.fabric.reconcile` having landed first.
      await ensureFabricDockerNetworks(fabricNetworks, FABRIC_DEFAULT_MTU);
    }

    const managedNetworkServices = parsedPayload.managedNetworkServices ?? [];
    if (managedNetworkServices.length > 0) {
      await ensureManagedIngressNetwork(run);
    }

    if (parsedPayload.noCache === true) {
      logInfo(
        "commands",
        `cacheless rebuild for compose project ${parsedPayload.projectName}`,
      );
      const build = await run([
        ...composeFileArgs(parsedPayload.projectName, chain),
        "build",
        "--no-cache",
        "--pull",
      ]);
      if (!build.success) {
        throw new Error(
          build.stderr || "Docker Compose cacheless build failed",
        );
      }
    }

    const up = await run([
      ...composeFileArgs(parsedPayload.projectName, chain),
      "up",
      "-d",
      "--remove-orphans",
    ]);
    if (!up.success) {
      throw new Error(up.stderr || "Docker Compose deployment failed");
    }

    if (serviceHooks.length > 0) {
      await runPostDeployHooks(serviceHooks, deploymentDir);
    }

    return {
      serviceNames: labeledServices,
      composePaths: chain,
    };
  } finally {
    await removeComposeStageDir(deploymentDir);
  }
}

/** Persists compiled `compose.yaml` + `deployment.json` for traditional-web-only
 * deploys (no Docker compose up). */
async function writeDeployComposeMarker(
  parsedPayload: EnvironmentDeployPayload,
  files: EnvironmentDeployComposeFile[],
  deploymentDir: string,
): Promise<string[]> {
  const yaml = resolveRuntimeComposeYaml(parsedPayload, files);
  await writeComposeFileSecure(
    join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
    yaml,
  );
  await persistComposeEnvFile(deploymentDir, parsedPayload.envFile);
  await writeDeploymentManifest(
    deploymentDir,
    await buildDeploymentManifest(parsedPayload, yaml, []),
  );
  await pruneStaleComposeLayerFiles(
    deploymentDir,
    new Set([RUNTIME_COMPOSE_FILENAME]),
  );
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

function resolveEnvironmentDeployRuntime(deps?: EnvironmentDeployDeps): {
  run: RunDockerFn;
  decryptSecrets: DecryptSecretsFn | undefined;
  ensureDockerFn: () => Promise<void>;
  ensureExternalNetworks: (names: readonly string[]) => Promise<void>;
  ensureFabricDockerNetworks: NonNullable<
    EnvironmentDeployDeps["ensureFabricDockerNetworks"]
  >;
} {
  const run = deps?.runDocker ?? defaultRunDocker;
  return {
    run,
    decryptSecrets: deps?.decryptSecrets,
    ensureDockerFn: deps?.ensureDocker ?? defaultEnsureDocker,
    ensureExternalNetworks: deps?.ensureExternalDockerNetworks ??
      ((names: readonly string[]) =>
        defaultEnsureExternalDockerNetworks(names, run)),
    ensureFabricDockerNetworks: deps?.ensureFabricDockerNetworks ??
      defaultEnsureFabricDockerNetworks,
  };
}

async function resolveTraditionalWebDockerBindAddress(
  hasContainers: boolean,
  traditionalWebSites: readonly EnvironmentDeployTraditionalWebSite[],
): Promise<string | null> {
  if (!hasContainers || traditionalWebSites.length === 0) return null;
  return await resolveDockerHostGatewayAddress();
}

async function publishDeployedCompose(
  input: DeployContainerServicesInput & { hasContainers: boolean },
): Promise<{ labeledServices: string[]; composePaths: string[] }> {
  if (!input.hasContainers) {
    const labeledServices = await writeDeployComposeMarker(
      input.parsedPayload,
      input.files,
      input.deploymentDir,
    );
    return { labeledServices, composePaths: [] };
  }
  const deployed = await deployContainerServices(input);
  return {
    labeledServices: deployed.serviceNames,
    composePaths: deployed.composePaths,
  };
}

async function collectEnvironmentDeployContainers(input: {
  hasContainers: boolean;
  projectName: string;
  containerHostings: EnvironmentDeployHosting[];
  composePaths: readonly string[];
  ingressServices: readonly EnvironmentDeployIngressService[];
  layout: LayoutPaths;
  run: RunDockerFn;
}): Promise<EnvironmentDeployContainer[] | null> {
  const containers = input.hasContainers
    ? await collectDeployedContainers(
      input.projectName,
      input.containerHostings,
      input.composePaths,
      input.run,
    )
    : [];
  if (containers === null || input.ingressServices.length === 0) {
    return containers;
  }
  for (const ingress of input.ingressServices) {
    const ingressContainer = await collectServiceIngressContainer(
      ingress,
      input.layout,
      input.run,
    );
    if (ingressContainer) containers.push(ingressContainer);
  }
  return containers;
}

async function removeLegacyDeploymentDir(
  layout: LayoutPaths,
  environmentId: string,
  deploymentDir: string,
): Promise<void> {
  const legacyDir = legacyDeploymentDir(layout, environmentId);
  if (legacyDir === deploymentDir) return;
  try {
    await Deno.remove(legacyDir, { recursive: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    logInfo(
      "commands",
      `environment.deploy leftover pre-cutover dir env=${environmentId}`,
    );
  }
}

export async function handleEnvironmentDeploy(
  payload: EnvironmentDeployPayload,
  daemonReceivedAt: string,
  deps?: EnvironmentDeployDeps,
): Promise<EnvironmentDeployResult> {
  const parsedPayload = parseEnvironmentDeployPayload(payload);
  assertSafeDeploymentIdentifiers(parsedPayload);
  const layout = resolveLayout(Deno.env.toObject());
  const runtime = resolveEnvironmentDeployRuntime(deps);

  const traditionalWebSites = parsedPayload.traditionalWebSites ?? [];
  const traditionalNames = new Set(
    traditionalWebSites.map((site) => site.composeServiceName),
  );
  const files = resolveDeployComposeFiles(parsedPayload);
  const hasContainers = composeFilesHaveContainerServices(
    files.map((file) => file.content),
  );
  const containerHostings = parsedPayload.hostings.filter(
    (hosting) => !traditionalNames.has(hosting.composeServiceName),
  );

  const ingressServices = parsedPayload.ingressServices ?? [];
  await ensureDeployIngress(
    layout,
    parsedPayload.environmentId,
    hasContainers,
    containerHostings,
    parsedPayload.hostings,
    ingressServices,
    runtime.ensureDockerFn,
  );

  const deploymentDir = environmentDeploymentDir(
    layout,
    parsedPayload.projectId,
    parsedPayload.environmentId,
  );
  await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

  const principalMaterial = parsedPayload.principalMaterial ?? [];
  await ensureDeployPrincipals(layout, principalMaterial);

  const mountPaths = await resolveDeployMountPaths(
    layout,
    parsedPayload,
    principalMaterial,
    runtime.decryptSecrets,
  );

  await applyDeployTraditionalWebSites(
    layout,
    parsedPayload.environmentId,
    traditionalWebSites,
    await resolveTraditionalWebDockerBindAddress(
      hasContainers,
      traditionalWebSites,
    ),
  );

  const published = await publishDeployedCompose({
    hasContainers,
    layout,
    parsedPayload,
    files,
    containerHostings,
    traditionalWebSites,
    mountPaths,
    deploymentDir,
    run: runtime.run,
    decryptSecrets: runtime.decryptSecrets,
    ensureExternalNetworks: runtime.ensureExternalNetworks,
    ensureFabricDockerNetworks: runtime.ensureFabricDockerNetworks,
  });

  const hostnameTls = await materializeDeployTls(
    layout,
    parsedPayload,
    runtime.decryptSecrets,
  );

  await rewriteHostingCaddySites(layout, parsedPayload, hostnameTls);

  const containers = await collectEnvironmentDeployContainers({
    hasContainers,
    projectName: parsedPayload.projectName,
    containerHostings,
    composePaths: published.composePaths,
    ingressServices,
    layout,
    run: runtime.run,
  });

  logInfo(
    "commands",
    `environment.deploy completed project=${parsedPayload.projectName} received=${daemonReceivedAt}`,
  );

  await removeLegacyDeploymentDir(
    layout,
    parsedPayload.environmentId,
    deploymentDir,
  );

  return shapeEnvironmentDeployResult({
    projectName: parsedPayload.projectName,
    environmentId: parsedPayload.environmentId,
    labeledServices: published.labeledServices,
    traditionalWebSites,
    containers,
  });
}
