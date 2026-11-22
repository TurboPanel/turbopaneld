/**
 * One-time move of an updated host's PHP sockets to the root-owned run tree.
 *
 * The shared php-fpm masters used to keep their pidfile and sockets under the
 * daemon-owned run folder (`<runDir>/php/<series>/`); they now keep them under
 * `PHP_FPM_RUN_DIR`, a root-owned folder. A deploy writes the new socket paths
 * into the pool files and the vhosts, but a host updated in place keeps the old
 * ones until each site's next deploy, and nothing creates the old folder any
 * more: after a reboot the old pool's bind fails and the whole master with it.
 *
 * The daemon keeps no per-site spec to deploy from, so this rewrites the files
 * that are on the host. The socket path is the only thing that moves, so the
 * old folder prefix is replaced by the new one and every other byte stays; the
 * tests check that the result equals what the renderers write today. There is
 * no fallback: the old folder is not created or kept.
 *
 * Order, per pass:
 * 1. the `turbopanel-php-fpm@.service` template (PIDFile, `--pid`, which beats
 *    the old `pid =` of the role-owned `php-fpm.conf`, and the root-owned
 *    folders it creates), then `daemon-reload`;
 * 2. per series, the pool files (the bootstrap pool too), tested and the master
 *    restarted (its unit and pidfile changed, a reload would not do);
 * 3. the nginx, Apache and Caddy vhosts, each engine tested and reloaded.
 * Any failure puts the files of that step back; the pass is then not recorded,
 * so the next start tries again. Recorded once per daemon version otherwise.
 */

import { join } from "node:path";
import { DAEMON_VERSION } from "../../version.ts";
import { type LayoutPaths, PHP_FPM_RUN_DIR } from "../../paths/layout.ts";
import { writePrivateFileAtomic } from "../../permissions/host-unit-files.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { logInfo, logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import { installUnit, runHostCommand, systemctl } from "../systemd-unit-set.ts";
import { lockKeysFor, withLocks } from "./apache-walls-repair.ts";
import {
  APACHE_DRIVER,
  CADDY_DRIVER,
  NGINX_DRIVER,
  openSiteRollout,
  phpFpmDriver,
  siteCaddyConfigDir,
  type SiteEngineDriver,
  type SiteRunFn,
  type StagedConfigWrite,
  stageOwnedConfigFile,
} from "./engine-driver.ts";

/** The marker file, in the daemon's `sites` state folder. */
export const PHP_RUN_TREE_MARKER = ".php-run-tree-repair.json";

/** Group of a pool file: the php-fpm service group, as a deploy sets it. */
const POOL_GROUP = "tpapache";
const UNIT_NAME = "turbopanel-php-fpm@.service";
const SERIES_RE = /^\d\.\d{1,2}$/;

export type PhpRunTreeRepairIo = Readonly<{
  run: SiteRunFn;
  /** `/etc/systemd/system` on a host; a temp tree in tests. */
  unitDir: string;
  layout: Pick<
    LayoutPaths,
    "configDir" | "runDir" | "stateDir" | "daemonStateDir"
  >;
  version: string;
}>;

export type PhpRunTreeRepairResult = {
  /** Files rewritten (unit, pools and vhosts). */
  repaired: string[];
  failed: string[];
  /** The pass was already recorded for this version. */
  skipped: boolean;
};

/** `text` with the old run folder's socket prefix replaced by the new one. */
export function movePhpSocketPaths(text: string, oldRunDir: string): string {
  return text.replaceAll(`${oldRunDir}/php/`, `${PHP_FPM_RUN_DIR}/`);
}

/**
 * The php-fpm unit template with the new run tree: `PIDFile`, `--pid`, and the
 * folder it creates, which is root's (parent first, then the series folder).
 */
