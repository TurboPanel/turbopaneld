/**
 * Per-site PHP runtimes on the host: install, start, roll back, remove.
 *
 * Every write goes through tp-host, which re-checks each unit and config file
 * against its pinned shape (`php-runtime.ts` renders them). The order is the
 * one the design fixes for a mode switch:
 *
 * 1. {@link installSitePhpRuntime} writes the runtime's config and units,
 *    runs `php-test` (the site's own binary on its own config, as the owner),
 *    starts it and checks it stays up — before any vhost names its socket;
 * 2. the engine's safe rollout (stage, `.tpprev`, config test, reload, HTTP
 *    probe, switch back on failure) moves the vhost onto the new socket;
 * 3. {@link commitSitePhpRuntime} drops the snapshots, and only then does
 *    {@link removeSitePhpRuntimes} take the site's other runtimes away.
 *
 * A failure at 1 or 2 runs {@link rollbackSitePhpRuntime}: a runtime this apply
 * created is removed, one it changed in place gets its previous files back.
 *
 * PHP config cannot use the engines' `.tpnew` candidates: tp-host's PHP path
 * class takes only `php.ini`, `php-fpm.conf` and their `.tpprev`. So a changed
 * file is snapshotted with `cp -p` to `.tpprev`, installed in place (tp-host
 * validates the content), and moved back on failure.
 */

import { join } from "@std/path";
import { resolveLayout } from "../../paths/layout.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { logInfo, logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import { runHostCommand } from "../systemd-unit-set.ts";
import {
  CONFIG_PREVIOUS_SUFFIX,
  ownedConfigFileMatches,
  removeStagedFile,
  type SiteRunFn,
  type SiteRunResult,
  type SiteValidationTarget,
  validateSiteEndpoints,
} from "./engine-driver.ts";
import {
  isSitePhpRuntimeId,
  sitePhpConfigDir,
  sitePhpRuntimeIdsIn,
  type SitePhpRuntimeSpec,
  sitePhpServiceName,
  sitePhpSocketActivated,
  sitePhpSocketName,
} from "./php-runtime.ts";

/** Host seams: the privileged runner, the unit directory, and a sleep. */
export type SitePhpRuntimeIo = Readonly<{
  run: SiteRunFn;
  /** `/etc/systemd/system` on a host; a temp tree in tests. */
  unitDir: string;
  sleep?: (ms: number) => Promise<void>;
}>;

/** One runtime's rendered files (`socket` and `fpmConf` by mode). */
export type SitePhpRuntimeFiles = Readonly<{
  spec: SitePhpRuntimeSpec;
  service: string;
  socket: string | null;
  ini: string;
  fpmConf: string | null;
}>;

type ConfigWrite = Readonly<{ path: string; snapshotted: boolean }>;
type UnitWrite = Readonly<{ path: string; previous: string | null }>;

/** What one apply did to one runtime, for commit or rollback. */
export type PreparedSitePhpRuntime = Readonly<{
  files: SitePhpRuntimeFiles;
  /** No unit of this runtime existed before this apply. */
  created: boolean;
  /** Any of its files changed (a created runtime always has). */
  changed: boolean;
  configs: readonly ConfigWrite[];
  units: readonly UnitWrite[];
  /** The site's loopback endpoint, probed when no vhost reload covered it. */
  probe: SiteValidationTarget;
}>;

/** A unit-directory listing, by runtime id. */
export type SitePhpUnitListing = ReadonlyMap<
  string,
  Readonly<{ service: boolean; socket: boolean }>
>;

/** Seconds a just-started runtime has to still be running. */
const SETTLE_MS = 1000;

function sudo(io: SitePhpRuntimeIo, args: string[]): Promise<SiteRunResult> {
  return io.run("sudo", hostSudoArgs(["-n", ...args]));
}

