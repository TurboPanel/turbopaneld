import { buildStorageVolumesFragment } from "../../deploy/apply-storage-volumes.ts";
import { buildHostingLabelsFragment } from "../../deploy/compose-labels.ts";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import {
  composeFileArgs,
  type DeploymentManifestRelease,
  type DeploymentManifestSecret,
  type DeploymentManifestV2,
  environmentDeploymentDir,
  pruneStaleComposeLayerFiles,
  publishStagedRuntimeCompose,
  readDeploymentManifest,
  removeComposeEnvFile,
  removeComposeStageDir,
  resetComposeStageDir,
  RUNTIME_COMPOSE_FILENAME,
  writeComposeEnvFile,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "../../deploy/compose-files.ts";
import {
  applyRailpackImagesToComposeYaml,
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
  createStreamedRunner,
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
  type RunDockerStreamedFn,
} from "../../deploy/docker-cli.ts";
import { captureDecryptedSecrets } from "../../logs/capture.ts";
import {
  COMMAND_LOG_PHASES,
  type CommandOutputSink,
  createNoopCommandOutputSink,
} from "../../logs/contracts.ts";
import { ensureDocker as defaultEnsureDocker } from "../../deploy/ensure-docker.ts";
import { ensureSystemPrincipals } from "../../deploy/ensure-principal.ts";
import { applySshAccess } from "../../deploy/ssh/apply.ts";
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
import { applySites, type SiteRelease } from "../../deploy/site.ts";
import {
  type AppliedRelease,
  applySourceReleases,
  resolveReleaseServiceId,
} from "../../deploy/release/apply-source-releases.ts";
import {
  applyNativeAppServices,
  type ApplyNativeAppsOpts,
  nativeAppBindingsFromPayload,
} from "../../deploy/native/apply-native-apps.ts";
import {
  reclaimRemovedReleaseTrees,
  type ReleaseTreeRef,
} from "../../deploy/release/retention.ts";
import { runPrivileged as defaultRunPrivileged } from "../../deploy/release/release-layout.ts";
import type { RunFn } from "../../deploy/ensure-principal.ts";
import { ensureExternalDockerNetworks as defaultEnsureExternalDockerNetworks } from "../../deploy/ensure-docker-networks.ts";
import {
  ensureFabricDockerNetworks as defaultEnsureFabricDockerNetworks,
  FABRIC_DEFAULT_MTU,
} from "./fabric.ts";
import { ensureManagedIngressNetwork } from "../../managed/networks.ts";
import {
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  writeSystemComponentDescriptor,
} from "../../deploy/system-component.ts";
import {
  buildSiteReachabilityFragment,
  resolveDockerHostGatewayAddress,
} from "../../deploy/site-docker.ts";
import { logInfo, logWarn } from "../../logger.ts";
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
  type EnvironmentDeployNativeAppService,
  type EnvironmentDeployPayload,
  type EnvironmentDeployPrincipalMaterial,
  type EnvironmentDeployResult,
  type EnvironmentDeployResultRelease,
  type EnvironmentDeploySite,
  type EnvironmentDeploySource,
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

/**
 * Persist the shared HTTP Traefik identity from an `environment.deploy`
 * payload so {@link ensureHostingIngress} emits `container_name: <serviceId>-in`
 * instead of Compose's default `turbopanel-ingress-traefik-1`.
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
  ensureDockerFn: () => Promise<void>;
  /** Docker CLI seam — must reach every ingress helper so tests never touch real Docker. */
  runDocker: RunDockerFn;
  listenerPorts?: EnvironmentDeployPayload["listenerPorts"];
};

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
    ensureDockerFn,
    runDocker,
    listenerPorts,
  } = params;
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
    await ensureHostingCaddyRuntime(layout);
    return;
  }
  await ensureDockerFn();

  // Shared loopback Traefik only when something HTTP actually needs it —
  // bare nginx/workload deploys must not create the platform `-in` proxy.
  if (containerHostingsNeedSharedHttpIngress(containerHostings)) {
    await persistHostingIngressIdentity(layout, hostingIngress);
    await ensureHostingIngress(layout, { runDocker });
  }

  await cleanupStaleTcpUdpServiceIngress(
    layout,
    environmentId,
    environmentServiceIds,
    activeIngressServiceIds,
    { runDocker },
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
      { runDocker },
    );
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
function deployPrincipalSpecs(
  parsedPayload: EnvironmentDeployPayload,
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
    });
  }
  return [...byId.values()];
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
      ...(principal.runtimes === undefined
        ? {}
        : { runtimes: principal.runtimes }),
      ...(principal.accessGroups === undefined
        ? {}
        : { accessGroups: principal.accessGroups }),
    })),
  );

  // Key files, but **never** the removal sweep: this payload describes one
  // environment and the host serves many, so pruning here would revoke every
  // other environment's access. `server.principals.reconcile` is the caller
  // that holds the whole server and is allowed to delete.
  //
  // Skipped entirely when no principal declared keys, so a deploy from a
  // control plane that predates the key subsystem does not touch `sshd`.
  const withKeys = principalMaterial.filter(
    (principal) => principal.sshKeys !== undefined,
  );
  if (withKeys.length > 0) {
    try {
      await applySshAccess(
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

function resolveRuntimeComposeYaml(
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
 * declared it. Persisted so the container-log collector can resolve service
 * identity from deployment state instead of a live container label.
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
    out.push({
      composeServiceName: entry.composeServiceName,
      serviceId: result?.serviceId ??
        resolveReleaseServiceId(payload, entry.composeServiceName),
      // A rollback's live release is the one it promoted, not the id the
      // control plane would have allocated for a fresh build.
      releaseId: result?.releaseId ?? entry.rollbackToReleaseId ??
        entry.releaseId,
      sourceId: entry.sourceId,
      commitSha,
      ...(commitMessage === undefined ? {} : { commitMessage }),
      ...(commitAuthor === undefined ? {} : { commitAuthor }),
      ...(entry.ref.length > 0 ? { ref: entry.ref } : {}),
      ...(entry.principal ? { username: entry.principal.username } : {}),
    });
  }
  return out;
}

/**
 * Compose service name → the image a Railpack release built for it.
 *
 * Only entries that actually produced an image are in the map, so a deploy with
 * no Railpack services yields an empty map and
 * {@link applyRailpackImagesToComposeYaml} is a no-op. Rollbacks are included:
 * `applySourceReleases` reads the tag back off the target release's manifest,
 * so restoring a Railpack release is the same "write this tag into compose"
 * operation a fresh build is.
 */
function railpackImagesByService(
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
 * native release reports its commit, a Railpack release additionally reports
 * the image tag and the pinned frontend / plan versions that produced it,
 * because "which directory" is not an identity a Railpack release has.
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
    ...(release.railpackFrontendVersion === undefined
      ? {}
      : { railpackFrontendVersion: release.railpackFrontendVersion }),
    ...(release.railpackPlanVersion === undefined
      ? {}
      : { railpackPlanVersion: release.railpackPlanVersion }),
  }));
}

