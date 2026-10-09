/**
 * Durable on-volume fences for a demoted former primary. Survives daemon
 * restart, host reboot, and `docker start` outside `managed.lifecycle`.
 */

import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { helperLabelArgs } from "../deploy/labels.ts";
import { sanitizeForLog } from "../util/logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { readManagedComposeDataTarget } from "./compose.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { postgresDataDirFromVolumes } from "./engines/postgres-paths.ts";
import { managedComposePath } from "./engine-paths.ts";
import { probeVolumePath, volumeMountArgs } from "./engines/standby-probe.ts";

type RunDockerFn = (args: string[]) => Promise<DockerCliResult>;

async function readComposeProbeTarget(
  layout: LayoutPaths,
  managedId: string,
): Promise<ReturnType<typeof readManagedComposeDataTarget>> {
  const composeYaml = await Deno.readTextFile(
    managedComposePath(layout, managedId),
  );
  const target = readManagedComposeDataTarget(composeYaml);
  if (target.volumes.length === 0) {
    throw new Error("demoted fence: no data volume in compose");
  }
  return target;
}

async function plantPostgresStandbySignal(
  target: ReturnType<typeof readManagedComposeDataTarget>,
  containerUser: string,
  run: RunDockerFn,
): Promise<void> {
  const dataDir = postgresDataDirFromVolumes(target.volumes);
  const signalPath = `${dataDir}/standby.signal`;
  const probeCtx = {
    image: target.image,
    volumes: target.volumes,
    containerUser,
    runDocker: (argv: string[]) => run(argv),
  };
  if (await probeVolumePath(probeCtx, "-f", signalPath)) return;

  const result = await run([
    "run",
    "--rm",
    ...helperLabelArgs("volume-copy"),
    "--user",
    containerUser,
    ...volumeMountArgs(target.volumes),
    target.image,
    "sh",
    "-c",
    `touch '${signalPath}'`,
  ]);
  if (!result.success) {
    throw new Error(
      `demoted fence: could not write standby.signal: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
}

/**
 * Persist the engine-specific volume fence when a member is demoted. Postgres
 * gets `standby.signal` so the next process start enters recovery; MySQL /
 * MariaDB rely on runtime read_only enforcement (no standby marker — that would
 * mask `needs_resync`).
 */
export async function persistDemotedVolumeFence(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<void> {
  if (engine !== "postgres") return;
  const runtime = getManagedEngineRuntime(engine);
  const target = await readComposeProbeTarget(layout, managedId);
  await plantPostgresStandbySignal(target, runtime.containerUser, run);
}