async function sudoOrThrow(
  io: SitePhpRuntimeIo,
  args: string[],
  what: string,
): Promise<void> {
  const result = await sudo(io, args);
  if (!result.success) {
    throw new Error(`${what}: ${result.stderr || result.stdout || "failed"}`);
  }
}

async function sudoQuietly(
  io: SitePhpRuntimeIo,
  args: string[],
  what: string,
): Promise<void> {
  const result = await sudo(io, args);
  if (!result.success) logWarn("deploy", `${what}: ${result.stderr}`);
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeTemp(contents: string): Promise<string> {
  const tmp = await Deno.makeTempFile({ prefix: "tp-site-php-" });
  await Deno.writeTextFile(tmp, contents, { mode: 0o600 });
  return tmp;
}

/** Every per-site PHP runtime with a unit file, and which unit files it has. */
export async function listSitePhpUnits(
  io: SitePhpRuntimeIo,
): Promise<SitePhpUnitListing> {
  return await readSitePhpUnits(io) ?? new Map();
}

/**
 * {@link listSitePhpUnits}, but `null` when the unit directory could not be
 * listed, for callers that must not read "could not look" as "none there".
 */
export async function readSitePhpUnits(
  io: SitePhpRuntimeIo,
): Promise<SitePhpUnitListing | null> {
  const listing = new Map<string, { service: boolean; socket: boolean }>();
  const ls = await sudo(io, ["ls", "-1", "--", io.unitDir]);
  if (!ls.success) return null;
  for (const name of ls.stdout.split("\n")) {
    const match = /^turbopanel-php-([a-z0-9][a-z0-9-]*)\.(service|socket)$/
      .exec(name.trim());
    if (!match) continue;
    const entry = listing.get(match[1]) ?? { service: false, socket: false };
    entry[match[2] as "service" | "socket"] = true;
    listing.set(match[1], entry);
  }
  return listing;
}

/**
 * Install one config file root:<owner> 0640 when its bytes differ, with a
 * `.tpprev` snapshot of what was there. `null` when nothing changed.
 */
async function installConfigFile(
  io: SitePhpRuntimeIo,
  spec: SitePhpRuntimeSpec,
  name: string,
  contents: string,
): Promise<ConfigWrite | null> {
  const path = join(sitePhpConfigDir(spec.configDir, spec.id), name);
  const tmp = await writeTemp(contents);
  try {
    if (await ownedConfigFileMatches(io.run, tmp, path)) return null;
    const snapshot = await sudo(io, [
      "cp",
      "-p",
      "--",
      path,
      `${path}${CONFIG_PREVIOUS_SUFFIX}`,
    ]);
    await sudoOrThrow(
      io,
      ["install", "-m", "0640", "-o", "root", "-g", spec.group, tmp, path],
      `PHP runtime ${spec.id}: tp-host refused ${name}`,
    );
    return { path, snapshotted: snapshot.success };
  } finally {
    await removeStagedFile(tmp);
  }
}

async function readUnit(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Install one unit root:root 0644 when its bytes differ. */
async function installUnitFile(
  io: SitePhpRuntimeIo,
  name: string,
  contents: string,
): Promise<UnitWrite | null> {
  const path = join(io.unitDir, name);
  const tmp = await writeTemp(contents);
  try {
    if (await ownedConfigFileMatches(io.run, tmp, path)) return null;
    const previous = await readUnit(path);
    await sudoOrThrow(
      io,
      ["install", "-m", "0644", "-o", "root", "-g", "root", tmp, path],
      `tp-host refused ${name}`,
    );
    return { path, previous };
  } finally {
    await removeStagedFile(tmp);
  }
}

function configFiles(files: SitePhpRuntimeFiles): Array<[string, string]> {
  const out: Array<[string, string]> = [["php.ini", files.ini]];
  if (files.fpmConf !== null) out.push(["php-fpm.conf", files.fpmConf]);
  return out;
}

function unitFiles(files: SitePhpRuntimeFiles): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  // The socket first: a socket-activated service `Requires=` it.
  if (files.socket !== null) {
    out.push([sitePhpSocketName(files.spec.id), files.socket]);
  }
  out.push([sitePhpServiceName(files.spec.id), files.service]);
  return out;
}

async function writeRuntimeFiles(
  io: SitePhpRuntimeIo,
  files: SitePhpRuntimeFiles,
  configs: ConfigWrite[],
  units: UnitWrite[],
): Promise<void> {
  const { spec } = files;
  await sudoOrThrow(
    io,
    [
      "install",
      "-d",
      "-m",
      "0750",
      "-o",
      "root",
      "-g",
      spec.group,
      sitePhpConfigDir(spec.configDir, spec.id),
    ],
    `PHP runtime ${spec.id}: config directory`,
  );
  await forEachSequential(configFiles(files), async ([name, contents]) => {
    const written = await installConfigFile(io, spec, name, contents);
    if (written) configs.push(written);
  });
  await forEachSequential(unitFiles(files), async ([name, contents]) => {
    const written = await installUnitFile(io, name, contents);
    if (written) units.push(written);
  });
  if (units.length > 0) {
    await sudoOrThrow(io, ["systemctl", "daemon-reload"], "daemon-reload");
  }
}

/** This apply rewrote the runtime's existing `.socket` unit. */
function socketUnitChanged(prepared: PreparedSitePhpRuntime): boolean {
  const socket = sitePhpSocketName(prepared.files.spec.id);
  return prepared.units.some((unit) =>
    unit.previous !== null && unit.path.endsWith(`/${socket}`)
  );
}

/**
 * Start (or restart) a runtime whose files changed. FastCGI and lsphp: the
 * socket is enabled, then the service is started so PHP really boots now
 * rather than on the first visitor. php-fpm: enabled, then restarted when a unit changed
 * or it is down, else reloaded (graceful, USR2).
 */
async function startRuntime(
  io: SitePhpRuntimeIo,
  prepared: PreparedSitePhpRuntime,
): Promise<void> {
  const { spec } = prepared.files;
  const service = sitePhpServiceName(spec.id);
  if (sitePhpSocketActivated(spec.mode)) {
    const socket = sitePhpSocketName(spec.id);
    await sudoOrThrow(
      io,
      ["systemctl", "enable", "--now", socket],
      `PHP runtime ${spec.id}: socket`,
    );
    // A running socket keeps its old owner and group until it is restarted
    // (the site moved between nginx and Apache: `SocketGroup` changed).
    if (socketUnitChanged(prepared)) {
      await sudoOrThrow(
        io,
        ["systemctl", "restart", socket],
        `PHP runtime ${spec.id}: socket restart`,
      );
    }
    await sudoOrThrow(
      io,
      ["systemctl", "restart", service],
      `PHP runtime ${spec.id}: start`,
    );
    return;
  }
  await sudoOrThrow(
    io,
    ["systemctl", "enable", service],
    `PHP runtime ${spec.id}: enable`,
  );
  const active = await sudo(io, ["systemctl", "is-active", "--quiet", service]);
  const action = prepared.units.length > 0 || !active.success
    ? "restart"
    : "reload";
  await sudoOrThrow(
    io,
    ["systemctl", action, service],
    `PHP runtime ${spec.id}: ${action}`,
  );
}

/** The runtime is still running a moment after it was started. */
async function assertRuntimeUp(
  io: SitePhpRuntimeIo,
  spec: SitePhpRuntimeSpec,
): Promise<void> {
  await (io.sleep ?? sleepDefault)(SETTLE_MS);
  const service = sitePhpServiceName(spec.id);
  const active = await sudo(io, ["systemctl", "is-active", "--quiet", service]);
  if (!active.success) {
    throw new Error(
      `PHP runtime ${spec.id} did not stay up (systemctl status ${service})`,
    );
  }
}

/**
 * Rebuild the per-owner loopback rules from the PHP units on disk
 * (`tp-host php-loopback-sync`). Throws: a runtime must not start without them.
 */
async function syncLoopbackRules(io: SitePhpRuntimeIo): Promise<void> {
  await sudoOrThrow(io, ["php-loopback-sync"], "PHP loopback rules");
}

/**
 * Write, test and start one runtime. A runtime whose files are all unchanged
 * is left exactly as it is. On any failure the runtime is rolled back here and
 * the error rethrown, so the caller never sees a half-installed runtime.
 */
export async function installSitePhpRuntime(
  io: SitePhpRuntimeIo,
  files: SitePhpRuntimeFiles,
  opts: Readonly<{ existing: SitePhpUnitListing; probe: SiteValidationTarget }>,
): Promise<PreparedSitePhpRuntime> {
  const configs: ConfigWrite[] = [];
  const units: UnitWrite[] = [];
  const created = !opts.existing.has(files.spec.id);
  const prepared = (): PreparedSitePhpRuntime => ({
    files,
    created,
    changed: created || configs.length > 0 || units.length > 0,
    configs,
    units,
    probe: opts.probe,
  });
  try {
    await writeRuntimeFiles(io, files, configs, units);
    if (!prepared().changed) return prepared();
    const test = await sudo(io, ["php-test", files.spec.id]);
    if (!test.success) {
      throw new Error(
        `PHP runtime ${files.spec.id} failed its config test: ${
          (test.stderr || test.stdout).trim()
        }`,
      );
    }
    // Rules first, then PHP: a failure here must leave the runtime stopped.
    // (The unit's own ExecStartPre repeats this at every start.)
    await syncLoopbackRules(io);
    await startRuntime(io, prepared());
    await assertRuntimeUp(io, files.spec);
  } catch (err) {
    await rollbackSitePhpRuntime(io, prepared());
    throw err;
  }
  return prepared();
}

/** Keep what one apply installed: only the `.tpprev` snapshots go. */
export async function commitSitePhpRuntime(
  io: SitePhpRuntimeIo,
  prepared: PreparedSitePhpRuntime,
): Promise<void> {
  await forEachSequential(prepared.configs, async (config) => {
    if (!config.snapshotted) return;
    await sudoQuietly(
      io,
      ["rm", "-f", "--", `${config.path}${CONFIG_PREVIOUS_SUFFIX}`],
      `could not drop ${config.path}${CONFIG_PREVIOUS_SUFFIX}`,
    );
  });
}

async function restoreConfig(
  io: SitePhpRuntimeIo,
  config: ConfigWrite,
): Promise<void> {
  const args = config.snapshotted
    ? ["mv", "-f", "--", `${config.path}${CONFIG_PREVIOUS_SUFFIX}`, config.path]
    : ["rm", "-f", "--", config.path];
  await sudoQuietly(io, args, `could not restore ${config.path}`);
}

async function restoreUnit(
  io: SitePhpRuntimeIo,
  unit: UnitWrite,
): Promise<void> {
  if (unit.previous === null) {
    logWarn("deploy", `no previous copy of ${unit.path} to restore`);
    return;
  }
  const tmp = await writeTemp(unit.previous);
  try {
    await sudoQuietly(
      io,
      ["install", "-m", "0644", "-o", "root", "-g", "root", tmp, unit.path],
      `could not restore ${unit.path}`,
    );
  } finally {
    await removeStagedFile(tmp);
  }
}

/**
 * Undo one apply's changes to a runtime. Best-effort: the caller is already
 * throwing the failure that got here.
 */
export async function rollbackSitePhpRuntime(
  io: SitePhpRuntimeIo,
  prepared: PreparedSitePhpRuntime,
): Promise<void> {
  const { spec } = prepared.files;
  if (prepared.created) {
    const units = { service: true, socket: sitePhpSocketActivated(spec.mode) };
    await removeSitePhpRuntimes(
      io,
      spec.configDir,
      [spec.id],
      new Map([[spec.id, units]]),
    );
    return;
  }
  if (!prepared.changed) return;
  await forEachSequential(prepared.configs, (c) => restoreConfig(io, c));
  await forEachSequential(prepared.units, (u) => restoreUnit(io, u));
  if (prepared.units.length > 0) {
    await sudoQuietly(io, ["systemctl", "daemon-reload"], "daemon-reload");
  }
  if (socketUnitChanged(prepared)) {
    const socket = sitePhpSocketName(spec.id);
    await sudoQuietly(
      io,
      ["systemctl", "restart", socket],
      `could not restart ${socket} on its previous config`,
    );
  }
  await sudoQuietly(
    io,
    ["systemctl", "restart", sitePhpServiceName(spec.id)],
    `could not restart ${sitePhpServiceName(spec.id)} on its previous config`,
  );
}

/**
 * Probe the sites whose runtime changed while their vhost did not (so no
 * engine rollout probed them), then commit. A failed probe throws before
 * anything is committed, and the caller rolls the runtimes back — only ones
 * changed in place can be here, since a created runtime always comes with a
 * vhost change and so with an engine rollout.
 */
export async function settleSitePhpRuntimes(
  io: SitePhpRuntimeIo,
  prepared: readonly PreparedSitePhpRuntime[],
  opts: Readonly<{ engineProbed: boolean; label: string }>,
): Promise<void> {
  const changed = prepared.filter((p) => p.changed);
  if (!opts.engineProbed && changed.length > 0) {
    await validateSiteEndpoints(
      io.run,
      opts.label,
      changed.map((p) => p.probe),
    );
  }
  await forEachSequential(prepared, (p) => commitSitePhpRuntime(io, p));
}

/**
 * Stop, disable and delete runtimes, then their config directories. Unit
 * files are found in `listing` when given, else both names are tried.
 */
export async function removeSitePhpRuntimes(
  io: SitePhpRuntimeIo,
  configDir: string,
  ids: readonly string[],
  listing: SitePhpUnitListing,
): Promise<void> {
  if (ids.length === 0) return;
  await forEachSequential(ids, async (id) => {
    const has = listing.get(id) ?? { service: true, socket: true };
    const names = [
      ...(has.socket ? [sitePhpSocketName(id)] : []),
      ...(has.service ? [sitePhpServiceName(id)] : []),
    ];
    await sudoQuietly(io, ["systemctl", "stop", ...names], `stop ${id}`);
    await sudoQuietly(io, ["systemctl", "disable", ...names], `disable ${id}`);
    await forEachSequential(names, async (name) => {
      await sudoQuietly(
        io,
        ["rm", "-f", "--", join(io.unitDir, name)],
        `could not remove ${name}`,
      );
    });
  });
  await sudoQuietly(io, ["systemctl", "daemon-reload"], "daemon-reload");
  // Units are gone: an owner with no PHP left drops out of the rules. A stale
  // owner only stays restricted, so a failure here is a warning.
  await sudoQuietly(io, ["php-loopback-sync"], "PHP loopback rules");
  await forEachSequential(ids, async (id) => {
    await sudoQuietly(
      io,
      ["rm", "-rf", "--", sitePhpConfigDir(configDir, id)],
      `could not remove the PHP config of ${id}`,
    );
  });
}

/**
 * Runtimes an apply in this process has installed and not yet settled or
 * rolled back. Its vhost may not name it yet, so no orphan sweep may take it.
 */
const inFlight = new Map<string, number>();

/** Mark `id` in flight until `release` is called. */
export function holdSitePhpRuntime(id: string): () => void {
  inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(id) ?? 1) - 1;
    if (left > 0) inFlight.set(id, left);
    else inFlight.delete(id);
  };
}

