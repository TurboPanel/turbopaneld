/**
 * `system.reconcile` — persist system-component identity and self-heal or
 * report per the component's contract.
 *
 * Database-free: all identity arrives in the payload. `hosting-ingress`,
 * `proxysql`, and `orchestrator` self-heal. `database` / `queue`
 * live in the platform-managed `turbopanel-system` production
 * stack — the daemon only persists identity and inspects; it never deploys,
 * starts, or restarts them, regardless of `desired` or `action`.
 *
 * Disabling hosting via ordinary drift reconcile (`desired: 'absent'`,
 * `action: 'reconcile'`) is report-only for hosting-ingress — it must not
 * silently tear down a running proxy. An explicit `action: 'stop'` (from the
 * hosting-disable PATCH) intentionally stops the shared ingress compose
 * project, then inspects with `ps -a`.
 */

import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../../deploy/docker-cli.ts";
import { ensureDocker as defaultEnsureDocker } from "../../deploy/ensure-docker.ts";
import {
  ensureHostingIngress as defaultEnsureHostingIngress,
  hostingIngressComposePath,
  inspectHostingIngressContainer as defaultInspectHostingIngressContainer,
} from "../../deploy/ingress.ts";
import { ensureManagedIngressNetwork } from "../../managed/networks.ts";
import {
  inspectOrchestratorContainer,
  readCurrentOrchestratorManagedNetwork,
  restartOrchestratorStack,
  stopOrchestratorStack,
} from "../../managed/orchestrator.ts";
import { orchestratorComposePath } from "../../managed/paths.ts";
import {
  ensureProxySqlIngress,
  inspectProxySqlContainer,
  readCurrentProxySqlBindAddresses,
  readCurrentProxySqlListenerPorts,
  readCurrentProxySqlManagedNetwork,
  readCurrentProxySqlSegmentAttachments,
  restartProxySqlIngress,
  stopProxySqlIngress,
} from "../../managed/proxysql.ts";
import {
  SYSTEM_COMPONENT_CONTRACTS,
  type SystemComponentDescriptor,
  systemComponentProject,
  type SystemComponentSelfHeal,
  writeSystemComponentDescriptor,
} from "../../deploy/system-component.ts";
import {
  inspectSystemStackContainer as defaultInspectSystemStackContainer,
} from "../../deploy/system-stack.ts";
import { logInfo, sanitizeForLog } from "../../logger.ts";
import { type LayoutPaths, resolveLayout } from "../../paths/layout.ts";
import {
  type EnvironmentDeployContainer,
  parseSystemReconcilePayload,
  type SystemComponentDescriptorPayload,
  type SystemReconcilePayload,
  type SystemReconcileResult,
} from "./contracts.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type SystemReconcileHandlerDeps = {
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
  /** Test seam — defaults to {@link defaultEnsureDocker}. */
  ensureDocker?: () => Promise<void>;
  /** Test seam — defaults to {@link defaultEnsureHostingIngress}. */
  ensureHostingIngress?: (
    layout: LayoutPaths,
    ingressNetwork: string,
  ) => Promise<void>;
  /**
   * Test seam — defaults to {@link defaultInspectHostingIngressContainer}.
   * Return `undefined` when compose-ps itself failed (omit `containers`).
   * Return `null` when inspect completed with no matching row.
   */
  inspectHostingIngressContainer?: (
    layout: LayoutPaths,
  ) => Promise<EnvironmentDeployContainer | null | undefined>;
  /**
   * Test seam — defaults to {@link defaultInspectSystemStackContainer}.
   * Same return contract as {@link inspectHostingIngressContainer}, for the
   * inspect-only `database` / `queue` components.
   */
  inspectSystemStackContainer?: (
    layout: LayoutPaths,
    descriptor: SystemComponentDescriptor,
  ) => Promise<EnvironmentDeployContainer | null | undefined>;
};

type ObservedContainer = EnvironmentDeployContainer | null | undefined;

type ReconcileOneParams = {
  component: SystemComponentDescriptorPayload;
  action: SystemReconcilePayload["action"];
  layout: LayoutPaths;
  run: RunDockerFn;
  ensureDockerFn: () => Promise<void>;
  ensureHostingIngressFn: (
    layout: LayoutPaths,
    ingressNetwork: string,
  ) => Promise<void>;
  inspectHostingIngressFn: (
    layout: LayoutPaths,
  ) => Promise<ObservedContainer>;
  inspectSystemStackFn: (
    layout: LayoutPaths,
    descriptor: SystemComponentDescriptor,
  ) => Promise<ObservedContainer>;
  containers: EnvironmentDeployContainer[];
  onInspectFailed: () => void;
};

type HealRuntime = {
  action: SystemReconcilePayload["action"];
  desired: SystemComponentDescriptorPayload["desired"];
  layout: LayoutPaths;
  run: RunDockerFn;
  ensureDockerFn: () => Promise<void>;
};

