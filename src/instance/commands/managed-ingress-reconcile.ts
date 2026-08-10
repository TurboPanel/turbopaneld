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
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
} from "../../deploy/system-component.ts";
import { logInfo } from "../../logger.ts";
import { type LayoutPaths, resolveLayout } from "../../paths/layout.ts";
import { ensureManagedIngressNetwork } from "../../managed/networks.ts";
import {
  applyProxySqlAdminStatements,
  loadProxySqlAdminCredentials,
} from "../../managed/proxysql-admin.ts";
import {
  assertNoFrontendUserConflict,
  buildProxySqlAdminStatements,
  inspectProxySqlContainer,
  legacySweepLegacyManagedTraefikIngress,
  proxysqlCompose,
  type ProxySqlDesiredState,
  readPublishedBindAddressFromCompose,
  renderProxySqlConfig,
  staticConfigSectionChanged,
  writeProxySqlConfigAtomic,
} from "../../managed/proxysql.ts";
import { materializeProxySqlTlsMaterial } from "../../managed/tls.ts";
import {
  PROXYSQL_PROJECT,
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
};

function desiredStateFromPayload(
  payload: ManagedIngressReconcilePayload,
): ProxySqlDesiredState {
  return {
    // A missing `bindAddress` means "no cluster currently wants public/
    // datacenter exposure" (see instance `ingress-desired.ts`
    // `unionExposureBind`) — it must never be widened to "publish on every
    // interface". `null` here means the shared frontend is reachable only
    // via `MANAGED_INGRESS_NETWORK` (bindings from co-located compose
    // services), never the host. See `ProxySqlDesiredState.bindAddress`.
    bindAddress: payload.bindAddress ?? null,
    clusters: payload.clusters.map((cluster) => ({
      managedId: cluster.managedId,
      engine: cluster.engine,
      protocolPort: cluster.protocolPort,
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
      })),
    })),
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
  return { bindAddress: desired.bindAddress, clusters };
}

async function readPreviousConfig(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function ensureProxySqlComposeUp(
  layout: LayoutPaths,
  composePath: string,
  composeYaml: string,
  run: RunDockerFn,
): Promise<void> {
  const configDir = proxysqlComposePath(layout).replace(
    /\/docker-compose\.yml$/,
    "",
  );
  await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
  await Deno.writeTextFile(composePath, composeYaml, { mode: 0o640 });
  const up = await run([
    "compose",
    "-p",
    PROXYSQL_PROJECT,
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!up.success) {
    throw new Error(up.stderr || "proxysql compose up failed");
  }
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

export async function handleManagedIngressReconcile(
  payload: ManagedIngressReconcilePayload,
  daemonReceivedAt: string,
  deps?: ManagedIngressReconcileHandlerDeps,
): Promise<ManagedIngressReconcileResult> {
  const parsed = parseManagedIngressReconcilePayload(payload);
  const layout = resolveLayout(Deno.env.toObject());
  const run = deps?.runDocker ?? defaultRunDocker;
  const ensureDockerFn = deps?.ensureDocker ?? defaultEnsureDocker;

  if (!deps?.decryptSecrets) {
    throw new Error("managed.ingress.reconcile requires decryptSecrets");
  }

  let desired = desiredStateFromPayload(parsed);
  desired = await decryptProxySqlUserPasswords(desired, deps.decryptSecrets);
  assertNoFrontendUserConflict(desired);

  await materializeProxySqlTlsMaterial(
    proxysqlTlsDir(layout),
    parsed.orgTlsMaterial,
    deps.decryptSecrets,
  );

  await ensureDockerFn();
  await ensureManagedIngressNetwork(run);
  await legacySweepLegacyManagedTraefikIngress(layout, run);

  const descriptor = await readSystemComponentDescriptor(
    layout,
    SYSTEM_MANAGED_INGRESS_COMPONENT,
  );

  const adminCredentials = await loadProxySqlAdminCredentials(layout);
  const bindAddress = desired.bindAddress;
  const composePath = proxysqlComposePath(layout);
  const configPath = proxysqlConfigPath(layout);
  const nextConfig = renderProxySqlConfig(desired, adminCredentials);
  const previousConfig = await readPreviousConfig(configPath);
  const previousComposeText = await readPreviousConfig(composePath);
  // ProxySQL's internal `interfaces=` line is now a fixed constant (see
  // `CONTAINER_LISTEN_ADDRESS` in proxysql.ts), so a bindAddress-only change
  // (public <-> private, or a different published address) no longer shows
  // up in `staticConfigSectionChanged` — it only ever changes the compose
  // `ports:` publish. Detect that independently so toggling exposure still
  // triggers `compose up` and actually applies/removes the host publish.
  const previousBindAddress = previousComposeText === null
    ? null
    : readPublishedBindAddressFromCompose(previousComposeText);
  const restartNeeded = previousComposeText === null ||
    staticConfigSectionChanged(previousConfig, nextConfig) ||
    previousBindAddress !== bindAddress;

  await writeProxySqlConfigAtomic(configPath, nextConfig);

  if (restartNeeded) {
    await ensureProxySqlComposeUp(
      layout,
      composePath,
      proxysqlCompose(descriptor, bindAddress),
      run,
    );
  }

  const containerName = descriptor?.containerName;
  if (!containerName) {
    throw new Error("managed-ingress descriptor is missing");
  }

  const statements = buildProxySqlAdminStatements(desired);
  await applyProxySqlAdminStatements(statements, {
    runDocker: run,
    layout,
    containerName,
  });

  let containers: EnvironmentDeployContainer[] | undefined;
  if (descriptor) {
    const observed = await inspectProxySqlContainer(layout, descriptor, {
      runDocker: run,
    });
    if (observed === undefined) {
      containers = undefined;
    } else if (observed !== null) {
      containers = [observed];
    } else {
      containers = [];
    }
  }

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
