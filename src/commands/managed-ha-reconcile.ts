/**
 * `managed.ha.reconcile` — whole-server Orchestrator desired state.
 *
 * Empty desired tears the stack down. Present desired writes compose +
 * `Recover: false` config, then registers clusters with the organization's
 * topology account, org-wide HTTP/Raft credentials, and org CA.
 */

import type {
  EnvironmentDeployContainer,
  ManagedHaCluster,
  ManagedHaReconcilePayload,
  ManagedHaReconcileResult,
  ManagedHaRegistrationFailure,
} from "../contracts/commands-contracts.ts";
import { parseManagedHaReconcilePayload } from "../contracts/commands-contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import {
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_HA_COMPONENT,
  type SystemComponentDescriptor,
  writeSystemComponentDescriptor,
} from "../deploy/system-component.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { ensureManagedIngressNetwork } from "../managed/networks.ts";
import { materializeProxySqlTlsMaterial } from "../managed/tls.ts";
import {
  ensureOrchestratorStack,
  hostPrepPresent,
  inspectOrchestratorContainer,
  loadOrchestratorApiCredentials,
  loadOrchestratorRaftToken,
  materializeOrchestratorHostCredentials,
  ORCHESTRATOR_TLS_CA_PATH,
  type OrchestratorApiCredentials,
  orchestratorTopologyAliases,
  renderOrchestratorConf,
  resolveOrchestratorRegisterHost,
  stopOrchestratorStack,
} from "../managed/orchestrator.ts";
import {
  discoverInstance,
  type OrchestratorApiDeps,
  registerCandidate,
  setClusterAlias,
} from "../managed/orchestrator-api.ts";
import { orchestratorTlsDir } from "../managed/engine-paths.ts";
import { runOrchestratorSetup } from "../orchestration/ansible.ts";
import { clipKeepingEnd } from "../util/error-line.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

async function decryptHaReconcileSecret(
  ciphertext: string,
  decryptSecrets: DecryptSecretsFn | undefined,
  emptyError: string,
): Promise<string> {
  if (!decryptSecrets) {
    throw new Error("managed.ha.reconcile requires decryptSecrets");
  }
  const [plain] = await decryptSecrets([ciphertext]);
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error(emptyError);
  }
  return plain;
}

export type ManagedHaReconcileHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
  runDocker?: RunDockerFn;
  ensureDocker?: () => Promise<void>;
  runHostPrep?: () => Promise<void>;
  orchestratorApi?: OrchestratorApiDeps;
};

function emptyHaResult(serverId: string): ManagedHaReconcileResult {
  return {
    summary: `managed HA torn down for server ${serverId}`,
    registeredClusters: [],
    failedClusters: [],
    partial: false,
    restarted: false,
    containers: [],
  };
}

async function persistIdentity(
  layout: LayoutPaths,
  payload: ManagedHaReconcilePayload,
): Promise<SystemComponentDescriptor> {
  const descriptor: SystemComponentDescriptor = {
    component: SYSTEM_MANAGED_HA_COMPONENT,
    serviceId: payload.identity.serviceId,
    composeServiceName: payload.identity.composeServiceName,
    containerName: payload.identity.containerName,
    role: "turbopanel",
  };
  await writeSystemComponentDescriptor(layout, descriptor);
  return descriptor;
}

async function resolveOrchestratorHttpAuth(
  payload: ManagedHaReconcilePayload,
  layout: LayoutPaths,
  decryptSecrets?: DecryptSecretsFn,
): Promise<OrchestratorApiCredentials> {
  if (payload.orchestratorApiUser) {
    const password = await decryptHaReconcileSecret(
      payload.orchestratorApiUser.password,
      decryptSecrets,
      "failed to decrypt managed HA orchestrator API password",
    );
    return {
      user: payload.orchestratorApiUser.username,
      password,
    };
  }
  return await loadOrchestratorApiCredentials(layout);
}

async function resolveOrchestratorRaftAuthToken(
  payload: ManagedHaReconcilePayload,
  layout: LayoutPaths,
  decryptSecrets?: DecryptSecretsFn,
): Promise<string | null> {
  if (payload.orchestratorRaftToken) {
    return await decryptHaReconcileSecret(
      payload.orchestratorRaftToken,
      decryptSecrets,
      "failed to decrypt managed HA orchestrator raft token",
    );
  }
  return await loadOrchestratorRaftToken(layout);
}

async function materializeOrchestratorSecretsIfPresent(
  payload: ManagedHaReconcilePayload,
  layout: LayoutPaths,
  decryptSecrets?: DecryptSecretsFn,
): Promise<{
  httpAuth: OrchestratorApiCredentials;
  raftAuthToken: string | null;
}> {
  const httpAuth = await resolveOrchestratorHttpAuth(
    payload,
    layout,
    decryptSecrets,
  );
  const raftAuthToken = await resolveOrchestratorRaftAuthToken(
    payload,
    layout,
    decryptSecrets,
  );
  if (payload.orchestratorApiUser && payload.orchestratorRaftToken) {
    if (raftAuthToken === null) {
      throw new Error(
        "managed HA orchestrator raft token missing after decrypt",
      );
    }
    await materializeOrchestratorHostCredentials(layout, {
      httpAuth,
      raftToken: raftAuthToken,
    });
  }
  return { httpAuth, raftAuthToken };
}

