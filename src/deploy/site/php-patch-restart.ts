/**
 * Restart each site's PHP after a PHP package update, in order, with a check.
 *
 * PHP packages update on their own, daily (the PHP package archive is one of
 * the automatic update origins). A package update replaces the binaries, but a
 * running per-site runtime keeps the old build in memory until it restarts. So
 * the daemon notices a changed binary, waits until the package run is over, and
 * then restarts what runs the old build: each site's runtime, one at a time,
 * with a probe before and after; then the sites' workers; then the shared
 * master. The first site that answered before its restart and does not answer
 * after it stops the whole pass: the rest keep running the old build until the
 * next pass, so one bad site never takes the others down with it.
 *
 * What a restart needs to know about a runtime (its probe address, its site)
 * is kept in a small record the runtime apply writes:
 * `<state>/sites/.php-runtimes/<id>.json`.
 */

import { join } from "node:path";
import { environmentLockKey, withKeyedLock } from "../../util/keyed-lock.ts";
import { logInfo, logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { writePrivateFileAtomic } from "../../permissions/host-unit-files.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { RunFn } from "../ensure-principal.ts";
import { runHostCommand, systemctl } from "../systemd-unit-set.ts";
import {
  type PhpPatchRestartError,
  setPhpPatchSnapshot,
} from "../../host/php-patch-cache.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import { holdPruneKeys, phpSeriesHoldKey } from "./prune-holds.ts";
import { validateSiteEndpoints } from "./engine-driver.ts";
import { sitePhpServiceName } from "./php-runtime.ts";
import {
  type InstalledWorker,
  listInstalledWorkers,
  restartInstalledWorkers,
} from "./workers.ts";

/** What a restart needs to know about one per-site runtime. */
export type PhpRuntimeRecord = {
  id: string;
  series: string;
  mode: string;
  environmentId: string;
  composeServiceName: string;
  probeUrl: string;
  /** The installed patch version when last seen (`8.4.27`). */
  version?: string;
};

const SERIES_RE = /^\d{1,3}\.\d{1,3}$/;
const RECORD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENVIRONMENT_ID_RE = /^[A-Za-z0-9_-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** A package change is settled after this long without a package run. */
export const PHP_PATCH_SETTLE_MS = 120_000;
/** How often the daemon looks at the binaries' change times. */
export const PHP_PATCH_CHECK_INTERVAL_MS = 10 * 60_000;
/** At most this many sites in the inventory. */
export const PHP_PATCH_SITE_CAP = 256;

export function phpRuntimeRecordsDir(
  layout: Pick<LayoutPaths, "stateDir">,
): string {
  return join(layout.stateDir, "sites", ".php-runtimes");
}

function isRecord(value: unknown): value is PhpRuntimeRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && RECORD_ID_RE.test(r.id) &&
    typeof r.series === "string" && SERIES_RE.test(r.series) &&
    typeof r.mode === "string" &&
    typeof r.environmentId === "string" &&
    ENVIRONMENT_ID_RE.test(r.environmentId) &&
    typeof r.composeServiceName === "string" &&
    r.composeServiceName.length > 0 &&
    typeof r.probeUrl === "string" &&
    r.probeUrl.startsWith("http://127.0.0.1:") &&
    (r.version === undefined ||
      (typeof r.version === "string" && VERSION_RE.test(r.version)));
}

/** Write (or replace) a runtime's record. */
export async function writePhpRuntimeRecord(
  layout: Pick<LayoutPaths, "stateDir">,
  record: PhpRuntimeRecord,
): Promise<void> {
  const dir = phpRuntimeRecordsDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivateFileAtomic(
    dir,
    `${record.id}.json`,
    `${JSON.stringify(record)}\n`,
  );
}

/** Remove runtimes' records; a missing one is fine. */
export async function removePhpRuntimeRecords(
  layout: Pick<LayoutPaths, "stateDir">,
  ids: readonly string[],
): Promise<void> {
  const dir = phpRuntimeRecordsDir(layout);
  await forEachSequential(ids, async (id) => {
    if (!RECORD_ID_RE.test(id)) return;
    await Deno.remove(join(dir, `${id}.json`)).catch((err) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
  });
}

/** Every record, sorted by id. Unreadable or malformed files are skipped. */
export async function readPhpRuntimeRecords(
  layout: Pick<LayoutPaths, "stateDir">,
): Promise<PhpRuntimeRecord[]> {
  const dir = phpRuntimeRecordsDir(layout);
  const records: PhpRuntimeRecord[] = [];
  let names: string[];
  try {
    names = (await Array.fromAsync(Deno.readDir(dir)))
      .filter((entry) => entry.isFile && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  await forEachSequential(
    names.toSorted((a, b) => a.localeCompare(b)),
    async (name) => {
      try {
        const parsed: unknown = JSON.parse(
          await Deno.readTextFile(join(dir, name)),
        );
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // A broken record is ignored; the next apply writes it again.
      }
    },
  );
  return records.toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * Installed PHP patch versions from dpkg's status file: for each
 * `php<series>-cli` that is installed, `{ "<series>": "<upstream version>" }`.
 * The upstream version has no epoch and no package revision
 * (`1:8.4.27-1+0~2025+debian13~1.gbp1a2b3c` gives `8.4.27`).
 */
export function readPhpPackageVersions(
  statusText: string,
): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const stanza of statusText.split(/\n\s*\n/)) {
    const field = (name: string): string | undefined =>
      new RegExp(`^${name}: (.+)$`, "m").exec(stanza)?.[1]?.trim();
    const series = /^php(\d{1,3}\.\d{1,3})-cli$/.exec(field("Package") ?? "")
      ?.[1];
    if (series === undefined) continue;
    if ((field("Status") ?? "") !== "install ok installed") continue;
    const raw = field("Version");
    if (raw === undefined) continue;
    const upstream = raw.replace(/^\d+:/, "").split("-")[0] ?? "";
    if (VERSION_RE.test(upstream)) versions[series] = upstream;
  }
  return versions;
}

/** The binaries whose change time says a series was updated. */
export function phpSeriesBinaries(series: string): string[] {
  return [
    `/usr/bin/php-cgi${series}`,
    `/usr/sbin/php-fpm${series}`,
    `/usr/bin/php${series}`,
  ];
}

/**
 * The newest `ctime` of a series' binaries, in milliseconds, or `null` when
 * none exists. `ctime`, never `mtime`: packages keep the build time in `mtime`.
 */
export async function phpSeriesChangeTime(
  series: string,
  stat: (path: string) => Promise<Deno.FileInfo> = Deno.stat,
): Promise<number | null> {
  let newest: number | null = null;
  await forEachSequential(phpSeriesBinaries(series), async (path) => {
    try {
      const ctime = (await stat(path)).ctime?.getTime();
      if (ctime !== undefined && (newest === null || ctime > newest)) {
        newest = ctime;
      }
    } catch {
      // A binary a series does not ship (or has not got yet) is skipped.
    }
  });
  return newest;
}

/** The two properties of a unit that say when it started. */
export type UnitStart = { active: boolean; startedAtMs: number | null };

/** Parse `systemctl show --property=ActiveState,ActiveEnterTimestamp --timestamp=unix`. */
export function parseUnitStart(text: string): UnitStart {
  const state = /^ActiveState=(.*)$/m.exec(text)?.[1]?.trim();
  const entered = /^ActiveEnterTimestamp=@(\d+)$/m.exec(text)?.[1];
  return {
    active: state === "active",
    startedAtMs: entered === undefined ? null : Number(entered) * 1000,
  };
}

/** A unit runs the old build when it is active and started before the change. */
export function isStale(start: UnitStart, changeTimeMs: number): boolean {
  return start.active && start.startedAtMs !== null &&
    start.startedAtMs < changeTimeMs;
}

/** What the pass needs from the host, replaceable in tests. */
export type PhpPatchIo = {
  layout: Pick<LayoutPaths, "stateDir">;
  /** `sudo -n …` through tp-host. */
  run: RunFn;
  /** A read-only host command (no sudo): `systemctl show`. */
  runPlain: RunFn;
  readStatus: () => Promise<string>;
  changeTime: (series: string) => Promise<number | null>;
  /** True when no package run is under way. */
  packageRunIdle: () => Promise<boolean>;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a site answers (throws when it does not). */
  probe: (series: string, label: string, url: string) => Promise<void>;
  systemdUnitDir?: string;
};

let running = false;
const failedMarks = new Map<string, number>();
const lastChange = new Map<string, number>();
let lastError: PhpPatchRestartError | undefined;
/** Set when a pass left work for the next one (a stop, or a package run not over). */
let resumePending = false;

/** Forget what was learned (tests). */
export function resetPhpPatchState(): void {
  setPhpPatchSnapshot({ versions: {}, sites: [] });
  running = false;
  failedMarks.clear();
  lastChange.clear();
  lastError = undefined;
  resumePending = false;
}

/** A deploy of a site clears its failed mark. */
export function clearPhpPatchFailure(id: string): void {
  failedMarks.delete(id);
}

async function unitStart(io: PhpPatchIo, unit: string): Promise<UnitStart> {
  const result = await io.runPlain("systemctl", [
    "show",
    "--property=ActiveState,ActiveEnterTimestamp",
    "--timestamp=unix",
    unit,
  ]);
  return result.success
    ? parseUnitStart(result.stdout)
    : { active: false, startedAtMs: null };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : Deno.inspect(err);
}

async function answered(
  io: PhpPatchIo,
  record: PhpRuntimeRecord,
): Promise<boolean> {
  try {
    await io.probe(record.series, record.composeServiceName, record.probeUrl);
    return true;
  } catch {
    return false;
  }
}

export type PhpPatchPassResult = {
  /** Runtimes restarted, in order. */
  restarted: string[];
  /** Set when the pass stopped on a site that stopped answering. */
  stoppedAt?: string;
  /** Series skipped because a package run was not over. */
  waiting: string[];
};

/**
 * One pass over every installed series. A second request while one runs is
 * skipped (returns `undefined`).
 */
export async function runPhpPatchPass(
  io: PhpPatchIo,
): Promise<PhpPatchPassResult | undefined> {
  if (running) return undefined;
  running = true;
  try {
    return await passBody(io);
  } finally {
    running = false;
  }
}

async function passBody(io: PhpPatchIo): Promise<PhpPatchPassResult> {
  const result: PhpPatchPassResult = { restarted: [], waiting: [] };
  resumePending = false;
  const versions = readPhpPackageVersions(await io.readStatus());
  const records = await readPhpRuntimeRecords(io.layout);
  const outdated = new Set<string>();
  let stopped = false;

  await forEachSequential(
    Object.keys(versions).toSorted((a, b) => a.localeCompare(b)),
    async (series) => {
      if (stopped) return;
      const changeMs = await io.changeTime(series);
      if (changeMs === null) return;
      lastChange.set(series, changeMs);
      const mine = records.filter((record) => record.series === series);
      const stale: PhpRuntimeRecord[] = [];
      const staleWorkers: Array<
        { record: PhpRuntimeRecord; workers: InstalledWorker[] }
      > = [];
      await forEachSequential(mine, async (record) => {
        const start = await unitStart(io, sitePhpServiceName(record.id));
        if (isStale(start, changeMs)) outdated.add(record.id);
        if (failedMarks.get(record.id) === changeMs) return;
        if (isStale(start, changeMs)) stale.push(record);
        const workers = await staleWorkersOf(io, record, changeMs);
        if (workers.length > 0) staleWorkers.push({ record, workers });
      });
      const master = `turbopanel-php-fpm@${series}.service`;
      const masterStale = isStale(await unitStart(io, master), changeMs);
      if (stale.length === 0 && staleWorkers.length === 0 && !masterStale) {
        return;
      }
      // Wait out the package run: a pass during it would restart onto a
      // half-installed build.
      const settled = io.now() - changeMs >= PHP_PATCH_SETTLE_MS &&
        await io.packageRunIdle();
      if (!settled) {
        result.waiting.push(series);
        resumePending = true;
        return;
      }
      const release = await holdPruneKeys([phpSeriesHoldKey(series)]);
      try {
        const outcome = await restartRuntimes(io, series, changeMs, stale);
        result.restarted.push(...outcome.restarted);
        for (const id of outcome.restarted) outdated.delete(id);
        if (outcome.error !== undefined) {
          lastError = outcome.error;
          result.stoppedAt = outcome.stoppedAt;
          resumePending = true;
          stopped = true;
          return;
        }
        await restartWorkers(io, staleWorkers);
        if (masterStale) {
          const restart = await systemctl(io.run, ["restart", master]);
          if (!restart.success) {
            logWarn("deploy", `${master} did not restart: ${restart.stderr}`);
          }
        }
      } finally {
        release();
      }
    },
  );

  await refreshSnapshot(io, versions, records, outdated);
  return result;
}

async function restartRuntimes(
  io: PhpPatchIo,
  series: string,
  changeMs: number,
  stale: readonly PhpRuntimeRecord[],
): Promise<
  {
    restarted: string[];
    error?: PhpPatchRestartError;
    stoppedAt?: string;
  }
> {
  const restarted: string[] = [];
  let failure: { error: PhpPatchRestartError; stoppedAt: string } | undefined;
  await forEachSequential(stale, async (record) => {
    if (failure !== undefined) return;
    await withKeyedLock(environmentLockKey(record.environmentId), async () => {
      const before = await answered(io, record);
      const restart = await systemctl(io.run, [
        "restart",
        sitePhpServiceName(record.id),
      ]);
      const after = restart.success && await answered(io, record);
      if (before && !after) {
        failedMarks.set(record.id, changeMs);
        const message =
          `${record.composeServiceName} answered before its PHP ${series} restart and did not after it${
            restart.success ? "" : `: ${restart.stderr || "restart failed"}`
          }`;
        logWarn("deploy", `PHP patch restart stopped: ${message}`);
        failure = {
          stoppedAt: record.id,
          error: {
            series,
            environmentId: record.environmentId,
            composeServiceName: record.composeServiceName,
            message,
            at: new Date(io.now()).toISOString(),
          },
        };
        return;
      }
      if (!before) {
        logInfo(
          "deploy",
          `${record.composeServiceName} was not answering before the PHP ${series} restart`,
        );
      }
      restarted.push(record.id);
    });
  });
  return failure === undefined ? { restarted } : { restarted, ...failure };
}

function workerIoOf(io: PhpPatchIo) {
  return {
    run: io.run,
    onLine: (_stream: "stdout" | "stderr", line: string) =>
      logInfo("deploy", line),
    ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
    systemdUnitDir: io.systemdUnitDir ?? SYSTEMD_UNIT_DIR,
  };
}

/** The site's workers that started before the change. */
async function staleWorkersOf(
  io: PhpPatchIo,
  record: PhpRuntimeRecord,
  changeMs: number,
): Promise<InstalledWorker[]> {
  const installed = await listInstalledWorkers(
    workerIoOf(io),
    record.environmentId,
    record.composeServiceName,
  );
  const stale: InstalledWorker[] = [];
  await forEachSequential(installed, async (worker) => {
    const start = await unitStart(io, `${worker.base}@1.service`);
    if (isStale(start, changeMs)) stale.push(worker);
  });
  return stale;
}

/** Restart the stale workers, one site at a time under its environment's lock, gracefully. */
async function restartWorkers(
  io: PhpPatchIo,
  groups: ReadonlyArray<
    { record: PhpRuntimeRecord; workers: InstalledWorker[] }
  >,
): Promise<void> {
  await forEachSequential(groups, async ({ record, workers }) => {
    await withKeyedLock(environmentLockKey(record.environmentId), async () => {
      const failed = await restartInstalledWorkers(workerIoOf(io), workers);
      for (const label of failed) {
        logWarn(
          "deploy",
          `worker ${label} did not stay running after the PHP restart`,
        );
      }
    });
  });
}

async function refreshSnapshot(
  io: PhpPatchIo,
  versions: Record<string, string>,
  records: readonly PhpRuntimeRecord[],
  outdated: ReadonlySet<string>,
): Promise<void> {
  // A failed mark belongs to one package change; a newer change retries.
  for (const record of records) {
    const mark = failedMarks.get(record.id);
    if (mark !== undefined && mark !== lastChange.get(record.series)) {
      failedMarks.delete(record.id);
    }
  }
  // A runtime that is not behind a package change runs the installed version.
  await forEachSequential(records, async (record) => {
    const current = versions[record.series];
    if (
      current !== undefined && !outdated.has(record.id) &&
      record.version !== current
    ) {
      record.version = current;
      await writePhpRuntimeRecord(io.layout, record).catch((err) =>
        logWarn("deploy", `PHP runtime record not updated: ${describe(err)}`)
      );
    }
  });
  const sites = records.slice(0, PHP_PATCH_SITE_CAP).map((record) => ({
    environmentId: record.environmentId,
    composeServiceName: record.composeServiceName,
    series: record.series,
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(outdated.has(record.id) ? { outdated: true as const } : {}),
  })).sort((a, b) =>
    `${a.environmentId}/${a.composeServiceName}`.localeCompare(
      `${b.environmentId}/${b.composeServiceName}`,
    )
  );
  // The error stays on the server page until every failed site is cleared
  // (a deploy of it, or a newer package change).
  const restartError = failedMarks.size > 0 ? lastError : undefined;
  if (restartError === undefined) lastError = undefined;
  setPhpPatchSnapshot({
    versions,
    sites,
    ...(restartError === undefined ? {} : { restartError }),
  });
}

/** The host seams, for the daemon. */
export function hostPhpPatchIo(
  layout: Pick<LayoutPaths, "stateDir">,
): PhpPatchIo {
  return {
    layout,
    run: runHostCommand,
    runPlain: runHostCommand,
    readStatus: () => Deno.readTextFile("/var/lib/dpkg/status"),
    changeTime: (series) => phpSeriesChangeTime(series),
    packageRunIdle: async () => {
      try {
        for await (const _entry of Deno.readDir("/var/lib/dpkg/updates")) {
          return false;
        }
        return true;
      } catch {
        return true;
      }
    },
    now: () => Date.now(),
    probe: (series, label, url) =>
      validateSiteEndpoints(runHostCommand, `PHP ${series} patch restart`, [{
        label,
        url,
      }]),
  };
}

/** The timer, the clock and the pass are injected so a test never waits. */
export type PhpPatchSchedule = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
};

const realSchedule: PhpPatchSchedule = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // The watch never keeps the process alive.
    Deno.unrefTimer(handle);
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as number),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};