/**
 * The vhost directories whose sites hand PHP to a per-site runtime. nginx and
 * Apache keep one file per site; OpenLiteSpeed names the socket in a
 * directory per site (`vhosts/<site>/vhconf.conf`; its `sites/` fragments
 * name none), which {@link referencesIn} enters one level deep.
 */
export function sitePhpVhostDirs(configDir: string): string[] {
  return [
    join(configDir, "nginx", "sites"),
    join(configDir, "apache", "sites"),
    join(configDir, "openlitespeed", "vhosts"),
  ];
}

/**
 * One vhost directory's entries; `null` unread. A missing top-level directory
 * (that engine is not installed) is `[]`; a missing nested one is `null`: the
 * entry `cat` could not read is then a file it could not read, never an empty
 * directory.
 */
async function listVhostDir(
  io: SitePhpRuntimeIo,
  dir: string,
  missingIsEmpty: boolean,
): Promise<string[] | null> {
  const ls = await sudo(io, ["ls", "-A", "--", dir]);
  if (ls.success) return ls.stdout.split("\n").filter((n) => n.length > 0);
  return missingIsEmpty && /no such (file or )?directory/i.test(ls.stderr)
    ? []
    : null;
}

/**
 * Hands the text of every config file in `dir` to `visit`. An entry `cat`
 * cannot read is entered as a directory while `depth` allows (OpenLiteSpeed's
 * per-site directories); `false` when anything could not be read.
 */