export function patchPhpFpmUnit(text: string, oldRunDir: string): string {
  const old = `${oldRunDir}/php`;
  const lines = text.split("\n").flatMap((line) => {
    const create =
      /^ExecStartPre=\/usr\/bin\/install -d -o \S+ -g (\S+) -m 0750 (.+)$/
        .exec(line);
    if (create !== null && create[2] === `${old}/%i`) {
      const head = `ExecStartPre=/usr/bin/install -d -o root -g ${
        create[1]
      } -m 0750`;
      return [`${head} ${PHP_FPM_RUN_DIR}`, `${head} ${PHP_FPM_RUN_DIR}/%i`];
    }
    return [line];
  });
  return movePhpSocketPaths(lines.join("\n"), oldRunDir);
}

async function sudoText(
  io: PhpRunTreeRepairIo,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await io.run("sudo", hostSudoArgs(["-n", ...args]));
  return { ok: result.success, stdout: result.stdout, stderr: result.stderr };
}

/** Names in a root-owned folder; `null` when it does not exist. */
async function listDir(
  io: PhpRunTreeRepairIo,
  dir: string,
): Promise<string[] | null> {
  const ls = await sudoText(io, ["ls", "-A", "--", dir]);
  if (ls.ok) return ls.stdout.split("\n").filter((name) => name.length > 0);
  if (/no such (file or )?directory/i.test(ls.stderr)) return null;
  throw new Error(ls.stderr.trim() || `cannot list ${dir}`);
}

type Candidate = { path: string; name: string; text: string };

/** The `*.conf` files of `dir` that still name the old socket folder. */
async function staleConfigs(
  io: PhpRunTreeRepairIo,
  dir: string,
): Promise<Candidate[]> {
  const names = (await listDir(io, dir) ?? []).filter((name) =>
    name.endsWith(".conf")
  );
  const found: Candidate[] = [];
  await forEachSequential(names.toSorted(), async (name) => {
    const cat = await sudoText(io, ["cat", "--", join(dir, name)]);
    if (!cat.ok) throw new Error(cat.stderr.trim() || `cannot read ${name}`);
    if (cat.stdout.includes(`${io.layout.runDir}/php/`)) {
      found.push({ path: join(dir, name), name, text: cat.stdout });
    }
  });
  return found;
}

async function stageAll(
  io: PhpRunTreeRepairIo,
  found: readonly Candidate[],
  stage: (path: string, text: string) => Promise<StagedConfigWrite | null>,
): Promise<StagedConfigWrite[]> {
  const staged: StagedConfigWrite[] = [];
  await forEachSequential(found, async (file) => {
    const next = await stage(
      file.path,
      movePhpSocketPaths(file.text, io.layout.runDir),
    );
    if (next !== null) staged.push(next);
  });
  return staged;
}

async function repairUnit(io: PhpRunTreeRepairIo): Promise<boolean> {
  const path = join(io.unitDir, UNIT_NAME);
  // The unit folder is world-readable (0644 units), so no root read is needed.
  let current: string;
  try {
    current = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false; // no shared masters
    throw err;
  }
  const next = patchPhpFpmUnit(current, io.layout.runDir);
  if (next === current) return false;
  await installUnit(io.run, path, next, "tp-php-unit-");
  const reload = await systemctl(io.run, ["daemon-reload"]);
  if (!reload.success) {
    throw new Error(reload.stderr || "systemctl daemon-reload failed");
  }
  return true;
}

async function repairPools(
  io: PhpRunTreeRepairIo,
  series: string,
  result: PhpRunTreeRepairResult,
): Promise<void> {
  const dir = join(io.layout.configDir, "php", series, "pools");
  const found = await staleConfigs(io, dir);
  const staged = await stageAll(
    io,
    found,
    (path, text) => stageOwnedConfigFile(io.run, path, text, POOL_GROUP),
  );
  if (staged.length === 0) return;
  const rollout = await openSiteRollout({
    run: io.run,
    layout: io.layout as LayoutPaths,
    target: phpFpmDriver(series),
    restart: true,
    staged,
    validationTargets: [],
  });
  await rollout.commit();
  result.repaired.push(...found.map((file) => `php ${series} ${file.name}`));
}

