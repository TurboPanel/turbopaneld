/**
 * `system.reconcile` — persist system-component identity and self-heal or
 * report per the component's contract.
 *
 * Database-free: all identity arrives in the payload. Only `hosting-ingress`
 * self-heals (the daemon owns the shared Traefik). `database` / `queue` /
 * `analytics` live in the platform-managed `turbopanel-system` production
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
  HOSTING_INGRESS_PROJECT,
  hostingIngressComposePath,
  inspectHostingIngressContainer as defaultInspectHostingIngressContainer,
} from "../../deploy/ingress.ts";
import {
  SYSTEM_COMPONENT_CONTRACTS,
  type SystemComponentDescriptor,
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
  ensureHostingIngress?: (layout: LayoutPaths) => Promise<void>;
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
   * inspect-only `database` / `queue` / `analytics` components.
   */
  inspectSystemStackContainer?: (
    layout: LayoutPaths,
    descriptor: SystemComponentDescriptor,
  ) => Promise<EnvironmentDeployContainer | null | undefined>;
};

async function restartHostingIngress(
  layout: LayoutPaths,
  run: RunDockerFn,
): Promise<void> {
  const composePath = hostingIngressComposePath(layout);
  const result = await run([
    "compose",
    "-p",
    HOSTING_INGRESS_PROJECT,
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
    "-p",
    HOSTING_INGRESS_PROJECT,
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
 * inspect-only (`database` / `queue` / `analytics`).
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

async function reconcileOneComponent(params: {
  component: SystemComponentDescriptorPayload;
  action: SystemReconcilePayload["action"];
  layout: LayoutPaths;
  run: RunDockerFn;
  ensureDockerFn: () => Promise<void>;
  ensureHostingIngressFn: (layout: LayoutPaths) => Promise<void>;
  inspectHostingIngressFn: (
    layout: LayoutPaths,
  ) => Promise<EnvironmentDeployContainer | null | undefined>;
  inspectSystemStackFn: (
    layout: LayoutPaths,
    descriptor: SystemComponentDescriptor,
  ) => Promise<EnvironmentDeployContainer | null | undefined>;
  containers: EnvironmentDeployContainer[];
  onInspectFailed: () => void;
}): Promise<void> {
  const {
    component,
    action,
    layout,
    run,
    ensureDockerFn,
    ensureHostingIngressFn,
    inspectHostingIngressFn,
    inspectSystemStackFn,
    containers,
    onInspectFailed,
  } = params;

  const descriptor = descriptorFromComponent(component);

  // Always persist identity so later tenant deploys keep emitting
  // identity-bearing compose instead of reverting to the anonymous shape.
  await writeSystemComponentDescriptor(layout, descriptor);

  const contract = SYSTEM_COMPONENT_CONTRACTS[component.component];

  let observed: EnvironmentDeployContainer | null | undefined;
  if (contract.selfHealAllowed) {
    if (action === "stop") {
      // Explicit hosting-disable stop — tear down the running proxy, then
      // inspect. Ordinary desired:'absent' reconcile stays report-only.
      await ensureDockerFn();
      await stopHostingIngress(layout, run);
    } else if (component.desired === "present") {
      await ensureDockerFn();
      await ensureHostingIngressFn(layout);
      if (action === "restart") {
        await restartHostingIngress(layout, run);
      }
    }
    // desired === 'absent' && action !== 'stop' → report-only: skip
    // ensureDocker / ensureHostingIngress / compose writes.
    observed = await inspectHostingIngressFn(layout);
  } else {
    // database / queue / analytics: platform-managed production stack.
    // Inspect only — never ensureDocker, never compose up, never restart,
    // regardless of `desired` or `action`.
    observed = await inspectSystemStackFn(layout, descriptor);
  }

  if (observed === undefined) {
    onInspectFailed();
    return;
  }
  if (observed !== null) {
    containers.push(observed);
  }
}