async function visitVhostTexts(
  io: SitePhpRuntimeIo,
  dir: string,
  visit: (text: string) => void,
  depth = 1,
): Promise<boolean> {
  const names = await listVhostDir(io, dir, depth === 1);
  if (names === null) return false;
  let readAll = true;
  // Live configs and staged / snapshot copies alike: a rollout in progress
  // may swap either back in.
  await forEachSequential(names, async (name) => {
    const cat = await sudo(io, ["cat", "--", join(dir, name)]);
    if (cat.success) {
      visit(cat.stdout);
      return;
    }
    if (
      depth > 0 && await visitVhostTexts(io, join(dir, name), visit, depth - 1)
    ) {
      return;
    }
    readAll = false;
  });
  return readAll;
}

/** Adds every runtime id the vhosts in `dir` name; `false` if any was unreadable. */
function referencesIn(
  io: SitePhpRuntimeIo,
  dir: string,
  into: Set<string>,
): Promise<boolean> {
  return visitVhostTexts(io, dir, (text) => {
    for (const id of sitePhpRuntimeIdsIn(text)) into.add(id);
  });
}

/**
 * The text of every nginx, Apache and OpenLiteSpeed vhost on this host, or
 * `null` when any could not be read: the caller then decides nothing on the
 * strength of a reference it could not see. Caddy's site files are not read:
 * a Caddy site always runs PHP in a shared pool, which the pool check covers.
 */
