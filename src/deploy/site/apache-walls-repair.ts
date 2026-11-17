/**
 * One-time repair of the Apache walls on a host that took a daemon update.
 *
 * The walls (the unset of `PHP_VALUE`, `PHP_ADMIN_VALUE`, `PHPRC`,
 * `PHP_INI_SCAN_DIR` and `TP_SITE_KEY` in the vhost, and the per-site key the
 * vhost sends to a runtime that checks it) reach a site only when the site is
 * deployed. A host updated in place keeps its old vhosts and pools until each
 * site's next deploy, and until then the walls are not there. The daemon keeps
 * no per-site spec to deploy from, so this patches the files that are on the
 * host: it adds what is missing and leaves every other byte alone. What it
 * writes is checked against the renderers in the tests (the patched file must
 * equal what a deploy would have written).
 *
 * For each Apache site that hands PHP to a per-site runtime:
 * 1. the vhost gets the wall lines and the site key (staged, swapped, tested,
 *    reloaded and probed like a deploy; put back when any step fails);
 * 2. then the runtime gets its guard, key and locked directives (written,
 *    tested with `php-test`, restarted, probed; put back when any step fails).
 * The vhost goes first: a vhost that sends a key to a runtime without a guard
 * is harmless, a guard without the key would refuse every request.
 *
 * A site on a shared pool has no runtime to guard; it is logged as needing a
 * redeploy. Once a pass ends with no failure it is recorded for this daemon
 * version, so a restart does not do it again. A failed site is retried the
 * next time the daemon starts.
 */