/**
 * Run a pass in the background, never throwing: the daemon's boot, a deploy
 * that applied a PHP site, and the interval all use this.
 */
export function requestPhpPatchPass(
  io: PhpPatchIo,
  schedule: Pick<PhpPatchSchedule, "setTimeout"> = realSchedule,
): void {
  schedule.setTimeout(() => {
    runPhpPatchPass(io).catch((err) =>
      logWarn("deploy", `PHP patch pass failed: ${describe(err)}`)
    );
  }, 0);
}

/**
 * Every ten minutes, look only at the binaries' change times (no `systemctl`
 * calls when nothing changed) and start a pass when a series moved since the
 * last one. Returns a function that stops the timer.
 */
export function armPhpPatchWatch(
  io: PhpPatchIo,
  schedule: PhpPatchSchedule = realSchedule,
): () => void {
  const tick = async () => {
    const series = Object.keys(readPhpPackageVersions(await io.readStatus()));
    let moved = false;
    await forEachSequential(series, async (name) => {
      const changeMs = await io.changeTime(name);
      if (changeMs !== null && changeMs !== lastChange.get(name)) moved = true;
    });
    if (moved || resumePending) await runPhpPatchPass(io);
  };
  const handle = schedule.setInterval(() => {
    tick().catch((err) =>
      logWarn("deploy", `PHP patch watch failed: ${describe(err)}`)
    );
  }, PHP_PATCH_CHECK_INTERVAL_MS);
  return () => schedule.clearInterval(handle);
}

