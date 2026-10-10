/**
 * Durable on-volume fences for a demoted former primary. Survives daemon
 * restart, host reboot, and `docker start` outside `managed.lifecycle`.
 */

import { dirname, join } from "@std/path";
import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { helperLabelArgs } from "../deploy/labels.ts";
import { sanitizeForLog } from "../util/logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { readManagedComposeDataTarget } from "./compose.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { postgresDataDirFromVolumes } from "./engines/postgres-paths.ts";
import { managedComposePath, managedDir } from "./engine-paths.ts";
import { probeVolumePath, volumeMountArgs } from "./engines/standby-probe.ts";

type RunDockerFn = (args: string[]) => Promise<DockerCliResult>;

/** Host config fragment applied on the next engine start (MySQL-family). */
export const MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL =
  "conf.d/zz-turbopanel-demoted-fence.cnf";

const MYSQL_DEMOTED_FENCE_CNF = [
  "[mysqld]",
  "read_only=1",
  "super_read_only=1",
  "",
].join("\n");

const MARIADB_DEMOTED_FENCE_CNF = [
  "[mariadb]",
  "read_only=1",
  "",
].join("\n");

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

function mysqlFamilyFenceCnf(engine: "mysql" | "mariadb"): string {
  return engine === "mariadb"
    ? MARIADB_DEMOTED_FENCE_CNF
    : MYSQL_DEMOTED_FENCE_CNF;
}

function managedConfigFencePath(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(
    managedDir(layout, managedId),
    "config",
    MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL,
  );
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

async function removePostgresStandbySignal(
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
  if (!(await probeVolumePath(probeCtx, "-f", signalPath))) return;

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
    `rm -f '${signalPath}'`,
  ]);
  if (!result.success) {
    throw new Error(
      `demoted fence: could not remove standby.signal: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
}

async function plantMysqlFamilyConfigFence(
  layout: LayoutPaths,
  managedId: string,
  engine: "mysql" | "mariadb",
): Promise<void> {
  const path = managedConfigFencePath(layout, managedId);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, mysqlFamilyFenceCnf(engine), {
    mode: 0o640,
  });
}

async function removeMysqlFamilyConfigFence(
  layout: LayoutPaths,
  managedId: string,
): Promise<void> {
  try {
    await Deno.remove(managedConfigFencePath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

/**
 * Persist the engine-specific volume fence when a member is demoted. Postgres
 * gets `standby.signal` so the next process start enters recovery; MySQL /
 * MariaDB get a `conf.d` fragment with `read_only` (and `super_read_only` on
 * MySQL) so the next start cannot accept writes before the guard runs.
 */
export async function persistDemotedVolumeFence(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<void> {
  if (engine === "mysql" || engine === "mariadb") {
    await plantMysqlFamilyConfigFence(layout, managedId, engine);
    return;
  }
  if (engine !== "postgres") return;
  const runtime = getManagedEngineRuntime(engine);
  const target = await readComposeProbeTarget(layout, managedId);
  await plantPostgresStandbySignal(target, runtime.containerUser, run);
}

/** Remove durable fence artefacts when the member is cleared or reactivated. */
export async function clearDemotedVolumeFence(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<void> {
  if (engine === "mysql" || engine === "mariadb") {
    await removeMysqlFamilyConfigFence(layout, managedId);
    return;
  }
  if (engine !== "postgres") return;
  const runtime = getManagedEngineRuntime(engine);
  const target = await readComposeProbeTarget(layout, managedId);
  await removePostgresStandbySignal(target, runtime.containerUser, run);
}