async function resolveOrchestratorTopologyCredentials(
  payload: ManagedHaReconcilePayload,
  decryptSecrets?: DecryptSecretsFn,
): Promise<{ topologyUser: string; topologyPassword: string }> {
  if (payload.topologyUser) {
    const topologyPassword = await decryptHaReconcileSecret(
      payload.topologyUser.password,
      decryptSecrets,
      "failed to decrypt managed HA topology password",
    );
    return {
      topologyUser: payload.topologyUser.username,
      topologyPassword,
    };
  }
  const cluster = payload.clusters.find((entry) =>
    orchestratorMonitorsEngine(entry.engine)
  );
  if (!cluster) {
    return { topologyUser: "tp_repl", topologyPassword: "" };
  }
  const topologyPassword = await decryptHaReconcileSecret(
    cluster.replicationPasswordEnvelope,
    decryptSecrets,
    "failed to decrypt managed HA replication password",
  );
  return {
    topologyUser: cluster.replicationUsername,
    topologyPassword,
  };
}

async function materializeOrchestratorOrgTls(
  payload: ManagedHaReconcilePayload,
  layout: LayoutPaths,
  decryptSecrets?: DecryptSecretsFn,
): Promise<void> {
  if (!payload.orgTlsMaterial) return;
  if (!decryptSecrets) {
    throw new Error("managed.ha.reconcile requires decryptSecrets");
  }
  await materializeProxySqlTlsMaterial(
    orchestratorTlsDir(layout),
    payload.orgTlsMaterial,
    decryptSecrets,
  );
}

/**
 * Engines the bundled Orchestrator can monitor. It speaks only the MySQL
 * protocol: a Postgres member answers `/api/discover` with HTTP 500
 * `invalid connection`, which aborted the whole reconcile, so no MySQL or
 * MariaDB cluster after it on the same server registered either.
 */
export function orchestratorMonitorsEngine(engine: string): boolean {
  return engine === "mysql" || engine === "mariadb";
}

async function registerClusters(
  clusters: readonly ManagedHaCluster[],
  api: OrchestratorApiDeps,
): Promise<{
  registeredClusters: string[];
  failedClusters: ManagedHaRegistrationFailure[];
}> {
  const registered: string[] = [];
  const failures: ManagedHaRegistrationFailure[] = [];
  await forEachSequential(clusters, async (cluster) => {
    try {
      await registerOneCluster(cluster, api);
      registered.push(cluster.managedId);
    } catch (err) {
      logWarn(
        "commands",
        `managed.ha.reconcile failed to register cluster ${cluster.managedId}:`,
        sanitizeForLog(err),
      );
      failures.push({
        managedId: cluster.managedId,
        error: clipKeepingEnd(sanitizeForLog(err)),
      });
    }
  });
  if (clusters.length > 0 && registered.length === 0) {
    throw new Error(
      `managed.ha.reconcile failed to register every monitored cluster: ${
        formatRegistrationFailures(failures)
      }`,
    );
  }
  return {
    registeredClusters: registered.toSorted((a, b) => a.localeCompare(b)),
    failedClusters: failures.toSorted((a, b) =>
      a.managedId.localeCompare(b.managedId)
    ),
  };
}

function formatRegistrationFailures(
  failures: readonly ManagedHaRegistrationFailure[],
): string {
  return failures.map((failure) => `${failure.managedId}: ${failure.error}`)
    .join("; ");
}

async function registerOneCluster(
  cluster: ManagedHaCluster,
  api: OrchestratorApiDeps,
): Promise<void> {
  await forEachSequential(cluster.members, async (member) => {
    // `host` is the private-listener address (not the Docker name, which
    // only resolves on the member's own host). `containerName` is mapped
    // via extra_hosts so a later topology walk can still resolve it.
    await discoverInstance({ host: member.host, port: member.port }, api);
    await registerCandidate(
      { host: member.host, port: member.port },
      member.promotionRule,
      api,
    );
  });
  const primary = cluster.members.find((member) => member.role === "primary");
  if (primary) {
    await setClusterAlias(
      `${primary.host}:${primary.port}`,
      cluster.clusterAlias,
      api,
    ).catch(() => {
      // Alias is best-effort — recover still keys off host:port.
    });
  }
}