async function restartHostingIngress(
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<void> {
  const composePath = hostingIngressComposePath(layout);
  // No `-p`: the daemon-written compose file declares its own project through
  // the top-level `name:` key (the hosting-ingress `serviceId`).
  const result = await run([
    "compose",
    "-f",
    composePath,
    "restart",
  ]);
  if (!result.success) {
    throw new Error(
      sanitizeForLog(result.stderr || "compose restart failed"),
    );
  }
}

/**
 * Stop the shared ingress compose project without recreating it. Leaves the
 * compose file on disk so a later `ps -a` inspect can report absence.
 */
async function stopHostingIngress(
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<void> {
  const composePath = hostingIngressComposePath(layout);
  try {
    await Deno.stat(composePath);
  } catch {
    // No compose file → nothing to stop (authoritative absence).
    return;
  }
  const result = await run([
    "compose",
    "-f",
    composePath,
    "stop",
  ]);
  if (!result.success) {
    throw new Error(
      sanitizeForLog(result.stderr || "compose stop failed"),
    );
  }
}

/**
 * Reconcile each system component: always persist the descriptor, then
 * dispatch on the component's contract — self-heal (`hosting-ingress`) or
 * inspect-only (`database` / `queue`).
 */
export async function handleSystemReconcile(
  payload: SystemReconcilePayload,
  daemonReceivedAt: string,
  deps?: SystemReconcileHandlerDeps,
): Promise<SystemReconcileResult> {
  const parsedPayload = parseSystemReconcilePayload(payload);
  const run = deps?.runDocker ?? defaultRunDocker;
  const ensureDockerFn = deps?.ensureDocker ?? defaultEnsureDocker;
  const ensureHostingIngressFn = deps?.ensureHostingIngress ??
    defaultEnsureHostingIngress;
  const inspectHostingIngressFn = deps?.inspectHostingIngressContainer ??
    ((layoutArg) =>
      defaultInspectHostingIngressContainer(layoutArg, { runDocker: run }));
  const inspectSystemStackFn = deps?.inspectSystemStackContainer ??
    ((layoutArg, descriptor) =>
      defaultInspectSystemStackContainer(layoutArg, descriptor, {
        runDocker: run,
      }));
  const layout = resolveLayout(Deno.env.toObject());

  const containers: EnvironmentDeployContainer[] = [];
  let inspectFailed = false;

  for (const component of parsedPayload.components) {
    await reconcileOneComponent({
      component,
      action: parsedPayload.action,
      layout,
      run,
      ensureDockerFn,
      ensureHostingIngressFn,
      inspectHostingIngressFn,
      inspectSystemStackFn,
      containers,
      onInspectFailed: () => {
        inspectFailed = true;
      },
    });
    if (inspectFailed) break;
  }

  const summary =
    `System reconcile ${parsedPayload.action} for environment ${parsedPayload.environmentId}`;
  logInfo(
    "commands",
    `system.reconcile completed action=${parsedPayload.action} components=${parsedPayload.components.length} received=${daemonReceivedAt}`,
  );

  return {
    summary,
    ...(inspectFailed ? {} : { containers }),
  };
}

function descriptorFromComponent(
  component: SystemComponentDescriptorPayload,
): SystemComponentDescriptor {
  return {
    component: component.component,
    serviceId: component.serviceId,
    composeServiceName: component.composeServiceName,
    containerName: component.containerName,
    role: component.role,
  };
}

async function reconcileOneComponent(
  params: ReconcileOneParams,
): Promise<void> {
  const descriptor = descriptorFromComponent(params.component);

  // Always persist identity so later tenant deploys keep emitting
  // identity-bearing compose instead of reverting to the anonymous shape.
  await writeSystemComponentDescriptor(params.layout, descriptor);

  const observed = await observeComponent(
    SYSTEM_COMPONENT_CONTRACTS[params.component.component].selfHeal,
    params,
    descriptor,
  );
  if (observed === undefined) {
    params.onInspectFailed();
    return;
  }
  if (observed !== null) {
    params.containers.push(observed);
  }
}

function observeComponent(
  selfHeal: SystemComponentSelfHeal,
  params: ReconcileOneParams,
  descriptor: SystemComponentDescriptor,
): Promise<ObservedContainer> {
  const runtime: HealRuntime = {
    action: params.action,
    desired: params.component.desired,
    layout: params.layout,
    run: params.run,
    ensureDockerFn: params.ensureDockerFn,
  };
  switch (selfHeal) {
    case "hosting-ingress":
      return observeHostingIngress(runtime, params, descriptor);
    case "proxysql":
      return observeProxySql(runtime, descriptor);
    case "orchestrator":
      return observeOrchestrator(runtime, descriptor);
    case "none":
      return params.inspectSystemStackFn(params.layout, descriptor);
    default: {
      const exhaustive: never = selfHeal;
      throw new TypeError(`unsupported selfHeal strategy: ${exhaustive}`);
    }
  }
}

/**
 * Shared stop / present / restart lifecycle for self-healing components.
 * `restart` is omitted when the strategy gates restart on extra local state —
 * both ProxySQL and Orchestrator only restart once their `present` step has
 * confirmed a daemon-written compose (and managed network) on disk, so they
 * own the restart decision inside `present` instead.
 */
async function runWhenPresentOrStop(
  runtime: HealRuntime,
  ops: {
    stop: () => Promise<void>;
    present: () => Promise<void>;
    restart?: () => Promise<void>;
  },
): Promise<void> {
  if (runtime.action === "stop") {
    await runtime.ensureDockerFn();
    await ops.stop();
    return;
  }
  if (runtime.desired !== "present") {
    return;
  }
  await runtime.ensureDockerFn();
  await ops.present();
  if (runtime.action === "restart") {
    await ops.restart?.();
  }
}

async function observeHostingIngress(
  runtime: HealRuntime,
  params: ReconcileOneParams,
  descriptor: SystemComponentDescriptor,
): Promise<ObservedContainer> {
  const { layout, run } = runtime;
  // The shared ingress network *is* the hosting-ingress component's allocated
  // serviceId — the descriptor was persisted just above, so it is in hand
  // here rather than reconstructed from a literal.
  const ingressNetwork = systemComponentProject(descriptor);
  await runWhenPresentOrStop(runtime, {
    stop: () => stopHostingIngress(layout, run),
    present: () => params.ensureHostingIngressFn(layout, ingressNetwork),
    restart: () => restartHostingIngress(layout, run),
  });
  return params.inspectHostingIngressFn(layout);
}

async function observeProxySql(
  runtime: HealRuntime,
  descriptor: SystemComponentDescriptor,
): Promise<ObservedContainer> {
  const { layout, run } = runtime;
  await runWhenPresentOrStop(runtime, {
    stop: () => stopProxySqlIngress(layout, run),
    present: () =>
      ensurePresentProxySql(layout, descriptor, run, runtime.action),
  });
  return inspectProxySqlContainer(layout, descriptor, { runDocker: run });
}

async function ensurePresentProxySql(
  layout: LayoutPaths,
  descriptor: SystemComponentDescriptor,
  run: RunDockerFn,
  action: SystemReconcilePayload["action"],
): Promise<void> {
  // The organization's managed network name lives only on the compose file:
  // self-heal has no fresh `managed.ingress.reconcile` payload to read it
  // from. No compose file means the frontend was never reconciled here, so
  // there is nothing to heal — never guess a network name.
  const managedNetwork = await readCurrentProxySqlManagedNetwork(layout);
  if (managedNetwork === null) {
    logInfo(
      "commands",
      "system.reconcile proxysql self-heal skipped: no managed network on disk",
    );
    return;
  }
  await ensureManagedIngressNetwork(managedNetwork, run);
  // Preserve whatever binds the last `managed.ingress.reconcile` desired
  // (or `[]`/private when never published) — self-heal has no fresh
  // desired-state payload and must never widen exposure by guessing
  // `0.0.0.0`. See `readPublishedBindAddressesFromCompose`.
  const preservedBindAddresses = await readCurrentProxySqlBindAddresses(
    layout,
  );
  // Same reasoning for consumer spanning networks: rewriting compose
  // without the previously-rendered `tpn_*` attachments (and their
  // reserved addresses) would detach every remote binding until the
  // control plane happened to reconcile again.
  const preservedSegments = await readCurrentProxySqlSegmentAttachments(
    layout,
  );
  // And the organization's configured client listener ports, so a
  // self-heal does not move them back to the platform defaults.
  const preservedListenerPorts = await readCurrentProxySqlListenerPorts(
    layout,
  );
  await ensureProxySqlIngress(
    layout,
    descriptor,
    run,
    preservedBindAddresses,
    preservedSegments,
    preservedListenerPorts,
    managedNetwork,
  );
  // Restart only once the compose file we just healed is known to exist —
  // the skip above means there is no stack here to restart.
  if (action === "restart") {
    await restartProxySqlIngress(layout, run);
  }
}

async function observeOrchestrator(
  runtime: HealRuntime,
  descriptor: SystemComponentDescriptor,
): Promise<ObservedContainer> {
  const { layout, run } = runtime;
  await runWhenPresentOrStop(runtime, {
    stop: () => stopOrchestratorStack(layout, run),
    present: () => ensurePresentOrchestrator(layout, run, runtime.action),
  });
  return inspectOrchestratorContainer(layout, descriptor, { runDocker: run });
}

async function ensurePresentOrchestrator(
  layout: LayoutPaths,
  run: RunDockerFn,
  action: SystemReconcilePayload["action"],
): Promise<void> {
  try {
    await Deno.stat(orchestratorComposePath(layout));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return;
    }
    throw err;
  }
  // Same reasoning as ProxySQL: the managed network name survives only on the
  // daemon-written compose file, so recover it rather than guessing. A file we
  // cannot parse means we skip the ensure instead of creating a wrong network.
  const managedNetwork = await readCurrentOrchestratorManagedNetwork(layout);
  if (managedNetwork === null) {
    logInfo(
      "commands",
      "system.reconcile orchestrator self-heal skipped: no managed network on disk",
    );
    return;
  }
  await ensureManagedIngressNetwork(managedNetwork, run);
  if (action === "restart") {
    await restartOrchestratorStack(layout, run);
  }
}
