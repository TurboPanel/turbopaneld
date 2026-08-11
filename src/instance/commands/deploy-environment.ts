import { buildSecretVariablesFragment } from "../../deploy/apply-deploy-variables.ts";
import { buildStorageVolumesFragment } from "../../deploy/apply-storage-volumes.ts";
import { buildHostingLabelsFragment } from "../../deploy/compose-labels.ts";
import {
  composeBasename,
  composeFileArgs,
  deploymentDir as resolveDeploymentDir,
  LEGACY_COMPOSE_FILENAME,
  pruneStaleComposeLayerFiles,
  publishStagedComposeChain,
  removeComposeStageDir,
  resetComposeStageDir,
  writeComposeFileManifest,
  writeComposeLayerFiles,
} from "../../deploy/compose-files.ts";
import {
  mergeComposeOverlayFragments,
  writeDaemonComposeLayer,
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
import { ensureManagedIngressNetwork } from "../../managed/networks.ts";
import {
  buildTraditionalWebReachabilityFragment,
  resolveDockerHostGatewayAddress,
} from "../../deploy/traditional-web-docker.ts";
import { logInfo } from "../../logger.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  type EnvironmentDeployComposeFile,
  type EnvironmentDeployContainer,
  type EnvironmentDeployHosting,
  type EnvironmentDeployIngressService,
  type EnvironmentDeployPayload,
  type EnvironmentDeployPrincipalMaterial,
  type EnvironmentDeployResult,
  type EnvironmentDeployTraditionalWebSite,
  parseEnvironmentDeployPayload,
} from "./contracts.ts";
import type { LayoutPaths } from "../../paths/layout.ts";

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
 * Payload compose layers when present; otherwise a one-element legacy chain
 * from `composeYaml` written as `docker-compose.yml`.
 */