export async function readSiteConfigTexts(
  io: SitePhpRuntimeIo,
  configDir: string,
): Promise<string[] | null> {
  const texts: string[] = [];
  let readAll = true;
  const dirs = [
    ...sitePhpVhostDirs(configDir),
    join(configDir, "openlitespeed", "sites"),
  ];
  await forEachSequential(dirs, async (dir) => {
    if (!await visitVhostTexts(io, dir, (text) => texts.push(text))) {
      readAll = false;
    }
  });
  return readAll ? texts : null;
}

/**
 * Every runtime id a vhost on this host names, or `null` when any vhost could
 * not be read — the caller then removes nothing and starts nothing on the
 * strength of a reference it could not see.
 */
export async function referencedSitePhpRuntimes(
  io: SitePhpRuntimeIo,
  configDir: string,
): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let readAll = true;
  await forEachSequential(sitePhpVhostDirs(configDir), async (dir) => {
    if (!await referencesIn(io, dir, ids)) readAll = false;
  });
  return readAll ? ids : null;
}

/**
 * Installed runtimes no vhost names and no apply holds: what a removed site,
 * an interrupted apply or a crashed daemon left behind. `null` when the
 * vhosts could not all be read.
 */
export async function orphanSitePhpRuntimes(
  io: SitePhpRuntimeIo,
  configDir: string,
  listing: SitePhpUnitListing,
): Promise<string[] | null> {
  if (listing.size === 0) return [];
  const referenced = await referencedSitePhpRuntimes(io, configDir);
  if (referenced === null) return null;
  return [...listing.keys()].filter((id) =>
    isSitePhpRuntimeId(id) && !referenced.has(id) && !inFlight.has(id)
  );
}

