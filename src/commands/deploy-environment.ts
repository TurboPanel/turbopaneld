import {
  buildStorageVolumesFragment,
  declaredVolumeUsers,
} from "../deploy/apply-storage-volumes.ts";
import { applyVolumeAccess } from "../deploy/volume-access.ts";
import {
  deploymentBindWarnings,
  ensureNamedVolumeOwners,
  namedVolumeOwnerTargets,
} from "../deploy/named-volume-owner.ts";
import { buildHostingLabelsFragment } from "../deploy/compose-labels.ts";
import { assertComposePolicy } from "../deploy/compose-final-policy.ts";
import { assertNoReservedOwnerLabels } from "../deploy/compose-reserved-labels.ts";
import { assertComposeBuildPolicy } from "../deploy/compose-build-policy.ts";
import {
  DeployCancelledError,
  type DeployCancelToken,
} from "../deploy/deploy-cancel.ts";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import type { FolderRefParts } from "../contracts/directory-names.ts";
import {
  composeFileArgs,
  DEPLOYMENT_MANIFEST_FILENAME,
  type DeploymentManifest,
  type DeploymentManifestRelease,
  type DeploymentManifestSecret,
  environmentDeploymentDir,
  previousComposePaths,
  pruneStaleComposeLayerFiles,
  publishStagedRuntimeCompose,
  readDeploymentManifest,
  removeComposeEnvFile,
  removeComposeStageDir,
  resetComposeStageDir,
  resolveDeployedComposePaths,
  restorePreviousDeployment,
  RUNTIME_COMPOSE_FILENAME,
  writeComposeEnvFile,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "../deploy/compose-files.ts";
import {
  projectsForCommand,
  singleGeneration,
} from "../deploy/deployment-generations.ts";
import {
  readPreviousProjects,
  retirePreviousProjects,
} from "../deploy/retire-previous-projects.ts";
import {
  applyImageBuildImagesToComposeYaml,
  mergeComposeOverlayFragments,
  mergeOverlayIntoComposeYaml,
} from "../deploy/compose-overlay.ts";
import {
  parseComposePsEntries,
  readComposePsContainer,
} from "../deploy/compose-ps.ts";
import {
  composeFilesHaveContainerServices,
  resolveComposeModel,
  validateComposeConfig,
} from "../deploy/compose-services.ts";
import {
  createStreamedRunner,
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
  type RunDockerStreamedFn,
} from "../deploy/docker-cli.ts";
import { captureDecryptedSecrets } from "../logs/capture.ts";
import { resolveSiteSecretEnv } from "../deploy/site/site-secret-env.ts";
import {
  COMMAND_LOG_PHASES,
  type CommandOutputSink,
  createNoopCommandOutputSink,
} from "../logs/contracts.ts";
import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import { ensureBuildkitImageBuild } from "../deploy/release/image-build.ts";
import { observeBuildSlot } from "../deploy/release/build-sandbox.ts";
import { nativeAppRuntimeKind } from "../deploy/native/unit.ts";
import {
  createNoopDeployStepReporter,
  createPlaybookEventHandler,
  type DeployStepReporter,
  type PlannedDeployStep,
} from "./deploy-progress.ts";
import {
  automaticCertificateDetail,
  certificatesStep,
  type DeployPresenceProbes,
  deployStepNeeds,
  HEALTH_RESULT_TITLES,
  HEALTH_STEP_ID,
  installStepIds,
  planDeploySteps,
  probeDeployPresence,
} from "./deploy-progress-plan.ts";
import {
  ensureSystemPrincipals,
  reportPrincipalIds,
} from "../deploy/ensure-principal.ts";
import { applySshAccess, type PrincipalSshSpec } from "../deploy/ssh/apply.ts";
import {
  assertHostingNamesFree,
  buildTcpUdpIngressEntries,
  cleanupStaleTcpUdpServiceIngress,
  ensureHostingCaddyRuntime,
  ensureHostingIngress,
  ensureServiceIngress,
  resetHostingCaddyRuntimeEnsuredForDeploy,
  rewriteHostingCaddySites,
  serviceIngressComposePath,
  serviceIngressProject,
  syncTcpUdpIngressEntries,
} from "../deploy/ingress.ts";
import {
  materializeStorageEntries,
  resolveVolumeOwnerIds,
  type VolumeOwnerIds,
} from "../deploy/materialize-storage.ts";
import {
  type DecryptSecretsFn,
  hostnameTlsMap,
  materializeTlsCertificates,
} from "../deploy/materialize-tls.ts";
import {
  runSequentialDeploy,
  type SequentialDeploySteps,
} from "../deploy/sequential-deploy.ts";
import {
  composePsForGate,
  HEALTH_GATE_DEFAULT_POLL_MS,
  HEALTH_GATE_DEFAULT_STABLE_MS,
  type HealthGateResult,
  type HealthGateTick,
  waitForHealthGate,
} from "../deploy/health-gate.ts";
import {
  assertHooksConfined,
  runDeployServiceHooks,
  runPostDeployHooks,
} from "../deploy/run-deploy-hooks.ts";
import {
  applySites,
  ensureSiteEngines,
  planSiteWebEnv,
  pruneHoldKeysForDeploy,
  removeNamedSites,
  resolveSiteDocumentRoot,
  type SiteManagedDirectory,
  type SiteRelease,
  siteWritableDirs,
} from "../deploy/site.ts";
import { detectSiteApps } from "../deploy/site-apps.ts";
import {
  clearAppliedDeployHash,
  readAppliedDeployHash,
  writeAppliedDeployHash,
} from "../deploy/applied-deploy-hash.ts";
import { environmentLockKey, withKeyedLock } from "../util/keyed-lock.ts";
import {
  createHostProbe,
  type HostProbe,
  hostStillRunsDeploy,
  usesMutableImageTag,
} from "../deploy/unchanged-deploy.ts";
import { holdPruneKeys } from "../deploy/site/prune-holds.ts";
import {
  applyCronJobs,
  type CronApplySpec,
  hasInstalledCronUnits,
} from "../deploy/cron/apply.ts";
import {
  type AppliedRelease,
  applySourceReleases,
  resolveReleaseServiceId,
} from "../deploy/release/apply-source-releases.ts";
import {
  serviceFolderFromPayload,
} from "../deploy/release/release-service-id.ts";
import {
  applyNativeAppServices,
  type ApplyNativeAppsOpts,
  ensureNativeAppRuntime,
  type NativeAppBindings,
  nativeAppBindingsFromPayload,
  nativeAppIsServing,
  type RuntimeChoice,
} from "../deploy/native/apply-native-apps.ts";
import {
  siteBuildRuntimes,
  sitesWithReleaseRoots,
} from "../deploy/release/site-release.ts";
import {
  keptServiceFolders,
  type ReleaseTreeRef,
} from "../deploy/release/retention.ts";
import { runPrivileged as defaultRunPrivileged } from "../deploy/release/release-layout.ts";
import type { RunFn } from "../deploy/ensure-principal.ts";
import {
  ensureExternalDockerNetworks as defaultEnsureExternalDockerNetworks,
  type ExternalDockerNetworkSpec,
} from "../deploy/ensure-docker-networks.ts";
import {
  ensureFabricDockerNetworks as defaultEnsureFabricDockerNetworks,
  FABRIC_DEFAULT_MTU,
} from "./fabric.ts";
import { ensureManagedIngressNetwork } from "../managed/networks.ts";
import {
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  writeSystemComponentDescriptor,
} from "../deploy/system-component.ts";
import {
  buildSiteReachabilityFragment,
  resolveDockerHostGatewayAddress,
} from "../deploy/site-docker.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { definedFields } from "../util/optional-fields.ts";
import {
  assertComposeHostPathsConfined,
  collectAuthoredHostPaths,
  collectResolvedHostPaths,
  priorWritableMounts,
} from "../deploy/compose-host-paths.ts";
import {
  materializeSecretFiles,
  pruneStaleSecretFiles,
  removeSecretTree,
  rewriteComposeSecretFilePaths,
} from "../deploy/secret-runtime.ts";
import {
  type EnvironmentDeployComposeFile,
  type EnvironmentDeployContainer,
  type EnvironmentDeployFabricNetwork,
  type EnvironmentDeployHosting,
  type EnvironmentDeployIngressService,
  type EnvironmentDeployNativeAppService,
  type EnvironmentDeployPayload,
  type EnvironmentDeployPrincipalMaterial,
  type EnvironmentDeployResult,
  type EnvironmentDeployResultRelease,
  type EnvironmentDeployResultSite,
  type EnvironmentDeployServiceHook,
  type EnvironmentDeploySite,
  type EnvironmentDeploySource,
  type EnvironmentDeployStorageMaterial,
  type KeptFolder,
  parseEnvironmentDeployPayload,
  type PrincipalIdReport,
} from "../contracts/commands-contracts.ts";
import {
  type LayoutPaths,
  resolveLayout,
  serviceTree,
  volumeFolder,
} from "../paths/layout.ts";

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
  /**
   * Execution-log transcript sink (`src/logs/`). Optional everywhere — the
   * default no-op sink keeps existing callers and tests unchanged.
   */
  logSink?: CommandOutputSink;
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
  /**
   * Test seam — defaults to {@link defaultEnsureDocker}. Avoids real Docker/
   * Ansible install on hermetic suite paths that still exercise compose.
   */
  ensureDocker?: () => Promise<void>;
  /** Test seam — defaults to {@link waitForHealthGate} (real polling and sleeps). */
  waitForHealth?: typeof waitForHealthGate;
  /**
   * Test seam — defaults to {@link defaultEnsureExternalDockerNetworks}.
   * When omitted, the default uses `runDocker` from these deps. Receives one
   * spec per `dockerExternalNetworks` name, zipped with any
   * `dockerNetworkAddressing` entry (a name without one is a bare `{ name }`).
   */
  ensureExternalDockerNetworks?: (
    networks: readonly ExternalDockerNetworkSpec[],
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
  /**
   * Test seam — privileged `sudo -n …` runner used to reclaim the release trees
   * of services that lost their source. Defaults to {@link runPrivileged}.
   */
  runPrivileged?: RunFn;
  /**
   * Test seam — the native-app apply's own IO (privileged runner, Ansible,
   * loopback probe, sleep, systemd unit dir). Omitted in production, where each
   * one falls back to the real implementation inside
   * {@link applyNativeAppServices}. It exists so a **mixed** deploy — containers
   * alongside a hosted native app — can be exercised end to end without systemd
   * or a real `ansible-playbook` run.
   */
  nativeAppIo?: Omit<ApplyNativeAppsOpts, "bindings">;
  /** Test seam: how the host is asked whether a skipped deploy is still running. */
  hostProbe?: HostProbe;
  /** Test seam — the Ansible runner for the early site engine install. */
  siteIo?: Parameters<typeof ensureSiteEngines>[1];
  /**
   * Step plan + live progress reporter (`./deploy-progress.ts`), created by
   * the command router on the dispatch socket. Absent (tests, other callers)
   * means the no-op reporter: nothing is planned and no host probe runs.
   */
  progress?: DeployStepReporter;
  /** Test seam — the presence probes behind the step plan. */
  presenceProbes?: DeployPresenceProbes;
  /**
   * Cancel token of this deploy (`../deploy/deploy-cancel.ts`). Checked between
   * phases and handed to the processes the deploy spawns; the first step that
   * changes what is serving commits it, after which a cancel is "too late".
   */
  cancel?: DeployCancelToken;
  /** Test seam — whether cron timers from an earlier deploy are installed. */
  hasCronUnits?: (environmentId: string) => Promise<boolean>;
};

/**
 * True when any HTTP hosting publishes at least one public hostname on the
 * edge (hosting Caddy and/or shared loopback Traefik). `tcp`/`udp` hostings
 * and empty hostname lists are ignored.
 */
export function hostingsNeedPublicHttpEdge(
  hostings: readonly EnvironmentDeployHosting[],
): boolean {
  for (const hosting of hostings) {
    if (hosting.protocol === "tcp" || hosting.protocol === "udp") continue;
    if (hosting.hostnames.length > 0) return true;
  }
  return false;
}

/**
 * True when any container hosting routes HTTP hostnames through the shared
 * loopback Traefik. Empty hostnames and `tcp`/`udp`
 * hostings do not need the shared proxy — per-service Traefik covers raw ports.
 */
export function containerHostingsNeedSharedHttpIngress(
  hostings: readonly EnvironmentDeployHosting[],
): boolean {
  return hostingsNeedPublicHttpEdge(hostings);
}

/**
 * Persist the shared HTTP Traefik identity from an `environment.deploy`
 * payload so {@link ensureHostingIngress} emits `container_name: <serviceId>-in`
 * instead of Compose's default `<project>-traefik-1`.
 *
 * No-op when the field is omitted (older payloads still fall back to a
 * descriptor written by `system.reconcile`, or anonymous Traefik).
 */
export async function persistHostingIngressIdentity(
  layout: LayoutPaths,
  hostingIngress?: EnvironmentDeployIngressService,
): Promise<void> {
  if (!hostingIngress) return;
  await writeSystemComponentDescriptor(layout, {
    component: SYSTEM_HOSTING_INGRESS_COMPONENT,
    serviceId: hostingIngress.serviceId,
    composeServiceName: hostingIngress.composeServiceName,
    containerName: hostingIngress.containerName,
    role: "ingress",
  });
}

/** Sets up Traefik/Docker ingress for container deploys, or the hosting-Caddy-only
 * runtime for site-only environments. Shared Traefik is HTTP-only and
 * starts only when an HTTP hosting actually routes hostnames; per-service
 * Traefik projects handle tcp/udp via `ingressServices[]`.
 *
 * Services that previously published raw ports but are absent from the new
 * `ingressServices[]` (e.g. tcp/udp → HTTP-only redeploy) are torn down here
 * so a later `environment.stop` does not depend on current hostings to find
 * stale claim files / Traefik projects.
 */
type EnsureDeployIngressParams = {
  layout: LayoutPaths;
  environmentId: string;
  hasContainers: boolean;
  containerHostings: EnvironmentDeployHosting[];
  allHostings: readonly EnvironmentDeployHosting[];
  ingressServices: readonly EnvironmentDeployIngressService[];
  hostingIngress?: EnvironmentDeployIngressService;
  /**
   * Shared hosting-ingress Docker network / compose project — the
   * `hosting-ingress` component's allocated `serviceId`. The wire contract
   * requires it exactly when the payload carries hostings, and both branches
   * that read it are reached only through a non-empty hosting list.
   */
  hostingIngressNetwork?: string;
  ensureDockerFn: () => Promise<void>;
  /** Docker CLI seam — must reach every ingress helper so tests never touch real Docker. */
  runDocker: RunDockerFn;
  listenerPorts?: EnvironmentDeployPayload["listenerPorts"];
  progress: DeployProgressRuntime;
};

/** The transcript sink and step reporter one deploy shares. */
type DeployProgressRuntime = {
  logSink: CommandOutputSink;
  progress: DeployStepReporter;
  /** The phase the sink is on, so an install can hand it back afterwards. */
  currentPhase: () => string;
};

/**
 * One on-demand install as a step of the plan: its own transcript phase while
 * it runs, the step(s) running → done / failed around it, and the previous
 * phase restored afterwards (the build tool installs mid-`build`).
 */
async function runInstallStep<T>(
  runtime: DeployProgressRuntime,
  ids: readonly string[],
  phase: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previousPhase = runtime.currentPhase();
  runtime.logSink.setPhase(phase);
  // Nested: an install mid-`build` (the build tool) leaves `build` running.
  runtime.progress.start(ids, { nested: true });
  try {
    const result = await fn();
    runtime.progress.done(ids);
    return result;
  } catch (err) {
    runtime.progress.fail(ids);
    throw err;
  } finally {
    runtime.logSink.setPhase(previousPhase);
  }
}

/**
 * Playbook events → transcript lines + the ticker of the first step of the
 * group that actually has work (a grouped install may start with a `ready`
 * one: Node 20 vendored, Node 22 missing).
 */
function installEvents(
  runtime: DeployProgressRuntime,
  ids: readonly string[],
  fallbackId: string,
  plan: readonly PlannedDeployStep[] = [],
) {
  const pending = plan.find((step) =>
    step.state === "pending" && ids.includes(step.id)
  );
  return createPlaybookEventHandler(
    runtime.logSink,
    runtime.progress,
    pending?.id ?? ids[0] ?? fallbackId,
  );
}

/**
 * Both ingress paths below run only when this deploy has hostings, and the
 * wire contract makes `hostingIngressNetwork` required in exactly that case —
 * so an absent value here means a control plane that never sent it, not an
 * optional field. Fail loudly rather than reconstruct a literal.
 */
function requireHostingIngressNetwork(value: string | undefined): string {
  if (value === undefined) {
    throw new Error(
      "environment.deploy requires hostingIngressNetwork when hostings are present",
    );
  }
  return value;
}

async function ensureDeployIngress(
  params: EnsureDeployIngressParams,
): Promise<void> {
  const {
    layout,
    environmentId,
    hasContainers,
    containerHostings,
    allHostings,
    ingressServices,
    hostingIngress,
    hostingIngressNetwork,
    ensureDockerFn,
    runDocker,
    listenerPorts,
    progress,
  } = params;
  const gatewayStep = <T>(fn: () => Promise<T>) =>
    runInstallStep(
      progress,
      ["install-gateway"],
      COMMAND_LOG_PHASES.INSTALL_GATEWAY,
      fn,
    );
  const caddyDeps = {
    onEvent: installEvents(progress, ["install-gateway"], "install-gateway"),
  };
  const activeIngressServiceIds = new Set(
    ingressServices.map((ingress) => ingress.serviceId),
  );
  const environmentServiceIds = new Set(
    allHostings.map((h) => h.serviceId),
  );

  if (!hasContainers) {
    // Sites only: hosting Caddy without Traefik/Docker.
    await cleanupStaleTcpUdpServiceIngress(
      layout,
      environmentId,
      environmentServiceIds,
      activeIngressServiceIds,
      { runDocker },
    );
    if (hostingsNeedPublicHttpEdge(allHostings)) {
      await gatewayStep(() => ensureHostingCaddyRuntime(layout, caddyDeps));
    }
    return;
  }
  await runInstallStep(
    progress,
    ["install-docker"],
    COMMAND_LOG_PHASES.INSTALL_DOCKER,
    ensureDockerFn,
  );

  // Shared loopback Traefik only when something HTTP actually needs it —
  // bare nginx/workload deploys must not create the platform `-in` proxy.
  if (containerHostingsNeedSharedHttpIngress(containerHostings)) {
    await persistHostingIngressIdentity(layout, hostingIngress);
    await gatewayStep(() =>
      ensureHostingIngress(
        layout,
        requireHostingIngressNetwork(hostingIngressNetwork),
        { runDocker },
      )
    );
  }

  await cleanupStaleTcpUdpServiceIngress(
    layout,
    environmentId,
    environmentServiceIds,
    activeIngressServiceIds,
    { runDocker },
  );

  await forEachSequential(ingressServices, async (ingress) => {
    const hostingsForService = containerHostings.filter(
      (h) => h.serviceId === ingress.serviceId,
    );
    const entries = buildTcpUdpIngressEntries(hostingsForService);
    const ownEntries = await syncTcpUdpIngressEntries(
      layout,
      ingress.serviceId,
      entries,
      listenerPorts,
    );
    await ensureServiceIngress(
      layout,
      ingress.serviceId,
      ownEntries,
      {
        serviceId: ingress.serviceId,
        composeServiceName: ingress.composeServiceName,
        containerName: ingress.containerName,
      },
      requireHostingIngressNetwork(hostingIngressNetwork),
      { runDocker },
    );
  });

  // Edge hostnames on host-native services (sites, native apps) still reach
  // hosting Caddy even when no container hosting needs shared Traefik.
  if (hostingsNeedPublicHttpEdge(allHostings)) {
    await gatewayStep(() => ensureHostingCaddyRuntime(layout, caddyDeps));
  }
}

/**
 * Principals this deploy must exist on the host: `principalMaterial[]` plus any
 * principal only named by a `sourceMaterial[]` entry.
 *
 * A Git-backed release publishes into `<principalHome>/sites/…`, so its owner
 * has to be created before the release engine runs — even when nothing else in
 * the payload references that principal.
 */
export function deployPrincipalSpecs(
  parsedPayload: Pick<EnvironmentDeployPayload, "sourceMaterial" | "sites">,
  principalMaterial: EnvironmentDeployPrincipalMaterial[],
): EnvironmentDeployPrincipalMaterial[] {
  const byId = new Map<string, EnvironmentDeployPrincipalMaterial>();
  for (const principal of principalMaterial) {
    byId.set(principal.principalId, principal);
  }
  for (const entry of parsedPayload.sourceMaterial ?? []) {
    const principal = entry.principal;
    if (!principal || byId.has(principal.principalId)) continue;
    byId.set(principal.principalId, {
      principalId: principal.principalId,
      username: principal.username,
      ...(principal.uid === undefined ? {} : { uid: principal.uid }),
      ...(principal.gid === undefined ? {} : { gid: principal.gid }),
      ...(principal.idSource === undefined
        ? {}
        : { idSource: principal.idSource }),
    });
  }
  return [...byId.values()];
}

async function ensureDeployPrincipals(
  layout: LayoutPaths,
  principalMaterial: EnvironmentDeployPrincipalMaterial[],
): Promise<PrincipalIdReport[]> {
  if (principalMaterial.length === 0) return [];
  await ensureSystemPrincipals(
    layout,
    principalMaterial.map((principal) => ({
      principalId: principal.principalId,
      username: principal.username,
      ...(principal.uid === undefined ? {} : { uid: principal.uid }),
      ...(principal.gid === undefined ? {} : { gid: principal.gid }),
      ...(principal.idSource === undefined
        ? {}
        : { idSource: principal.idSource }),
      ...(principal.home === undefined ? {} : { home: principal.home }),
      ...(principal.shell === undefined ? {} : { shell: principal.shell }),
      ...(principal.accessGroups === undefined
        ? {}
        : { accessGroups: principal.accessGroups }),
      ...(principal.passwordHash === undefined
        ? {}
        : { passwordHash: principal.passwordHash }),
    })),
  );

  await applyDeploySshAccess(principalMaterial);
  return await reportPrincipalIds(
    principalMaterial,
    undefined,
    layout.principalHomeRoot,
  );
}

/**
 * Key files and the `sshd` drop-in for the principals a deploy materialized.
 *
 * Runs on **every** deploy that materializes a principal, keys or not. The
 * drop-in's backstop block is what stops a principal with no SSH level from
 * signing in with a key it planted in its own home and tunnelling into the
 * host; gating this on declared keys left that drop-in off every host whose
 * tenants never asked for SSH — the default case.
 *
 * Key files, but **never** the removal sweep: this payload describes one
 * environment and the host serves many, so pruning here would revoke every
 * other environment's access. `server.principals.reconcile` is the caller that
 * holds the whole server and is allowed to delete. A principal whose material
 * says nothing about keys (`sshKeys` absent) gets no key file written.
 */
export async function applyDeploySshAccess(
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[],
  apply: (
    principals: readonly PrincipalSshSpec[],
  ) => Promise<unknown> = applySshAccess,
): Promise<void> {
  if (principalMaterial.length === 0) return;
  const withKeys = principalMaterial.filter(
    (principal) => principal.sshKeys !== undefined,
  );
  try {
    await apply(
      withKeys.map((principal) => ({
        username: principal.username,
        keys: principal.sshKeys ?? [],
      })),
    );
  } catch (err) {
    // Warn, do not fail. A host whose `sshd_config` has no `Include` line
    // cannot take the drop-in, and that is a real problem — but it is not a
    // reason to refuse to deploy an application. The key files themselves are
    // written before that check, so the account is left correct-but-not-yet
    // -consulted, and `server.principals.reconcile` is where the operator
    // sees the failure as a failure.
    logWarn(
      "deploy",
      `ssh access could not be applied: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
 * Compiled runtime `compose.yaml` from the required `composeFiles` snapshot.
 */
export function resolveDeployComposeFiles(
  payload: EnvironmentDeployPayload,
): EnvironmentDeployComposeFile[] {
  return payload.composeFiles;
}

export function resolveRuntimeComposeYaml(
  files: readonly EnvironmentDeployComposeFile[],
): string {
  const runtime = files.find((file) =>
    file.role === "runtime" && file.filename === RUNTIME_COMPOSE_FILENAME
  );
  if (runtime) return runtime.content;
  if (files.length === 1) return files[0]!.content;
  throw new Error("composeFiles must include role runtime compose.yaml");
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

/**
 * Compose service name → TurboPanel service UUID, as the deploy payload
 * declared it. Persisted so the on-demand log tail can decide whether a
 * requested container belongs to the service being asked about, from
 * deployment state rather than a live container label.
 */
function serviceIdsForManifest(
  payload: EnvironmentDeployPayload,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const hosting of payload.hostings ?? []) {
    if (!hosting.composeServiceName || !hosting.serviceId) continue;
    out[hosting.composeServiceName] = hosting.serviceId;
  }
  return out;
}

/**
 * `sourceMaterial[]` → durable per-service release rows.
 *
 * Written at the environment level so the host keeps its own record of which
 * release and commit each Git-backed service is on. `deployment.json` is what
 * the reboot / reconnect paths read (`environment.lifecycle`,
 * `rehydrate-deployments.ts`); without these rows they can restart the stack but
 * cannot say what code it is running once the control plane is unreachable.
 *
 * `serviceId` is resolved the same way the release engine resolves the release
 * directory segment ({@link resolveReleaseServiceId}), so the recorded identity
 * addresses the tree that was actually published.
 *
 * **The commit comes from the release engine, not the payload, whenever the
 * engine ran.** On a rollback the payload's `commitSha` is a stored copy the
 * control plane sent along; the authority is the promoted release's own
 * manifest, which {@link applySourceReleases} already read back. Preferring the
 * applied result keeps `deployment.json` from claiming a rolled-back service is
 * serving a commit it is not. The payload remains the fallback for entries the
 * engine skipped (no owning principal) and for the marker-only write path, which
 * publishes the manifest without running the engine at all.
 */
function releasesForManifest(
  payload: EnvironmentDeployPayload,
  applied: readonly AppliedRelease[] = [],
): DeploymentManifestRelease[] {
  const appliedByService = new Map(
    applied.map((entry) => [entry.composeServiceName, entry]),
  );
  const out: DeploymentManifestRelease[] = [];
  for (const entry of payload.sourceMaterial ?? []) {
    const result = appliedByService.get(entry.composeServiceName);
    const commitSha = result?.commitSha ?? entry.commitSha;
    const commitMessage = result?.commitMessage ?? entry.commitMessage;
    const commitAuthor = result?.commitAuthor ?? entry.commitAuthor;
    const serviceId = result?.serviceId ??
      resolveReleaseServiceId(payload, entry.composeServiceName);
    const folder = entry.principal
      ? serviceFolderFromPayload(payload, serviceId)
      : undefined;
    out.push({
      composeServiceName: entry.composeServiceName,
      serviceId,
      // A rollback's live release is the one it promoted, not the id the
      // control plane would have allocated for a fresh build.
      releaseId: result?.releaseId ?? entry.rollbackToReleaseId ??
        entry.releaseId,
      sourceId: entry.sourceId,
      commitSha,
      ...(commitMessage === undefined ? {} : { commitMessage }),
      ...(commitAuthor === undefined ? {} : { commitAuthor }),
      ...(entry.ref.length > 0 ? { ref: entry.ref } : {}),
      ...(entry.principal && folder
        ? { username: entry.principal.username, folder }
        : {}),
    });
  }
  return out;
}

/**
 * Compose service name → the image an image-build release built for it.
 *
 * Only entries that actually produced an image are in the map, so a deploy with
 * no image-build services yields an empty map and
 * {@link applyImageBuildImagesToComposeYaml} is a no-op. Rollbacks are included:
 * `applySourceReleases` reads the tag back off the target release's manifest,
 * so restoring an image-build release is the same "write this tag into compose"
 * operation a fresh build is.
 */
function imageBuildImagesByService(
  applied: readonly AppliedRelease[],
): Map<string, string> {
  const images = new Map<string, string>();
  for (const release of applied) {
    if (!release.imageTag) continue;
    images.set(release.composeServiceName, release.imageTag);
  }
  return images;
}

/**
 * `AppliedRelease[]` → the release rows the command result carries.
 *
 * The control plane's release-history and rollback surface reads this instead
 * of asking the host again. It is deliberately generic across both lanes: a
 * native release reports its commit, an image-build release additionally reports
 * the image tag and the pinned frontend / plan versions that produced it,
 * because "which directory" is not an identity an image-build release has.
 */
function deployResultReleases(
  applied: readonly AppliedRelease[],
): EnvironmentDeployResultRelease[] {
  return applied.map((release) => ({
    composeServiceName: release.composeServiceName,
    serviceId: release.serviceId,
    releaseId: release.releaseId,
    commitSha: release.commitSha,
    ...(release.imageTag === undefined ? {} : { imageTag: release.imageTag }),
    ...(release.builderFrontendVersion === undefined
      ? {}
      : { builderFrontendVersion: release.builderFrontendVersion }),
    ...(release.builderPlanVersion === undefined
      ? {}
      : { builderPlanVersion: release.builderPlanVersion }),
  }));
}

/**
 * Compose service name → the release tree it serves from.
 *
 * Built from `sourceMaterial[]` on **every** deploy, not only when a release was
 * freshly promoted: a redeploy that does not touch the source still has to point
 * the document root at `current`, or the site would silently fall back to the
 * empty daemon-owned tree. Entries with no principal are skipped for the same reason the release engine
 * skips them — there is no home to serve out of.
 */
function deployReleaseBindings(
  payload: EnvironmentDeployPayload,
): Map<string, SiteRelease> {
  const bindings = new Map<string, SiteRelease>();
  for (const entry of payload.sourceMaterial ?? []) {
    if (entry.principal === undefined) continue;
    bindings.set(
      entry.composeServiceName,
      bindingFor(payload, {
        serviceId: resolveReleaseServiceId(payload, entry.composeServiceName),
        username: entry.principal.username,
      }),
    );
  }
  return bindings;
}

/** A service's binding: its ids and the folder the payload plans for it (refused when absent). */
function bindingFor(
  payload: EnvironmentDeployPayload,
  row: { serviceId: string; username: string },
): SiteRelease {
  return {
    serviceId: row.serviceId,
    username: row.username,
    folder: serviceFolderFromPayload(payload, row.serviceId),
  };
}

/**
 * Compose service name → the principal-owned upload folder it serves from
 * (`public/`).
 *
 * Same `serviceId` rule as {@link deployReleaseBindings} on purpose, so
 * `public/` and `current` are siblings and connecting a repository later is a
 * field flip rather than a move.
 *
 * A site that carries **both** a release and `sourceKind: managed-directory` is
 * not a mixed state to reconcile: the release wins, because a promoted tree is
 * what the release engine actually published and serving the directory instead
 * would ignore a build the operator asked for. `applyOneSite` takes the release
 * branch first for that reason; the entry is dropped here so the two never
 * disagree about which lane a site is on.
 */
export function deployManagedDirectoryBindings(
  payload: EnvironmentDeployPayload,
  releaseBindings: ReadonlyMap<string, SiteRelease>,
): Map<string, SiteManagedDirectory> {
  const bindings = new Map<string, SiteManagedDirectory>();
  // A site with an owner and no release gets the folder the control plane
  // planned for it, so its files live in the scope tree. Sites with no owner
  // stay in the daemon-owned tree.
  for (const site of payload.sites ?? []) {
    if (
      (site.sourceKind !== "managed-directory" &&
        site.sourceKind !== undefined) ||
      releaseBindings.has(site.composeServiceName) ||
      site.principal === undefined
    ) continue;
    bindings.set(
      site.composeServiceName,
      bindingFor(payload, {
        serviceId: resolveReleaseServiceId(payload, site.composeServiceName),
        username: site.principal.username,
      }),
    );
  }
  return bindings;
}

/**
 * Compose service names this deploy runs **outside** Docker.
 *
 * Both host-native lanes belong here: a site vhost and a native
 * `serviceKind: node` app are each a process on `127.0.0.1:<port>`, and neither
 * has a compose service in the runtime file (`compose-files.ts` strips them
 * before `docker compose config` ever sees them). Every container-only path —
 * shared/per-service Traefik ingress, the Traefik label overlay, deployed
 * container collection — has to be handed the *complement* of this set, or it
 * would look up a compose service that does not exist and fail the whole deploy
 * before a single app starts. Hosting **Caddy** is the deliberate exception: it
 * routes hostnames to both lanes and reads them straight off the payload.
 */
export function hostNativeComposeServiceNames(
  payload: EnvironmentDeployPayload,
): Set<string> {
  return new Set([
    ...(payload.sites ?? []).map((site) => site.composeServiceName),
    ...(payload.nativeAppServices ?? []).map((app) => app.composeServiceName),
  ]);
}

/** The `sourceMaterial[]` principal for one compose service, when it has one. */
function releasePrincipalForService(
  payload: EnvironmentDeployPayload,
  composeServiceName: string,
): EnvironmentDeploySource["principal"] {
  return (payload.sourceMaterial ?? []).find(
    (entry) => entry.composeServiceName === composeServiceName,
  )?.principal;
}

/**
 * Split the host-native services into the lane each one actually belongs on,
 * now that the releases have been built.
 *
 * A `serviceKind: node` service whose build turned out to be a statically
 * exported Next site (`output: 'export'`) has **no server process**: the release
 * is a directory of files. Supervising it with a systemd unit would install a
 * unit that can never answer its health probe, so it moves to the
 * site static lane instead — served straight out of the release
 * `current` symlink on the same loopback port hosting Caddy was already going
 * to proxy to. That keeps the hostname routing, the port, and the release tree
 * identical; only the thing that serves them changes.
 *
 * The decision is made here rather than in the release engine because this is
 * the layer that owns both lanes. The payload itself is never rewritten, and
 * the operator is not asked to re-declare `serviceKind` to get a working
 * deploy.
 */
/** Align wire `serviceId` with the release tree segment the engine just used. */
function nativeAppsWithAppliedServiceIds(
  apps: readonly EnvironmentDeployNativeAppService[],
  applied: readonly AppliedRelease[],
): EnvironmentDeployNativeAppService[] {
  const byCompose = new Map(
    applied.map((entry) => [entry.composeServiceName, entry.serviceId]),
  );
  return apps.map((app) => {
    const releaseServiceId = byCompose.get(app.composeServiceName);
    if (!releaseServiceId || releaseServiceId === app.serviceId) return app;
    return { ...app, serviceId: releaseServiceId };
  });
}

export function resolveHostNativeLanes(
  payload: EnvironmentDeployPayload,
  appliedReleases: readonly AppliedRelease[],
): {
  sites: EnvironmentDeploySite[];
  nativeAppServices: EnvironmentDeployNativeAppService[];
} {
  const declaredSites = payload.sites ?? [];
  const declaredApps = payload.nativeAppServices ?? [];
  const staticExports = new Set(
    appliedReleases
      .filter((release) => release.staticExport)
      .map((release) => release.composeServiceName),
  );
  if (staticExports.size === 0) {
    return {
      sites: [...declaredSites],
      nativeAppServices: [...declaredApps],
    };
  }

  const sites = [...declaredSites];
  const nativeAppServices: EnvironmentDeployNativeAppService[] = [];
  for (const app of declaredApps) {
    if (!staticExports.has(app.composeServiceName)) {
      nativeAppServices.push(app);
      continue;
    }
    const principal = releasePrincipalForService(
      payload,
      app.composeServiceName,
    );
    sites.push({
      composeServiceName: app.composeServiceName,
      // Static files and no PHP pool, so Caddy: `root` + `file_server` with
      // nothing to configure, and no FPM socket to keep in step.
      engine: "caddy",
      // The export tree *is* the release root — `prepareNativeAppBuildOutput`
      // published `out/` as the release payload, so the document root is
      // `current` itself.
      root: ".",
      listenPort: app.listenPort,
      ...(principal === undefined ? {} : { principal }),
    });
  }
  return { sites, nativeAppServices };
}

/**
 * `serviceId`s this payload still carries a `sourceMaterial[]` entry for.
 *
 * Uses the segments the release engine just applied when present.
 */
function currentReleaseServiceIds(
  payload: EnvironmentDeployPayload,
  applied: readonly AppliedRelease[],
): Set<string> {
  const appliedByCompose = new Map(
    applied.map((entry) => [entry.composeServiceName, entry.serviceId]),
  );
  const ids = new Set<string>();
  for (const entry of payload.sourceMaterial ?? []) {
    const canonical = resolveReleaseServiceId(
      payload,
      entry.composeServiceName,
    );
    const effective = appliedByCompose.get(entry.composeServiceName) ??
      canonical;
    ids.add(effective);
    ids.add(canonical);
  }
  return ids;
}

/**
 * Release trees the **previous** deploy of this environment published, read
 * back from its own `deployment.json`.
 *
 * This is the only durable record of a service that has since been dropped from
 * the compose: the payload in hand describes what the environment looks like
 * now, so a removed service is by definition absent from it. Rows with no
 * recorded principal or folder are skipped — those never had a tree published.
 */
async function previousReleaseTrees(
  deploymentDir: string,
): Promise<ReleaseTreeRef[]> {
  const manifest = await readDeploymentManifest(deploymentDir);
  const out: ReleaseTreeRef[] = [];
  for (const release of manifest?.releases ?? []) {
    if (!release.username || release.folder === undefined) continue;
    out.push({
      serviceId: release.serviceId,
      username: release.username,
      folder: release.folder,
    });
  }
  return out;
}

/**
 * Report the service folders of every service that had a release tree last
 * deploy and no longer declares a source.
 *
 * A service that leaves the compose file keeps its folder, whatever is in it:
 * only an explicit delete (`server.folders.remove`) removes files. The kept
 * folders go back in the result so the control plane can mark them orphans.
 *
 * Runs after the release engine so a tree this deploy is still publishing into
 * is never a candidate, and before the manifest is rewritten — once
 * `deployment.json` carries the new `releases[]`, the removed service is gone
 * from the host's record too.
 */
async function keptFoldersOfRemovedServices(
  payload: EnvironmentDeployPayload,
  applied: readonly AppliedRelease[],
  deploymentDir: string,
  logSink: CommandOutputSink,
): Promise<KeptFolder[]> {
  const previous = await previousReleaseTrees(deploymentDir);
  if (previous.length === 0) return [];
  const currentServiceIds = currentReleaseServiceIds(payload, applied);
  // A service the control plane still names a folder for this deploy is in use,
  // whether or not it has a source; only one that is gone from the payload is kept.
  const namedNow = new Set([
    ...currentServiceIds,
    ...(payload.serviceFolders ?? []).map((entry) => entry.serviceId),
  ]);
  const kept = keptServiceFolders(previous, namedNow).map((
    folder,
  ) => ({ ...folder, kind: "service" as const }));
  for (const folder of kept) {
    logSink.onLine(
      "stdout",
      `kept the folder of a service that left the compose file: ${folder.scope}/services/${folder.slug}`,
    );
  }
  return kept;
}

async function buildDeploymentManifest(
  payload: EnvironmentDeployPayload,
  composeYaml: string,
  serviceNames: readonly string[],
  appliedReleases: readonly AppliedRelease[] = [],
): Promise<DeploymentManifest> {
  const secrets = secretPlanToManifest(payload.secretPlan ?? []);
  const serviceIds = serviceIdsForManifest(payload);
  const releases = releasesForManifest(payload, appliedReleases);
  return {
    version: 3,
    projectId: payload.projectId,
    environmentId: payload.environmentId,
    serverId: payload.serverId ?? "",
    generation: payload.generation ?? 0,
    projectName: payload.projectName,
    composeSha256: await sha256HexUtf8(composeYaml),
    services: replicaCountsForManifest(payload, serviceNames),
    generations: [
      singleGeneration(payload.projectName, payload.generation ?? 0),
    ],
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(Object.keys(serviceIds).length > 0 ? { serviceIds } : {}),
    ...(releases.length > 0 ? { releases } : {}),
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

/**
 * Scheduled jobs for this environment's sites **and** native apps.
 *
 * Resolves each job's account and working directory from the same bindings the
 * owning apply used, rather than re-deriving them — two derivations from one
 * input is how a timer ends up running in a tree the vhost does not serve.
 *
 * Always called, even with no jobs: the apply's removal sweep is what retires a
 * timer the operator deleted from compose, and skipping it when the payload
 * declares none would leave those firing forever. That single sweep is also why
 * both lanes are collected here and applied in one pass: a second
 * `applyCronJobs` call would treat the first lane's timers as stale and remove
 * the ones it had just installed.
 */
/**
 * What a site's cron job may write besides the principal's `home/` and `tmp/`:
 * `shared/` and `logs/` in the release lane, `public/` too in the managed lane
 * (`webroot/` and `shared/` in the older tree), nothing for a tree outside the
 * principal's home.
 */
export function siteCronWritableDirs(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  release: SiteRelease | undefined,
  managed: SiteManagedDirectory | undefined,
): string[] {
  if (release) return siteWritableDirs(layout, release, false);
  if (managed) return siteWritableDirs(layout, managed, true);
  return [];
}

/** A native app's tree reference: its service id and owner, plus its folder. */
function nativeRef(
  app: EnvironmentDeployNativeAppService,
  binding: Pick<SiteRelease, "username" | "folder">,
): SiteRelease {
  return {
    serviceId: app.serviceId,
    username: binding.username,
    folder: binding.folder,
  };
}

async function applyDeployCronJobs(
  layout: LayoutPaths,
  parsedPayload: EnvironmentDeployPayload,
  sites: readonly EnvironmentDeploySite[],
  releaseBindings: ReadonlyMap<string, SiteRelease>,
  managedBindings: ReadonlyMap<string, SiteManagedDirectory>,
  nativeAppServices: readonly EnvironmentDeployNativeAppService[],
  nativeAppBindings: NativeAppBindings,
): Promise<void> {
  const specs: CronApplySpec[] = [];
  for (const site of sites) {
    const principal = site.principal;
    // The wire contract already refuses jobs without a principal; this keeps
    // the type honest rather than re-reporting it.
    if (!site.cron || site.cron.length === 0 || !principal) continue;
    specs.push({
      composeServiceName: site.composeServiceName,
      username: principal.username,
      workingDirectory: resolveSiteDocumentRoot(
        layout,
        parsedPayload.environmentId,
        site,
        releaseBindings.get(site.composeServiceName),
        managedBindings.get(site.composeServiceName),
      ),
      siteWritableDirs: siteCronWritableDirs(
        layout,
        releaseBindings.get(site.composeServiceName),
        managedBindings.get(site.composeServiceName),
      ),
      jobs: site.cron,
    });
  }
  for (const app of nativeAppServices) {
    if (!app.cron || app.cron.length === 0) continue;
    const binding = nativeAppBindings.get(app.composeServiceName);
    // No binding means no promoted release and no account to run as. The app's
    // own unit is skipped for the same reason, so a timer here would be a job
    // pointing into a tree that was never published.
    if (!binding) continue;
    specs.push({
      composeServiceName: app.composeServiceName,
      // The release `current` symlink, exactly what the app's own unit uses as
      // `WorkingDirectory` — a job and the application it belongs to must not
      // disagree about which tree is live.
      workingDirectory:
        serviceTree(layout, nativeRef(app, binding)).currentLink,
      siteWritableDirs: siteWritableDirs(
        layout,
        nativeRef(app, binding),
        false,
      ),
      username: binding.username,
      jobs: app.cron,
    });
  }
  try {
    await applyCronJobs(layout, parsedPayload.environmentId, specs);
  } catch (err) {
    // Warn, do not fail. A broken timer is a real problem and a bad reason to
    // refuse to publish an application that is otherwise ready — and the
    // transcript is where the operator sees it.
    logWarn(
      "deploy",
      `cron could not be applied: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function applyDeploySites(
  layout: LayoutPaths,
  environmentId: string,
  sites: EnvironmentDeploySite[],
  dockerBindAddress: string | null,
  releaseBindings: ReadonlyMap<string, SiteRelease>,
  managedDirectoryBindings: ReadonlyMap<string, SiteManagedDirectory>,
  hideWebServerNames: boolean,
): Promise<void> {
  if (sites.length === 0) return;
  await applySites(layout, environmentId, sites, {
    hideWebServerNames,
    dockerBindAddress,
    releaseBindings,
    managedDirectoryBindings,
  });
}

/**
 * Remove the vhost, pool and runtime of the sites the control plane says left
 * the compose file (`removedSites[]`). Only what is named goes, and a name that
 * is also a site or a native app of this deploy never does. A payload that
 * names none (an older control plane, a transient or partial payload) removes
 * nothing: absence from `sites[]` is never read as a deletion.
 *
 * Runs once everything else in the deploy has succeeded, so a deploy that fails
 * part way never leaves the old vhosts gone. A failed removal is logged and
 * does not fail a deploy that has already been published; whether a later
 * deploy names the site again is the control plane's choice. The folder of a
 * removed site stays, as an orphan.
 */
export async function removeLeftSites(
  layout: LayoutPaths,
  payload: Pick<
    EnvironmentDeployPayload,
    "environmentId" | "sites" | "nativeAppServices" | "removedSites"
  >,
  removeNamed: typeof removeNamedSites = removeNamedSites,
): Promise<string[]> {
  const current = new Set([
    ...(payload.sites ?? []).map((site) => site.composeServiceName),
    ...(payload.nativeAppServices ?? []).map((app) => app.composeServiceName),
  ]);
  const names = (payload.removedSites ?? []).filter((name) =>
    !current.has(name)
  );
  if (names.length === 0) return [];
  try {
    return await removeNamed(layout, payload.environmentId, names);
  } catch (err) {
    logWarn(
      "deploy",
      `sites that left the compose file could not be removed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/**
 * Supervise this deploy's native (`serviceKind: node`) apps.
 *
 * Runs after `applySourceReleases` and the site apply, for the same
 * reason the latter does: `<principalHome>/sites/<serviceId>/current` must
 * already resolve before a unit's `WorkingDirectory` points at it.
 */
async function applyDeployNativeApps(
  layout: LayoutPaths,
  parsedPayload: EnvironmentDeployPayload,
  apps: readonly EnvironmentDeployNativeAppService[],
  applied: readonly AppliedRelease[],
  logSink: CommandOutputSink,
  decryptSecrets: DecryptSecretsFn | undefined,
  io?: Omit<ApplyNativeAppsOpts, "bindings">,
): Promise<void> {
  if (apps.length === 0) return;
  const previousReleaseByService = new Map<string, string | null>(
    applied.map((entry) => [entry.composeServiceName, entry.previousReleaseId]),
  );
  const appliedByService = new Map(
    applied.map((entry) => [
      entry.composeServiceName,
      definedFields({
        releaseId: entry.releaseId,
        heldCurrent: entry.heldCurrent,
        nativeStart: entry.nativeStart,
        runtime: entry.runtime,
      }),
    ]),
  );
  // The live release's own runtime wins over the payload's: a rollback across a
  // Node/Deno switch restores the unit the old release needs.
  const appsForRelease = nativeAppsWithAppliedServiceIds(apps, applied).map(
    (app) => {
      const runtime = appliedByService.get(app.composeServiceName)?.runtime;
      if (runtime === undefined) return app;
      const { runtime: _runtime, ...rest } = app;
      return runtime === "deno" ? { ...rest, runtime } : rest;
    },
  );
  await applyNativeAppServices(
    layout,
    parsedPayload.environmentId,
    appsForRelease,
    {
      variableMaterial: parsedPayload.variableMaterial ?? [],
      decryptSecrets,
      setPhase: (phase) => logSink.setPhase(phase),
      ...io,
      onOutput: io?.onOutput ??
        ((stream, line) => logSink.onLine(stream, line)),
      ...(logSink.health === undefined ? {} : { health: logSink.health }),
      bindings: nativeAppBindingsFromPayload(
        parsedPayload,
        previousReleaseByService,
        appliedByService,
      ),
    },
  );
}

/**
 * The folders under the site owners' tree this deploy may bind from: each
 * volume folder it was sent.
 */
export function ownedVolumeRoots(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  payload: Pick<EnvironmentDeployPayload, "storageMaterial">,
): string[] {
  const roots: string[] = [];
  for (const entry of payload.storageMaterial ?? []) {
    if (entry.folder !== undefined) {
      roots.push(volumeFolder(layout, entry.folder));
    }
  }
  return roots;
}

/**
 * A container whose compose file names a numeric user other than the site
 * owner's gets an access entry on the volume folder for that uid. Never fails
 * the deploy: see `deploy/volume-access.ts`.
 */
async function grantDeclaredVolumeUsers(
  layout: LayoutPaths,
  entries: readonly EnvironmentDeployStorageMaterial[],
  resolved: Awaited<ReturnType<typeof resolveComposeModel>>,
  ownerIds: VolumeOwnerIds,
  runtime: { logSink: CommandOutputSink; runPrivileged: RunFn },
): Promise<void> {
  const { users, named } = declaredVolumeUsers(entries, resolved, ownerIds);
  if (users.length === 0 && named.length === 0) return;
  const folders = new Map<string, FolderRefParts>();
  for (const entry of entries) {
    if (entry.folder !== undefined) folders.set(entry.storageId, entry.folder);
  }
  await applyVolumeAccess(
    layout,
    folders,
    users,
    named,
    runtime.runPrivileged,
    (line) => runtime.logSink.onLine("stdout", line),
  );
}

function buildDaemonOverlayFragment(
  parsedPayload: EnvironmentDeployPayload,
  containerHostings: EnvironmentDeployHosting[],
  sites: EnvironmentDeploySite[],
  mountPaths: Map<string, string>,
  resolved: Awaited<ReturnType<typeof resolveComposeModel>>,
  volumeOwnerIds?: VolumeOwnerIds,
): ReturnType<typeof mergeComposeOverlayFragments> {
  const storageMaterial = parsedPayload.storageMaterial ?? [];

  const storageFragment = buildStorageVolumesFragment(
    storageMaterial,
    mountPaths,
    resolved,
    volumeOwnerIds,
  );

  const siteFragment = sites.length > 0
    ? buildSiteReachabilityFragment(sites, resolved)
    : {};

  const labelsFragment = buildHostingLabelsFragment({
    payload: parsedPayload,
    hostings: containerHostings,
    resolved,
  });

  return mergeComposeOverlayFragments([
    storageFragment,
    siteFragment,
    labelsFragment,
  ]);
}

type DeployContainerServicesInput = {
  waitForHealth?: typeof waitForHealthGate;
  layout: LayoutPaths;
  parsedPayload: EnvironmentDeployPayload;
  /** What the release engine actually promoted, for `deployment.json`. */
  appliedReleases: readonly AppliedRelease[];
  files: EnvironmentDeployComposeFile[];
  containerHostings: EnvironmentDeployHosting[];
  sites: EnvironmentDeploySite[];
  mountPaths: Map<string, string>;
  deploymentDir: string;
  run: RunDockerFn;
  runStreamed: RunDockerStreamedFn;
  logSink: CommandOutputSink;
  decryptSecrets: DecryptSecretsFn | undefined;
  ensureExternalNetworks: (
    networks: readonly ExternalDockerNetworkSpec[],
  ) => Promise<void>;
  ensureFabricDockerNetworks: (
    networks: readonly EnvironmentDeployFabricNetwork[],
    defaultMtu: number,
  ) => Promise<void>;
  cancel?: DeployCancelToken;
  /** Privileged runner for the volume access entries; defaults to the root helper. */
  runPrivileged?: RunFn;
};

/**
 * Zip `dockerExternalNetworks` (names, the authoritative list) with
 * `dockerNetworkAddressing` (additive, may be absent on a payload from an
 * older control plane). A name with no addressing entry is created bare —
 * today's behaviour — so the two fields never disagree about *which*
 * networks exist, only about how the new ones are addressed.
 */
export function zipExternalDockerNetworkSpecs(
  names: readonly string[] | undefined,
  addressing: readonly ExternalDockerNetworkSpec[] | undefined,
): ExternalDockerNetworkSpec[] {
  const byName = new Map<string, ExternalDockerNetworkSpec>();
  for (const entry of addressing ?? []) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return (names ?? []).map((name) => byName.get(name) ?? { name });
}

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

/**
 * Remove secret files that left the plan. Runs only once the new release is
 * up (and its hooks passed): until then the previous release, or the one a
 * failed or cancelled deploy restores, may still point at these files, so a
 * restart of it has to find them. The plan is the whole environment's; an
 * empty plan means every binding or secret variable is gone and the whole
 * directory goes. Never called from rehydrate.
 */
async function pruneDeploySecrets(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
): Promise<void> {
  const plan = payload.secretPlan ?? [];
  try {
    if (plan.length === 0) {
      await removeSecretTree(layout, payload.projectId, payload.environmentId);
      return;
    }
    await pruneStaleSecretFiles(
      layout,
      payload.projectId,
      payload.environmentId,
      plan,
    );
  } catch (err) {
    // The release is already running; a leftover file is not a failed deploy.
    logWarn(
      "deploy",
      `could not remove secret files that left the plan: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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

/** External, fabric and managed networks a deploy needs before compose runs. */
async function ensureDeployNetworks(
  input: DeployContainerServicesInput,
): Promise<void> {
  const { parsedPayload, run } = input;
  const externalNetworks = zipExternalDockerNetworkSpecs(
    parsedPayload.dockerExternalNetworks,
    parsedPayload.dockerNetworkAddressing,
  );
  if (externalNetworks.length > 0) {
    await input.ensureExternalNetworks(externalNetworks);
  }

  const fabricNetworks = parsedPayload.fabricNetworks ?? [];
  if (fabricNetworks.length > 0) {
    // Belt-and-braces for the race between reconcile and deploy: a deploy
    // must never depend on `server.fabric.reconcile` having landed first.
    await input.ensureFabricDockerNetworks(fabricNetworks, FABRIC_DEFAULT_MTU);
  }

  const managedNetworkServices = parsedPayload.managedNetworkServices ?? [];
  if (managedNetworkServices.length > 0) {
    // The contract requires `managedNetwork` exactly when at least one
    // compose service joins it, so this is a non-null read.
    await ensureManagedIngressNetwork(parsedPayload.managedNetwork!, run);
  }
}

type LineHandler = (
  event: { stream: "stdout" | "stderr"; line: string },
) => void;

/** `docker compose build --no-cache --pull` for the whole project. */
async function runComposeBuild(
  input: DeployContainerServicesInput,
  chain: string[],
  onLine: LineHandler,
): Promise<void> {
  const { parsedPayload, runStreamed, logSink } = input;
  logInfo(
    "commands",
    `cacheless rebuild for compose project ${parsedPayload.projectName}`,
  );
  logSink.setPhase(COMMAND_LOG_PHASES.BUILD);
  const build = await runStreamed([
    ...composeFileArgs(parsedPayload.projectName, chain),
    "build",
    "--no-cache",
    "--pull",
  ], { onLine });
  input.cancel?.throwIfCancelled("while the images were building");
  if (!build.success) {
    // Docker echoes build args and failing command output verbatim —
    // redact against the sink's deny-set before it becomes a summary.
    throw new Error(
      logSink.redactSummary(build.stderr) ||
        "Docker Compose cacheless build failed",
    );
  }
}

type SequentialDeployContext = {
  chain: string[];
  serviceHooks: EnvironmentDeployServiceHook[];
  labeledServices: string[];
  deploymentDir: string;
  onLine: LineHandler;
};

const DEFAULT_HEALTH_TIMEOUT_SECONDS = 120;

/**
 * The `sequential` strategy: stop the old version, migrate, start the new one,
 * gate on health, roll back when safe. See `deploy/sequential-deploy.ts`.
 */
async function deploySequentially(
  input: DeployContainerServicesInput,
  ctx: SequentialDeployContext,
): Promise<{ serviceNames: string[]; composePaths: string[] }> {
  const { parsedPayload, run, runStreamed, logSink } = input;
  const { chain, serviceHooks, labeledServices, deploymentDir, onLine } = ctx;
  if (serviceHooks.length > 0) {
    assertHooksConfined(serviceHooks, labeledServices);
  }
  const projectName = parsedPayload.projectName;
  const steps: SequentialDeploySteps = {
    prepare: () => prepareSequentialDeploy(input, chain, onLine),
    run: (args) => run(args),
    runStreamed: (args) => runStreamed(args, { onLine }),
    runPreDeployHooks: () =>
      runDeployServiceHooks(serviceHooks, {
        projectName,
        composePaths: chain,
        deploymentDir,
        runDocker: run,
        onOutput: (stream, line) => logSink.onLine(stream, line),
        redactSummary: (text) => logSink.redactSummary(text),
      }),
    gate: (paths) => gateComposeHealth(input, paths),
    restorePrevious: () => restorePreviousDeployment(deploymentDir),
    commit: () => input.cancel?.commit("before the old version was stopped"),
    composeArgs: (paths) => composeFileArgs(projectName, paths),
    redact: (text) => logSink.redactSummary(text),
    log: (line) => logSink.onLine("stdout", line),
    setPhase: (phase) => logSink.setPhase(SEQUENTIAL_PHASES[phase]),
  };
  await runSequentialDeploy({
    composePaths: chain,
    previousComposePaths: await previousComposePaths(deploymentDir),
    keepRunning: parsedPayload.keepRunningServices ?? [],
    hasHooks: serviceHooks.length > 0,
    hooksMigrate: serviceHooks.some((hook) => Boolean(hook.preDeployCommand)),
    breakingMigration: parsedPayload.migrations === "breaking",
    steps,
  });
  if (serviceHooks.length > 0) {
    logSink.setPhase(COMMAND_LOG_PHASES.POST_DEPLOY);
    await runPostDeployHooks(serviceHooks, {
      projectName,
      composePaths: chain,
      runDocker: run,
      onOutput: (stream, line) => logSink.onLine(stream, line),
      redactSummary: (text) => logSink.redactSummary(text),
    });
  }
  return { serviceNames: labeledServices, composePaths: chain };
}

/**
 * Wait for the project's containers to be healthy, writing the live line and
 * the result to the health step. Shared by the sequential strategy (which
 * rolls back on a failure) and the in-place one (which fails the deploy).
 */
async function gateComposeHealth(
  input: DeployContainerServicesInput,
  paths: readonly string[],
): Promise<HealthGateResult> {
  const { parsedPayload, run, logSink } = input;
  const timeoutMs = (parsedPayload.healthTimeoutSeconds ??
    DEFAULT_HEALTH_TIMEOUT_SECONDS) * 1000;
  // The services this deploy runs. A stack whose services are all behind
  // compose profiles has none, and waiting the whole timeout for containers
  // that will never exist would only delay the same answer.
  const listed = await run([
    ...composeFileArgs(parsedPayload.projectName, paths),
    "config",
    "--services",
  ]);
  const services = listed.success
    ? listed.stdout.split("\n").map((name) => name.trim()).filter(Boolean)
    : undefined;
  if (services?.length === 0) {
    const none: HealthGateResult = {
      ok: true,
      services: [],
      elapsedMs: 0,
      unchecked: [],
      reported: [],
    };
    reportHealthGate(logSink, none);
    return none;
  }
  const result = await (input.waitForHealth ?? waitForHealthGate)({
    ...(services === undefined ? {} : { services }),
    ps: composePsForGate(run, parsedPayload.projectName, paths),
    timeoutMs,
    stableMs: Math.min(HEALTH_GATE_DEFAULT_STABLE_MS, timeoutMs),
    pollMs: HEALTH_GATE_DEFAULT_POLL_MS,
    onProgress: (message) => logSink.onLine("stdout", message),
    onTick: (tick) => logSink.health?.waiting(waitingLine(tick, timeoutMs)),
  });
  reportHealthGate(logSink, result);
  return result;
}

/**
 * In place there is no previous version to go back to: a service that does not
 * become healthy fails the deploy, and the new containers stay up for
 * inspection (the sequential strategy rolls back instead).
 */
async function assertInPlaceHealthy(
  input: DeployContainerServicesInput,
  paths: readonly string[],
): Promise<void> {
  input.logSink.setPhase(COMMAND_LOG_PHASES.HEALTH);
  const gate = await gateComposeHealth(input, paths);
  if (!gate.ok) {
    throw new Error(
      input.logSink.redactSummary(
        `The containers started but ${gate.detail}. They were left running and nothing was rolled back; the hostings and certificates were not updated.`,
      ),
    );
  }
}

/** Whole seconds, with the unit: "12 s". */
function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/** The one live line of the health step while the gate waits. */
export function waitingLine(tick: HealthGateTick, timeoutMs: number): string {
  const head = `Attempt ${tick.attempt}, ${seconds(tick.elapsedMs)} of up to ${
    seconds(timeoutMs)
  }`;
  return `${head}: ${tick.pending[0] ?? "waiting"}`;
}

/**
 * Write the gate's verdict to the transcript and to the health step, so the
 * step ends with a result instead of just stopping. "Healthy" is only said
 * when Docker reported `healthy`; a container with no health check passed by
 * staying up, and the step says exactly that.
 */
export function reportHealthGate(
  logSink: CommandOutputSink,
  result: HealthGateResult,
): void {
  // A rollback runs the gate again for the previous version, after the step
  // already ended: its lines say so instead of passing for the new version.
  const prior = logSink.health?.active() === false ? "Previous version: " : "";
  const line = (stream: "stdout" | "stderr", text: string) =>
    logSink.onLine(stream, `${prior}${text}`);
  if (!result.ok) {
    const note = result.reason === "timeout"
      ? `${result.detail.charAt(0).toUpperCase()}${result.detail.slice(1)}`
      : `Stopped waiting: ${result.detail}`;
    line("stderr", note);
    logSink.health?.failed(HEALTH_RESULT_TITLES.unhealthy, note);
    return;
  }
  const after = seconds(result.elapsedMs);
  if (result.unchecked.length === 0 && result.reported.length === 0) {
    const note =
      "Nothing in this deploy reports its own health: no service is running, or every one is a job that finished with exit code 0";
    line("stdout", note);
    logSink.health?.done(HEALTH_RESULT_TITLES.notChecked, note);
    return;
  }
  if (result.unchecked.length === 0) {
    const note = `Healthy after ${after}`;
    line("stdout", `${result.reported.join(", ")}: ${note}`);
    logSink.health?.done(HEALTH_RESULT_TITLES.healthy, note);
    return;
  }
  const note = `${result.unchecked.join(", ")} stayed running for ${after}; ` +
    `no health check is configured, so that is all that was checked`;
  line("stdout", note);
  const mixed = result.reported.length > 0;
  logSink.health?.done(
    HEALTH_RESULT_TITLES.running,
    mixed ? `Other services healthy. ${note}` : note,
  );
}

const SEQUENTIAL_PHASES = {
  build: COMMAND_LOG_PHASES.BUILD,
  "pre-deploy": COMMAND_LOG_PHASES.PRE_DEPLOY,
  "compose-up": COMMAND_LOG_PHASES.COMPOSE_UP,
  health: COMMAND_LOG_PHASES.HEALTH,
} as const;

/**
 * Everything a sequential deploy does before it stops anything: networks,
 * image build and a best-effort pull, so the downtime window is only stop to
 * healthy and a build failure leaves the old version serving.
 */
async function prepareSequentialDeploy(
  input: DeployContainerServicesInput,
  chain: string[],
  onLine: LineHandler,
): Promise<void> {
  const { parsedPayload, runStreamed, logSink } = input;
  await ensureDeployNetworks(input);
  if (parsedPayload.noCache === true) {
    await runComposeBuild(input, chain, onLine);
  } else {
    const build = await runStreamed([
      ...composeFileArgs(parsedPayload.projectName, chain),
      "build",
    ], { onLine });
    input.cancel?.throwIfCancelled("while the images were building");
    if (!build.success) {
      throw new Error(
        logSink.redactSummary(build.stderr) || "Docker Compose build failed",
      );
    }
  }
  // Best effort: `up` pulls anything still missing.
  await runStreamed([
    ...composeFileArgs(parsedPayload.projectName, chain),
    "pull",
    "--ignore-buildable",
  ], { onLine });
  input.cancel?.throwIfCancelled("while the images were being pulled");
}

/**
 * Undo {@link publishStagedRuntimeCompose} for a deploy cancelled before it
 * started anything: put the previous version's files back as the live ones, or
 * (a first deploy has none) remove what was published. Never throws: the
 * cancel is what the operator is told about.
 */
async function revertPublishedCompose(
  deploymentDir: string,
  hadPrevious: boolean,
): Promise<void> {
  try {
    if (hadPrevious) {
      await restorePreviousDeployment(deploymentDir);
      return;
    }
    await Deno.remove(join(deploymentDir, RUNTIME_COMPOSE_FILENAME)).catch(
      () => undefined,
    );
    await Deno.remove(join(deploymentDir, DEPLOYMENT_MANIFEST_FILENAME)).catch(
      () => undefined,
    );
    await removeComposeEnvFile(deploymentDir);
  } catch (err) {
    logWarn(
      "deploy",
      `could not put the previous compose files back after a cancel: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
    appliedReleases,
    files,
    containerHostings,
    sites,
    mountPaths,
    deploymentDir,
    run,
    runStreamed,
    logSink,
    decryptSecrets,
  } = input;
  const runPrivileged = input.runPrivileged ?? defaultRunPrivileged;
  const onLine = (event: { stream: "stdout" | "stderr"; line: string }) =>
    logSink.onLine(event.stream, event.line);
  const cancel = input.cancel;
  let published = false;
  let hadPrevious = false;
  const stageDir = await resetComposeStageDir(deploymentDir);
  // Read before publish replaces the live files.
  const previousProjects = await readPreviousProjects(deploymentDir);
  let retiredEarlier: string[] = [];
  try {
    const stagedPath = join(stageDir, RUNTIME_COMPOSE_FILENAME);
    let yaml = applySecretFilePaths(
      // image-built services get their `image` here, before anything reads
      // the document: `docker compose config` below would otherwise validate a
      // service whose image does not exist yet (or act on an authored `build:`
      // that the image-build lane has already superseded).
      applyImageBuildImagesToComposeYaml(
        resolveRuntimeComposeYaml(files),
        imageBuildImagesByService(appliedReleases),
      ),
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
    // A tenant compose never carries the labels that mark the platform's own
    // containers (the Docker gate trusts them); refuse before anything runs.
    assertNoReservedOwnerLabels(resolved.document ?? {});
    // The resolved model is what Compose will run (merge keys, anchors and
    // `extends` already expanded): host-level service fields need the control
    // plane's approval, and built images may not take platform image names.
    assertComposePolicy(resolved.document ?? {}, {
      hostLevelApproved: parsedPayload.hostLevelApproved === true,
      platformNetworks: [
        parsedPayload.hostingIngressNetwork,
        parsedPayload.managedNetwork,
      ].filter((n): n is string => typeof n === "string"),
    });
    // Build options no deploy may carry (host network, privileges, SSH agent,
    // internal extra_hosts or remote contexts, secret files outside); no
    // approval reaches these, bar a public remote context the organization
    // allowed (`remoteBuildSourcesApproved`). Build paths are confined just below.
    const daemonSecretNames = new Set(
      (parsedPayload.secretPlan ?? []).map((e) => e.source),
    );
    assertComposeBuildPolicy(resolved.document ?? {}, {
      stageDir,
      exemptSecretNames: daemonSecretNames,
      remoteBuildSourcesApproved:
        parsedPayload.remoteBuildSourcesApproved === true,
    });
    // The control plane's host-level gate is lexical; only the host can see
    // where a bind source really resolves. `hostLevelApproved` (absent reads
    // false) lets absolute and Docker-socket sources through; it never
    // excuses a symlink escape, a nested writable bind, or the staging dir.
    await assertComposeHostPathsConfined(
      [
        collectResolvedHostPaths(resolved.document ?? {}, daemonSecretNames),
        collectAuthoredHostPaths(yaml),
      ],
      {
        deploymentDir,
        stageDir,
        hostLevelApproved: parsedPayload.hostLevelApproved === true,
        ownerTree: {
          homeRoot: layout.principalHomeRoot,
          volumes: ownedVolumeRoots(layout, parsedPayload),
        },
        priorWritableMounts: await priorWritableMounts(
          parsedPayload.projectName,
          deploymentDir,
          run,
        ),
      },
    );

    const volumeOwnerIds = await resolveVolumeOwnerIds(
      parsedPayload.storageMaterial ?? [],
      parsedPayload.principalMaterial,
      undefined,
      (line) => logSink.onLine("stdout", line),
    );
    await grantDeclaredVolumeUsers(
      layout,
      parsedPayload.storageMaterial ?? [],
      resolved,
      volumeOwnerIds,
      { logSink, runPrivileged },
    );
    const fragment = buildDaemonOverlayFragment(
      parsedPayload,
      containerHostings,
      sites,
      mountPaths,
      resolved,
      volumeOwnerIds,
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
      appliedReleases,
    );

    if (resolved.serviceNames.length === 0) {
      // Nothing comes up, so containers an earlier deploy started would keep
      // running untracked: take the project (and any earlier-named one) down.
      cancel?.commit("before the old containers were removed");
      await retirePreviousProjects(
        previousProjects,
        parsedPayload.projectName,
        run,
        {
          environmentId: parsedPayload.environmentId,
          deploymentDir,
          includeCurrent: true,
        },
      );
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

    cancel?.throwIfCancelled("before the new version was published");
    const chain = await publishStagedRuntimeCompose(
      deploymentDir,
      stageDir,
      manifest,
    );
    // From here until the cutover a cancel has to put the live compose files
    // back, or they would describe a version that never started.
    published = true;
    hadPrevious = (await previousComposePaths(deploymentDir)) !== null;
    await persistComposeEnvFile(deploymentDir, parsedPayload.envFile);

    // A stack started under an earlier project name is replaced, not kept
    // (before either strategy brings the new name up). Images are pulled first
    // (best effort) so the gap between removing the old containers and
    // starting the new ones is short.
    if (previousProjects?.names.some((n) => n !== parsedPayload.projectName)) {
      await runStreamed([
        ...composeFileArgs(parsedPayload.projectName, chain),
        "pull",
        "--ignore-buildable",
      ], { onLine });
      cancel?.commit("before the earlier containers were removed");
    }
    retiredEarlier = await retirePreviousProjects(
      previousProjects,
      parsedPayload.projectName,
      run,
      { environmentId: parsedPayload.environmentId, deploymentDir },
    );

    // A container run as the site owner must be able to write the named
    // volumes it mounts too: Docker makes those root-owned.
    for (
      const line of deploymentBindWarnings(
        fragment.services as
          | Record<string, Record<string, unknown>>
          | undefined,
        resolved.services as Record<string, Record<string, unknown>>,
        [stageDir, deploymentDir],
      )
    ) {
      logSink.onLine("stdout", line);
    }
    await ensureNamedVolumeOwners(
      namedVolumeOwnerTargets(
        fragment.services as
          | Record<string, Record<string, unknown>>
          | undefined,
        resolved.services as Record<string, Record<string, unknown>>,
        (resolved.document?.volumes ?? undefined) as
          | Record<string, unknown>
          | undefined,
        parsedPayload.projectName,
        new Set(
          (parsedPayload.storageMaterial ?? []).flatMap((entry) =>
            entry.provider === "docker" && entry.volumeName
              ? [entry.volumeName]
              : []
          ),
        ),
        new Map(
          (parsedPayload.storageMaterial ?? []).flatMap((entry) => {
            const ids = volumeOwnerIds.get(entry.storageId);
            return entry.provider === "docker" && entry.volumeName &&
                ids !== undefined
              ? [[entry.volumeName, `${ids.uid}:${ids.gid}`] as const]
              : [];
          }),
        ),
      ),
      {
        projectName: parsedPayload.projectName,
        composePaths: chain,
        run,
        log: (line) => logSink.onLine("stdout", line),
      },
    );

    const serviceHooks = parsedPayload.serviceHooks ?? [];
    if (parsedPayload.deployStrategy === "sequential") {
      const sequential = await deploySequentially(input, {
        chain,
        serviceHooks,
        labeledServices,
        deploymentDir,
        onLine,
      });
      await pruneDeploySecrets(layout, parsedPayload);
      return sequential;
    }
    if (serviceHooks.length > 0) {
      // Every hook must be confined to a compose service this deploy runs;
      // the runner then executes it inside that service's container.
      assertHooksConfined(serviceHooks, labeledServices);
      // Pre-deploy hooks run inside the live containers and may migrate data.
      cancel?.commit("before the pre-deploy hooks ran");
      logSink.setPhase(COMMAND_LOG_PHASES.PRE_DEPLOY);
      await runDeployServiceHooks(serviceHooks, {
        projectName: parsedPayload.projectName,
        composePaths: chain,
        deploymentDir,
        runDocker: run,
        onOutput: (stream, line) => logSink.onLine(stream, line),
        redactSummary: (text) => logSink.redactSummary(text),
      });
    }

    await ensureDeployNetworks(input);

    if (parsedPayload.noCache === true) {
      await runComposeBuild(input, chain, onLine);
    }

    cancel?.commit("before the new version was started");
    logSink.setPhase(COMMAND_LOG_PHASES.COMPOSE_UP);
    const up = await runStreamed([
      ...composeFileArgs(parsedPayload.projectName, chain),
      "up",
      "-d",
      "--remove-orphans",
    ], { onLine });
    if (!up.success) {
      throw new Error(
        logSink.redactSummary(up.stderr) || "Docker Compose deployment failed",
      );
    }

    await assertInPlaceHealthy(input, chain);

    if (serviceHooks.length > 0) {
      logSink.setPhase(COMMAND_LOG_PHASES.POST_DEPLOY);
      await runPostDeployHooks(serviceHooks, {
        projectName: parsedPayload.projectName,
        composePaths: chain,
        runDocker: run,
        onOutput: (stream, line) => logSink.onLine(stream, line),
        redactSummary: (text) => logSink.redactSummary(text),
      });
    }

    // The new release is up and its hooks passed: only now may the files the
    // previous one needed (and this plan no longer lists) be removed.
    await pruneDeploySecrets(layout, parsedPayload);
    return {
      serviceNames: labeledServices,
      composePaths: chain,
    };
  } catch (err) {
    if (published && err instanceof DeployCancelledError) {
      await revertPublishedCompose(deploymentDir, hadPrevious);
    }
    if (retiredEarlier.length > 0 && err instanceof Error) {
      err.message +=
        " The containers this environment had under its earlier compose project name were already removed; deploy again to bring it back.";
    }
    throw err;
  } finally {
    await removeComposeStageDir(deploymentDir);
  }
}

/** Persists compiled `compose.yaml` + `deployment.json` for site-only
 * deploys (no Docker compose up). */
async function writeDeployComposeMarker(
  parsedPayload: EnvironmentDeployPayload,
  files: EnvironmentDeployComposeFile[],
  deploymentDir: string,
  appliedReleases: readonly AppliedRelease[] = [],
): Promise<string[]> {
  const yaml = resolveRuntimeComposeYaml(files);
  await writeComposeFileSecure(
    join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
    yaml,
  );
  await persistComposeEnvFile(deploymentDir, parsedPayload.envFile);
  await writeDeploymentManifest(
    deploymentDir,
    await buildDeploymentManifest(parsedPayload, yaml, [], appliedReleases),
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
  sites: EnvironmentDeploySite[],
): string {
  const siteCount = sites.length;
  const summaryParts = [
    `Deployed ${labeledServices.length} container service(s)`,
  ];
  if (siteCount > 0) {
    summaryParts.push(`${siteCount} site(s)`);
  }
  return `${summaryParts.join(" + ")} for environment ${environmentId}`;
}

/** Pure result-shaping helper — exported for hermetic contract tests. */
export function buildDeployServiceNames(
  labeledServices: string[],
  sites: EnvironmentDeploySite[],
): string[] {
  return [
    ...labeledServices,
    ...sites.map((site) => site.composeServiceName),
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
  sites: EnvironmentDeploySite[];
  containers: EnvironmentDeployContainer[] | null;
  /** Git-backed releases this deploy applied, in payload order. */
  releases?: readonly EnvironmentDeployResultRelease[];
  /** Per-site application facts for the sites this deploy applied. */
  siteApps?: readonly EnvironmentDeployResultSite[];
  /** What the deploy worked around without failing; omitted when empty. */
  warnings?: readonly string[];
  /** The uid/gid each ensured account has on this host. */
  principals?: readonly PrincipalIdReport[];
  /** Service folders left in place because their service left the compose file. */
  keptFolders?: readonly KeptFolder[];
}): EnvironmentDeployResult {
  const summary = buildDeploySummary(
    input.environmentId,
    input.labeledServices,
    input.sites,
  );
  const serviceNames = buildDeployServiceNames(
    input.labeledServices,
    input.sites,
  );
  return {
    projectName: input.projectName,
    summary,
    ...(serviceNames.length > 0 ? { services: serviceNames } : {}),
    // Include `containers: []` when collection succeeded with no rows; omit the
    // field entirely when collection failed (non-authoritative).
    ...(input.containers === null ? {} : { containers: input.containers }),
    // Omitted rather than empty when nothing Git-backed was applied — an
    // environment with no sources should not grow a release array.
    ...(input.releases && input.releases.length > 0
      ? { releases: [...input.releases] }
      : {}),
    ...(input.siteApps && input.siteApps.length > 0
      ? { sites: [...input.siteApps] }
      : {}),
    ...(input.warnings && input.warnings.length > 0
      ? { warnings: [...input.warnings] }
      : {}),
    ...(input.principals && input.principals.length > 0
      ? { principals: [...input.principals] }
      : {}),
    ...(input.keptFolders && input.keptFolders.length > 0
      ? { keptFolders: [...input.keptFolders] }
      : {}),
  };
}

/**
 * The deploy's sink, with the step reporter following its phases: `fetch`,
 * `build`, `compose-up` and `health` are steps of the plan, so every existing
 * `setPhase` site marks its step without knowing about progress.
 */
function progressFollowingSink(
  inner: CommandOutputSink,
  progress: DeployStepReporter,
): { logSink: CommandOutputSink; currentPhase: () => string } {
  let phase: string = COMMAND_LOG_PHASES.PREPARE;
  let healthEnded = false;
  const healthRunning = () =>
    progress.snapshot().steps.some((s) =>
      s.id === HEALTH_STEP_ID && s.state === "running"
    );
  const logSink: CommandOutputSink = {
    onLine: (stream, message) => inner.onLine(stream, message),
    setPhase: (next) => {
      if (next === COMMAND_LOG_PHASES.HEALTH) healthEnded = false;
      phase = next;
      inner.setPhase(next);
      progress.phase(next);
    },
    addSecrets: (values) => inner.addSecrets(values),
    redactSummary: (text) => inner.redactSummary(text),
    finalize: () => inner.finalize(),
    health: {
      waiting: (text) => {
        // A rollback's gate runs after the step already failed: its ticks
        // must not land on whatever step is running then.
        if (healthRunning()) progress.detail(HEALTH_STEP_ID, text);
      },
      done: (title, note) => {
        healthEnded = true;
        progress.done(HEALTH_STEP_ID, { label: title, note });
      },
      failed: (title, note) => {
        healthEnded = true;
        progress.fail(HEALTH_STEP_ID, { label: title, note });
      },
      ended: () => healthEnded,
      active: healthRunning,
    },
  };
  return { logSink, currentPhase: () => phase };
}

function resolveEnvironmentDeployRuntime(deps?: EnvironmentDeployDeps): {
  run: RunDockerFn;
  runStreamed: RunDockerStreamedFn;
  logSink: CommandOutputSink;
  progress: DeployStepReporter;
  currentPhase: () => string;
  decryptSecrets: DecryptSecretsFn | undefined;
  ensureDockerFn: () => Promise<void>;
  ensureExternalNetworks: (
    networks: readonly ExternalDockerNetworkSpec[],
  ) => Promise<void>;
  ensureFabricDockerNetworks: NonNullable<
    EnvironmentDeployDeps["ensureFabricDockerNetworks"]
  >;
  runPrivileged: RunFn;
  waitForHealth: typeof waitForHealthGate | undefined;
} {
  const run = deps?.runDocker ?? defaultRunDocker;
  const progress = deps?.progress ?? createNoopDeployStepReporter();
  const { logSink, currentPhase } = progressFollowingSink(
    deps?.logSink ?? createNoopCommandOutputSink(),
    progress,
  );
  const streamed = createStreamedRunner(deps?.runDocker);
  const cancel = deps?.cancel;
  const dockerEvents = createPlaybookEventHandler(
    logSink,
    progress,
    "install-docker",
  );
  return {
    run,
    progress,
    currentPhase,
    // Every streamed docker call (build, pull, up) dies with a cancel; once the
    // deploy has committed, the signal can no longer fire.
    runStreamed: cancel
      ? (args, options) => streamed(args, { ...options, signal: cancel.signal })
      : streamed,
    logSink,
    // Every plaintext this deploy decrypts (variable material, principal
    // passwords, TLS private keys) joins the transcript redaction deny-set.
    decryptSecrets: captureDecryptedSecrets(deps?.decryptSecrets, logSink),
    ensureDockerFn: deps?.ensureDocker ??
      (() => defaultEnsureDocker({ onEvent: dockerEvents })),
    ensureExternalNetworks: deps?.ensureExternalDockerNetworks ??
      ((networks: readonly ExternalDockerNetworkSpec[]) =>
        defaultEnsureExternalDockerNetworks(networks, run)),
    ensureFabricDockerNetworks: deps?.ensureFabricDockerNetworks ??
      defaultEnsureFabricDockerNetworks,
    runPrivileged: deps?.runPrivileged ?? defaultRunPrivileged,
    waitForHealth: deps?.waitForHealth,
  };
}

async function resolveSiteDockerBindAddress(
  hasContainers: boolean,
  sites: readonly EnvironmentDeploySite[],
): Promise<string | null> {
  if (!hasContainers || sites.length === 0) return null;
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
      input.appliedReleases,
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
  await forEachSequential(input.ingressServices, async (ingress) => {
    const ingressContainer = await collectServiceIngressContainer(
      ingress,
      input.layout,
      input.run,
    );
    if (ingressContainer) containers.push(ingressContainer);
  });
  return containers;
}

/**
 * Would the host-native steps of this deploy change what is serving? Sites and
 * native apps obviously do; so does the removal sweep when an earlier deploy
 * left release trees or cron timers behind. A container-only deploy with none of
 * those stays cancellable until its own cutover. Any doubt answers `true`.
 */
async function hostNativeCutoverPending(input: {
  sites: readonly EnvironmentDeploySite[];
  nativeAppServices: readonly EnvironmentDeployNativeAppService[];
  deploymentDir: string;
  environmentId: string;
  hasCronUnits?: (environmentId: string) => Promise<boolean>;
}): Promise<boolean> {
  if (input.sites.length > 0 || input.nativeAppServices.length > 0) return true;
  try {
    if ((await previousReleaseTrees(input.deploymentDir)).length > 0) {
      return true;
    }
    return await (input.hasCronUnits ?? hasInstalledCronUnits)(
      input.environmentId,
    );
  } catch {
    return true;
  }
}

export async function handleEnvironmentDeploy(
  payload: EnvironmentDeployPayload,
  daemonReceivedAt: string,
  deps?: EnvironmentDeployDeps,
): Promise<EnvironmentDeployResult> {
  const parsedPayload = parseEnvironmentDeployPayload(payload);
  // Destroy, stop and lifecycle commands for this environment wait for a
  // running deploy to finish instead of reclaiming trees under it.
  return await withKeyedLock(
    environmentLockKey(parsedPayload.environmentId),
    () => handleEnvironmentDeployLocked(parsedPayload, daemonReceivedAt, deps),
  );
}

async function handleEnvironmentDeployLocked(
  parsedPayload: ReturnType<typeof parseEnvironmentDeployPayload>,
  daemonReceivedAt: string,
  deps?: EnvironmentDeployDeps,
): Promise<EnvironmentDeployResult> {
  // A PHP series or a web engine is installed long before the site config that
  // uses it exists (the release builds in between), so no unused-software
  // removal may take one this deploy needs.
  const releaseHolds = await holdPruneKeys(
    pruneHoldKeysForDeploy(parsedPayload.sites ?? []),
  );
  try {
    // The control plane's run deadline counts only while this is `true`: it
    // pauses while the deploy waits for another build to free the host.
    const progress = deps?.progress;
    progress?.running(true);
    // Rewriting the web server config builds nothing, so it does not wait for
    // a build slot.
    const result = parsedPayload.hostingsOnly === true
      ? await applyHostingsOnly(parsedPayload, deps)
      : await observeBuildSlot(
        {
          waiting: () => progress?.running(false),
          acquired: () => progress?.running(true),
        },
        () => deployEnvironmentHolding(parsedPayload, daemonReceivedAt, deps),
      );
    deps?.progress?.finish("succeeded");
    return result;
  } catch (err) {
    // The last payload goes out before the outcome: the running step failed
    // (or was skipped by a cancel), the rest never ran.
    deps?.progress?.finish(
      err instanceof DeployCancelledError ? "cancelled" : "failed",
    );
    throw err;
  } finally {
    releaseHolds();
  }
}

/**
 * `hostingsOnly`: a hosting's certificate choice changed (a Let's Encrypt
 * certificate was picked) and the control plane wants it live without a
 * redeploy. Only this environment's hosting Caddy config and the certificates
 * it pins are rewritten; nothing is built, started, stopped or pruned. The
 * applied-deploy hash is left alone, so the next real deploy still runs even
 * when the payload also carried changes this run did not apply. A server
 * whose hosting Caddy has no site for this environment yet has had no deploy
 * to point the config at, so the run is refused there.
 */
export async function applyHostingsOnly(
  parsedPayload: ReturnType<typeof parseEnvironmentDeployPayload>,
  deps?: EnvironmentDeployDeps,
): Promise<EnvironmentDeployResult> {
  assertSafeDeploymentIdentifiers(parsedPayload);
  const layout = resolveLayout(Deno.env.toObject());
  const sitePath = join(
    layout.configDir,
    "hosting",
    "sites",
    `${parsedPayload.environmentId}.caddy`,
  );
  try {
    await Deno.stat(sitePath);
  } catch {
    throw new Error(
      "this environment has no web server config on this server yet: deploy it first",
    );
  }
  const runtime = resolveEnvironmentDeployRuntime(deps);
  await assertHostingNamesFree(layout, parsedPayload);
  // One step, so the run shows the certificate line like a full deploy does.
  runtime.progress.plan([certificatesStep()]);
  runtime.progress.start("certificates");
  const hostnameTls = await materializeDeployTls(
    layout,
    parsedPayload,
    runtime.decryptSecrets,
  );
  await rewriteHostingCaddySites(layout, parsedPayload, hostnameTls);
  finishCertificatesStep(runtime.progress, parsedPayload);
  logInfo(
    "commands",
    `environment.deploy hostings only env=${parsedPayload.environmentId}`,
  );
  return {
    projectName: parsedPayload.projectName,
    summary:
      `Web server settings applied for environment ${parsedPayload.environmentId}: no build, no restart`,
    unchanged: true,
  };
}

/**
 * Finish the certificates step. For names the web server gets a certificate
 * for by itself, the step keeps a line saying so, which stays readable after
 * the step is done.
 */
function finishCertificatesStep(
  progress: DeployStepReporter,
  parsedPayload: EnvironmentDeployPayload,
): void {
  const note = automaticCertificateDetail(parsedPayload);
  progress.done("certificates", note === undefined ? {} : { note });
}

/**
 * Preflight: what this deploy will do on the server and what is already
 * there, probed without installing anything, then sent as the first
 * `command-progress`. Nothing runs for the no-op reporter.
 */
async function planDeployProgress(
  runtime: DeployProgressRuntime,
  layout: LayoutPaths,
  parsedPayload: EnvironmentDeployPayload,
  edge: { hasContainers: boolean; sharedIngress: boolean; publicEdge: boolean },
  probes: DeployPresenceProbes | undefined,
): Promise<PlannedDeployStep[]> {
  if (!runtime.progress.enabled) return [];
  try {
    const needs = deployStepNeeds(parsedPayload, edge);
    const presence = await probeDeployPresence(layout, needs, probes);
    const steps = planDeploySteps(needs, presence);
    runtime.progress.plan(steps);
    return steps;
  } catch (err) {
    // The plan is a courtesy to the UI; a probe that cannot answer must not
    // stop the deploy. Without a plan the steps simply never show.
    logWarn(
      "deploy",
      `deploy step plan skipped: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

/**
 * Vendor the Node and Deno series the deploy's apps run on, one install step
 * group per runtime so the rail shows which one is being fetched.
 */
async function ensureDeployNativeRuntimes(
  runtime: DeployProgressRuntime,
  plan: readonly PlannedDeployStep[],
  apps: readonly RuntimeChoice[],
  io: Omit<ApplyNativeAppsOpts, "bindings"> | undefined,
): Promise<void> {
  const groups = [
    ["node", installStepIds(plan, "install-runtime:node-")],
    ["deno", installStepIds(plan, "install-runtime:deno-")],
  ] as const;
  await forEachSequential(groups, async ([kind, ids]) => {
    const ofKind = apps.filter((app) => nativeAppRuntimeKind(app) === kind);
    if (ofKind.length === 0) return;
    await runInstallStep(
      runtime,
      ids,
      COMMAND_LOG_PHASES.INSTALL_RUNTIME,
      () =>
        ensureNativeAppRuntime(ofKind, {
          ...io,
          onEvent: installEvents(
            runtime,
            ids,
            `install-runtime:${kind}`,
            plan,
          ),
        }),
    );
  });
}

/**
 * The result of a redeploy that changes nothing, or `null` when the deploy has
 * to run. The control plane's hash is compared with the one recorded when the
 * last deploy finished; a rebuild-from-scratch request, a deploy with no hash
 * and a host that lost its compose file always run in full.
 */
async function unchangedDeployResult(
  parsedPayload: ReturnType<typeof parseEnvironmentDeployPayload>,
  deploymentDir: string,
  layout: LayoutPaths,
  runtime: ReturnType<typeof resolveEnvironmentDeployRuntime>,
  hostProbe?: HostProbe,
): Promise<EnvironmentDeployResult | null> {
  const desired = parsedPayload.desiredHash;
  if (desired === undefined || parsedPayload.noCache === true) return null;
  if (await readAppliedDeployHash(deploymentDir) !== desired) return null;
  const files = resolveDeployComposeFiles(parsedPayload).map((f) => f.content);
  // The hash cannot see a moved tag, so such a deploy always runs.
  if (usesMutableImageTag(files)) return null;
  const hasContainers = composeFilesHaveContainerServices(files);
  const composePaths = await resolveDeployedComposePaths(deploymentDir);
  if (hasContainers && composePaths === null) return null;
  const projects = hasContainers
    ? projectsForCommand(
      await readDeploymentManifest(deploymentDir),
      parsedPayload.projectName,
      "live",
    )
    : [];
  let currentLinks: string[];
  try {
    currentLinks = currentLinksOf(layout, parsedPayload);
  } catch {
    return null;
  }
  const probe = hostProbe ?? createHostProbe({
    layout,
    composePaths: composePaths ?? [],
    runDocker: runtime.run,
    run: runtime.runPrivileged,
  });
  const up = await hostStillRunsDeploy({
    environmentId: parsedPayload.environmentId,
    projects,
    nativeServiceIds: (parsedPayload.nativeAppServices ?? []).map((app) =>
      app.serviceId
    ),
    siteNames: (parsedPayload.sites ?? []).map((site) =>
      site.composeServiceName
    ),
    currentLinks,
  }, probe);
  if (!up) return null;
  logInfo(
    "commands",
    `environment.deploy nothing changed env=${parsedPayload.environmentId}`,
  );
  return {
    projectName: parsedPayload.projectName,
    summary:
      `Nothing changed for environment ${parsedPayload.environmentId}: no build, no restart`,
    unchanged: true,
  };
}

/** `current` link of every release this deploy puts live; `[]` entries that cannot be resolved are kept out of the skip by throwing. */
function currentLinksOf(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
): string[] {
  return [...deployReleaseBindings(payload).values()].map((binding) =>
    serviceTree(layout, binding).currentLink
  );
}

async function deployEnvironmentHolding(
  parsedPayload: ReturnType<typeof parseEnvironmentDeployPayload>,
  daemonReceivedAt: string,
  deps?: EnvironmentDeployDeps,
): Promise<EnvironmentDeployResult> {
  assertSafeDeploymentIdentifiers(parsedPayload);
  const layout = resolveLayout(Deno.env.toObject());
  const earlyDeploymentDir = environmentDeploymentDir(
    layout,
    parsedPayload.projectId,
    parsedPayload.environmentId,
  );
  const unchanged = await unchangedDeployResult(
    parsedPayload,
    earlyDeploymentDir,
    layout,
    resolveEnvironmentDeployRuntime(deps),
    deps?.hostProbe,
  );
  if (unchanged !== null) return unchanged;
  // From here the deploy will change the host; it counts as applied only once
  // it has finished.
  await clearAppliedDeployHash(earlyDeploymentDir);
  resetHostingCaddyRuntimeEnsuredForDeploy();
  const runtime = resolveEnvironmentDeployRuntime(deps);

  const files = resolveDeployComposeFiles(parsedPayload);
  const hasContainers = composeFilesHaveContainerServices(
    files.map((file) => file.content),
  );
  // Container-only paths get container hostings only. Both host-native lanes
  // are stripped from the runtime compose, so a hosting for a site
  // site *or* a native app has no compose service to attach a Traefik label to.
  const hostNativeNames = hostNativeComposeServiceNames(parsedPayload);
  const containerHostings = parsedPayload.hostings.filter(
    (hosting) => !hostNativeNames.has(hosting.composeServiceName),
  );

  const cancel = deps?.cancel;
  cancel?.throwIfCancelled("before the deploy started");
  const ingressServices = parsedPayload.ingressServices ?? [];
  const plan = await planDeployProgress(runtime, layout, parsedPayload, {
    hasContainers,
    sharedIngress: containerHostingsNeedSharedHttpIngress(containerHostings),
    publicEdge: hostingsNeedPublicHttpEdge(parsedPayload.hostings),
  }, deps?.presenceProbes);
  cancel?.throwIfCancelled("before the deploy started");
  runtime.logSink.setPhase(COMMAND_LOG_PHASES.PREPARE);
  await ensureDeployIngress({
    layout,
    environmentId: parsedPayload.environmentId,
    hasContainers,
    containerHostings,
    allHostings: parsedPayload.hostings,
    ingressServices,
    hostingIngress: parsedPayload.hostingIngress,
    hostingIngressNetwork: parsedPayload.hostingIngressNetwork,
    ensureDockerFn: runtime.ensureDockerFn,
    runDocker: runtime.run,
    listenerPorts: parsedPayload.listenerPorts,
    progress: runtime,
  });

  cancel?.throwIfCancelled("while the host was being prepared");
  const deploymentDir = earlyDeploymentDir;
  await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

  // Tenant Node must exist before the Git build: native installs run
  // `corepack` from `vendor/node-app/<series>/current/bin`.
  await ensureDeployNativeRuntimes(
    runtime,
    plan,
    [
      ...(parsedPayload.nativeAppServices ?? []),
      // A site's Git build runs on the default Node too.
      ...siteBuildRuntimes(parsedPayload),
    ],
    deps?.nativeAppIo,
  );
  // The web engines and PHP too, so a site's runtime is on disk before
  // anything starts it. One engine playbook vendors the engine and its PHP
  // series together, so their steps run and finish as one group.
  const siteInstallIds = [
    ...installStepIds(plan, "install-web-server:"),
    ...installStepIds(plan, "install-php:"),
  ];
  await runInstallStep(
    runtime,
    siteInstallIds,
    COMMAND_LOG_PHASES.INSTALL_WEB_SERVER,
    () =>
      ensureSiteEngines(parsedPayload.sites ?? [], {
        ...deps?.siteIo,
        onEvent: installEvents(
          runtime,
          siteInstallIds,
          "install-web-server",
          plan,
        ),
      }),
  );

  const principalMaterial = parsedPayload.principalMaterial ?? [];
  const principalIdReports = await ensureDeployPrincipals(
    layout,
    deployPrincipalSpecs(parsedPayload, principalMaterial),
  );

  // Git-backed releases run before the compose / site apply steps,
  // so `<principalHome>/sites/<serviceId>/current` already resolves by the time
  // the site apply below points a document root at it.
  cancel?.throwIfCancelled("while the host was being prepared");
  const appliedReleases = await applySourceReleases(layout, parsedPayload, {
    logSink: runtime.logSink,
    decryptSecrets: runtime.decryptSecrets,
    // A Node app that is serving keeps `current` until its new release has
    // answered beside it, so a crash, a cancel or a failure anywhere before
    // the switch leaves the serving release live (and the one a restart or a
    // reboot starts).
    holdCurrent: (service) =>
      nativeAppIsServing(
        parsedPayload.nativeAppServices ?? [],
        service,
        deps?.nativeAppIo,
      ),
    ensureBuildkitImageBuildFn: (releaseLayout) =>
      runInstallStep(
        runtime,
        ["install-build-tool"],
        COMMAND_LOG_PHASES.INSTALL_BUILD_TOOL,
        () =>
          ensureBuildkitImageBuild(releaseLayout, {
            onEvent: installEvents(
              runtime,
              ["install-build-tool"],
              "install-build-tool",
            ),
          }),
      ),
    ...(cancel === undefined ? {} : { cancel }),
  });
  // Which host-native lane each service ends up on can only be decided once the
  // releases are built: a `serviceKind: node` service that turned out to be a
  // static export is served as files, not supervised as a process.
  const lanes = resolveHostNativeLanes(parsedPayload, appliedReleases);
  // A site that publishes an output folder serves that folder, not `public`.
  lanes.sites = sitesWithReleaseRoots(parsedPayload, lanes.sites);
  const { nativeAppServices } = lanes;
  // Everything from here on (release trees reclaimed, sites and native apps
  // applied, cron timers swept) changes what is serving. A deploy with none of
  // that to do stays cancellable until its containers are touched.
  if (
    cancel &&
    await hostNativeCutoverPending({
      sites: lanes.sites,
      nativeAppServices,
      deploymentDir,
      environmentId: parsedPayload.environmentId,
      hasCronUnits: deps?.hasCronUnits,
    })
  ) {
    cancel.commit("before the sites and apps were switched over");
  }
  // Whole-tree cleanup for services that lost their source since last deploy —
  // per-release retention only ever walks services still being published.
  const keptFolders = await keptFoldersOfRemovedServices(
    parsedPayload,
    appliedReleases,
    deploymentDir,
    runtime.logSink,
  );
  runtime.logSink.setPhase(COMMAND_LOG_PHASES.PREPARE);

  // Secret runtime variables arrive sealed; the engine configs and
  // `hosting.env` take them from `webEnv` once decrypted.
  const sites = await resolveSiteSecretEnv(lanes.sites, runtime.decryptSecrets);

  const mountPaths = await resolveDeployMountPaths(
    layout,
    parsedPayload,
    principalMaterial,
    runtime.decryptSecrets,
  );

  // Before anything is written: a variable a site's web server cannot carry is
  // named in the command log and the result, a required database setting stops
  // the deploy here.
  const siteWarnings = sites.flatMap(planSiteWebEnv);
  for (const warning of siteWarnings) {
    runtime.logSink.onLine("stderr", warning);
  }

  const siteReleaseBindings = deployReleaseBindings(parsedPayload);
  const siteManagedBindings = deployManagedDirectoryBindings(
    parsedPayload,
    siteReleaseBindings,
  );
  const nativeAppServicesForHost = nativeAppsWithAppliedServiceIds(
    nativeAppServices,
    appliedReleases,
  );
  // Host-native lanes start here; `compose-up` marks the step for containers.
  if (sites.length > 0 || nativeAppServicesForHost.length > 0) {
    runtime.progress.start("start");
  }
  await applyDeploySites(
    layout,
    parsedPayload.environmentId,
    sites,
    await resolveSiteDockerBindAddress(
      hasContainers,
      sites,
    ),
    siteReleaseBindings,
    siteManagedBindings,
    parsedPayload.hideWebServerNames === true,
  );

  // Read-only: what each site's document root runs (WordPress today), reported
  // so the control plane can warn about an unusable database pairing.
  const siteApps = await detectSiteApps(
    layout,
    parsedPayload.environmentId,
    sites,
    {
      releaseBindings: siteReleaseBindings,
      managedDirectoryBindings: siteManagedBindings,
      run: runtime.runPrivileged,
    },
  );

  // Native apps come last of the host-native lanes: the release is published
  // and the vhost tree is settled, so a new release that does not answer fails
  // only its own app. The apply walks the transcript through "start the new
  // release", "check service health", "switch traffic" and "stop the old
  // release" itself. A deploy without native apps keeps `prepare`, so the step
  // rail does not show "Check Service Health" before anything started.
  if (nativeAppServicesForHost.length > 0) {
    runtime.logSink.setPhase(COMMAND_LOG_PHASES.START_RELEASE);
    await applyDeployNativeApps(
      layout,
      parsedPayload,
      nativeAppServicesForHost,
      appliedReleases,
      runtime.logSink,
      runtime.decryptSecrets,
      deps?.nativeAppIo,
    );
    runtime.logSink.setPhase(COMMAND_LOG_PHASES.PREPARE);
  }

  // After *both* host-native applies, because a job's WorkingDirectory is the
  // tree its owner just settled — a site's document root, or a native app's
  // release `current` symlink, which does not exist until the promote above has
  // run. A timer pointed at a tree that is not there yet fails on its first
  // firing rather than at deploy, which is the worst place to find out.
  //
  // One call covers both lanes on purpose: `applyCronJobs` retires every timer
  // for this environment that the specs it was handed do not name, so splitting
  // this into two passes would make each one delete the other's units.
  await applyDeployCronJobs(
    layout,
    parsedPayload,
    sites,
    siteReleaseBindings,
    siteManagedBindings,
    nativeAppServicesForHost,
    nativeAppBindingsFromPayload(parsedPayload),
  );

  // Before any container carries a routing label for a name another
  // environment already serves here.
  await assertHostingNamesFree(layout, parsedPayload);

  const published = await publishDeployedCompose({
    hasContainers,
    layout,
    parsedPayload,
    appliedReleases,
    files,
    containerHostings,
    sites,
    mountPaths,
    deploymentDir,
    run: runtime.run,
    runStreamed: runtime.runStreamed,
    logSink: runtime.logSink,
    decryptSecrets: runtime.decryptSecrets,
    ensureExternalNetworks: runtime.ensureExternalNetworks,
    ensureFabricDockerNetworks: runtime.ensureFabricDockerNetworks,
    ...(runtime.waitForHealth === undefined
      ? {}
      : { waitForHealth: runtime.waitForHealth }),
    runPrivileged: runtime.runPrivileged,
    ...(cancel === undefined ? {} : { cancel }),
  });

  // Planned when the payload carries certificate files or names the web
  // server gets a certificate for by itself; otherwise these calls do nothing.
  runtime.progress.start("certificates");
  const hostnameTls = await materializeDeployTls(
    layout,
    parsedPayload,
    runtime.decryptSecrets,
  );

  await rewriteHostingCaddySites(layout, parsedPayload, hostnameTls);
  finishCertificatesStep(runtime.progress, parsedPayload);

  // The container gate (sequential and in place) and the native apps already
  // ended the health step with their own result; only a deploy that checked
  // nothing says so here.
  const healthEnded = runtime.logSink.health?.ended() === true;
  if (!healthEnded) runtime.logSink.setPhase(COMMAND_LOG_PHASES.HEALTH);
  const containers = await collectEnvironmentDeployContainers({
    hasContainers,
    projectName: parsedPayload.projectName,
    containerHostings,
    composePaths: published.composePaths,
    ingressServices,
    layout,
    run: runtime.run,
  });
  if (!healthEnded) {
    runtime.logSink.health?.done(
      HEALTH_RESULT_TITLES.notChecked,
      "Nothing in this deploy reports its own health",
    );
  }

  // Last of the changes to the host, after the health phase: the containers
  // are up, the health gates have passed (they run inside the publish above;
  // collecting the containers here only reports them) and the new sites are
  // serving, so a deploy that failed earlier never leaves an old vhost gone.
  // A failure from here on is only the report being built, and the vhosts of a
  // site that has left the compose file are not needed by the new version.
  await removeLeftSites(layout, parsedPayload);

  logInfo(
    "commands",
    `environment.deploy completed project=${parsedPayload.projectName} received=${daemonReceivedAt}`,
  );

  if (parsedPayload.desiredHash !== undefined) {
    await writeAppliedDeployHash(earlyDeploymentDir, parsedPayload.desiredHash);
  }

  return shapeEnvironmentDeployResult({
    projectName: parsedPayload.projectName,
    environmentId: parsedPayload.environmentId,
    labeledServices: published.labeledServices,
    sites,
    containers,
    releases: deployResultReleases(appliedReleases),
    siteApps,
    warnings: siteWarnings,
    principals: principalIdReports,
    keptFolders,
  });
}
