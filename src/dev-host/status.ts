/**
 * Build the development host status (`DevHostStatus`).
 *
 * Speed doctrine: per tick one `systemctl show` for all units, a `git fetch`
 * per checkout at most every 10 minutes, file reads for HEAD and
 * `origin/trunk`, one `git rev-list --count` only when either moved, one
 * `git status` (plus `git diff --numstat` when a tracked file is modified)
 * and a few `stat` calls. The newest-source check walks `src/` in process and
 * stops at the first newer file; once a restart is known to be needed it is
 * not walked again until the unit restarts.
 */
import { join } from "@std/path";
import {
  type DevHostDirty,
  type DevHostJob,
  type DevHostPart,
  type DevHostStatus,
  MAX_DEV_HOST_NAME_CHARS,
  MAX_DEV_HOST_TEXT_CHARS,
} from "../contracts/cell-messages.ts";
import { clipText, type RunCommand } from "./commands.ts";
import {
  type DevHostPartName,
  type DevHostPartSpec,
  type DevHostPaths,
  partCheckout,
} from "./config.ts";
import { CLEAN, readDirty } from "./dirty.ts";
import {
  countBehind,
  fetchTrunk,
  headCommitAt,
  readHead,
  readRef,
  REMOTE_TRUNK_REF,
  statHeadReflog,
  TRUNK,
} from "./git.ts";
import { readUnits, type UnitState } from "./units.ts";
import { firstSequential } from "../util/sequential.ts";

/** A checkout is fetched at most this often by the status tick. */
export const FETCH_INTERVAL_MS = 10 * 60_000;

export type StatusDeps = {
  paths: Pick<DevHostPaths, "devRoot">;
  parts: readonly DevHostPartSpec[];
  run: RunCommand;
  /** Extra git variables (tests isolate git from the user's config). */
  gitEnv?: Record<string, string>;
  nowMs?: () => number;
  /** The commit this daemon process was started from. */
  daemonCommit: string | null;
  /** The control plane's commit from the attach frame, when it is a real sha. */
  controlPlaneCommit?: () => string | null;
  /** Modification time in ms, or null when the file is missing. */
  mtimeMs?: (path: string) => Promise<number | null>;
  /** True when any file under `dir` is newer than `sinceMs`. */
  anyNewer?: (dir: string, sinceMs: number) => Promise<boolean>;
};

type PartMemo = {
  lastFetchMs: number | null;
  behindKey: string | null;
  behindBy: number;
  /** A refused fast-forward, kept while HEAD and the remote ref stay put. */
  blocked: { reason: string; key: string } | null;
  /** Restart already known to be needed for this unit start. */
  restartForStart: number | null;
  /** The commit the unit started on, from the HEAD reflog, per start and reflog state. */
  startedOn: { key: string; commit: string | null } | null;
};

const SHA_RE = /^[0-9a-f]{40}$/;

export class DevHostStatusCollector {
  readonly #deps: StatusDeps;
  readonly #memo = new Map<DevHostPartName, PartMemo>();
  #lastFetchAt: string | null = null;
  #forceFetch = false;