async function startIfDown(
  io: SitePhpRuntimeIo,
  id: string,
  has: Readonly<{ socket: boolean }>,
): Promise<string | null> {
  const unit = has.socket ? sitePhpSocketName(id) : sitePhpServiceName(id);
  const active = await sudo(io, ["systemctl", "is-active", "--quiet", unit]);
  if (active.success) return null;
  await sudoQuietly(io, ["systemctl", "reset-failed", unit], `reset ${unit}`);
  const start = await sudo(io, ["systemctl", "start", unit]);
  if (start.success) return unit;
  logWarn("deploy", `PHP runtime ${unit} did not start: ${start.stderr}`);
  return null;
}

/**
 * Boot reconcile: remove the runtimes no vhost names, then start every one a
 * vhost does name that is not running.
 *
 * systemd already starts what is enabled (a FastCGI socket from
 * `sockets.target`, a php-fpm master from `multi-user.target`), and recreates
 * the `/run` directories as it does. This is the daemon's check of that at its
 * own start: a runtime that failed at boot (its home was not mounted yet, its
 * owner's group was missing) or whose enable an interrupted apply never
 * reached is started again. A FastCGI service is left to its socket. An orphan
 * is never started: nothing would reach it, and it still runs site code.
 *
 * When a vhost cannot be read nothing is removed or started — systemd's own
 * start stands. Best-effort and logged: a runtime that still will not start is
 * the next deploy's failure, with its config test, not the daemon's.
 */
