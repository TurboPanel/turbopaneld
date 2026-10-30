/**
 * `managed.ingress.reconcile` — whole-server ProxySQL desired state.
 */

import {
  markProxySqlReconciled,
  withProxySqlLock,
} from "../managed/proxysql-lock.ts";
import type {
  EnvironmentDeployContainer,
  ManagedIngressReconcilePayload,
  ManagedIngressReconcileResult,
} from "../contracts/commands-contracts.ts";
import { parseManagedIngressReconcilePayload } from "../contracts/commands-contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import {
  PROXYSQL_COMPOSE_SERVICE_NAME,
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  type SystemComponentDescriptor,
  writeSystemComponentDescriptor,
} from "../deploy/system-component.ts";
import { ingressContainerName } from "../deploy/ingress-identity.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { forEachSequential, repeatSequential } from "../util/sequential.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  containerMissesManagedNetwork,
  dockerContainerNetworkNames,
  ensureContainerJoinedManagedNetwork,
  ensureManagedIngressNetwork,
  pruneStaleManagedDockerNetworks,
  removeUnusedManagedDockerNetwork,
} from "../managed/networks.ts";
import {
  applyProxySqlAdminStatements,
  assertProxySqlHostRegularFile,
  loadProxySqlAdminCredentials,
  loadProxySqlMonitorCredentials,
  proxySqlHostPrepPresent,
  readProxySqlRuntimeInterfaces,
  readProxySqlRuntimeServers,
} from "../managed/proxysql-admin.ts";
import {
  PROXYSQL_IPV6_NETWORK,
  proxySqlBindsUseIpv6,
  proxySqlIpv6ListenProbeArgs,
  proxySqlIpv6NetworkSupport,
  proxySqlProbeShowsListening,
  readProxySqlIpv6SubnetFromCompose,
} from "../managed/proxysql-ipv6.ts";
import { runProxySqlSetup } from "../orchestration/ansible.ts";
import {
  assertManagedIngressPortsBindable,
  assertNoFrontendUserConflict,
  buildProxySqlAdminStatements,
  buildProxySqlListenerInterfacesStatements,
  DEFAULT_PROXYSQL_LISTENER_PORTS,
  desiredProxySqlListenerInterfaces,
  findIngressRuntimeMismatch,
  inspectProxySqlContainer,
  isSourceLimitedUser,
  type ProbeHostPortFn,
  proxysqlCompose,
  type ProxySqlDesiredState,
  proxySqlFamiliesInUse,
  proxySqlListenerInterfacesMismatch,
  type ProxySqlProtocolFamily,
  type ProxySqlRuntimeServerRow,
  readManagedNetworkFromCompose,
  readPublishedBindAddressesFromCompose,
  readPublishedListenerPortsFromCompose,
  renderProxySqlConfig,
  restartProxySqlIngress,
  staticConfigSectionChanged,
  userAllowsLocalSources,
  writeProxySqlConfigAtomic,
} from "../managed/proxysql.ts";
import { collectLocalRootSources } from "../managed/proxysql-root-guard.ts";
import { materializeProxySqlTlsMaterial } from "../managed/tls.ts";
import {
  proxysqlAdminCnfPath,
  proxysqlComposePath,
  proxysqlConfigPath,
  proxysqlMonitorCnfPath,
  proxysqlProject,
  proxysqlTlsDir,
} from "../managed/engine-paths.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

export type ManagedIngressReconcileHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
  runDocker?: RunDockerFn;
  ensureDocker?: () => Promise<void>;
  /** Test seam — defaults to {@link runProxySqlSetup}. */
  runHostPrep?: () => Promise<void>;
  /** Test seam for the listener-port preflight (defaults to a real bind probe). */
  probeHostPort?: ProbeHostPortFn;
  /** Test seam: wait between IPv6 listener probes (defaults to 2 s). */
  ipv6ProbeDelayMs?: number;
};

