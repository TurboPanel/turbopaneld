/**
 * Re-point a local standby at a new primary after switchover or failover.
 *
 * Does not re-seed: Postgres rewrites `primary_conninfo`; MySQL / MariaDB
 * change only the replication source host and port.
 */

import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  collectManagedContainers,
  resolveEngineContainerId,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import type { ManagedEngineContext } from "./engines/types.ts";
import { ManagedReplicationNotSupportedError } from "./engines/types.ts";
import { managedComposeProject } from "./engine-paths.ts";
import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type FollowPrimarySpec = {
  managedId: string;
  engine?: ManagedEngineCode;
  primary: {
    host: string;
    hostaddr?: string;
    port: number;
  };
};

export type FollowPrimaryDeps = {
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

export async function followLocalStandby(
  spec: FollowPrimarySpec,
  deps?: FollowPrimaryDeps,
): Promise<void> {
  const engine = getManagedEngineRuntime(spec.engine ?? "postgres");
  if (!engine.replication) {
    throw new ManagedReplicationNotSupportedError(engine.engine);
  }

  const run = deps?.runDocker ?? defaultRunDocker;
  const ensureDocker = deps?.ensureDocker ?? defaultEnsureDocker;

  await ensureDocker();
  resolveLayout(Deno.env.toObject());

  const project = managedComposeProject(spec.managedId);
  const containers = await collectManagedContainers(project, undefined, run);
  if (!containers || containers.length === 0) {
    throw new Error(
      `managed.ha.failover repoint: no running containers for ${spec.managedId}`,
    );
  }
  const containerId = resolveEngineContainerId(
    containers,
    containers[0]!.composeServiceName,
  );

  const ctx: ManagedEngineContext = {
    containerId,
    composeServiceName: containers[0]!.composeServiceName,
    rootUsername: engine.rootUsername,
    defaultDatabase: engine.defaultDatabase,
    exec: buildEngineExec(containerId, run),
  };

  await engine.replication.followPrimary(ctx, { primary: spec.primary });
}