export async function reconcileSitePhpRuntimes(
  io: SitePhpRuntimeIo,
  configDir: string,
): Promise<{ started: string[]; removed: string[] }> {
  const listing = await listSitePhpUnits(io);
  const orphans = await orphanSitePhpRuntimes(io, configDir, listing);
  if (orphans === null) {
    logWarn(
      "deploy",
      "PHP runtime reconcile skipped: a vhost could not be read",
    );
    return { started: [], removed: [] };
  }
  await removeSitePhpRuntimes(io, configDir, orphans, listing);
  // The rules live in the kernel only: rebuild them after a reboot or flush,
  // before anything below is started (each start also runs the guard).
  const live = [...listing].filter(([id]) =>
    isSitePhpRuntimeId(id) && !orphans.includes(id)
  );
  // With PHP runtimes left this must not fail silently (a host without the
  // `nft` package would otherwise only show unit start failures): reconcile
  // fails with the helper's own message, and no runtime is started open.
  if (live.length > 0) await syncLoopbackRules(io);
  else await sudoQuietly(io, ["php-loopback-sync"], "PHP loopback rules");
  const started: string[] = [];
  await forEachSequential(live, async ([id, has]) => {
    const unit = await startIfDown(io, id, has);
    if (unit) started.push(unit);
  });
  return { started, removed: orphans };
}

/** {@link reconcileSitePhpRuntimes} on the host, at daemon start. Never throws. */
export async function reconcileSitePhpRuntimesAtBoot(): Promise<void> {
  try {
    const { started, removed } = await reconcileSitePhpRuntimes(
      { run: runHostCommand, unitDir: SYSTEMD_UNIT_DIR },
      resolveLayout().configDir,
    );
    if (removed.length > 0) {
      logInfo("deploy", `orphaned PHP runtimes removed: ${removed.join(",")}`);
    }
    if (started.length > 0) {
      logInfo("deploy", `PHP runtimes started at boot: ${started.join(",")}`);
    }
  } catch (err) {
    logWarn(
      "deploy",
      `PHP runtime boot reconcile skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