  constructor(deps: StatusDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.nowMs ?? Date.now)();
  }

  #memoFor(name: DevHostPartName): PartMemo {
    let memo = this.#memo.get(name);
    if (!memo) {
      memo = {
        lastFetchMs: null,
        behindKey: null,
        behindBy: 0,
        blocked: null,
        restartForStart: null,
        startedOn: null,
      };
      this.#memo.set(name, memo);
    }
    return memo;
  }

  /** The next collect fetches every checkout. */
  requestFetch(): void {
    this.#forceFetch = true;
  }

  /** A job fetched this checkout just now. */
  noteFetched(name: DevHostPartName): void {
    this.#memoFor(name).lastFetchMs = this.#now();
    this.#lastFetchAt = new Date(this.#now()).toISOString();
  }

  /** A job's fast-forward was refused; shown until HEAD or the remote ref moves. */
  async noteBlocked(spec: DevHostPartSpec, reason: string): Promise<void> {
    const repo = partCheckout(this.#deps.paths, spec);
    this.#memoFor(spec.name).blocked = {
      reason: clipText(reason, MAX_DEV_HOST_TEXT_CHARS),
      key: await this.#refsKey(repo),
    };
  }

  async #refsKey(repo: string): Promise<string> {
    const head = await readHead(repo);
    const remote = await readRef(repo, REMOTE_TRUNK_REF);
    return `${head?.commit ?? "-"}..${remote ?? "-"}`;
  }

  /** Build the full status; `job` is passed through as it is. */
  async collect(job: DevHostJob | null): Promise<DevHostStatus> {
    const fetchAll = this.#forceFetch;
    this.#forceFetch = false;
    const units = await readUnits(
      this.#deps.run,
      this.#deps.parts.map((p) => p.unit),
    );
    const parts = await Promise.all(
      this.#deps.parts.map((spec) =>
        this.#collectPart(spec, units.get(spec.unit), fetchAll)
      ),
    );
    return { parts, lastFetchAt: this.#lastFetchAt, job };
  }

  /**
   * Whether one part needs a restart now, from file reads and one
   * `systemctl show` only (no git command): used by the job's restart steps.
   */
  async restartNeeded(spec: DevHostPartSpec): Promise<boolean> {
    const repo = partCheckout(this.#deps.paths, spec);
    const head = await readHead(repo);
    if (!head) return false;
    const units = await readUnits(this.#deps.run, [spec.unit]);
    const unit = units.get(spec.unit);
    const memo = this.#memoFor(spec.name);
    return await this.#restartNeeded(
      spec,
      repo,
      head.commit,
      await this.#runningCommit(spec.name, repo, unit, memo),
      unit,
      memo,
    );
  }

  async #collectPart(
    spec: DevHostPartSpec,
    unit: UnitState | undefined,
    fetchAll: boolean,
  ): Promise<DevHostPart> {
    const repo = partCheckout(this.#deps.paths, spec);
    const memo = this.#memoFor(spec.name);
    const head = await readHead(repo);
    const base = {
      name: spec.name,
      unit: clipText(spec.unit, MAX_DEV_HOST_NAME_CHARS),
      active: unit?.active ?? false,
    };
    if (!head) {
      return {
        ...base,
        branch: "",
        onTrunk: false,
        headCommit: "",
        runningCommit: this.#reportedCommit(spec.name),
        behindBy: 0,
        dirty: CLEAN,
        restartNeeded: false,
        setupNeeded: {},
        blockedReason: "checkout missing",
      };
    }
    await this.#maybeFetch(spec, repo, memo, fetchAll);
    const remote = await readRef(repo, REMOTE_TRUNK_REF);
    const behindBy = await this.#behind(repo, head.commit, remote, memo);
    const { dirty, error } = await readDirty(
      this.#deps.run,
      repo,
      spec.repo,
      this.#deps.gitEnv,
    );
    const runningCommit = await this.#runningCommit(
      spec.name,
      repo,
      unit,
      memo,
    );
    const onTrunk = head.branch === TRUNK;
    const part: DevHostPart = {
      ...base,
      branch: clipText(head.branch ?? "", MAX_DEV_HOST_NAME_CHARS),
      onTrunk,
      headCommit: head.commit ?? "",
      runningCommit,
      behindBy,
      dirty,
      restartNeeded: await this.#restartNeeded(
        spec,
        repo,
        head.commit,
        runningCommit,
        unit,
        memo,
      ),
      setupNeeded: await this.#setupNeeded(spec, repo),
    };
    const reason = blockedReasonFor(
      head,
      behindBy,
      dirty,
      error,
      memo.blocked,
      `${head.commit ?? "-"}..${remote ?? "-"}`,
    );
    if (reason) part.blockedReason = clipText(reason, MAX_DEV_HOST_TEXT_CHARS);
    return part;
  }

  /** The commit the process itself reports (daemon, control plane), else null. */
  #reportedCommit(name: DevHostPartName): string | null {
    let commit: string | null = null;
    if (name === "daemon") commit = this.#deps.daemonCommit;
    if (name === "control-plane") {
      commit = this.#deps.controlPlaneCommit?.() ?? null;
    }
    return commit && SHA_RE.test(commit) ? commit : null;
  }

  /**
   * The commit the unit runs: what the process reports, else what HEAD was
   * when the unit started (its HEAD reflog). The web interface and website
   * report nothing, so this is how a pull after their start shows as a
   * restart. Read again only when the unit restarts or the reflog changes.
   */
  async #runningCommit(
    name: DevHostPartName,
    repo: string,
    unit: UnitState | undefined,
    memo: PartMemo,
  ): Promise<string | null> {
    const reported = this.#reportedCommit(name);
    if (reported) return reported;
    const startedAtMs = unit?.startedAtMs ?? null;
    if (startedAtMs === null) return null;
    const reflog = await statHeadReflog(repo);
    if (!reflog) return null;
    const key = `${startedAtMs}|${reflog.key}`;
    if (memo.startedOn?.key !== key) {
      memo.startedOn = {
        key,
        commit: await headCommitAt(reflog.path, startedAtMs),
      };
    }
    return memo.startedOn.commit;
  }

  async #maybeFetch(
    spec: DevHostPartSpec,
    repo: string,
    memo: PartMemo,
    fetchAll: boolean,
  ): Promise<void> {
    const now = this.#now();
    const due = fetchAll || memo.lastFetchMs === null ||
      now - memo.lastFetchMs >= FETCH_INTERVAL_MS;
    if (!due) return;
    // Counted as tried even on failure, so an offline host does not fork git
    // every tick.
    memo.lastFetchMs = now;
    const result = await fetchTrunk(this.#deps.run, repo, this.#deps.gitEnv);
    if (result.code === 0) this.noteFetched(spec.name);
  }

  async #behind(
    repo: string,
    head: string | null,
    remote: string | null,
    memo: PartMemo,
  ): Promise<number> {
    if (!head || !remote) return 0;
    if (head === remote) {
      memo.behindKey = `${head}..${remote}`;
      memo.behindBy = 0;
      return 0;
    }
    const key = `${head}..${remote}`;
    if (memo.behindKey === key) return memo.behindBy;
    const count = await countBehind(this.#deps.run, repo, this.#deps.gitEnv);
    memo.behindKey = count === null ? null : key;
    memo.behindBy = count ?? 0;
    return memo.behindBy;
  }

  async #restartNeeded(
    spec: DevHostPartSpec,
    repo: string,
    headCommit: string | null,
    runningCommit: string | null,
    unit: UnitState | undefined,
    memo: PartMemo,
  ): Promise<boolean> {
    if (runningCommit && headCommit && runningCommit !== headCommit) {
      return true;
    }
    const startedAtMs = unit?.startedAtMs ?? null;
    if (startedAtMs === null) return false;
    if (memo.restartForStart === startedAtMs) return true;
    const mtime = this.#deps.mtimeMs ?? mtimeOrNull;
    const changed = await Promise.all(
      spec.restartFiles.map((file) => mtime(join(repo, file))),
    );
    if (changed.some((t) => t !== null && t > startedAtMs)) {
      memo.restartForStart = startedAtMs;
      return true;
    }
    if (spec.reload === "source") {
      const anyNewer = this.#deps.anyNewer ?? anyFileNewer;
      if (await anyNewer(join(repo, "src"), startedAtMs)) {
        memo.restartForStart = startedAtMs;
        return true;
      }
    }
    return false;
  }

  async #setupNeeded(
    spec: DevHostPartSpec,
    repo: string,
  ): Promise<DevHostPart["setupNeeded"]> {
    if (!spec.installs) return {};
    return { install: await installNeeded(repo, this.#deps.mtimeMs) };
  }
}

/** The lockfile is newer than the installed packages (or none are installed). */
export async function installNeeded(
  repo: string,
  mtimeMs: (path: string) => Promise<number | null> = mtimeOrNull,
): Promise<boolean> {
  const lock = await mtimeMs(join(repo, "pnpm-lock.yaml"));
  if (lock === null) return false;
  const installed = await mtimeMs(
    join(repo, "node_modules", ".pnpm", "lock.yaml"),
  );
  return installed === null || lock > installed;
}

/** The most changed paths a reason names before "and N more". */
export const REASON_PATHS = 3;

/** "a.ts, b.ts and 2 more" for the changes that block a pull. */
function changedFilesText(dirty: DevHostDirty): string {
  const paths = dirty.kinds.filter((k) => k.kind === "content").map((k) =>
    k.path
  );
  if (paths.length === 0) return "local changes";
  const shown = paths.slice(0, REASON_PATHS).join(", ");
  // `kinds` is capped with blocking entries first: every blocking path is in
  // it unless it holds nothing else and is shorter than `files`.
  const complete = paths.length < dirty.kinds.length ||
    dirty.kinds.length >= dirty.files;
  const more = paths.length - REASON_PATHS;
  let tail = "";
  if (!complete) tail = " and more";
  else if (more > 0) tail = ` and ${more} more`;
  return `local changes in ${shown}${tail}`;
}

/**
 * Why a part is not pulled, in the exact words the bar shows: "detached at
 * 4f7b5ed, 19 behind trunk; not pulled", "on branch fix/x, not trunk; not
 * pulled", "local changes in .gitconfig; not pulled", or git's own line for a
 * refused fast-forward.
 */
export function blockedReasonFor(
  head: { branch: string | null; commit: string | null },
  behindBy: number,
  dirty: DevHostDirty,
  dirtyError: string | undefined,
  blocked: { reason: string; key: string } | null,
  refsKey: string,
): string | null {
  const behind = behindBy > 0 ? `, ${behindBy} behind trunk` : "";
  if (head.branch !== TRUNK) {
    const where = head.branch
      ? `on branch ${head.branch}, not trunk`
      : `detached at ${(head.commit ?? "unknown").slice(0, 7)}`;
    return `${where}${behind}; not pulled`;
  }
  if (dirtyError) return `${dirtyError}; not pulled`;
  if (dirty.blocking) return `${changedFilesText(dirty)}${behind}; not pulled`;
  if (blocked?.key === refsKey) return blocked.reason;
  return null;
}

export async function mtimeOrNull(path: string): Promise<number | null> {
  try {
    return (await Deno.stat(path)).mtime?.getTime() ?? null;
  } catch {
    return null;
  }
}

/**
 * True when any regular file under `dir` was modified after `sinceMs`. Skips
 * `node_modules` and dot folders; stops at the first newer file.
 */
export async function anyFileNewer(
  dir: string,
  sinceMs: number,
): Promise<boolean> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return false;
  }
  const found = await firstSequential(entries, async (entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      return undefined;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      return (await anyFileNewer(path, sinceMs)) ? true : undefined;
    }
    if (!entry.isFile) return undefined;
    const mtime = await mtimeOrNull(path);
    return mtime !== null && mtime > sinceMs ? true : undefined;
  });
  return found === true;
}