function desiredStateFromPayload(
  payload: ManagedIngressReconcilePayload,
): ProxySqlDesiredState {
  return {
    // The instance sends the addresses from the server's single "allow external
    // access to the databases on this server" setting (`127.0.0.1` off,
    // `0.0.0.0` on, plus `::` on a server with IPv6). Missing/empty `bindAddresses` means nothing is published
    // to the host — it must never be widened to "publish on every
    // interface". `[]` here means the shared frontend is reachable only via
    // the organization's managed Docker network (bindings from co-located
    // compose services),
    // never the host. See `ProxySqlDesiredState.bindAddresses`.
    bindAddresses: payload.bindAddresses ?? [],
    // Absent means the control plane predates configurable ports; the renderer
    // then falls back to DEFAULT_PROXYSQL_LISTENER_PORTS.
    ...(payload.listenerPorts
      ? {
        listenerPorts: {
          pgsql: payload.listenerPorts.postgres,
          mysql: payload.listenerPorts.mysqlFamily,
        },
      }
      : {}),
    clusters: payload.clusters.map((cluster) => ({
      managedId: cluster.managedId,
      engine: cluster.engine,
      ...(cluster.engineVersion !== undefined
        ? { engineVersion: cluster.engineVersion }
        : {}),
      protocolPort: cluster.protocolPort,
      ...(cluster.family !== undefined ? { family: cluster.family } : {}),
      writerHostgroup: cluster.writerHostgroup,
      readerHostgroup: cluster.readerHostgroup,
      backends: cluster.backends.map((backend) => ({ ...backend })),
      users: cluster.users.map((user) => ({
        username: user.username,
        role: user.role,
        // sealed envelope until decryptProxySqlUserPasswords replaces it
        password: user.password,
        ...(user.defaultDatabase !== undefined
          ? { defaultDatabase: user.defaultDatabase }
          : {}),
        ...(user.connectionRole !== undefined
          ? { connectionRole: user.connectionRole }
          : {}),
        ...(user.tool === true ? { tool: true } : {}),
        ...(user.straightThrough === true ? { straightThrough: true } : {}),
        ...(user.allowedSources !== undefined
          ? { allowedSources: [...user.allowedSources] }
          : {}),
        ...(user.allowLocalSources !== undefined
          ? { allowLocalSources: user.allowLocalSources }
          : {}),
        ...(user.maxConnections !== undefined
          ? { maxConnections: user.maxConnections }
          : {}),
      })),
      ...(cluster.autoReadSplit !== undefined
        ? { autoReadSplit: cluster.autoReadSplit }
        : {}),
      ...(cluster.requireTls !== undefined
        ? { requireTls: cluster.requireTls }
        : {}),
    })),
    ...(payload.segments && payload.segments.length > 0
      ? { segments: payload.segments }
      : {}),
  };
}

async function decryptProxySqlUserPasswords(
  desired: ProxySqlDesiredState,
  decryptSecrets: DecryptSecretsFn,
): Promise<ProxySqlDesiredState> {
  const envelopes: string[] = [];
  const slot: Array<{ clusterIndex: number; userIndex: number }> = [];
  for (let ci = 0; ci < desired.clusters.length; ci++) {
    const cluster = desired.clusters[ci]!;
    for (let ui = 0; ui < cluster.users.length; ui++) {
      envelopes.push(cluster.users[ui]!.password);
      slot.push({ clusterIndex: ci, userIndex: ui });
    }
  }
  if (envelopes.length === 0) return desired;

  const plaintexts = await decryptSecrets(envelopes);
  if (plaintexts.length !== envelopes.length) {
    throw new Error(
      "decryptSecrets returned unexpected length for ProxySQL users",
    );
  }

  const clusters = desired.clusters.map((cluster) => ({
    ...cluster,
    users: cluster.users.map((user) => ({ ...user })),
  }));
  for (let i = 0; i < slot.length; i++) {
    const plain = plaintexts[i];
    if (typeof plain !== "string" || plain.length === 0) {
      throw new Error("failed to decrypt ProxySQL frontend user password");
    }
    const { clusterIndex, userIndex } = slot[i]!;
    clusters[clusterIndex]!.users[userIndex]!.password = plain;
  }
  return {
    bindAddresses: desired.bindAddresses,
    ...(desired.listenerPorts ? { listenerPorts: desired.listenerPorts } : {}),
    clusters,
    ...(desired.segments ? { segments: desired.segments } : {}),
  };
}

/** Order-insensitive: publishing the same set of addresses needs no restart. */
function sameBindAddresses(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x.localeCompare(y));
  const right = [...b].sort((x, y) => x.localeCompare(y));
  return left.every((value, index) => value === right[index]);
}

