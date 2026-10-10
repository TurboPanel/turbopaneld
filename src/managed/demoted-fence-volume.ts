/**
 * Durable on-volume fences for a demoted former primary. Survives daemon
 * restart, host reboot, and `docker start` outside `managed.lifecycle`.
 */

import { join } from "@std/path";
import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { helperLabelArgs } from "../deploy/labels.ts";
import { sanitizeForLog } from "../util/logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { readManagedComposeDataTarget } from "./compose.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { postgresDataDirFromVolumes } from "./engines/postgres-paths.ts";
import { managedComposePath, managedConfigDir } from "./engine-paths.ts";
import { probeVolumePath, volumeMountArgs } from "./engines/standby-probe.ts";

type RunDockerFn = (args: string[]) => Promise<DockerCliResult>;

/**
 * MySQL-family option file the engine container actually reads: the control
 * plane mounts `./config/my.cnf` as `/etc/mysql/conf.d/zz-turbopanel.cnf`.
 * The fence is a delimited block appended to it, so a hand `docker start`
 * (which re-resolves the bind mount) brings the engine up read-only.
 */
export const MYSQL_FAMILY_CNF_FILE = "my.cnf";
export const DEMOTED_FENCE_BEGIN = "# BEGIN turbopanel demoted fence";
export const DEMOTED_FENCE_END = "# END turbopanel demoted fence";

const MYSQL_FENCE_LINES = ["[mysqld]", "read_only=1", "super_read_only=1"];
/** MariaDB has no super_read_only: an unknown variable stops mariadbd. */
const MARIADB_FENCE_LINES = ["[mariadb]", "read_only=1"];

function mysqlFamilyFenceBlock(engine: "mysql" | "mariadb"): string {
  const body = engine === "mariadb" ? MARIADB_FENCE_LINES : MYSQL_FENCE_LINES;
  return [DEMOTED_FENCE_BEGIN, ...body, DEMOTED_FENCE_END].join("\n");
}

/** Drop every fence block (and a half-written one cut off by a crash). */
export function withoutDemotedFenceBlock(text: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (line.trim() === DEMOTED_FENCE_BEGIN) {
      inBlock = true;
    } else if (inBlock && line.trim() === DEMOTED_FENCE_END) {
      inBlock = false;
    } else if (!inBlock) {
      kept.push(line);
    }
  }
  const body = kept.join("\n").trimEnd();
  return body.length > 0 ? `${body}\n` : "";
}

export function withDemotedFenceBlock(
  text: string,
  engine: "mysql" | "mariadb",
): string {
  const base = withoutDemotedFenceBlock(text);
  const block = mysqlFamilyFenceBlock(engine);
  return base.length > 0 ? `${base}\n${block}\n` : `${block}\n`;
}

function hasCompleteFenceBlock(
  text: string,
  engine: "mysql" | "mariadb",
): boolean {
  return text.includes(mysqlFamilyFenceBlock(engine));
}

function hasAnyFenceLine(text: string): boolean {
  return text.includes(DEMOTED_FENCE_BEGIN) || text.includes(DEMOTED_FENCE_END);
}

async function readComposeImage(
  layout: LayoutPaths,
  managedId: string,
): Promise<string> {
  const composeYaml = await Deno.readTextFile(
    managedComposePath(layout, managedId),
  );
  return readManagedComposeDataTarget(composeYaml).image;
}

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

type MysqlCnfTarget = { configDir: string; image: string; run: RunDockerFn };