let armedIo: PhpPatchIo | undefined;
let armedStop: (() => void) | undefined;

/**
 * Arm the daemon's own patch restarts: a background pass now (the boot), the
 * ten-minute watch, and the passes after deploys. Called once from the daemon's
 * start; a second call is ignored. Nothing else arms it, so a test that runs a
 * deploy never reaches the host.
 */
export function armPhpPatchRestarts(
  layout: Pick<LayoutPaths, "stateDir">,
  io: PhpPatchIo = hostPhpPatchIo(layout),
  schedule: PhpPatchSchedule = realSchedule,
): void {
  if (armedIo !== undefined) return;
  armedIo = io;
  armedStop = armPhpPatchWatch(io, schedule);
  requestPhpPatchPass(io, schedule);
}

/** Stop the watch and forget the armed seams (tests). */
export function disarmPhpPatchRestarts(): void {
  armedStop?.();
  armedStop = undefined;
  armedIo = undefined;
}

/**
 * After a deploy that applied a PHP site: a pass in the background, never
 * awaited, never run while the deploy still holds its environment's lock (the
 * pass takes that lock itself and waits behind it). Does nothing unless armed.
 */
export function requestPhpPatchPassAfterDeploy(
  schedule: Pick<PhpPatchSchedule, "setTimeout"> = realSchedule,
): void {
  if (armedIo === undefined) return;
  requestPhpPatchPass(armedIo, schedule);
}
