/**
 * Make this host's project caches for one environment match a list.
 *
 * One function serves both paths: `environment.deploy` (the complete set rides
 * in the payload, applied right after the accounts exist) and `cache.apply`
 * (queued between deploys). Everything root does goes through `tp-host`: the
 * folders (`cache-prepare`), the config copy (`cache-config-install`), the unit
 * (`install`, checked against the text the daemon renders), the removal
 * (`cache-remove`), and `systemctl`.
 *
 * Order for the listed caches: runtime if missing, slices, then per cache its
 * folders, config and unit; one `daemon-reload`; the account walls rebuilt (a
 * cache's loopback port is guarded before the process can listen on it); then
 * start or restart (only a cache whose config or unit bytes changed), each
 * waited on. A cache that fails fails alone. Then removals, a second walls
 * rebuild, and the host index (`<state>/caches/<environment id>.json`).
 *
 * Data is never removed because a cache left the list; only an explicit
 * `deleteData` (or a destroy that asked for the data to go) removes it.
 */

import { join } from "node:path";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import {
  installUnitFile,
  writePrivateFileAtomic,
} from "../../permissions/host-unit-files.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { sha256HexOfBytes } from "../../orchestration/download-verify.ts";
import type {
  CacheApplyRemoval,
  CacheApplyResult,
  EnvironmentDeployCache,
} from "../../contracts/commands-contracts.ts";
import { logWarn } from "../../util/logger.ts";
import {
  forEachSequential,
  mapSequential,
  repeatSequential,
} from "../../util/sequential.ts";
import type { RunFn } from "../ensure-principal.ts";
import { syncAccountWalls } from "../reach/reach-ports.ts";
import {
  nativeAppConfigDir,
  principalSliceContent,
  principalSlicePath,
  principalSliceStagedPath,
  SYSTEMD_UNIT_DIR,
} from "../native/unit.ts";
import { renderCacheConfig } from "./config.ts";
import {
  CACHE_ID_RE,
  cacheBinaryPath,
  cacheIndexPath,
  cachePatchVersion,
  cacheStageDir,
  cacheUnitName,
} from "./runtime.ts";
import { renderCacheUnit } from "./unit.ts";

export type CacheLayout = Pick<
  LayoutPaths,
  "runtimesDir" | "configDir" | "stateDir" | "principalHomeRoot"
>;

export type CacheIo = {
  run: RunFn;
  layout: CacheLayout;
  /** Vendor the cache runtime of this patch release; throws when it cannot. */
  ensureRuntime: (patch: string) => Promise<void>;
  /** Folder the unit files go to (default `/etc/systemd/system`). */
  unitDir?: string;
  /** Whether a Linux account exists on this host (default: `id -u`). */
  userExists?: (username: string) => Promise<boolean>;
  /** Whether the vendored binary is there (default: the file system). */
  binaryExists?: (path: string) => Promise<boolean>;
  /** Wait; tests replace it so no real time passes. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a started cache may take to report active (default 60 s). */
  activeTimeoutMs?: number;
};

/** What the host index remembers of a cache this host runs. */
export type CacheIndexEntry = {
  id: string;
  username: string;
  /** SHA-256 of the config last installed; decides whether the cache restarts. */
  configSha256?: string;
};

export type CacheApplyOutcome = {
  results: CacheApplyResult[];
  /** Plain words about what was worked around without failing. */
  warnings: string[];
};

const DEFAULT_ACTIVE_TIMEOUT_MS = 60_000;
const ACTIVE_POLL_MS = 1_000;

const encoder = new TextEncoder();

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

async function defaultBinaryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Read the host index for an environment; a missing or unreadable file means none. */
export async function readCacheIndex(
  layout: Pick<LayoutPaths, "stateDir">,
  environmentId: string,
): Promise<CacheIndexEntry[]> {
  try {
    const parsed: unknown = JSON.parse(
      await Deno.readTextFile(cacheIndexPath(layout, environmentId)),
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): CacheIndexEntry[] => {
      if (
        entry === null || typeof entry !== "object" ||
        typeof entry.id !== "string" || !CACHE_ID_RE.test(entry.id) ||
        typeof entry.username !== "string"
      ) return [];
      return [{
        id: entry.id,
        username: entry.username,
        ...(typeof entry.configSha256 === "string"
          ? { configSha256: entry.configSha256 }
          : {}),
      }];
    });
  } catch {
    return [];
  }
}