import { basename, join } from "node:path";
import { DAEMON_VERSION } from "../../version.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { writePrivateFileAtomic } from "../../permissions/host-unit-files.ts";
import { environmentLockKey, withKeyedLock } from "../../util/keyed-lock.ts";
import { logInfo, logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import { runHostCommand } from "../systemd-unit-set.ts";
import { apacheWallLines } from "../site.ts";
import {
  APACHE_DRIVER,
  openSiteRollout,
  type SiteRunFn,
  type SiteValidationTarget,
  validateSiteEndpoints,
} from "./engine-driver.ts";
import {
  commitSitePhpRuntime,
  holdSitePhpRuntime,
  installSitePhpRuntime,
  listSitePhpUnits,
  type PreparedSitePhpRuntime,
  rollbackSitePhpRuntime,
  type SitePhpRuntimeFiles,
  type SitePhpRuntimeIo,
} from "./php-runtime-apply.ts";
import {
  type PhpRuntimeRecord,
  readPhpRuntimeRecords,
} from "./php-patch-restart.ts";
import {
  SITE_PHP_ID_RE,
  sitePhpConfigDir,
  sitePhpGuardPath,
  sitePhpGuardPhp,
  sitePhpRuntimeIdsIn,
  type SitePhpRuntimeMode,
  sitePhpServiceName,
  sitePhpSocketName,
} from "./php-runtime.ts";
import { cachedPhpSiteKeySecret, phpSiteKey } from "./php-site-key.ts";

/** The marker file, in the daemon's `sites` state folder. */
export const APACHE_WALLS_MARKER = ".apache-walls-repair.json";

const WALL_PREFIX = '  ProxyFCGISetEnvIf "true" ';
const WALL_NAMES = [
  "PHP_VALUE",
  "PHP_ADMIN_VALUE",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "TP_SITE_KEY",
];

/** A wall line (an unset, or the site key) a deploy writes, however old. */
function isWallLine(line: string): boolean {
  if (!line.startsWith(WALL_PREFIX)) return false;
  const rest = line.slice(WALL_PREFIX.length);
  if (rest.startsWith('TP_SITE_KEY "')) return true;
  return rest.startsWith("!") && WALL_NAMES.includes(rest.slice(1));
}

const PHP_HANDLER_RE = /^\s*SetHandler "proxy:/m;

/** The vhost text with the wall lines (and the key) a deploy would write. */
export function patchApacheVhost(
  text: string,
  siteKey: string | null,
): string {
  const wall = apacheWallLines(siteKey);
  const lines = text.split("\n");
  const first = lines.findIndex((line) => isWallLine(line));
  const kept = lines.filter((line) => !isWallLine(line));
  let at = first;
  if (at < 0) {
    at = kept.findIndex((line) => line.startsWith("  <LocationMatch "));
    if (at < 0) at = kept.findIndex((line) => line.startsWith("</VirtualHost"));
    if (at < 0) return text;
  }
  return [...kept.slice(0, at), ...wall, ...kept.slice(at)].join("\n");
}

/** Set `key = value` in place, or append it to `lines` when absent. */
function setIniLine(lines: string[], key: string, value: string): void {
  const at = lines.findIndex((line) =>
    line.replace(/\s+/g, "").toLowerCase().startsWith(`${key}=`)
  );
  if (at >= 0) lines[at] = `${key} = ${value}`;
  else lines.push(`${key} = ${value}`);
}

/**
 * `php.ini` with the guard, the key and `allow_url_include = Off` added the way
 * `sitePhpIni` writes them: in the main section, and again in the locked
 * `[PATH=]` section; the guard path joins `open_basedir` when there is one.
 */
export function patchSitePhpIni(
  text: string,
  key: string,
  guardPath: string,
): string {
  const lines = text.split("\n");
  const trailing = lines.at(-1) === "" ? [lines.pop() as string] : [];
  let section = lines.findIndex((line) => line.startsWith("[PATH="));
  if (section < 0) section = lines.length;
  const head = lines.slice(0, section);
  const tail = lines.slice(section);
  const basedir = head.findIndex((line) => /^open_basedir\s*=/.test(line));
  if (basedir >= 0) {
    const value = head[basedir].replace(/^open_basedir\s*=\s*/, "");
    if (value !== "" && !value.split(":").includes(guardPath)) {
      head[basedir] = `open_basedir = ${value}:${guardPath}`;
    }
  }
  setIniLine(head, "turbopanel.site_key", key);
  setIniLine(head, "auto_prepend_file", guardPath);
  setIniLine(head, "allow_url_include", "Off");
  if (tail.length > 0) {
    setIniLine(tail, "auto_prepend_file", guardPath);
    setIniLine(tail, "allow_url_include", "Off");
  }
  return [...head, ...tail, ...trailing].join("\n");
}

/** `php-fpm.conf` with the guard's two pool directives, as `sitePhpFpmConf`. */
export function patchSitePhpFpmConf(
  text: string,
  guardPath: string,
): string | null {
  const lines = text.split("\n").filter((line) =>
    !/^php_admin_(value\[auto_prepend_file\]|flag\[allow_url_include\])\s*=/
      .test(line)
  );
  const at = lines.findIndex((line) => line.startsWith("catch_workers_output"));
  if (at < 0) return null;
  return [
    ...lines.slice(0, at),
    `php_admin_value[auto_prepend_file] = ${guardPath}`,
    "php_admin_flag[allow_url_include] = off",
    ...lines.slice(at),
  ].join("\n");
}

/** What the repair reads from and writes to the host. */
export type ApacheWallsRepairIo = Readonly<{
  run: SiteRunFn;
  /** `/etc/systemd/system` on a host; a temp tree in tests. */
  unitDir: string;
  layout: Pick<LayoutPaths, "configDir" | "stateDir" | "daemonStateDir">;
  /** The daemon's site-key secret. */
  secret: () => Promise<Uint8Array>;
  version: string;
  sleep?: (ms: number) => Promise<void>;
}>;

export type ApacheWallsRepairResult = {
  /** Sites whose vhost or runtime changed. */
  repaired: string[];
  /** Sites on a shared pool, which a redeploy has to cover. */
  needsRedeploy: string[];
  failed: string[];
  /** The pass was already recorded for this version. */
  skipped: boolean;
};

const MODE_BY_TAG: Readonly<Record<string, SitePhpRuntimeMode>> = {
  fcgi: "fastcgi",
  fpm: "fpm",
  lsd: "lsphp-detached",
};

async function sudoText(
  io: ApacheWallsRepairIo,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await io.run("sudo", hostSudoArgs(["-n", ...args]));
  return {
    ok: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function readUnitText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

function markerDir(io: ApacheWallsRepairIo): string {
  return join(io.layout.stateDir, "sites");
}

async function markerVersion(io: ApacheWallsRepairIo): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await Deno.readTextFile(join(markerDir(io), APACHE_WALLS_MARKER)),
    );
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * The runtime's files rebuilt from what is on the host, plus the guard; `null`
 * files when the runtime already has them. A string is the reason it cannot be
 * repaired.
 */
async function runtimeFiles(
  io: ApacheWallsRepairIo,
  id: string,
  key: string,
): Promise<{ files: SitePhpRuntimeFiles | null } | string> {
  const match = /-(fcgi|fpm|lsd)(\d)(\d+)$/.exec(id);
  if (!SITE_PHP_ID_RE.test(id) || match === null) return "not a runtime id";
  const service = await readUnitText(join(io.unitDir, sitePhpServiceName(id)));
  if (service === null) return "unit not found";
  const user = /^User=(\S+)$/m.exec(service)?.[1];
  if (user === undefined) return "unit has no User=";
  const group = /^Group=(\S+)$/m.exec(service)?.[1] ?? user;
  const mode = MODE_BY_TAG[match[1]];
  const dir = sitePhpConfigDir(io.layout.configDir, id);
  const guardPath = sitePhpGuardPath(io.layout.configDir, id);
  const ini = await sudoText(io, ["cat", "--", join(dir, "php.ini")]);
  if (!ini.ok) return `php.ini not readable: ${ini.stderr.trim()}`;
  let fpmNow: string | null = null;
  let fpmConf: string | null = null;
  if (mode === "fpm") {
    const conf = await sudoText(io, ["cat", "--", join(dir, "php-fpm.conf")]);
    if (!conf.ok) return `php-fpm.conf not readable: ${conf.stderr.trim()}`;
    fpmNow = conf.stdout;
    fpmConf = patchSitePhpFpmConf(conf.stdout, guardPath);
    if (fpmConf === null) return "php-fpm.conf has an unexpected shape";
  }
  const guardNow = await sudoText(io, ["cat", "--", guardPath]);
  const guard = sitePhpGuardPhp();
  const iniNext = patchSitePhpIni(ini.stdout, key, guardPath);
  if (
    iniNext === ini.stdout && fpmConf === fpmNow && guardNow.ok &&
    guardNow.stdout === guard
  ) {
    return { files: null };
  }
  return {
    files: {
      // Only what the installer reads: the id, config root, owner, mode and
      // series; the rest belongs to the unit, which is kept as it is.
      spec: {
        id,
        mode,
        series: `${match[2]}.${match[3]}`,
        user,
        group,
        home: "",
        configDir: io.layout.configDir,
        libDir: "",
        runtimesDir: "",
        webAccount: "tpapache",
      },
      service,
      socket: await readUnitText(join(io.unitDir, sitePhpSocketName(id))),
      ini: iniNext,
      fpmConf,
      guard,
    },
  };
}

type RepairContext = {
  io: ApacheWallsRepairIo;
  runtimeIo: SitePhpRuntimeIo;
  files: SitePhpRuntimeFiles | null;
  rollout: Awaited<ReturnType<typeof openSiteRollout>> | null;
  existing: Awaited<ReturnType<typeof listSitePhpUnits>>;
  probe: SiteValidationTarget | undefined;
  record: PhpRuntimeRecord | undefined;
  id: string;
};

/** Install the runtime (when it changes), commit both, or put both back. */
async function installAndCommit(c: RepairContext): Promise<void> {
  const { io, runtimeIo, files, rollout, probe, record, id } = c;
  let prepared: PreparedSitePhpRuntime | null = null;
  try {
    if (files !== null) {
      prepared = await installSitePhpRuntime(runtimeIo, files, {
        existing: c.existing,
        probe: probe ?? { label: id, url: "" },
        ...(record === undefined ? {} : {
          record: {
            stateDir: io.layout.stateDir,
            environmentId: record.environmentId,
          },
        }),
      });
      if (probe !== undefined && prepared.changed) {
        await validateSiteEndpoints(io.run, `PHP runtime ${id}`, [probe]);
      }
    }
    await rollout?.commit();
    if (prepared !== null) await commitSitePhpRuntime(runtimeIo, prepared);
  } catch (err) {
    if (prepared !== null) await rollbackSitePhpRuntime(runtimeIo, prepared);
    await rollout?.rollback();
    throw err;
  }
}

type SiteOutcome = "repaired" | "current" | "needs-redeploy";

/**
 * The environment lock keys a deploy of this vhost could hold: the record's
 * environment when there is one, else every way to read the environment id out
 * of `tp-<environment>-<service>.conf` (both parts may hold dashes). A key
 * nobody holds costs nothing, and only this repair takes more than one.
 */
function lockKeysFor(
  file: string,
  record: PhpRuntimeRecord | undefined,
): string[] {
  if (record !== undefined) return [environmentLockKey(record.environmentId)];
  const match = /^tp-(.+)\.conf$/.exec(basename(file));
  if (match === null) return [];
  const rest = match[1];
  const keys: string[] = [];
  for (let at = rest.indexOf("-"); at > 0; at = rest.indexOf("-", at + 1)) {
    keys.push(environmentLockKey(rest.slice(0, at)));
  }
  return keys;
}

function withLocks<T>(keys: string[], run: () => Promise<T>): Promise<T> {
  return keys.reduceRight<() => Promise<T>>(
    (inner, key) => () => withKeyedLock(key, inner),
    run,
  )();
}

/** The vhost as it is now, read under the lock a deploy also takes. */
async function freshVhost(
  io: ApacheWallsRepairIo,
  file: string,
  ids: string[],
): Promise<string> {
  const cat = await sudoText(io, ["cat", "--", file]);
  if (!cat.ok) throw new Error(cat.stderr.trim() || "unreadable");
  const now = [...new Set(sitePhpRuntimeIdsIn(cat.stdout))];
  if (now.length !== ids.length || now.some((id, i) => id !== ids[i])) {
    throw new Error("the vhost changed while it was being repaired");
  }
  return cat.stdout;
}

/** A vhost with no per-site runtime: only its walls (no key to set). */
async function repairWallsOnly(
  io: ApacheWallsRepairIo,
  file: string,
  text: string,
): Promise<boolean> {
  const staged = await APACHE_DRIVER.stageSiteConfig(
    io.run,
    file,
    patchApacheVhost(text, null),
  );
  if (staged === null) return false;
  const rollout = await openSiteRollout({
    run: io.run,
    layout: io.layout as LayoutPaths,
    target: APACHE_DRIVER,
    restart: false,
    staged: [staged],
    validationTargets: [],
  });
  try {
    await rollout.commit();
  } catch (err) {
    await rollout.rollback();
    throw err;
  }
  return true;
}

/** One site: its vhost, then its runtime. Returns what it did. */
async function repairSite(
  io: ApacheWallsRepairIo,
  file: string,
  text: string,
  records: ReadonlyMap<string, PhpRuntimeRecord>,
  existing: Awaited<ReturnType<typeof listSitePhpUnits>>,
  runtimeIo: SitePhpRuntimeIo,
): Promise<SiteOutcome> {
  const ids = [...new Set(sitePhpRuntimeIdsIn(text))];
  const hasHandler = PHP_HANDLER_RE.test(text);
  if (ids.length !== 1) {
    return await withLocks(lockKeysFor(file, undefined), async () => {
      const now = await freshVhost(io, file, ids);
      const changed = await repairWallsOnly(io, file, now);
      if (hasHandler) return "needs-redeploy";
      return changed ? "repaired" : "current";
    });
  }
  const id = ids[0];
  const key = await phpSiteKey(await io.secret(), id);
  const record = records.get(id);
  const probe: SiteValidationTarget | undefined = record === undefined
    ? undefined
    : { label: record.composeServiceName, url: record.probeUrl };
  const run = async (): Promise<"repaired" | "current"> => {
    // Read everything first: a runtime that cannot be read leaves the vhost
    // alone too, so no vhost ever sends a key to a runtime that is not ready.
    const runtime = await runtimeFiles(io, id, key);
    if (typeof runtime === "string") {
      throw new TypeError(`runtime ${id}: ${runtime}`);
    }
    // Read again under the lock: a deploy may have written it since the list.
    const now = await freshVhost(io, file, ids);
    const staged = await APACHE_DRIVER.stageSiteConfig(
      io.run,
      file,
      patchApacheVhost(now, key),
    );
    if (staged === null && runtime.files === null) return "current";
    const rollout = staged === null ? null : await openSiteRollout({
      run: io.run,
      layout: io.layout as LayoutPaths,
      target: APACHE_DRIVER,
      restart: false,
      staged: [staged],
      validationTargets: probe === undefined ? [] : [probe],
    });
    await installAndCommit({
      io,
      runtimeIo,
      files: runtime.files,
      rollout,
      existing,
      probe,
      record,
      id,
    });
    return "repaired";
  };
  const release = holdSitePhpRuntime(id);
  try {
    return await withLocks(lockKeysFor(file, record), run);
  } finally {
    release();
  }
}

/**
 * The repair pass. Never throws for a site: a site that fails is logged and
 * left as it was, and the pass is not recorded, so the next start tries again.
 */
export async function repairApacheWalls(
  io: ApacheWallsRepairIo,
): Promise<ApacheWallsRepairResult> {
  const result: ApacheWallsRepairResult = {
    repaired: [],
    needsRedeploy: [],
    failed: [],
    skipped: false,
  };
  if (await markerVersion(io) === io.version) {
    result.skipped = true;
    return result;
  }
  const dir = join(io.layout.configDir, "apache", "sites");
  const ls = await sudoText(io, ["ls", "-A", "--", dir]);
  const names = ls.ok
    ? ls.stdout.split("\n").filter((name) => name.endsWith(".conf"))
    : [];
  if (!ls.ok && !/no such (file or )?directory/i.test(ls.stderr)) {
    logWarn("deploy", `Apache walls repair skipped: ${ls.stderr.trim()}`);
    result.failed.push(dir);
    return result;
  }
  const runtimeIo: SitePhpRuntimeIo = {
    run: io.run,
    unitDir: io.unitDir,
    ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
  };
  const records = new Map(
    (await readPhpRuntimeRecords(io.layout)).map((r) => [r.id, r]),
  );
  const existing = await listSitePhpUnits(runtimeIo);
  await forEachSequential(
    names.toSorted((a, b) => a.localeCompare(b)),
    async (name) => {
      const file = join(dir, name);
      try {
        const cat = await sudoText(io, ["cat", "--", file]);
        if (!cat.ok) throw new Error(cat.stderr.trim() || "unreadable");
        const outcome = await repairSite(
          io,
          file,
          cat.stdout,
          records,
          existing,
          runtimeIo,
        );
        if (outcome === "repaired") {
          result.repaired.push(name);
          logInfo("deploy", `Apache walls repaired for ${name}`);
        } else if (outcome === "needs-redeploy") {
          result.needsRedeploy.push(name);
          logWarn(
            "deploy",
            `Apache site ${name} has no per-site PHP runtime to guard; a redeploy adds its site key`,
          );
        }
      } catch (err) {
        result.failed.push(name);
        logWarn(
          "deploy",
          `Apache walls repair failed for ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  );
  if (result.failed.length === 0) {
    await Deno.mkdir(markerDir(io), { recursive: true, mode: 0o700 });
    await writePrivateFileAtomic(
      markerDir(io),
      APACHE_WALLS_MARKER,
      `${
        JSON.stringify({
          version: io.version,
          repaired: result.repaired,
          needsRedeploy: result.needsRedeploy,
        })
      }\n`,
    );
  }
  return result;
}

/** The daemon's own seams: the root helper, the unit folder, the secret. */
export function hostApacheWallsRepairIo(
  layout: ApacheWallsRepairIo["layout"],
): ApacheWallsRepairIo {
  return {
    run: runHostCommand,
    unitDir: SYSTEMD_UNIT_DIR,
    layout,
    secret: () => cachedPhpSiteKeySecret(layout),
    version: DAEMON_VERSION,
  };
}