async function resolveClustersForOrchestrator(
  clusters: readonly ManagedHaCluster[],
  run: RunDockerFn,
): Promise<ManagedHaCluster[]> {
  const resolved: ManagedHaCluster[] = [];
  await forEachSequential(clusters, async (cluster) => {
    const members: ManagedHaCluster["members"] = [];
    await forEachSequential(cluster.members, async (member) => {
      try {
        const dial = await resolveOrchestratorRegisterHost(member, run);
        members.push({ ...member, host: dial.host, port: dial.port });
      } catch (err) {
        // A stopped or recreating member (exactly when a primary just died)
        // must not abort the reconcile for everyone else on this server.
        logWarn(
          "commands",
          `managed.ha.reconcile skipped member ${
            member.containerName ?? member.host
          }: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    if (members.length > 0) resolved.push({ ...cluster, members });
  });
  return resolved;
}

async function reconcileOrchestratorPresentState(
  payload: ManagedHaReconcilePayload,
  layout: LayoutPaths,
  daemonReceivedAt: string,
  deps: ManagedHaReconcileHandlerDeps | undefined,
): Promise<ManagedHaReconcileResult> {
  const run = deps?.runDocker ?? defaultRunDocker;
  const ensureDocker = deps?.ensureDocker ?? defaultEnsureDocker;
  const runHostPrep = deps?.runHostPrep ?? runOrchestratorSetup;

  await ensureDocker();
  await ensureManagedIngressNetwork(payload.managedNetwork, run);

  const { httpAuth, raftAuthToken } =
    await materializeOrchestratorSecretsIfPresent(
      payload,
      layout,
      deps?.decryptSecrets,
    );

  if (!(await hostPrepPresent(layout))) {
    await runHostPrep();
  }

  await materializeOrchestratorOrgTls(payload, layout, deps?.decryptSecrets);

  const mysqlClusters = payload.clusters.filter((cluster) =>
    orchestratorMonitorsEngine(cluster.engine)
  );
  if (mysqlClusters.length < payload.clusters.length) {
    logInfo(
      "commands",
      `managed.ha.reconcile ignored ${
        payload.clusters.length - mysqlClusters.length
      } Postgres cluster(s) in payload serverId=${payload.serverId}`,
    );
  }
  const { topologyUser, topologyPassword } =
    await resolveOrchestratorTopologyCredentials(payload, deps?.decryptSecrets);
  const conf = renderOrchestratorConf({
    raft: payload.raft!,
    httpAuth,
    topologyUser,
    topologyPassword,
    sslCaPath: payload.orgTlsMaterial ? ORCHESTRATOR_TLS_CA_PATH : undefined,
    ...(raftAuthToken ? { raftAuthToken } : {}),
  });

  const descriptor = await readSystemComponentDescriptor(
    layout,
    SYSTEM_MANAGED_HA_COMPONENT,
  );
  if (!descriptor) {
    throw new Error("managed-ha identity missing after persist");
  }

  const clusters = await resolveClustersForOrchestrator(
    mysqlClusters,
    run,
  );
  const topologyAliases = orchestratorTopologyAliases(
    clusters.flatMap((cluster) => cluster.members),
  );
  const restarted = await ensureOrchestratorStack(
    layout,
    descriptor,
    payload.raft!,
    payload.managedNetwork,
    conf,
    run,
    { topologyAliases },
  );

  const api: OrchestratorApiDeps = {
    ...deps?.orchestratorApi,
    credentials: httpAuth,
  };
  const registrations = clusters.length === 0
    ? { registeredClusters: [], failedClusters: [] }
    : await registerClusters(clusters, api);
  const { registeredClusters, failedClusters } = registrations;
  const partial = failedClusters.length > 0;

  let containers: EnvironmentDeployContainer[] | undefined;
  const observed = await inspectOrchestratorContainer(layout, descriptor, {
    runDocker: run,
  });
  if (observed) containers = [observed];

  logInfo(
    "commands",
    `managed.ha.reconcile completed serverId=${payload.serverId} clusters=${registeredClusters.length} failed=${failedClusters.length} received=${daemonReceivedAt}`,
  );
  const summary = partial
    ? `managed HA partially reconciled for server ${payload.serverId}; failed clusters: ${
      formatRegistrationFailures(failedClusters)
    }`
    : `managed HA reconciled for server ${payload.serverId}`;
  return {
    summary,
    registeredClusters,
    failedClusters,
    partial,
    restarted,
    ...(containers ? { containers } : {}),
  };
}

export async function handleManagedHaReconcile(
  rawPayload: unknown,
  daemonReceivedAt: string,
  deps?: ManagedHaReconcileHandlerDeps,
): Promise<ManagedHaReconcileResult> {
  const payload = parseManagedHaReconcilePayload(rawPayload);
  const layout = resolveLayout(Deno.env.toObject());
  const run = deps?.runDocker ?? defaultRunDocker;
  const ensureDocker = deps?.ensureDocker ?? defaultEnsureDocker;

  await persistIdentity(layout, payload);

  // Teardown must never trigger lazy host prep: that playbook ends by starting
  // `turbopanel-orchestrator-stack.service`, so a partially prepared host would
  // start the stack on its way to stopping it.
  if (payload.desired === "absent" || payload.raft === null) {
    await ensureDocker();
    await stopOrchestratorStack(layout, run);
    logInfo(
      "commands",
      `managed.ha.reconcile teardown completed serverId=${payload.serverId} received=${daemonReceivedAt}`,
    );
    return emptyHaResult(payload.serverId);
  }

  return await reconcileOrchestratorPresentState(
    payload,
    layout,
    daemonReceivedAt,
    deps,
  );
}