async function writeCacheIndex(
  layout: Pick<LayoutPaths, "stateDir">,
  environmentId: string,
  entries: readonly CacheIndexEntry[],
): Promise<void> {
  const path = cacheIndexPath(layout, environmentId);
  if (entries.length === 0) {
    await Deno.remove(path).catch((err) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
    return;
  }
  const dir = join(layout.stateDir, "caches");
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivateFileAtomic(
    dir,
    `${environmentId}.json`,
    `${JSON.stringify(entries)}\n`,
  );
}

async function systemctl(io: CacheIo, args: string[]) {
  return await io.run("sudo", hostSudoArgs(["-n", "systemctl", ...args]));
}

async function mustSystemctl(io: CacheIo, args: string[], what: string) {
  const result = await systemctl(io, args);
  if (!result.success) {
    throw new Error(
      `${what}: ${result.stderr.trim() || "systemctl refused it"}`,
    );
  }
}

async function accountExists(io: CacheIo, username: string): Promise<boolean> {
  if (io.userExists) return await io.userExists(username);
  return (await io.run("id", ["-u", username])).success;
}

async function ensureRuntimes(
  io: CacheIo,
  caches: readonly EnvironmentDeployCache[],
): Promise<void> {
  const exists = io.binaryExists ?? defaultBinaryExists;
  const patches = new Set<string>();
  for (const cache of caches) {
    const patch = cachePatchVersion(cache.engine, cache.version);
    if (patch === undefined) {
      throw new Error(`the cache engine ${cache.version} is not vendored`);
    }
    patches.add(patch);
  }
  await forEachSequential(patches, async (patch) => {
    if (await exists(cacheBinaryPath(io.layout, patch))) return;
    await io.ensureRuntime(patch);
  });
}

/** Install each account's slice once, from the ceiling a cache carries; never rewritten to empty limits. */
async function installSlices(
  io: CacheIo,
  caches: readonly EnvironmentDeployCache[],
): Promise<boolean> {
  const limits = new Map<
    string,
    NonNullable<EnvironmentDeployCache["accountLimits"]>
  >();
  for (const cache of caches) {
    if (cache.accountLimits && !limits.has(cache.username)) {
      limits.set(cache.username, cache.accountLimits);
    }
  }
  if (limits.size === 0) return false;
  await Deno.mkdir(nativeAppConfigDir(io.layout), {
    recursive: true,
    mode: 0o750,
  });
  let changed = false;
  await forEachSequential(limits, async ([username, accountLimits]) => {
    const installed = await installUnitFile(io.run, {
      stagedPath: principalSliceStagedPath(io.layout, username),
      installedPath: principalSlicePath(
        username,
        io.unitDir ?? SYSTEMD_UNIT_DIR,
      ),
      contents: principalSliceContent({ username, limits: accountLimits }),
    });
    changed ||= installed;
  });
  return changed;
}

async function hostSudo(io: CacheIo, args: string[], what: string) {
  const result = await io.run("sudo", hostSudoArgs(["-n", ...args]));
  if (!result.success) {
    throw new Error(`${what}: ${result.stderr.trim() || "tp-host refused it"}`);
  }
}

type Installed = {
  cache: EnvironmentDeployCache;
  patch: string;
  /** The config or the unit bytes differ from what the host had. */
  changed: boolean;
  isNew: boolean;
  configSha256: string;
};

/** Folders, config and unit of one cache. Throws with a plain sentence on any refusal. */
async function installOne(
  io: CacheIo,
  cache: EnvironmentDeployCache,
  previous: CacheIndexEntry | undefined,
): Promise<Installed> {
  const patch = cachePatchVersion(cache.engine, cache.version);
  if (patch === undefined) throw new Error("the cache engine is not vendored");
  const { id, username } = cache;
  await hostSudo(io, ["cache-prepare", username, id], "preparing the folders");

  const config = renderCacheConfig(io.layout, {
    id,
    username,
    maxMemoryMb: cache.maxMemoryMb,
    ...(cache.port === undefined ? {} : { port: cache.port }),
    passwordSha256: cache.passwordSha256,
  });
  const configSha256 = await sha256HexOfBytes(encoder.encode(config));
  const stageDir = cacheStageDir(io.layout);
  await Deno.mkdir(stageDir, { recursive: true, mode: 0o700 });
  await Deno.chmod(stageDir, 0o700);
  await writePrivateFileAtomic(stageDir, `${id}.conf`, config);
  try {
    await hostSudo(
      io,
      ["cache-config-install", username, id],
      "installing the config",
    );
  } finally {
    await Deno.remove(join(stageDir, `${id}.conf`)).catch(() => undefined);
  }

  const unitChanged = await installUnitFile(io.run, {
    stagedPath: join(stageDir, cacheUnitName(id)),
    installedPath: join(io.unitDir ?? SYSTEMD_UNIT_DIR, cacheUnitName(id)),
    contents: renderCacheUnit(io.layout, {
      id,
      username,
      patch,
      maxMemoryMb: cache.maxMemoryMb,
      ...(cache.port === undefined ? {} : { port: cache.port }),
    }),
  });
  return {
    cache,
    patch,
    isNew: previous === undefined,
    changed: unitChanged || previous?.configSha256 !== configSha256,
    configSha256,
  };
}

async function waitActive(io: CacheIo, unit: string): Promise<boolean> {
  const sleep = io.sleep ?? defaultSleep;
  const limit = io.activeTimeoutMs ?? DEFAULT_ACTIVE_TIMEOUT_MS;
  let waited = 0;
  let active = false;
  await repeatSequential(async () => {
    active = (await systemctl(io, ["is-active", "--quiet", unit])).success;
    if (active || waited >= limit) return false;
    await sleep(ACTIVE_POLL_MS);
    waited += ACTIVE_POLL_MS;
    return true;
  });
  return active;
}

/** Start a new or stopped cache, restart a changed one, and wait for it. */
async function startOne(io: CacheIo, item: Installed): Promise<void> {
  const unit = cacheUnitName(item.cache.id);
  await systemctl(io, ["reset-failed", unit]);
  await mustSystemctl(io, ["enable", "--now", unit], "starting the cache");
  if (item.changed && !item.isNew) {
    await mustSystemctl(io, ["restart", unit], "restarting the cache");
  }
  if (!(await waitActive(io, unit))) {
    throw new Error("the cache did not report running; see its log");
  }
}

async function removeUnit(io: CacheIo, id: string): Promise<void> {
  const unit = cacheUnitName(id);
  // A unit that was never installed is already gone; the next step says so.
  await systemctl(io, ["disable", "--now", unit]);
  await systemctl(io, ["reset-failed", unit]);
  await hostSudo(
    io,
    ["rm", "-f", "--", join(io.unitDir ?? SYSTEMD_UNIT_DIR, unit)],
    "removing the unit",
  );
}

/** Stop one cache and delete its unit and config; its data only with `deleteData`. */
export async function removeCache(
  io: CacheIo,
  entry: { id: string; username: string },
  deleteData: boolean,
): Promise<void> {
  if (!CACHE_ID_RE.test(entry.id)) throw new Error("not a cache id");
  await removeUnit(io, entry.id);
  await hostSudo(
    io,
    [
      "cache-remove",
      entry.username,
      entry.id,
      ...(deleteData ? ["--data"] : []),
    ],
    "removing the cache",
  );
}

async function removeEach(
  io: CacheIo,
  entries: readonly { id: string; username: string; deleteData: boolean }[],
  warnings: string[],
): Promise<Set<string>> {
  const removed = new Set<string>();
  await forEachSequential(entries, async (entry) => {
    try {
      await removeCache(io, entry, entry.deleteData);
      removed.add(entry.id);
    } catch (err) {
      warnings.push(
        `cache ${entry.id} could not be removed: ${
          describe(err, "tp-host refused it")
        }`,
      );
    }
  });
  return removed;
}

type Step = { cache: EnvironmentDeployCache; result?: CacheApplyResult };

function failed(cache: EnvironmentDeployCache, err: unknown): CacheApplyResult {
  return {
    id: cache.id,
    state: "failed",
    error: describe(err, "the cache could not be applied"),
  };
}

async function classify(
  io: CacheIo,
  caches: readonly EnvironmentDeployCache[],
): Promise<Step[]> {
  return await mapSequential(caches, async (cache): Promise<Step> => {
    if (await accountExists(io, cache.username)) return { cache };
    return {
      cache,
      result: {
        id: cache.id,
        state: "pending",
        error:
          "starts with the next deploy, when its Hosting Account exists on this server",
      },
    };
  });
}

async function installAll(
  io: CacheIo,
  steps: Step[],
  index: readonly CacheIndexEntry[],
): Promise<Installed[]> {
  const installed: Installed[] = [];
  await forEachSequential(steps, async (step) => {
    if (step.result) return;
    try {
      installed.push(
        await installOne(
          io,
          step.cache,
          index.find((e) => e.id === step.cache.id),
        ),
      );
    } catch (err) {
      step.result = failed(step.cache, err);
    }
  });
  return installed;
}

async function startAll(
  io: CacheIo,
  steps: Step[],
  installed: readonly Installed[],
): Promise<void> {
  await forEachSequential(installed, async (item) => {
    const step = steps.find((s) => s.cache.id === item.cache.id);
    if (!step) return;
    try {
      await startOne(io, item);
      step.result = {
        id: item.cache.id,
        state: "ready",
        runtimeVersion: item.patch,
      };
    } catch (err) {
      step.result = failed(item.cache, err);
    }
  });
}

type Removal = { id: string; username: string; deleteData: boolean };

/**
 * What goes: the caches named in `removed`, and (when asked) every cache the
 * host runs for this environment that is neither listed nor named. The second
 * kind keeps its data and says so.
 */
function removalsFor(
  index: readonly CacheIndexEntry[],
  caches: readonly EnvironmentDeployCache[],
  opts: { removed?: readonly CacheApplyRemoval[]; pruneUnlisted: boolean },
  warnings: string[],
): Removal[] {
  const named: Removal[] = [...(opts.removed ?? [])];
  if (!opts.pruneUnlisted) return named;
  const keep = new Set([...caches, ...named].map((c) => c.id));
  for (const entry of index) {
    if (keep.has(entry.id)) continue;
    warnings.push(
      `cache ${entry.id} is no longer in this environment; its data stayed on this server`,
    );
    named.push({ id: entry.id, username: entry.username, deleteData: false });
  }
  return named;
}

/** Reload systemd and rebuild the account walls after units went; trouble here is a warning. */
async function settleAfterRemoval(io: CacheIo, warnings: string[]) {
  await mustSystemctl(io, ["daemon-reload"], "reloading systemd").catch(
    (err) => warnings.push(describe(err, "systemd was not reloaded")),
  );
  await syncAccountWalls(io.run).catch((err) =>
    warnings.push(describe(err, "the account walls were not reloaded"))
  );
}

/** The listed caches: runtime, slices, files, units, walls, start. */
async function applyListed(
  io: CacheIo,
  steps: Step[],
  index: readonly CacheIndexEntry[],
): Promise<Installed[]> {
  const runnable = steps.filter((s) => !s.result).map((s) => s.cache);
  if (runnable.length === 0) return [];
  let installed: Installed[] = [];
  try {
    await ensureRuntimes(io, runnable);
    const sliceChanged = await installSlices(io, runnable);
    installed = await installAll(io, steps, index);
    if (sliceChanged || installed.some((i) => i.changed)) {
      await mustSystemctl(io, ["daemon-reload"], "reloading systemd");
    }
    // Guard a port before anything can listen on it.
    if (installed.some((i) => i.cache.port !== undefined)) {
      await syncAccountWalls(io.run);
    }
    await startAll(io, steps, installed);
  } catch (err) {
    for (const step of steps) step.result ??= failed(step.cache, err);
  }
  return installed;
}

/**
 * Apply `caches` (the complete set of this environment on this host) and
 * `removed`. With `pruneUnlisted`, a cache the host runs for this environment
 * that is not listed loses its unit and config, with a warning that its data
 * stayed.
 */
export async function applyEnvironmentCaches(
  io: CacheIo,
  environmentId: string,
  caches: readonly EnvironmentDeployCache[],
  opts: { removed?: readonly CacheApplyRemoval[]; pruneUnlisted: boolean },
): Promise<CacheApplyOutcome> {
  const warnings: string[] = [];
  const index = await readCacheIndex(io.layout, environmentId);
  const steps = await classify(io, caches);
  const installed = await applyListed(io, steps, index);

  const gone = removalsFor(index, caches, opts, warnings);
  const removedIds = await removeEach(io, gone, warnings);
  if (gone.length > 0) await settleAfterRemoval(io, warnings);

  // A failed removal, or a listed cache that failed before its files were
  // written, keeps the entry it had, so the next apply starts from the truth.
  const done = new Set(installed.map((i) => i.cache.id));
  const entries: CacheIndexEntry[] = [
    ...installed.map((i) => ({
      id: i.cache.id,
      username: i.cache.username,
      configSha256: i.configSha256,
    })),
    ...index.filter((e) => !removedIds.has(e.id) && !done.has(e.id)),
  ];
  await writeCacheIndex(io.layout, environmentId, entries).catch((err) =>
    logWarn("cache", `host index not written: ${describe(err, "write failed")}`)
  );
  return {
    results: steps.map((s) =>
      s.result ?? failed(s.cache, new Error("the cache was not applied"))
    ),
    warnings,
  };
}

/**
 * Remove every cache the host index lists for an environment (a destroy), then
 * the index. Data goes only with `deleteData`. Failures are warnings: the
 * destroy goes on and the index keeps what is left.
 */
export async function removeEnvironmentCaches(
  io: CacheIo,
  environmentId: string,
  deleteData: boolean,
): Promise<string[]> {
  const index = await readCacheIndex(io.layout, environmentId);
  if (index.length === 0) return [];
  const warnings: string[] = [];
  const removed = await removeEach(
    io,
    index.map((e) => ({ ...e, deleteData })),
    warnings,
  );
  await settleAfterRemoval(io, warnings);
  await writeCacheIndex(
    io.layout,
    environmentId,
    index.filter((e) => !removed.has(e.id)),
  );
  return warnings;
}