async function repairEngine(
  io: PhpRunTreeRepairIo,
  driver: SiteEngineDriver,
  dir: string,
  result: PhpRunTreeRepairResult,
): Promise<void> {
  const found = await staleConfigs(io, dir);
  if (found.length === 0) return;
  const keys = [
    ...new Set(found.flatMap((f) => lockKeysFor(f.path, undefined))),
  ];
  await withLocks(keys, async () => {
    // Read again under the lock: a deploy may have written them since.
    const fresh = await staleConfigs(io, dir);
    const staged = await stageAll(
      io,
      fresh,
      (path, text) => driver.stageSiteConfig(io.run, path, text),
    );
    if (staged.length === 0) return;
    const rollout = await openSiteRollout({
      run: io.run,
      layout: io.layout as LayoutPaths,
      target: driver,
      restart: false,
      staged,
      validationTargets: [],
    });
    await rollout.commit();
    result.repaired.push(...fresh.map((f) => `${driver.engine} ${f.name}`));
  });
}

function markerDir(io: PhpRunTreeRepairIo): string {
  return join(io.layout.stateDir, "sites");
}

async function markerVersion(io: PhpRunTreeRepairIo): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await Deno.readTextFile(join(markerDir(io), PHP_RUN_TREE_MARKER)),
    );
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * The repair pass. Never throws: a step that fails is logged and left as it
 * was, and the pass is not recorded, so the next start tries again.
 */
export async function repairPhpRunTree(
  io: PhpRunTreeRepairIo,
): Promise<PhpRunTreeRepairResult> {
  const result: PhpRunTreeRepairResult = {
    repaired: [],
    failed: [],
    skipped: false,
  };
  if (await markerVersion(io) === io.version) {
    result.skipped = true;
    return result;
  }
  const step = async (label: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      result.failed.push(label);
      logWarn(
        "deploy",
        `PHP run tree repair failed for ${label}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  await step("unit", async () => {
    if (await repairUnit(io)) result.repaired.push(UNIT_NAME);
  });
  // A unit that could not be moved leaves the pools alone: a pool on the new
  // path under a unit that does not create it would fail the next start.
  if (result.failed.length === 0) {
    let series: string[] = [];
    await step("series", async () => {
      series = (await listDir(io, join(io.layout.configDir, "php")) ?? [])
        .filter((name) => SERIES_RE.test(name))
        .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    });
    await forEachSequential(
      series,
      (name) => step(`php ${name}`, () => repairPools(io, name, result)),
    );
  }
  // Vhosts go after the pools: they name sockets the pools now bind.
  if (result.failed.length === 0) {
    const engines: [SiteEngineDriver, string][] = [
      [
        CADDY_DRIVER,
        join(siteCaddyConfigDir(io.layout as LayoutPaths), "sites"),
      ],
      [NGINX_DRIVER, join(io.layout.configDir, "nginx", "sites")],
      [APACHE_DRIVER, join(io.layout.configDir, "apache", "sites")],
    ];
    await forEachSequential(
      engines,
      ([driver, dir]) =>
        step(driver.engine, () => repairEngine(io, driver, dir, result)),
    );
  }
  if (result.failed.length === 0) {
    await Deno.mkdir(markerDir(io), { recursive: true, mode: 0o700 });
    await writePrivateFileAtomic(
      markerDir(io),
      PHP_RUN_TREE_MARKER,
      `${JSON.stringify({ version: io.version, repaired: result.repaired })}\n`,
    );
    if (result.repaired.length > 0) {
      logInfo("deploy", `PHP run tree repaired: ${result.repaired.join(", ")}`);
    }
  }
  return result;
}

/** The daemon's own seams: the root helper and the unit folder. */
export function hostPhpRunTreeRepairIo(
  layout: PhpRunTreeRepairIo["layout"],
): PhpRunTreeRepairIo {
  return {
    run: runHostCommand,
    unitDir: SYSTEMD_UNIT_DIR,
    layout,
    version: DAEMON_VERSION,
  };
}
