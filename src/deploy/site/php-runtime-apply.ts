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
  sitePhpConfigDir,
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
  const listing = new Map<string, { service: boolean; socket: boolean }>();
  const ls = await sudo(io, ["ls", "-1", "--", io.unitDir]);
  if (!ls.success) return listing;
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
 * Install one config file root:<owner>-grp 0640 when its bytes differ, with a
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
  await forEachSequential(ids, async (id) => {
    await sudoQuietly(
      io,
      ["rm", "-rf", "--", sitePhpConfigDir(configDir, id)],
      `could not remove the PHP config of ${id}`,
    );
  });
}

/**
 * Boot reconcile: start every installed runtime that is not running.
 *
 * systemd already starts what is enabled (a FastCGI socket from
 * `sockets.target`, a php-fpm master from `multi-user.target`), and recreates
 * the `/run` directories as it does. This is the daemon's check of that at its
 * own start: a runtime that failed at boot (its home was not mounted yet, its
 * owner's group was missing) or whose enable an interrupted apply never
 * reached is started again. A FastCGI service is left to its socket.
 * Best-effort and logged: a runtime that still will not start is the next
 * deploy's failure, with its config test, not the daemon's.
 */
export async function reconcileSitePhpRuntimes(
  io: SitePhpRuntimeIo,
): Promise<string[]> {
  const listing = await listSitePhpUnits(io);
  const started: string[] = [];
  await forEachSequential(listing, async ([id, has]) => {
    const unit = has.socket ? sitePhpSocketName(id) : sitePhpServiceName(id);
    const active = await sudo(io, ["systemctl", "is-active", "--quiet", unit]);
    if (active.success) return;
    await sudoQuietly(io, ["systemctl", "reset-failed", unit], `reset ${unit}`);
    const start = await sudo(io, ["systemctl", "start", unit]);
    if (start.success) {
      started.push(unit);
      return;
    }
    logWarn("deploy", `PHP runtime ${unit} did not start: ${start.stderr}`);
  });
  return started;
}

/** {@link reconcileSitePhpRuntimes} on the host, at daemon start. Never throws. */
export async function reconcileSitePhpRuntimesAtBoot(): Promise<void> {
  try {
    const started = await reconcileSitePhpRuntimes({
      run: runHostCommand,
      unitDir: SYSTEMD_UNIT_DIR,
    });
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