/** `my.cnf` is root:<engine group> 0640 after apply — read it as root. */
async function readMysqlFamilyCnf(target: MysqlCnfTarget): Promise<string> {
  const result = await target.run([
    "run",
    "--rm",
    ...helperLabelArgs("managed-files"),
    "--user",
    "0",
    "--entrypoint",
    "cat",
    "-v",
    `${target.configDir}:/c:ro`,
    target.image,
    `/c/${MYSQL_FAMILY_CNF_FILE}`,
  ]);
  if (!result.success) {
    throw new Error(
      `demoted fence: could not read ${MYSQL_FAMILY_CNF_FILE}: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
  return result.stdout;
}

/**
 * Replace `my.cnf` atomically: copy (keeps owner/mode), overwrite the copy,
 * rename over the original. A crash leaves either the old or the new file,
 * never a truncated one. The content is a positional argument, not shell text.
 */
async function writeMysqlFamilyCnf(
  target: MysqlCnfTarget,
  content: string,
): Promise<void> {
  const file = `/c/${MYSQL_FAMILY_CNF_FILE}`;
  const tmp = `/c/.${MYSQL_FAMILY_CNF_FILE}.tp-fence`;
  const result = await target.run([
    "run",
    "--rm",
    ...helperLabelArgs("managed-files"),
    "--user",
    "0",
    "--entrypoint",
    "sh",
    "-v",
    `${target.configDir}:/c`,
    target.image,
    "-c",
    `set -eu; cp -p '${file}' '${tmp}'; printf '%s' "$1" > '${tmp}'; mv -f '${tmp}' '${file}'`,
    "sh",
    content,
  ]);
  if (!result.success) {
    throw new Error(
      `demoted fence: could not write ${MYSQL_FAMILY_CNF_FILE}: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
}

async function mysqlCnfTarget(
  layout: LayoutPaths,
  managedId: string,
  run: RunDockerFn,
): Promise<MysqlCnfTarget | null> {
  const configDir = managedConfigDir(layout, managedId);
  try {
    await Deno.stat(join(configDir, MYSQL_FAMILY_CNF_FILE));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  return { configDir, image: await readComposeImage(layout, managedId), run };
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
  if (!(await probeVolumePath(probeCtx, "-f", signalPath))) {
    throw new Error("demoted fence: standby.signal missing after write");
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
  if (await probeVolumePath(probeCtx, "-f", signalPath)) {
    throw new Error("demoted fence: standby.signal still present after clear");
  }
}

async function plantMysqlFamilyConfigFence(
  layout: LayoutPaths,
  managedId: string,
  engine: "mysql" | "mariadb",
  run: RunDockerFn,
): Promise<void> {
  const target = await mysqlCnfTarget(layout, managedId, run);
  if (!target) {
    throw new Error(
      `demoted fence: config/${MYSQL_FAMILY_CNF_FILE} missing; cannot plant read-only fence`,
    );
  }
  const current = await readMysqlFamilyCnf(target);
  if (hasCompleteFenceBlock(current, engine)) return;
  await writeMysqlFamilyCnf(target, withDemotedFenceBlock(current, engine));
  if (!hasCompleteFenceBlock(await readMysqlFamilyCnf(target), engine)) {
    throw new Error("demoted fence: read-only block missing after write");
  }
}

async function removeMysqlFamilyConfigFence(
  layout: LayoutPaths,
  managedId: string,
  run: RunDockerFn,
): Promise<void> {
  const target = await mysqlCnfTarget(layout, managedId, run);
  if (!target) return;
  const current = await readMysqlFamilyCnf(target);
  if (!hasAnyFenceLine(current)) return;
  await writeMysqlFamilyCnf(target, withoutDemotedFenceBlock(current));
  if (hasAnyFenceLine(await readMysqlFamilyCnf(target))) {
    throw new Error("demoted fence: read-only block still present after clear");
  }
}

/**
 * Persist the engine-specific volume fence when a member is demoted. Postgres
 * gets `standby.signal` so the next process start enters recovery; MySQL /
 * MariaDB get a delimited `read_only` (and `super_read_only` on MySQL) block
 * in the mounted `config/my.cnf`, so the next start cannot accept writes
 * before the guard runs. Throws unless the artefact is verified on disk.
 */
export async function persistDemotedVolumeFence(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<void> {
  if (engine === "mysql" || engine === "mariadb") {
    await plantMysqlFamilyConfigFence(layout, managedId, engine, run);
    return;
  }
  if (engine !== "postgres") return;
  const runtime = getManagedEngineRuntime(engine);
  const target = await readComposeProbeTarget(layout, managedId);
  await plantPostgresStandbySignal(target, runtime.containerUser, run);
}

/**
 * Remove durable fence artefacts when the member is cleared or reactivated.
 * Throws unless the artefact is verified gone. `keepStandbySignal` is for a
 * member that is now a Postgres replica, whose standby.signal is not a fence.
 */
export async function clearDemotedVolumeFence(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
  options: { keepStandbySignal?: boolean } = {},
): Promise<void> {
  if (engine === "mysql" || engine === "mariadb") {
    await removeMysqlFamilyConfigFence(layout, managedId, run);
    return;
  }
  // A Postgres streaming replica needs its standby.signal (pg_basebackup -R
  // wrote it): removing it would bring the replica up writable on restart.
  if (engine !== "postgres" || options.keepStandbySignal) return;
  const runtime = getManagedEngineRuntime(engine);
  const target = await readComposeProbeTarget(layout, managedId);
  await removePostgresStandbySignal(target, runtime.containerUser, run);
}