/**
 * Compose service name → the release tree it serves from.
 *
 * Built from `sourceMaterial[]` on **every** deploy, not only when a release was
 * freshly promoted: a redeploy that does not touch the source still has to point
 * the document root at `current`, or the site would silently fall back to the
 * empty daemon-owned tree. `serviceId` resolves the same way the release engine
 * resolved it ({@link resolveReleaseServiceId}), so this addresses the tree that
 * was actually published. Entries with no principal are skipped for the same
 * reason the release engine skips them — there is no home to serve out of.
 */
function deployReleaseBindings(
  payload: EnvironmentDeployPayload,
): Map<string, SiteRelease> {
  const bindings = new Map<string, SiteRelease>();
  for (const entry of payload.sourceMaterial ?? []) {
    const principal = entry.principal;
    if (!principal) continue;
    bindings.set(entry.composeServiceName, {
      serviceId: resolveReleaseServiceId(payload, entry.composeServiceName),
      username: principal.username,
    });
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

/** `serviceId`s this payload still carries a `sourceMaterial[]` entry for. */
function currentReleaseServiceIds(
  payload: EnvironmentDeployPayload,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of payload.sourceMaterial ?? []) {
    ids.add(resolveReleaseServiceId(payload, entry.composeServiceName));
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
 * recorded principal are skipped — those never had a tree published.
 */
async function previousReleaseTrees(
  deploymentDir: string,
): Promise<ReleaseTreeRef[]> {
  const manifest = await readDeploymentManifest(deploymentDir);
  const out: ReleaseTreeRef[] = [];
  for (const release of manifest?.releases ?? []) {
    if (!release.username) continue;
    out.push({ serviceId: release.serviceId, username: release.username });
  }
  return out;
}

/**
 * Reclaim `<principalHome>/sites/<serviceId>` for every service that had a
 * release tree last deploy and no longer declares a source.
 *
 * Runs after the release engine so a tree this deploy is still publishing into
 * is never a candidate, and before the manifest is rewritten — once
 * `deployment.json` carries the new `releases[]`, the removed service is gone
 * from the host's record too.
 */
async function reclaimRemovedServiceReleaseTrees(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  deploymentDir: string,
  logSink: CommandOutputSink,
  runFn: RunFn,
): Promise<void> {
  const previous = await previousReleaseTrees(deploymentDir);
  if (previous.length === 0) return;
  const removed = await reclaimRemovedReleaseTrees({
    layout,
    previous,
    currentServiceIds: currentReleaseServiceIds(payload),
    runFn,
    onOutput: (stream, line) => logSink.onLine(stream, line),
  });
  for (const path of removed) {
    logSink.onLine("stdout", `reclaimed removed service release tree ${path}`);
  }
}

async function buildDeploymentManifest(
  payload: EnvironmentDeployPayload,
  composeYaml: string,
  serviceNames: readonly string[],
  appliedReleases: readonly AppliedRelease[] = [],
): Promise<DeploymentManifestV2> {
  const secrets = secretPlanToManifest(payload.secretPlan ?? []);
  const serviceIds = serviceIdsForManifest(payload);
  const releases = releasesForManifest(payload, appliedReleases);
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

async function applyDeploySites(
  layout: LayoutPaths,
  environmentId: string,
  sites: EnvironmentDeploySite[],
  dockerBindAddress: string | null,
  releaseBindings: ReadonlyMap<string, SiteRelease>,
): Promise<void> {
  if (sites.length === 0) return;
  await applySites(layout, environmentId, sites, {
    dockerBindAddress,
    releaseBindings,
  });
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
  io?: Omit<ApplyNativeAppsOpts, "bindings">,
): Promise<void> {
  if (apps.length === 0) return;
  const previousReleaseByService = new Map<string, string | null>(
    applied.map((entry) => [entry.composeServiceName, entry.previousReleaseId]),
  );
  await applyNativeAppServices(layout, parsedPayload.environmentId, apps, {
    ...io,
    bindings: nativeAppBindingsFromPayload(
      parsedPayload,
      previousReleaseByService,
    ),
  });
}

function buildDaemonOverlayFragment(
  parsedPayload: EnvironmentDeployPayload,
  containerHostings: EnvironmentDeployHosting[],
  sites: EnvironmentDeploySite[],
  mountPaths: Map<string, string>,
  resolved: Awaited<ReturnType<typeof resolveComposeModel>>,
): ReturnType<typeof mergeComposeOverlayFragments> {
  const storageMaterial = parsedPayload.storageMaterial ?? [];

  const storageFragment = buildStorageVolumesFragment(
    storageMaterial,
    mountPaths,
    resolved,
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
    ensureExternalNetworks,
    ensureFabricDockerNetworks,
  } = input;
  const onLine = (event: { stream: "stdout" | "stderr"; line: string }) =>
    logSink.onLine(event.stream, event.line);
  const stageDir = await resetComposeStageDir(deploymentDir);
  try {
    const stagedPath = join(stageDir, RUNTIME_COMPOSE_FILENAME);
    let yaml = applySecretFilePaths(
      // Railpack-built services get their `image` here, before anything reads
      // the document: `docker compose config` below would otherwise validate a
      // service whose image does not exist yet (or act on an authored `build:`
      // that the Railpack lane has already superseded).
      applyRailpackImagesToComposeYaml(
        resolveRuntimeComposeYaml(files),
        railpackImagesByService(appliedReleases),
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

    const fragment = buildDaemonOverlayFragment(
      parsedPayload,
      containerHostings,
      sites,
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
      appliedReleases,
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
      logSink.setPhase(COMMAND_LOG_PHASES.BUILD);
      const build = await runStreamed([
        ...composeFileArgs(parsedPayload.projectName, chain),
        "build",
        "--no-cache",
        "--pull",
      ], { onLine });
      if (!build.success) {
        // Docker echoes build args and failing command output verbatim —
        // redact against the sink's deny-set before it becomes a summary.
        throw new Error(
          logSink.redactSummary(build.stderr) ||
            "Docker Compose cacheless build failed",
        );
      }
    }

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

    if (serviceHooks.length > 0) {
      logSink.setPhase(COMMAND_LOG_PHASES.POST_DEPLOY);
      await runPostDeployHooks(
        serviceHooks,
        deploymentDir,
        (stream, line) => logSink.onLine(stream, line),
        (text) => logSink.redactSummary(text),
      );
    }

    return {
      serviceNames: labeledServices,
      composePaths: chain,
    };
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
  };
}

function resolveEnvironmentDeployRuntime(deps?: EnvironmentDeployDeps): {
  run: RunDockerFn;
  runStreamed: RunDockerStreamedFn;
  logSink: CommandOutputSink;
  decryptSecrets: DecryptSecretsFn | undefined;
  ensureDockerFn: () => Promise<void>;
  ensureExternalNetworks: (names: readonly string[]) => Promise<void>;
  ensureFabricDockerNetworks: NonNullable<
    EnvironmentDeployDeps["ensureFabricDockerNetworks"]
  >;
  runPrivileged: RunFn;
} {
  const run = deps?.runDocker ?? defaultRunDocker;
  const logSink = deps?.logSink ?? createNoopCommandOutputSink();
  return {
    run,
    runStreamed: createStreamedRunner(deps?.runDocker),
    logSink,
    // Every plaintext this deploy decrypts (variable material, principal
    // passwords, TLS private keys) joins the transcript redaction deny-set.
    decryptSecrets: captureDecryptedSecrets(deps?.decryptSecrets, logSink),
    ensureDockerFn: deps?.ensureDocker ?? defaultEnsureDocker,
    ensureExternalNetworks: deps?.ensureExternalDockerNetworks ??
      ((names: readonly string[]) =>
        defaultEnsureExternalDockerNetworks(names, run)),
    ensureFabricDockerNetworks: deps?.ensureFabricDockerNetworks ??
      defaultEnsureFabricDockerNetworks,
    runPrivileged: deps?.runPrivileged ?? defaultRunPrivileged,
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

export async function handleEnvironmentDeploy(
  payload: EnvironmentDeployPayload,
  daemonReceivedAt: string,
  deps?: EnvironmentDeployDeps,
): Promise<EnvironmentDeployResult> {
  const parsedPayload = parseEnvironmentDeployPayload(payload);
  assertSafeDeploymentIdentifiers(parsedPayload);
  const layout = resolveLayout(Deno.env.toObject());
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

  const ingressServices = parsedPayload.ingressServices ?? [];
  runtime.logSink.setPhase(COMMAND_LOG_PHASES.PREPARE);
  await ensureDeployIngress({
    layout,
    environmentId: parsedPayload.environmentId,
    hasContainers,
    containerHostings,
    allHostings: parsedPayload.hostings,
    ingressServices,
    hostingIngress: parsedPayload.hostingIngress,
    ensureDockerFn: runtime.ensureDockerFn,
    runDocker: runtime.run,
    listenerPorts: parsedPayload.listenerPorts,
  });

  const deploymentDir = environmentDeploymentDir(
    layout,
    parsedPayload.projectId,
    parsedPayload.environmentId,
  );
  await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

  const principalMaterial = parsedPayload.principalMaterial ?? [];
  await ensureDeployPrincipals(
    layout,
    deployPrincipalSpecs(parsedPayload, principalMaterial),
  );

  // Git-backed releases run before the compose / site apply steps,
  // so `<principalHome>/sites/<serviceId>/current` already resolves by the time
  // the site apply below points a document root at it.
  const appliedReleases = await applySourceReleases(layout, parsedPayload, {
    logSink: runtime.logSink,
    decryptSecrets: runtime.decryptSecrets,
  });
  // Whole-tree cleanup for services that lost their source since last deploy —
  // per-release retention only ever walks services still being published.
  await reclaimRemovedServiceReleaseTrees(
    layout,
    parsedPayload,
    deploymentDir,
    runtime.logSink,
    runtime.runPrivileged,
  );
  runtime.logSink.setPhase(COMMAND_LOG_PHASES.PREPARE);

  // Which host-native lane each service ends up on can only be decided once the
  // releases are built: a `serviceKind: node` service that turned out to be a
  // static export is served as files, not supervised as a process.
  const { sites, nativeAppServices } = resolveHostNativeLanes(
    parsedPayload,
    appliedReleases,
  );

  const mountPaths = await resolveDeployMountPaths(
    layout,
    parsedPayload,
    principalMaterial,
    runtime.decryptSecrets,
  );

  await applyDeploySites(
    layout,
    parsedPayload.environmentId,
    sites,
    await resolveSiteDockerBindAddress(
      hasContainers,
      sites,
    ),
    deployReleaseBindings(parsedPayload),
  );

  // Native apps come last of the host-native lanes: the release is promoted and
  // the vhost tree is settled, so a unit that fails its health probe fails only
  // itself and rolls its own `current` back.
  runtime.logSink.setPhase(COMMAND_LOG_PHASES.RELEASE_PROMOTE);
  await applyDeployNativeApps(
    layout,
    parsedPayload,
    nativeAppServices,
    appliedReleases,
    deps?.nativeAppIo,
  );
  runtime.logSink.setPhase(COMMAND_LOG_PHASES.PREPARE);

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
  });

  const hostnameTls = await materializeDeployTls(
    layout,
    parsedPayload,
    runtime.decryptSecrets,
  );

  await rewriteHostingCaddySites(layout, parsedPayload, hostnameTls);

  runtime.logSink.setPhase(COMMAND_LOG_PHASES.HEALTH);
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

  return shapeEnvironmentDeployResult({
    projectName: parsedPayload.projectName,
    environmentId: parsedPayload.environmentId,
    labeledServices: published.labeledServices,
    sites,
    containers,
    releases: deployResultReleases(appliedReleases),
  });
}