async function readPreviousConfig(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/**
 * Empty-cluster teardown is `compose down` and leaves the yaml/cnf on disk.
 * File-diff restart detection then treats the next non-empty reconcile as a
 * no-op, so a single remaining (or newly created) cluster never comes back.
 * Inspect failure (`undefined`) is not treated as down — do not compose-up
 * just because `ps` could not run.
 */
function proxysqlStackNeedsComposeUp(
  observed: EnvironmentDeployContainer | null | undefined,
): boolean {
  if (observed === undefined) return false;
  if (observed === null) return true;
  return observed.status !== "running";
}

function proxysqlComposeNameConflict(stderr: string): boolean {
  return stderr.includes("already in use by container");
}

async function ensureProxySqlComposeUp(
  layout: LayoutPaths,
  composePath: string,
  composeYaml: string,
  run: RunDockerFn,
  forceRecreate = false,
  containerName?: string,
): Promise<void> {
  const configDir = proxysqlComposePath(layout).replace(
    /\/docker-compose\.yml$/,
    "",
  );
  // Refuse compose up when admin.cnf / proxysql.cnf are missing or Docker
  // bind-mount scar directories — compose would recreate empty dirs as mounts.
  await assertProxySqlHostRegularFile(
    proxysqlAdminCnfPath(layout),
    "proxysql admin.cnf",
  );
  await assertProxySqlHostRegularFile(
    proxysqlConfigPath(layout),
    "proxysql.cnf",
  );
  await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
  await Deno.writeTextFile(composePath, composeYaml, { mode: 0o640 });
  // No `-p`: the daemon-written compose file declares its own project through
  // the top-level `name:` key (the managed-ingress `serviceId`).
  // `--force-recreate` when the managed-engine network renamed: `up -d` alone
  // can leave a running frontend attached to the retired bridge.
  const upArgs = [
    "compose",
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ];
  if (forceRecreate) upArgs.push("--force-recreate");
  const up = await run(upArgs);
  if (up.success) return;
  // Compose's project `name:` is the allocated service UUID. A frontend
  // created under an older project still occupies `container_name`, so
  // `--force-recreate` tries to create a second container and Docker
  // rejects the name. Remove the orphan and retry once.
  if (
    containerName &&
    proxysqlComposeNameConflict(up.stderr)
  ) {
    logInfo(
      "commands",
      `removing conflicting ProxySQL container ${containerName} and retrying compose up`,
    );
    await run(["rm", "-f", containerName]);
    const retry = await run(upArgs);
    if (retry.success) return;
    throw new Error(retry.stderr || up.stderr || "proxysql compose up failed");
  }
  throw new Error(up.stderr || "proxysql compose up failed");
}

function desiredHasGuardedRoot(desired: ProxySqlDesiredState): boolean {
  return desired.clusters.some((cluster) =>
    cluster.users.some((user) =>
      isSourceLimitedUser(user) && userAllowsLocalSources(user)
    )
  );
}

function collectAppliedUsers(desired: ProxySqlDesiredState): string[] {
  const users = new Set<string>();
  for (const cluster of desired.clusters) {
    for (const user of cluster.users) users.add(user.username);
  }
  return [...users].sort((a, b) => a.localeCompare(b));
}

function collectAppliedBackends(desired: ProxySqlDesiredState): string[] {
  const backends = new Set<string>();
  for (const cluster of desired.clusters) {
    for (const backend of cluster.backends) backends.add(backend.memberId);
  }
  return [...backends].sort((a, b) => a.localeCompare(b));
}

function emptyIngressResult(
  serverId: string,
): ManagedIngressReconcileResult {
  return {
    summary: `managed ingress torn down for server ${serverId}`,
    appliedUsers: [],
    appliedBackends: [],
    restarted: false,
    containers: [],
  };
}

/**
 * Remove the stack's `proxysql-data` volume once the last cluster is gone.
 * `compose down` keeps named volumes, so it was left on the host for good. The
 * saved proxysql.db is rebuilt from the desired state on the next provision.
 * Best effort: a volume still in use, or one that is already gone, is logged
 * and never fails the teardown. The project comes from the saved descriptor
 * (it survives teardown), so a host torn down by an older build is cleaned up
 * too, and no other project's volume of that name is touched.
 */
async function removeProxySqlDataVolume(
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<void> {
  try {
    const descriptor = await readSystemComponentDescriptor(
      layout,
      SYSTEM_MANAGED_INGRESS_COMPONENT,
    );
    if (!descriptor) return;
    const volume = `${proxysqlProject(descriptor.serviceId)}_proxysql-data`;
    const inspect = await run(["volume", "inspect", volume]);
    if (!inspect.success) return;
    const rm = await run(["volume", "rm", volume]);
    if (!rm.success) {
      logInfo(
        "commands",
        `managed.ingress.reconcile left volume ${volume}: ${
          rm.stderr || "rm failed"
        }`,
      );
    }
  } catch (err) {
    logInfo(
      "commands",
      `managed.ingress.reconcile proxysql volume cleanup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function tearDownProxySqlStack(
  layout: LayoutPaths,
  serverId: string,
  managedNetwork: string,
  daemonReceivedAt: string,
  run: RunDockerFn,
): Promise<ManagedIngressReconcileResult> {
  const composePath = proxysqlComposePath(layout);
  const previousComposeText = await readPreviousConfig(composePath);
  if (previousComposeText === null) {
    // Still sweep the managed bridge: a prior teardown (or a manual cleanup)
    // may have removed the compose file while the external network lingered.
    await removeUnusedManagedDockerNetwork(managedNetwork, run);
    await removeProxySqlDataVolume(layout, run);
    logInfo(
      "commands",
      `managed.ingress.reconcile teardown skipped (no compose) serverId=${serverId} received=${daemonReceivedAt}`,
    );
    return emptyIngressResult(serverId);
  }
  const down = await run([
    "compose",
    "-f",
    composePath,
    "down",
    "--remove-orphans",
  ]);
  if (!down.success) {
    throw new Error(down.stderr || "proxysql compose down failed");
  }
  // The stack unit runs `compose up -d` at boot whenever the compose file
  // exists, so a torn-down stack would resurrect on the next reboot unless
  // the file goes with it. The descriptor stays: identity must survive for a
  // later re-provision or repeated teardown.
  try {
    await Deno.remove(composePath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  // The managed bridge is compose-`external`, so the `down` above never
  // removes it. Engine destroys land before this teardown fans out, so a
  // zero-container network here is the org's last managed footprint on the
  // host — drop it (skipped whenever anything is still attached).
  await removeUnusedManagedDockerNetwork(managedNetwork, run);
  await removeProxySqlDataVolume(layout, run);
  logInfo(
    "commands",
    `managed.ingress.reconcile teardown completed serverId=${serverId} received=${daemonReceivedAt}`,
  );
  return emptyIngressResult(serverId);
}

async function persistManagedIngressIdentity(
  layout: LayoutPaths,
  identity: NonNullable<ManagedIngressReconcilePayload["identity"]>,
): Promise<SystemComponentDescriptor> {
  const descriptor: SystemComponentDescriptor = {
    component: SYSTEM_MANAGED_INGRESS_COMPONENT,
    serviceId: identity.serviceId,
    composeServiceName: identity.composeServiceName,
    containerName: identity.containerName,
    role: "ingress",
  };
  await writeSystemComponentDescriptor(layout, descriptor);
  return descriptor;
}

function identityFromComposeText(
  text: string | null,
): SystemComponentDescriptor | null {
  if (text === null || text.length === 0) return null;
  const nameMatch = /^[ \t]*container_name:[ \t]+(\S+)/m.exec(text);
  const idMatch = /^[ \t]*serviceId:[ \t]+([0-9a-f-]{36})/m.exec(text);
  if (!nameMatch?.[1] || !idMatch?.[1]) return null;
  const serviceId = idMatch[1];
  const containerName = nameMatch[1];
  if (containerName !== ingressContainerName(serviceId)) return null;
  return {
    component: SYSTEM_MANAGED_INGRESS_COMPONENT,
    serviceId,
    composeServiceName: PROXYSQL_COMPOSE_SERVICE_NAME,
    containerName: ingressContainerName(serviceId),
    role: "ingress",
  };
}

async function resolveManagedIngressDescriptor(
  layout: LayoutPaths,
  identity: ManagedIngressReconcilePayload["identity"] | undefined,
  previousComposeText: string | null,
): Promise<SystemComponentDescriptor> {
  if (identity) {
    return await persistManagedIngressIdentity(layout, identity);
  }
  const existing = await readSystemComponentDescriptor(
    layout,
    SYSTEM_MANAGED_INGRESS_COMPONENT,
  );
  if (existing) return existing;
  const fromCompose = identityFromComposeText(previousComposeText);
  if (fromCompose) {
    await writeSystemComponentDescriptor(layout, fromCompose);
    return fromCompose;
  }
  throw new Error("managed-ingress descriptor is missing");
}

function resolveHandlerDeps(deps?: ManagedIngressReconcileHandlerDeps) {
  return {
    run: deps?.runDocker ?? defaultRunDocker,
    ensureDockerFn: deps?.ensureDocker ?? defaultEnsureDocker,
    runHostPrep: deps?.runHostPrep ?? runProxySqlSetup,
  };
}

/** Publish binds, listener ports, and managed network from the previous compose file. */
function readPreviousComposeFacts(previousComposeText: string | null) {
  if (previousComposeText === null) {
    return {
      previousBindAddresses: [] as string[],
      previousListenerPorts: null,
      previousManagedNetwork: null,
    };
  }
  return {
    previousBindAddresses: readPublishedBindAddressesFromCompose(
      previousComposeText,
    ),
    previousListenerPorts: readPublishedListenerPortsFromCompose(
      previousComposeText,
    ),
    previousManagedNetwork: readManagedNetworkFromCompose(previousComposeText),
  };
}

/**
 * Whether this reconcile may give ProxySQL its IPv6 network: only with an IPv6
 * publish, and only on a Docker that can carry it (`proxysql-ipv6.ts`).
 * Otherwise the IPv6 publish keeps going through `docker-proxy` as before. A
 * version that cannot be read keeps what the previous render had, so one
 * failed `docker version` never tears a working network down.
 */
async function resolveProxySqlIpv6Support(
  bindAddresses: readonly string[],
  previousComposeText: string | null,
  run: RunDockerFn,
): Promise<boolean> {
  if (!proxySqlBindsUseIpv6(bindAddresses)) return true;
  const support = await proxySqlIpv6NetworkSupport(run);
  if (support.supported) return true;
  const hadNetwork = previousComposeText !== null &&
    readProxySqlIpv6SubnetFromCompose(previousComposeText) !== null;
  const keep = support.unreadable && hadNetwork;
  logWarn(
    "commands",
    `managed.ingress.reconcile: ${sanitizeForLog(support.reason)}; ${
      keep
        ? "keeping ProxySQL's existing IPv6 network"
        : "no IPv6 network for ProxySQL, so IPv6 clients keep arriving through docker-proxy with the gateway address"
    }`,
  );
  return keep;
}

/**
 * Best effort, before compose up: when the running listeners differ from
 * `desired`, write the new ones to `proxysql.db` so the recreated container
 * starts with them. A container that is not there or not answering is left
 * to {@link activateProxySqlListenerInterfaces} after the up (no connect
 * retries here, so a missing or stuck proxy costs nothing).
 */
async function stageProxySqlListenerInterfaces(
  desired: Record<ProxySqlProtocolFamily, string>,
  admin: ProxySqlAdminTarget,
): Promise<void> {
  const once = { ...admin, connectRetries: 0 };
  try {
    const running = await readProxySqlRuntimeInterfaces(once);
    if (proxySqlListenerInterfacesMismatch(desired, running).length === 0) {
      return;
    }
    await applyProxySqlAdminStatements(
      buildProxySqlListenerInterfacesStatements(desired),
      once,
    );
  } catch (err) {
    logInfo(
      "commands",
      `managed.ingress.reconcile: listeners not staged before compose up (${
        sanitizeForLog(err instanceof Error ? err.message : String(err))
      }); checked again after it`,
    );
  }
}

type ProxySqlAdminTarget = NonNullable<
  Parameters<typeof readProxySqlRuntimeInterfaces>[0]
>;

const IPV6_PROBE_ATTEMPTS = 5;
const IPV6_PROBE_DELAY_MS = 2_000;

/**
 * Prove each IPv6 listener in use accepts connections inside the container
 * (`runtime_global_variables` holds the configured string whether or not the
 * bind worked). A few short retries cover a proxy that has just restarted.
 */
async function assertProxySqlIpv6Listening(
  run: RunDockerFn,
  containerName: string,
  ports: readonly number[],
  delayMs: number,
): Promise<void> {
  await forEachSequential(ports, async (port) => {
    let attempt = 0;
    let ok = false;
    await repeatSequential(async () => {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      attempt += 1;
      ok = proxySqlProbeShowsListening(
        await run(proxySqlIpv6ListenProbeArgs(containerName, port)),
      );
      return !ok && attempt < IPV6_PROBE_ATTEMPTS;
    });
    if (!ok) {
      throw new Error(
        `ProxySQL is not accepting connections on [::]:${port} inside its container`,
      );
    }
  });
}

/**
 * Make ProxySQL serve the listener addresses this reconcile wants.
 *
 * `mysql-interfaces` / `pgsql-interfaces` are read only when ProxySQL starts,
 * and from `proxysql.cnf` only on a first boot (an existing `proxysql.db` in
 * the data volume wins), so recreating the container is not enough. When the
 * running value still differs after the compose up (no recreate happened, or
 * {@link stageProxySqlListenerInterfaces} could not reach the admin port),
 * write the new value to `proxysql.db`, restart the container and check it
 * took. Every other table was saved to disk by the admin apply just before,
 * so the restart loads the same users, servers and rules. Returns whether it
 * restarted. A family with no running row is left alone.
 */
async function activateProxySqlListenerInterfaces(
  desired: Record<ProxySqlProtocolFamily, string>,
  layout: LayoutPaths,
  admin: ProxySqlAdminTarget,
): Promise<boolean> {
  const running = await readProxySqlRuntimeInterfaces(admin);
  if (running.mysql === undefined && running.pgsql === undefined) {
    logInfo(
      "commands",
      "managed.ingress.reconcile: ProxySQL reported no listener variables; not checked",
    );
    return false;
  }
  const stale = proxySqlListenerInterfacesMismatch(desired, running);
  if (stale.length === 0) return false;
  logInfo(
    "commands",
    `managed.ingress.reconcile restarting ProxySQL for new listeners: ${
      stale.map((family) =>
        `${family} ${running[family]} -> ${desired[family]}`
      )
        .join(", ")
    }`,
  );
  await applyProxySqlAdminStatements(
    buildProxySqlListenerInterfacesStatements(desired),
    admin,
  );
  await restartProxySqlIngress(layout, admin.runDocker);
  const after = await readProxySqlRuntimeInterfaces(admin);
  const still = proxySqlListenerInterfacesMismatch(desired, after);
  if (still.length > 0) {
    throw new Error(
      `ProxySQL did not take its new listeners after a restart: ${
        still.map((family) => `${family} is ${after[family]}`).join(", ")
      }`,
    );
  }
  return true;
}

/**
 * Compose up when the stack needs it. During a managed-network migration a
 * compose failure is tolerated: the follow-up `docker network connect`
 * ({@link ensureContainerJoinedManagedNetwork}) still moves the frontend.
 */
async function composeUpIfNeeded(
  restartNeeded: boolean,
  layout: LayoutPaths,
  composePath: string,
  nextComposeText: string,
  run: RunDockerFn,
  migrateManagedNetwork: boolean,
  containerName: string,
): Promise<void> {
  if (!restartNeeded) return;
  try {
    await ensureProxySqlComposeUp(
      layout,
      composePath,
      nextComposeText,
      run,
      migrateManagedNetwork,
      containerName,
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!migrateManagedNetwork) throw error;
    logInfo(
      "commands",
      `managed.ingress.reconcile compose up failed; migrating networks anyway: ${error.message}`,
    );
  }
}

/**
 * Join the frontend to the current managed bridge (when migrating) and prune
 * leftovers. Stale networks are disconnected only after a confirmed join so a
 * failed join never strands the container with no managed endpoint.
 */
async function migrateManagedNetworkMembership(
  containerName: string,
  managedNetwork: string,
  previousManagedNetwork: string | null,
  migrate: boolean,
  run: RunDockerFn,
): Promise<void> {
  let joined = true;
  if (migrate) {
    joined = await ensureContainerJoinedManagedNetwork(
      containerName,
      managedNetwork,
      run,
    );
  }
  await pruneStaleManagedDockerNetworks(
    managedNetwork,
    previousManagedNetwork,
    run,
    { disconnect: migrate && joined },
  );
  if (migrate && !joined) {
    throw new Error(
      `ProxySQL container ${containerName} is not on managed network ${managedNetwork}`,
    );
  }
}

function containersFromObserved(
  observed: EnvironmentDeployContainer | null | undefined,
): EnvironmentDeployContainer[] | undefined {
  if (observed === undefined) return undefined;
  return observed === null ? [] : [observed];
}

/**
 * Read ProxySQL's runtime tables back after the admin apply and refuse to
 * report success while they still route somewhere the desired state does not
 * (for instance a writer hostgroup still holding the old primary after a
 * failover). Only called with at least one cluster, never on teardown.
 */
async function assertRuntimeRepointed(
  desired: ProxySqlDesiredState,
  admin: {
    runDocker: RunDockerFn;
    layout: LayoutPaths;
    containerName: string;
  },
): Promise<void> {
  const families = proxySqlFamiliesInUse(desired);
  const tables = await Promise.all(
    families.map((family) => readProxySqlRuntimeServers(family, admin)),
  );
  const runtime: Partial<
    Record<(typeof families)[number], ProxySqlRuntimeServerRow[]>
  > = {};
  families.forEach((family, index) => {
    runtime[family] = tables[index];
  });
  const mismatch = findIngressRuntimeMismatch(desired, runtime);
  if (mismatch !== null) throw new Error(sanitizeForLog(mismatch));
}

export function handleManagedIngressReconcile(
  payload: ManagedIngressReconcilePayload,
  daemonReceivedAt: string,
  deps?: ManagedIngressReconcileHandlerDeps,
): Promise<ManagedIngressReconcileResult> {
  return withProxySqlLock(async () => {
    const result = await reconcileManagedIngress(
      payload,
      daemonReceivedAt,
      deps,
    );
    // Only a reconcile that settled the stack (up or deliberate down) makes
    // the boot repair stand down; a thrown one leaves it free to run.
    markProxySqlReconciled();
    return result;
  });
}

async function resolveMonitorCredentials(
  layout: ReturnType<typeof resolveLayout>,
  monitor: ManagedIngressReconcilePayload["monitor"],
  decryptSecrets: DecryptSecretsFn,
): Promise<{ user: string; password: string } | null> {
  if (!monitor) return await loadProxySqlMonitorCredentials(layout);
  const [monitorPassword] = await decryptSecrets([monitor.password]);
  if (typeof monitorPassword !== "string" || monitorPassword.length === 0) {
    throw new Error(
      "managed.ingress.reconcile failed to decrypt monitor credential",
    );
  }
  const credentials = { user: monitor.username, password: monitorPassword };
  await writeProxySqlConfigAtomic(
    proxysqlMonitorCnfPath(layout),
    `[client]\nuser=${credentials.user}\npassword=${credentials.password}\n`,
  );
  return credentials;
}

async function reconcileManagedIngress(
  payload: ManagedIngressReconcilePayload,
  daemonReceivedAt: string,
  deps?: ManagedIngressReconcileHandlerDeps,
): Promise<ManagedIngressReconcileResult> {
  const parsed = parseManagedIngressReconcilePayload(payload);
  const layout = resolveLayout(Deno.env.toObject());
  const { run, ensureDockerFn, runHostPrep } = resolveHandlerDeps(deps);

  if (parsed.clusters.length === 0) {
    return await tearDownProxySqlStack(
      layout,
      parsed.serverId,
      parsed.managedNetwork,
      daemonReceivedAt,
      run,
    );
  }

  // The managed network must exist before any lazy host prep runs: that
  // playbook ends by starting `turbopanel-proxysql-stack.service`, whose unit
  // runs `docker compose up -d` against an existing compose file. On a rerun
  // where the external managed network was pruned, that start fails unless the
  // daemon recreated the network first.
  await ensureDockerFn();
  await ensureManagedIngressNetwork(parsed.managedNetwork, run);

  if (!(await proxySqlHostPrepPresent(layout))) {
    await runHostPrep();
  }

  if (!deps?.decryptSecrets) {
    throw new Error("managed.ingress.reconcile requires decryptSecrets");
  }
  if (!parsed.orgTlsMaterial) {
    throw new Error("managed.ingress.reconcile requires orgTlsMaterial");
  }

  let desired = desiredStateFromPayload(parsed);
  desired = await decryptProxySqlUserPasswords(desired, deps.decryptSecrets);
  assertNoFrontendUserConflict(desired);

  await materializeProxySqlTlsMaterial(
    proxysqlTlsDir(layout),
    parsed.orgTlsMaterial,
    deps.decryptSecrets,
  );

  const adminCredentials = await loadProxySqlAdminCredentials(layout);
  // Payload monitor credential (control-plane minted, per server) wins over
  // the host-seeded `monitor.cnf`: cross-host clusters need every server to
  // monitor with its own control-plane-known identity (the engine roles are
  // created from `managed.apply` monitorUsers). Rewrite `monitor.cnf` so the
  // engine-apply fallback path stays consistent with what ProxySQL uses.
  const monitorCredentials = await resolveMonitorCredentials(
    layout,
    parsed.monitor,
    deps.decryptSecrets,
  );
  const bindAddresses = desired.bindAddresses;
  const composePath = proxysqlComposePath(layout);
  const configPath = proxysqlConfigPath(layout);
  const previousComposeText = await readPreviousConfig(composePath);
  const ipv6Supported = await resolveProxySqlIpv6Support(
    bindAddresses,
    previousComposeText,
    run,
  );
  const nextConfig = renderProxySqlConfig(
    desired,
    adminCredentials,
    monitorCredentials,
    ipv6Supported,
  );
  const previousConfig = await readPreviousConfig(configPath);
  const descriptor = await resolveManagedIngressDescriptor(
    layout,
    parsed.identity,
    previousComposeText,
  );
  // A bind change between loopback and all IPv4 interfaces only changes the
  // compose `ports:` publish (ProxySQL's own `interfaces=` stays all IPv4
  // interfaces), caught by the full nextComposeText comparison below along with
  // container_name renames. Adding or dropping an IPv6 publish also changes
  // the networks and the listeners (`interfaces=` gains or loses `[::]`), which
  // `activateProxySqlListenerInterfaces` applies.
  const {
    previousBindAddresses,
    previousListenerPorts,
    previousManagedNetwork,
  } = readPreviousComposeFacts(previousComposeText);

  // Preflight before the first write: an organization port that something else
  // on this host already owns must fail while the current frontend is still
  // serving, not after `compose up` has torn it down.
  await assertManagedIngressPortsBindable(
    bindAddresses,
    desired.listenerPorts ?? DEFAULT_PROXYSQL_LISTENER_PORTS,
    previousListenerPorts,
    deps?.probeHostPort,
  );

  await writeProxySqlConfigAtomic(configPath, nextConfig);

  // Compose identity (container_name / publish bind) and static cnf changes
  // need compose up. Comparing rendered compose catches containerName
  // → `<serviceId>-in` changes that static cnf never sees.
  const nextComposeText = proxysqlCompose(
    descriptor,
    bindAddresses,
    desired.segments ?? [],
    desired.listenerPorts,
    parsed.managedNetwork,
    ipv6Supported,
  );
  const attachedNetworks = await dockerContainerNetworkNames(
    descriptor.containerName,
    run,
  );
  const networkRenamed = previousManagedNetwork !== null &&
    previousManagedNetwork !== parsed.managedNetwork;
  const attachedToStale = containerMissesManagedNetwork(
    attachedNetworks,
    parsed.managedNetwork,
  );
  const migrateManagedNetwork = networkRenamed || attachedToStale;
  // A compose up that failed after the file was written leaves the old
  // container running without ProxySQL's IPv6 network while the file on disk
  // already matches; a restart would not attach it, only a recreate does.
  const missesIpv6Network =
    readProxySqlIpv6SubnetFromCompose(nextComposeText) !== null &&
    attachedNetworks.length > 0 &&
    !attachedNetworks.includes(
      `${proxysqlProject(descriptor.serviceId)}_${PROXYSQL_IPV6_NETWORK}`,
    );
  const composeNeedsUp =
    previousComposeText?.trimEnd() !== nextComposeText.trimEnd() ||
    migrateManagedNetwork || missesIpv6Network;
  let restartNeeded = composeNeedsUp ||
    staticConfigSectionChanged(previousConfig, nextConfig) ||
    !sameBindAddresses(previousBindAddresses, bindAddresses);
  if (!restartNeeded) {
    const current = await inspectProxySqlContainer(layout, descriptor, {
      runDocker: run,
    });
    restartNeeded = proxysqlStackNeedsComposeUp(current);
  }

  const desiredInterfaces = desiredProxySqlListenerInterfaces(
    desired.listenerPorts ?? DEFAULT_PROXYSQL_LISTENER_PORTS,
    ipv6Supported && proxySqlBindsUseIpv6(bindAddresses),
  );
  const adminTarget = {
    runDocker: run,
    layout,
    containerName: descriptor.containerName,
  };
  if (restartNeeded) {
    // Before compose recreates the container, so it starts with the new
    // listeners: one blip, and never an IPv6 network with no IPv6 listener.
    await stageProxySqlListenerInterfaces(desiredInterfaces, adminTarget);
  }
  await composeUpIfNeeded(
    restartNeeded,
    layout,
    composePath,
    nextComposeText,
    run,
    migrateManagedNetwork,
    descriptor.containerName,
  );

  await migrateManagedNetworkMembership(
    descriptor.containerName,
    parsed.managedNetwork,
    previousManagedNetwork,
    migrateManagedNetwork,
    run,
  );

  const containerName = descriptor.containerName;

  const statements = buildProxySqlAdminStatements(desired, {
    monitor: monitorCredentials,
    // Read after the stack and its networks are settled, on every reconcile,
    // so a recreated Docker network's new subnet is picked up here.
    ...(desiredHasGuardedRoot(desired)
      ? { localRootSources: await collectLocalRootSources(containerName, run) }
      : {}),
  });
  await applyProxySqlAdminStatements(statements, {
    runDocker: run,
    layout,
    containerName,
  });
  const interfacesRestarted = await activateProxySqlListenerInterfaces(
    desiredInterfaces,
    layout,
    adminTarget,
  );
  if (interfacesRestarted) restartNeeded = true;
  if (desiredInterfaces.mysql.includes("[::]")) {
    const ports = desired.listenerPorts ?? DEFAULT_PROXYSQL_LISTENER_PORTS;
    await assertProxySqlIpv6Listening(
      run,
      containerName,
      proxySqlFamiliesInUse(desired).map((family) => ports[family]),
      deps?.ipv6ProbeDelayMs ?? IPV6_PROBE_DELAY_MS,
    );
  }
  await assertRuntimeRepointed(desired, {
    runDocker: run,
    layout,
    containerName,
  });

  const containers = containersFromObserved(
    await inspectProxySqlContainer(layout, descriptor, { runDocker: run }),
  );

  logInfo(
    "commands",
    `managed.ingress.reconcile completed serverId=${parsed.serverId} restarted=${restartNeeded} received=${daemonReceivedAt}`,
  );

  const result: ManagedIngressReconcileResult = {
    summary: `managed ingress reconciled for server ${parsed.serverId}`,
    appliedUsers: collectAppliedUsers(desired),
    appliedBackends: collectAppliedBackends(desired),
    restarted: restartNeeded,
  };
  if (containers !== undefined) {
    result.containers = containers;
  }
  return result;
}
