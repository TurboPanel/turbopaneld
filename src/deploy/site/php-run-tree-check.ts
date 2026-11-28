/**
 * Startup check that an updated host's PHP sockets moved to the root-owned run
 * tree.
 *
 * The shared php-fpm masters used to keep their pidfile and sockets under the
 * daemon-owned run folder (`<runDir>/php/<series>/`); they now keep them under
 * `PHP_FPM_RUN_DIR`, a root-owned folder. The move itself is done as root by
 * the php-fpm role (`tasks/converge-run-tree.yml`, run by the boot converge,
 * before any deploy can run). This check only reads: it warns when the unit
 * template does not name the new folder, or a pool or vhost still names the old
 * one (a converge that failed, or a host that never runs it). It changes
 * nothing and records nothing.
 */

import { join } from "node:path";
import { type LayoutPaths, PHP_FPM_RUN_DIR } from "../../paths/layout.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import { runHostCommand } from "../systemd-unit-set.ts";
import { siteCaddyConfigDir, type SiteRunFn } from "./engine-driver.ts";

const UNIT_NAME = "turbopanel-php-fpm@.service";
const SERIES_RE = /^\d\.\d{1,2}$/;

export type PhpRunTreeCheckIo = Readonly<{
  run: SiteRunFn;
  /** `/etc/systemd/system` on a host; a temp tree in tests. */
  unitDir: string;
  layout: Pick<LayoutPaths, "configDir" | "runDir">;
}>;

async function sudoText(
  io: PhpRunTreeCheckIo,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await io.run("sudo", hostSudoArgs(["-n", ...args]));
  return { ok: result.success, stdout: result.stdout, stderr: result.stderr };
}

/** Names in a folder; empty when it does not exist. */
async function listDir(io: PhpRunTreeCheckIo, dir: string): Promise<string[]> {
  const ls = await sudoText(io, ["ls", "-A", "--", dir]);
  if (ls.ok) return ls.stdout.split("\n").filter((name) => name.length > 0);
  if (/no such (file or )?directory/i.test(ls.stderr)) return [];
  throw new Error(ls.stderr.trim() || `cannot list ${dir}`);
}

/** The `*.conf` files of `dir` that still name the old socket folder. */
async function staleConfigs(
  io: PhpRunTreeCheckIo,
  dir: string,
): Promise<string[]> {
  const names = (await listDir(io, dir)).filter((name) =>
    name.endsWith(".conf")
  );
  const stale: string[] = [];
  await forEachSequential(
    names.toSorted((a, b) => a.localeCompare(b)),
    async (name) => {
      const cat = await sudoText(io, ["cat", "--", join(dir, name)]);
      if (!cat.ok) throw new Error(cat.stderr.trim() || `cannot read ${name}`);
      if (cat.stdout.includes(`${io.layout.runDir}/php/`)) stale.push(name);
    },
  );
  return stale;
}

/** What still names the old run folder (empty when the host has moved). */
export async function findStalePhpRunTree(
  io: PhpRunTreeCheckIo,
): Promise<string[]> {
  const stale: string[] = [];
  try {
    const unit = await Deno.readTextFile(join(io.unitDir, UNIT_NAME));
    if (!unit.includes(PHP_FPM_RUN_DIR)) stale.push(UNIT_NAME);
  } catch (err) {
    // No unit: no shared masters, nothing to move.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    return stale;
  }
  const series = (await listDir(io, join(io.layout.configDir, "php")))
    .filter((name) => SERIES_RE.test(name));
  await forEachSequential(series, async (name) => {
    const found = await staleConfigs(
      io,
      join(io.layout.configDir, "php", name, "pools"),
    );
    stale.push(...found.map((file) => `php ${name} ${file}`));
  });
  const engines: [string, string][] = [
    ["caddy", join(siteCaddyConfigDir(io.layout as LayoutPaths), "sites")],
    ["nginx", join(io.layout.configDir, "nginx", "sites")],
    ["apache", join(io.layout.configDir, "apache", "sites")],
  ];
  await forEachSequential(engines, async ([engine, dir]) => {
    const found = await staleConfigs(io, dir);
    stale.push(...found.map((file) => `${engine} ${file}`));
  });
  return stale;
}

/**
 * Warn when the host still uses the old PHP run folder. Never throws, never
 * changes anything; returns what it found.
 */
export async function checkPhpRunTree(
  io: PhpRunTreeCheckIo,
): Promise<string[]> {
  try {
    const stale = await findStalePhpRunTree(io);
    if (stale.length > 0) {
      logWarn(
        "deploy",
        `PHP still uses the old socket folder (${stale.join(", ")}); the ` +
          "daemon converge moves it to the root-owned run tree, so check that " +
          "it succeeded. A reboot would stop PHP sites on those pools.",
      );
    }
    return stale;
  } catch (err) {
    logWarn(
      "deploy",
      `PHP run tree check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/** The daemon's own seams: the root helper and the unit folder. */
export function hostPhpRunTreeCheckIo(
  layout: PhpRunTreeCheckIo["layout"],
): PhpRunTreeCheckIo {
  return { run: runHostCommand, unitDir: SYSTEMD_UNIT_DIR, layout };
}