export function resolveDeployComposeFiles(
  payload: EnvironmentDeployPayload,
): EnvironmentDeployComposeFile[] {
  if (payload.composeFiles && payload.composeFiles.length > 0) {
    return payload.composeFiles;
  }
  return [{
    filename: LEGACY_COMPOSE_FILENAME,
    role: "project",
    source: "inline",
    content: payload.composeYaml,
  }];
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

async function buildDaemonOverlayFragment(
  parsedPayload: EnvironmentDeployPayload,
  containerHostings: EnvironmentDeployHosting[],
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
  mountPaths: Map<string, string>,
  resolved: Awaited<ReturnType<typeof resolveComposeModel>>,
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<ReturnType<typeof mergeComposeOverlayFragments>> {
  const variableMaterial = parsedPayload.variableMaterial ?? [];
  const storageMaterial = parsedPayload.storageMaterial ?? [];

  let secretsFragment = {};
  if (variableMaterial.length > 0) {
    if (!decryptSecrets) {
      throw new Error(
        "Variable material present but secrets decrypt is unavailable",
      );
    }
    secretsFragment = await buildSecretVariablesFragment(
      variableMaterial,
      decryptSecrets,
      resolved,
    );
  }

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

  // Match historical injection order: secrets → storage → TW reachability → labels.
  return mergeComposeOverlayFragments([
    secretsFragment,
    storageFragment,
    traditionalFragment,
    labelsFragment,
  ]);
}

type DeployContainerServicesRunDeps = {
  run: RunDockerFn;
  decryptSecrets: DecryptSecretsFn | undefined;
  ensureExternalNetworks: (names: readonly string[]) => Promise<void>;
};

/**
 * Labels + writes layers into a stage dir, validates Docker config/overlay,
 * publishes the authoritative live chain (manifest + prune), then runs deploy
 * hooks / external networks / compose up. A failure before publish leaves the
 * previous live manifest and its referenced files intact.
 */
async function deployContainerServices(
  parsedPayload: EnvironmentDeployPayload,
  files: EnvironmentDeployComposeFile[],
  containerHostings: EnvironmentDeployHosting[],
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
  mountPaths: Map<string, string>,
  deploymentDir: string,
  runDeps: DeployContainerServicesRunDeps,
): Promise<{ serviceNames: string[]; composePaths: string[] }> {
  const { run, decryptSecrets, ensureExternalNetworks } = runDeps;
  const stageDir = await resetComposeStageDir(deploymentDir);
  try {
    const userPaths = await writeComposeLayerFiles(
      stageDir,
      files.map((file) => ({ filename: file.filename, content: file.content })),
    );

    const resolved = await resolveComposeModel(
      parsedPayload.projectName,
      userPaths,
      run,
    );

    const fragment = await buildDaemonOverlayFragment(
      parsedPayload,
      containerHostings,
      traditionalWebSites,
      mountPaths,
      resolved,
      decryptSecrets,
    );

    const daemonPath = await writeDaemonComposeLayer(stageDir, fragment);
    const stagedChain = daemonPath === null
      ? [...userPaths]
      : [...userPaths, daemonPath];
    const basenames = stagedChain.map((path) => composeBasename(path));

    if (resolved.serviceNames.length === 0) {
      const livePaths = await publishStagedComposeChain(
        deploymentDir,
        stageDir,
        basenames,
      );
      logInfo(
        "commands",
        `environment.deploy resolved zero services project=${parsedPayload.projectName}; skipping compose up`,
      );
      return { serviceNames: [], composePaths: livePaths };
    }

    // Validate against the staged chain before touching the live directory.
    await validateComposeConfig(parsedPayload.projectName, stagedChain, run);

    // Publish is the cutover: new manifest becomes authoritative, stale live
    // layers (including prior daemon overlay) are pruned only here.
    const chain = await publishStagedComposeChain(
      deploymentDir,
      stageDir,
      basenames,
    );

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
      serviceNames: [...resolved.serviceNames].sort((a, b) =>
        a.localeCompare(b)
      ),
      composePaths: chain,
    };
  } finally {
    await removeComposeStageDir(deploymentDir);
  }
}

/** Persists layer files + manifest so stop/lifecycle stay consistent for
 * traditional-web-only deploys (no daemon layer, no Docker calls). */
async function writeDeployComposeMarker(
  deploymentDir: string,
  files: EnvironmentDeployComposeFile[],
): Promise<string[]> {
  // Write first, then commit the manifest, then prune — so a failed rewrite
  // cannot delete files still referenced by an older manifest.
  const userPaths = await writeComposeLayerFiles(
    deploymentDir,
    files.map((file) => ({ filename: file.filename, content: file.content })),
  );
  const basenames = userPaths.map((path) => composeBasename(path));
  await writeComposeFileManifest(deploymentDir, basenames);
  await pruneStaleComposeLayerFiles(deploymentDir, new Set(basenames));
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
  const run = deps?.runDocker ?? defaultRunDocker;
  const ensureDockerFn = deps?.ensureDocker ?? defaultEnsureDocker;
  const ensureExternalNetworks = deps?.ensureExternalDockerNetworks ??
    ((names: readonly string[]) =>
      defaultEnsureExternalDockerNetworks(names, run));

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
    ensureDockerFn,
  );

  const deploymentDir = resolveDeploymentDir(
    layout,
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

  const mixedTraditionalAndContainers = hasContainers &&
    traditionalWebSites.length > 0;
  const dockerBindAddress = mixedTraditionalAndContainers
    ? await resolveDockerHostGatewayAddress()
    : null;

  await applyDeployTraditionalWebSites(
    layout,
    parsedPayload.environmentId,
    traditionalWebSites,
    dockerBindAddress,
  );

  let labeledServices: string[] = [];
  let composePathsForCollect: string[] = [];
  if (hasContainers) {
    const deployed = await deployContainerServices(
      parsedPayload,
      files,
      containerHostings,
      mixedTraditionalAndContainers ? traditionalWebSites : [],
      mountPaths,
      deploymentDir,
      { run, decryptSecrets: deps?.decryptSecrets, ensureExternalNetworks },
    );
    labeledServices = deployed.serviceNames;
    composePathsForCollect = deployed.composePaths;
  } else {
    labeledServices = await writeDeployComposeMarker(deploymentDir, files);
  }

  const hostnameTls = await materializeDeployTls(
    layout,
    parsedPayload,
    deps?.decryptSecrets,
  );

  await rewriteHostingCaddySites(layout, parsedPayload, hostnameTls);

  const containers: EnvironmentDeployContainer[] | null = hasContainers
    ? await collectDeployedContainers(
      parsedPayload.projectName,
      containerHostings,
      composePathsForCollect,
      run,
    )
    : [];

  if (containers !== null && ingressServices.length > 0) {
    for (const ingress of ingressServices) {
      const ingressContainer = await collectServiceIngressContainer(
        ingress,
        layout,
        run,
      );
      if (ingressContainer) containers.push(ingressContainer);
    }
  }

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
