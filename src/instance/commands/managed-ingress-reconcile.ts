/**
 * `managed.ingress.reconcile` — whole-server ProxySQL desired state.
 */

import type {
  EnvironmentDeployContainer,
  ManagedIngressReconcilePayload,
  ManagedIngressReconcileResult,
} from "./contracts.ts";
import { parseManagedIngressReconcilePayload } from "./contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../../deploy/docker-cli.ts";
import { ensureDocker as defaultEnsureDocker } from "../../deploy/ensure-docker.ts";
import {
  PROXYSQL_COMPOSE_SERVICE_NAME,
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  type SystemComponentDescriptor,
  writeSystemComponentDescriptor,
} from "../../deploy/system-component.ts";
import { ingressContainerName } from "../../deploy/ingress-identity.ts";
import { logInfo } from "../../logger.ts";
import { type LayoutPaths, resolveLayout } from "../../paths/layout.ts";
import {
  containerMissesManagedNetwork,
  dockerContainerNetworkNames,
  ensureContainerJoinedManagedNetwork,
  ensureManagedIngressNetwork,
  pruneStaleManagedDockerNetworks,
} from "../../managed/networks.ts";
import {
  applyProxySqlAdminStatements,
  assertProxySqlHostRegularFile,
  loadProxySqlAdminCredentials,
  loadProxySqlMonitorCredentials,
  proxySqlHostPrepPresent,
} from "../../managed/proxysql-admin.ts";
import { runProxySqlSetup } from "../../orchestration/ansible.ts";
import {
  assertManagedIngressPortsBindable,
  assertNoFrontendUserConflict,
  buildProxySqlAdminStatements,
  DEFAULT_PROXYSQL_LISTENER_PORTS,
  inspectProxySqlContainer,
  type ProbeHostPortFn,
  proxysqlCompose,
  type ProxySqlDesiredState,
  readManagedNetworkFromCompose,
  readPublishedBindAddressesFromCompose,
  readPublishedListenerPortsFromCompose,
  renderProxySqlConfig,
  staticConfigSectionChanged,
  writeProxySqlConfigAtomic,
} from "../../managed/proxysql.ts";
import { materializeProxySqlTlsMaterial } from "../../managed/tls.ts";
import {
  proxysqlAdminCnfPath,
  proxysqlComposePath,
  proxysqlConfigPath,
  proxysqlTlsDir,
} from "../../managed/paths.ts";

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
};

function desiredStateFromPayload(
  payload: ManagedIngressReconcilePayload,
): ProxySqlDesiredState {
  return {
    // Missing/empty `bindAddresses` means "no cluster currently wants an access
    // scope that reaches the host" (see instance `ingress-desired.ts`
    // `decideIngressBindScopes`) — it must never be widened to "publish on every
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

async function tearDownProxySqlStack(
  layout: LayoutPaths,
  serverId: string,
  daemonReceivedAt: string,
  run: RunDockerFn,
): Promise<ManagedIngressReconcileResult> {
  const composePath = proxysqlComposePath(layout);
  const previousComposeText = await readPreviousConfig(composePath);
  if (previousComposeText === null) {
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

export async function handleManagedIngressReconcile(
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
  const monitorCredentials = await loadProxySqlMonitorCredentials(layout);
  const bindAddresses = desired.bindAddresses;
  const composePath = proxysqlComposePath(layout);
  const configPath = proxysqlConfigPath(layout);
  const nextConfig = renderProxySqlConfig(
    desired,
    adminCredentials,
    monitorCredentials,
  );
  const previousConfig = await readPreviousConfig(configPath);
  const previousComposeText = await readPreviousConfig(composePath);
  const descriptor = await resolveManagedIngressDescriptor(
    layout,
    parsed.identity,
    previousComposeText,
  );
  // ProxySQL's internal `interfaces=` line is now a fixed constant (see
  // `CONTAINER_LISTEN_ADDRESS` in proxysql.ts), so a bind-only change
  // (public <-> private, a different address, or gaining/losing a second scope)
  // only changes the compose `ports:` publish — caught by full nextComposeText
  // comparison below (along with container_name renames).
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
  const composeNeedsUp =
    previousComposeText?.trimEnd() !== nextComposeText.trimEnd() ||
    migrateManagedNetwork;
  let restartNeeded = composeNeedsUp ||
    staticConfigSectionChanged(previousConfig, nextConfig) ||
    !sameBindAddresses(previousBindAddresses, bindAddresses);
  if (!restartNeeded) {
    const current = await inspectProxySqlContainer(layout, descriptor, {
      runDocker: run,
    });
    restartNeeded = proxysqlStackNeedsComposeUp(current);
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
  });
  await applyProxySqlAdminStatements(statements, {
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
