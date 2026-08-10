/**
 * Operator-triggered promotion of a streaming standby to primary.
 *
 * Never contacts the old primary (that host is fenced by a separate
 * `managed.lifecycle stop`). No timers, watchdogs, or automatic failover.
 */

import type {
  ManagedPromotePayload,
  ManagedPromoteResult,
} from "../instance/commands/contracts.ts";
import { ensureDocker } from "../deploy/ensure-docker.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  collectManagedContainers,
  resolveEngineContainerId,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import type { ManagedEngineContext } from "./engines/types.ts";
import { ManagedReplicationNotSupportedError } from "./engines/types.ts";
import { managedComposeProject } from "./paths.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

export type ManagedPromoteHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
};

function buildEngineExec(
  containerId: string,
): ManagedEngineContext["exec"] {
  return async (argv, input) => {
    const result = await runDocker(
      ["exec", "-i", containerId, ...argv],
      input === undefined ? undefined : { input },
    );
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: sanitizeForLog(result.stderr),
    };
  };
}

export async function handleManagedPromote(
  payload: ManagedPromotePayload,
  _daemonReceivedAt: string,
  _deps?: ManagedPromoteHandlerDeps,
): Promise<ManagedPromoteResult> {
  const engine = getManagedEngineRuntime(payload.engine ?? "postgres");
  if (!engine.replication) {
    throw new ManagedReplicationNotSupportedError(engine.engine);
  }

  await ensureDocker();
  resolveLayout(Deno.env.toObject());

  const project = managedComposeProject(payload.managedId);
  const containers = await collectManagedContainers(project);
  if (!containers || containers.length === 0) {
    throw new Error(
      `managed.promote: no running containers for ${payload.managedId}`,
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
    exec: buildEngineExec(containerId),
  };

  await engine.replication.promote(ctx);
  const health = await engine.replication.readHealth(ctx, "primary");

  return {
    status: "ready",
    role: "primary",
    promotedMemberId: payload.memberId,
    demoted: payload.demoteMemberId !== undefined,
    ...(payload.demoteMemberId !== undefined
      ? { demotedMemberId: payload.demoteMemberId }
      : {}),
    summary: "standby promoted to primary",
    replication: health,
  };
}
