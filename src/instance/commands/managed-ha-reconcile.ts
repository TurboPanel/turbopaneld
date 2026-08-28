/**
 * `managed.ha.reconcile` — whole-server Orchestrator desired state.
 *
 * Empty desired tears the stack down. Present desired writes compose +
 * `Recover: false` config, then registers clusters with `tp_repl` + org CA.
 */

import type {
  EnvironmentDeployContainer,
  ManagedHaCluster,
  ManagedHaReconcilePayload,
  ManagedHaReconcileResult,
} from "./contracts.ts";
import { parseManagedHaReconcilePayload } from "./contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../../deploy/docker-cli.ts";
import { ensureDocker as defaultEnsureDocker } from "../../deploy/ensure-docker.ts";
import {
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_HA_COMPONENT,
  type SystemComponentDescriptor,
  writeSystemComponentDescriptor,
} from "../../deploy/system-component.ts";
import { logInfo } from "../../logger.ts";
import { type LayoutPaths, resolveLayout } from "../../paths/layout.ts";
import { ensureManagedIngressNetwork } from "../../managed/networks.ts";
import { materializeProxySqlTlsMaterial } from "../../managed/tls.ts";
import {
  ensureOrchestratorStack,
  hostPrepPresent,
  inspectOrchestratorContainer,
  loadOrchestratorApiCredentials,
  loadOrchestratorRaftToken,
  renderOrchestratorConf,
  stopOrchestratorStack,
} from "../../managed/orchestrator.ts";
import {
  discoverInstance,
  type OrchestratorApiDeps,
  registerCandidate,
  setClusterAlias,
} from "../../managed/orchestrator-api.ts";
import { orchestratorTlsDir } from "../../managed/paths.ts";
import { runOrchestratorSetup } from "../../orchestration/ansible.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

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

async function decryptTopologyPassword(
  cluster: ManagedHaCluster,
  decryptSecrets?: DecryptSecretsFn,
): Promise<string> {
  if (!decryptSecrets) {
    throw new Error("managed.ha.reconcile requires decryptSecrets");
  }
  const [plain] = await decryptSecrets([cluster.replicationPasswordEnvelope]);
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("failed to decrypt managed HA replication password");
  }
  return plain;
}

async function registerClusters(
  clusters: readonly ManagedHaCluster[],
  api: OrchestratorApiDeps,
): Promise<string[]> {
  const registered: string[] = [];
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      await discoverInstance({ host: member.host, port: member.port }, api);
      await registerCandidate(
        { host: member.host, port: member.port },
        member.promotionRule,
        api,
      );
    }
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
    registered.push(cluster.managedId);
  }
  return registered.sort((a, b) => a.localeCompare(b));
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
  const runHostPrep = deps?.runHostPrep ?? runOrchestratorSetup;

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

  // And the managed network must exist before host prep can start that unit:
  // the unit runs `docker compose up -d` whenever compose already exists, which
  // fails against a pruned external network unless the daemon recreates it
  // first.
  await ensureDocker();
  await ensureManagedIngressNetwork(payload.managedNetwork, run);

  if (!(await hostPrepPresent(layout))) {
    await runHostPrep();
  }

  if (payload.orgTlsMaterial) {
    if (!deps?.decryptSecrets) {
      throw new Error("managed.ha.reconcile requires decryptSecrets");
    }
    await materializeProxySqlTlsMaterial(
      orchestratorTlsDir(layout),
      payload.orgTlsMaterial,
      deps.decryptSecrets,
    );
  }

  const httpAuth = await loadOrchestratorApiCredentials(layout);
  const raftAuthToken = await loadOrchestratorRaftToken(layout);
  const topologyUser = payload.clusters[0]?.replicationUsername ?? "tp_repl";
  const topologyPassword = payload.clusters[0]
    ? await decryptTopologyPassword(payload.clusters[0], deps?.decryptSecrets)
    : "";
  const conf = renderOrchestratorConf({
    raft: payload.raft,
    httpAuth,
    topologyUser,
    topologyPassword,
    sslCaPath: payload.orgTlsMaterial
      ? "/etc/orchestrator/tls/ca.pem"
      : undefined,
    ...(raftAuthToken ? { raftAuthToken } : {}),
  });

  const descriptor = await readSystemComponentDescriptor(
    layout,
    SYSTEM_MANAGED_HA_COMPONENT,
  );
  if (!descriptor) {
    throw new Error("managed-ha identity missing after persist");
  }

  const restarted = await ensureOrchestratorStack(
    layout,
    descriptor,
    payload.raft,
    payload.managedNetwork,
    conf,
    run,
  );

  const api: OrchestratorApiDeps = {
    ...deps?.orchestratorApi,
    credentials: httpAuth,
  };
  const registeredClusters = payload.clusters.length === 0
    ? []
    : await registerClusters(payload.clusters, api);

  let containers: EnvironmentDeployContainer[] | undefined;
  const observed = await inspectOrchestratorContainer(layout, descriptor, {
    runDocker: run,
  });
  if (observed) containers = [observed];

  logInfo(
    "commands",
    `managed.ha.reconcile completed serverId=${payload.serverId} clusters=${registeredClusters.length} received=${daemonReceivedAt}`,
  );
  return {
    summary: `managed HA reconciled for server ${payload.serverId}`,
    registeredClusters,
    restarted,
    ...(containers ? { containers } : {}),
  };
}
