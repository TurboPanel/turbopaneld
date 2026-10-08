/**
 * Resolve the engine runtime and an exec context for this host's managed
 * engine container. Shared by promote and follow-primary.
 */

import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import {
  collectManagedContainers,
  resolveEngineContainerId,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import {
  type ManagedEngineContext,
  ManagedReplicationNotSupportedError,
} from "./engines/types.ts";
import { managedComposeProject } from "./engine-paths.ts";

export type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type LocalEngineContextDeps = {
  runDocker?: RunDockerFn;
  ensureDocker?: () => Promise<void>;
};

function buildEngineExec(
  containerId: string,
  run: RunDockerFn,
): ManagedEngineContext["exec"] {
  return async (argv, input) => {
    const result = await run(
      ["exec", "-i", "-u", "0", containerId, ...argv],
      input === undefined ? undefined : { input },
    );
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: sanitizeForLog(result.stderr),
    };
  };
}

export async function resolveLocalReplicationEngine(
  managedId: string,
  engineCode: ManagedEngineCode | undefined,
  commandName: string,
  deps?: LocalEngineContextDeps,
): Promise<{
  engine: ReturnType<typeof getManagedEngineRuntime>;
  ctx: ManagedEngineContext;
}> {
  const engine = getManagedEngineRuntime(engineCode ?? "postgres");
  if (!engine.replication) {
    throw new ManagedReplicationNotSupportedError(engine.engine);
  }
  const run = deps?.runDocker ?? defaultRunDocker;
  const ensureDocker = deps?.ensureDocker ?? defaultEnsureDocker;

  await ensureDocker();
  resolveLayout(Deno.env.toObject());

  const containers = await collectManagedContainers(
    managedComposeProject(managedId),
    undefined,
    run,
  );
  if (!containers || containers.length === 0) {
    throw new Error(`${commandName}: no running containers for ${managedId}`);
  }
  const composeServiceName = containers[0]!.composeServiceName;
  const containerId = resolveEngineContainerId(containers, composeServiceName);
  return {
    engine,
    ctx: {
      containerId,
      composeServiceName,
      rootUsername: engine.rootUsername,
      defaultDatabase: engine.defaultDatabase,
      exec: buildEngineExec(containerId, run),
    },
  };
}
