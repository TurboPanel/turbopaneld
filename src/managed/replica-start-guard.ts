/**
 * Whether a managed replica's data volume may be started without risking a
 * second writable primary. Shared by `managed.lifecycle` start/restart and the
 * periodic engine exit self-heal.
 */

import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { readManagedComposeDataTarget } from "./compose.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { managedComposePath } from "./engine-paths.ts";

type RunDockerFn = (args: string[]) => Promise<DockerCliResult>;

async function readReplicaComposeTarget(
  layout: LayoutPaths,
  managedId: string,
): Promise<ReturnType<typeof readManagedComposeDataTarget>> {
  let composeYaml: string;
  try {
    composeYaml = await Deno.readTextFile(
      managedComposePath(layout, managedId),
    );
  } catch (err) {
    throw new Error(
      `cannot verify standby data: compose file unreadable (${
        sanitizeForLog(err instanceof Error ? err.message : String(err))
      })`,
    );
  }
  const target = readManagedComposeDataTarget(composeYaml);
  if (target.volumes.length === 0) {
    throw new Error("cannot verify standby data: no data volume in compose");
  }
  return target;
}

/**
 * `false` when a replica's volume holds non-standby data (`needs_resync`).
 * Primaries and engines without replication always return `true`.
 */
export async function replicaStandbyDataAllowsEngineStart(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  role: "primary" | "replica",
  run: RunDockerFn,
): Promise<boolean> {
  if (role !== "replica") return true;
  const runtime = getManagedEngineRuntime(engine);
  if (!runtime.replication) return true;

  const target = await readReplicaComposeTarget(layout, managedId);
  const state = await runtime.replication.probeStandbyData({
    image: target.image,
    volumes: target.volumes,
    containerUser: runtime.containerUser,
    runDocker: (argv) => run(argv),
  });
  return state !== "not_standby";
}
