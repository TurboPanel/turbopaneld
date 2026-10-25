/**
 * Docker stopped and started again (a restart, a package upgrade): the
 * containers of the managed database connection point (ProxySQL) and watcher
 * (Orchestrator) can be gone for good, and nothing recreated them until the
 * control plane next changed the cluster. This brings both back from the
 * compose files already on disk, rewriting nothing, so exposure and cluster
 * settings stay exactly as the last reconcile left them.
 */

import type { LayoutPaths } from "../paths/layout.ts";
import { runDocker, type RunDockerFn } from "../deploy/docker-cli.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { startMissingOrchestratorStack } from "./orchestrator.ts";
import { repairProxySqlFrontendAtBoot } from "./proxysql-boot-repair.ts";

export type DockerReturnHealDeps = {
  runDocker?: RunDockerFn;
  repairProxySql?: typeof repairProxySqlFrontendAtBoot;
};

export async function healManagedStacksOnDockerReturn(
  layout: LayoutPaths,
  deps: DockerReturnHealDeps = {},
): Promise<void> {
  const run = deps.runDocker ?? runDocker;
  const repair = deps.repairProxySql ?? repairProxySqlFrontendAtBoot;
  // Independent: a failure of one must not keep the other from coming back.
  const results = await Promise.allSettled([
    repair(layout, {
      runDocker: run,
      ignoreReconcile: true,
      budgetMs: 2 * 60_000,
    }),
    startMissingOrchestratorStack(layout, run),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      logWarn(
        "managed",
        "restoring a managed stack after Docker returned failed:",
        sanitizeForLog(result.reason),
      );
    }
  }
}
