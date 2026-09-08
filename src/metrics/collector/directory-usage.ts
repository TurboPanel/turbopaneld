/**
 * Directory-usage walker — the `managed.storage` family's four byte pairs
 * (hosting / backup / logs used, and each one's containing-filesystem free
 * space), computed on their own slow interval and cached for the sample tick
 * to read synchronously.
 *
 * **Never walked on the 60 s tick.** A hosting root that is not itself a
 * mount point costs a full recursive `readDir` of every tenant's tree; doing
 * that once a minute would make the metrics collector the busiest thing on a
 * shared-hosting box. So this module owns a separate
 * {@link DIRECTORY_USAGE_WALK_INTERVAL_MS} timer, caches the result, and
 * {@link DirectoryUsageWalker.latest} hands the sample builder whatever the
 * last completed walk produced — `null` readings until the first one lands,
 * which is what keeps `sample.storage` presence-gated rather than emitting a
 * row of zeros on a freshly started daemon.
 *
 * **A mount point is not walked at all.** When the path is its own
 * filesystem — the common case for `/backup` on attached storage, and for
 * `/var/log` on hosts that separate it — used bytes are
 * `(blocks - bfree) * bsize` straight from `statfs`, which is both exact and
 * free. The walk is the fallback for a directory that merely lives on a
 * shared filesystem, where `statfs` would report the whole disk instead.
 *
 * The walk itself is bounded three ways ({@link DIRECTORY_USAGE_MAX_DEPTH},
 * {@link DIRECTORY_USAGE_MAX_ENTRIES}, and a yield every
 * {@link DIRECTORY_USAGE_YIELD_EVERY} entries) so a pathological tree cannot
 * pin the event loop or run unbounded. Hitting a bound returns `null` rather
 * than a partial total: an under-count rendered as a real number is worse
 * than a gap, because it silently understates a filling disk.
 */
import type { StorageSample } from "../contract.ts";
import type { StatfsResult } from "./types.ts";

/**
 * How often the walk runs. Deliberately far slower than the metrics tick:
 * disk usage moves on the order of minutes at worst, and the AE/DuckDB
 * cadence tier for `managed.storage` is 300 s anyway, so a 15-minute walk
 * still refreshes the value several times per stored point's lifetime.
 */
export const DIRECTORY_USAGE_WALK_INTERVAL_MS = 15 * 60_000;

/** Directory nesting bound — deeper than any real hosting tree, shallow enough to stop a symlink-free cycle. */
export const DIRECTORY_USAGE_MAX_DEPTH = 32;

/** Total entries one walk may visit before giving up and reporting `null`. */
export const DIRECTORY_USAGE_MAX_ENTRIES = 400_000;

/** Entries between event-loop yields, so a long walk never blocks the metrics tick. */
export const DIRECTORY_USAGE_YIELD_EVERY = 512;

/** Bytes per `blocks` unit in POSIX `stat` — allocated size, not apparent size. */
const STAT_BLOCK_BYTES = 512;

/** One path's usage picture. `null` on either half means "not measurable", never zero. */
export type DirectoryUsageReading = {
  usedBytes: number | null;
  freeBytes: number | null;
};

const MISSING_READING: DirectoryUsageReading = {
  usedBytes: null,
  freeBytes: null,
};

export type DirectoryUsageSnapshot = {
  hosting: DirectoryUsageReading;
  backup: DirectoryUsageReading;
  logs: DirectoryUsageReading;
  /** When the walk that produced this finished, or `null` before the first one. */
  computedAtMs: number | null;
};

/** The empty snapshot a walker reports before its first walk completes. */
export function emptyDirectoryUsageSnapshot(): DirectoryUsageSnapshot {
  return {
    hosting: { ...MISSING_READING },
    backup: { ...MISSING_READING },
    logs: { ...MISSING_READING },
    computedAtMs: null,
  };
}

/** Minimal `Deno.DirEntry` shape the walk consumes. */
export type DirectoryEntryLike = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
};

/** Minimal `Deno.FileInfo` shape the walk consumes. */
export type FileInfoLike = {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  /** Allocated 512-byte blocks, when the platform reports them (Linux does). */
  blocks?: number | null;
  /** Containing device id — how a mount point is told apart from a plain subdirectory. */
  dev?: number | null;
};

export type DirectoryUsageIo = {
  statfs: (path: string) => StatfsResult | null | Promise<StatfsResult | null>;
  /** Follows symlinks — used only for device-id comparison. */
  stat: (path: string) => Promise<FileInfoLike | null>;
  /** Does **not** follow symlinks — a symlink's own size is counted, its target is never traversed. */
  lstat: (path: string) => Promise<FileInfoLike | null>;
  readDir: (path: string) => AsyncIterable<DirectoryEntryLike>;
};

export type DirectoryUsageDeps = {
  resolveHostingPath: () => string | Promise<string>;
  resolveBackupPath: () => string;
  resolveLogsPath: () => string;
  io: DirectoryUsageIo;
  now?: () => number;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Yield point between entry batches — injectable so tests drain deterministically. */
  yieldToEventLoop?: () => Promise<void>;
  onError?: (path: string, error: unknown) => void;
};

function defaultIo(): DirectoryUsageIo {
  return {
    statfs: async (path) => {
      const { statfs } = await import("node:fs/promises");
      try {
        const result = await statfs(path);
        return {
          blocks: Number(result.blocks),
          bfree: Number(result.bfree),
          bavail: Number(result.bavail),
          bsize: Number(result.bsize),
          files: Number(result.files),
          ffree: Number(result.ffree),
        };
      } catch {
        return null;
      }
    },
    stat: async (path) => {
      try {
        return await Deno.stat(path);
      } catch {
        return null;
      }
    },
    lstat: async (path) => {
      try {
        return await Deno.lstat(path);
      } catch {
        return null;
      }
    },
    readDir: (path) => Deno.readDir(path),
  };
}

/** Parent directory of `path` without importing a path module for one join. */
function parentOf(path: string): string {
  const trimmed = path.length > 1 && path.endsWith("/")
    ? path.slice(0, -1)
    : path;
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0) return "/";
  return trimmed.slice(0, cut);
}

function childPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** Free bytes on the filesystem containing `path` — unprivileged availability (`bavail`), matching `probeStorage`. */
function freeBytesFrom(stat: StatfsResult | null): number | null {
  if (!stat) return null;
  const bavail = Number(stat.bavail);
  const bsize = Number(stat.bsize);
  if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bsize <= 0) {
    return null;
  }
  return bavail * bsize;
}

/** Used bytes of a whole filesystem — `(blocks - bfree) * bsize`, including root-reserved blocks. */
function filesystemUsedBytesFrom(stat: StatfsResult | null): number | null {
  if (!stat) return null;
  const blocks = Number(stat.blocks);
  const bfree = Number(stat.bfree);
  const bsize = Number(stat.bsize);
  if (
    !Number.isFinite(blocks) || !Number.isFinite(bfree) ||
    !Number.isFinite(bsize) || bsize <= 0 || blocks <= 0
  ) {
    return null;
  }
  const used = (blocks - bfree) * bsize;
  return used >= 0 ? used : null;
}

/** Allocated bytes for one entry — `blocks * 512` when the platform reports it, else apparent size. */
function entryBytes(info: FileInfoLike): number {
  const blocks = info.blocks;
  if (typeof blocks === "number" && Number.isFinite(blocks) && blocks >= 0) {
    return blocks * STAT_BLOCK_BYTES;
  }
  return Number.isFinite(info.size) && info.size >= 0 ? info.size : 0;
}

/**
 * `true` when `path` is its own mount point — its device id differs from its
 * parent's. `/` is always one. An unreadable path or parent answers `false`,
 * which is the safe direction: it falls back to the walk, which then reports
 * `null` for a path that does not exist.
 */
async function isMountPoint(
  path: string,
  io: DirectoryUsageIo,
): Promise<boolean> {
  if (path === "/") return true;
  const [self, parent] = await Promise.all([
    io.stat(path),
    io.stat(parentOf(path)),
  ]);
  if (!self || !parent) return false;
  if (typeof self.dev !== "number" || typeof parent.dev !== "number") {
    return false;
  }
  return self.dev !== parent.dev;
}

/**
 * Bounded recursive size of `root`, in allocated bytes. Returns `null` when
 * the root is unreadable or when a bound is hit — a partial total would
 * understate a filling disk, which is exactly the number this metric exists
 * to catch.
 *
 * Symlinks are counted by their own size and never followed: following them
 * would double-count (a symlink into the same tree) or leave the tree
 * entirely (a symlink to another filesystem).
 */
export async function walkDirectoryBytes(
  root: string,
  deps: {
    io: DirectoryUsageIo;
    maxDepth?: number;
    maxEntries?: number;
    yieldEvery?: number;
    yieldToEventLoop?: () => Promise<void>;
    onError?: (path: string, error: unknown) => void;
  },
): Promise<number | null> {
  const ctx = walkContextFrom(root, deps);

  const rootInfo = await ctx.io.lstat(root);
  if (!rootInfo) return null;
  if (!rootInfo.isDirectory) return entryBytes(rootInfo);

  const state: WalkState = {
    total: entryBytes(rootInfo),
    visited: 0,
    queue: [{ path: root, depth: 0 }],
  };

  while (state.queue.length > 0) {
    const dir = state.queue.shift()!;
    const entries = await listEntries(ctx, dir.path);
    if (!entries) return null;
    for (const entry of entries) {
      if (!(await visitEntry(ctx, state, dir, entry))) return null;
    }
  }

  return state.total;
}

/** Resolved bounds and callbacks shared by every step of one walk. */
type WalkContext = {
  io: DirectoryUsageIo;
  root: string;
  maxDepth: number;
  maxEntries: number;
  yieldEvery: number;
  yieldToEventLoop: () => Promise<void>;
  onError?: (path: string, error: unknown) => void;
};

/** Mutable progress of one walk: the running total and the breadth-first frontier. */
type WalkState = {
  total: number;
  visited: number;
  queue: QueuedDirectory[];
};

type QueuedDirectory = { path: string; depth: number };

function walkContextFrom(
  root: string,
  deps: Parameters<typeof walkDirectoryBytes>[1],
): WalkContext {
  return {
    io: deps.io,
    root,
    maxDepth: deps.maxDepth ?? DIRECTORY_USAGE_MAX_DEPTH,
    maxEntries: deps.maxEntries ?? DIRECTORY_USAGE_MAX_ENTRIES,
    yieldEvery: deps.yieldEvery ?? DIRECTORY_USAGE_YIELD_EVERY,
    yieldToEventLoop: deps.yieldToEventLoop ??
      (() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
    onError: deps.onError,
  };
}

/**
 * Every entry of one directory, or `null` when it cannot be read. An
 * unreadable subdirectory is a real gap in the total, not a rounding error —
 * the caller refuses the whole reading rather than under-report.
 */
async function listEntries(
  ctx: WalkContext,
  path: string,
): Promise<DirectoryEntryLike[] | null> {
  try {
    const entries: DirectoryEntryLike[] = [];
    for await (const entry of ctx.io.readDir(path)) entries.push(entry);
    return entries;
  } catch (error) {
    ctx.onError?.(path, error);
    return null;
  }
}

/**
 * Account for one entry: count it, add its allocated bytes, and queue it for
 * descent when it is a real (non-symlink) directory. Returns `false` when a
 * bound was hit and the walk must abort with `null`.
 */
async function visitEntry(
  ctx: WalkContext,
  state: WalkState,
  parent: QueuedDirectory,
  entry: DirectoryEntryLike,
): Promise<boolean> {
  state.visited += 1;
  if (state.visited > ctx.maxEntries) {
    ctx.onError?.(
      ctx.root,
      new Error(`directory walk exceeded ${ctx.maxEntries} entries`),
    );
    return false;
  }
  if (state.visited % ctx.yieldEvery === 0) await ctx.yieldToEventLoop();

  const full = childPath(parent.path, entry.name);
  const info = await ctx.io.lstat(full);
  if (!info) return true;
  state.total += entryBytes(info);
  // `isSymlink` is checked before `isDirectory` because a symlink to a
  // directory reports both on some platforms — never traverse one.
  if (info.isSymlink || !info.isDirectory) return true;
  if (parent.depth + 1 > ctx.maxDepth) {
    ctx.onError?.(
      ctx.root,
      new Error(`directory walk exceeded depth ${ctx.maxDepth}`),
    );
    return false;
  }
  state.queue.push({ path: full, depth: parent.depth + 1 });
  return true;
}

/**
 * Measure one path: `statfs` for free space always, then either the
 * filesystem's own used bytes (when the path is a mount point) or a bounded
 * walk (when it is a directory on a shared filesystem).
 */
export async function measureDirectoryUsage(
  path: string,
  deps: Pick<
    DirectoryUsageDeps,
    "io" | "yieldToEventLoop" | "onError"
  >,
): Promise<DirectoryUsageReading> {
  const stat = await deps.io.statfs(path);
  const freeBytes = freeBytesFrom(stat);
  if (await isMountPoint(path, deps.io)) {
    return { usedBytes: filesystemUsedBytesFrom(stat), freeBytes };
  }
  const usedBytes = await walkDirectoryBytes(path, {
    io: deps.io,
    yieldToEventLoop: deps.yieldToEventLoop,
    onError: deps.onError,
  });
  return { usedBytes, freeBytes };
}

/**
 * The three paths' usage, measured once. Exported for tests and for the
 * walker's own timer; production callers read {@link DirectoryUsageWalker.latest}
 * instead of calling this on a tick.
 */
export async function collectDirectoryUsage(
  deps: DirectoryUsageDeps,
): Promise<DirectoryUsageSnapshot> {
  const now = deps.now ?? Date.now;
  const hostingPath = await Promise.resolve()
    .then(() => deps.resolveHostingPath())
    .catch(() => null);

  const [hosting, backup, logs] = await Promise.all([
    hostingPath === null
      ? Promise.resolve({ ...MISSING_READING })
      : measureDirectoryUsage(hostingPath, deps),
    measureDirectoryUsage(deps.resolveBackupPath(), deps),
    measureDirectoryUsage(deps.resolveLogsPath(), deps),
  ]);

  return { hosting, backup, logs, computedAtMs: now() };
}

/**
 * Owns the walk timer and the cached result.
 *
 * Started once at daemon boot and stopped on shutdown, independent of the
 * metrics scheduler's attach/detach cycle: the cache is a property of the
 * host, not of a control-plane connection, so a reconnect must not throw away
 * a walk that already ran.
 *
 * Overlapping walks are impossible by construction — a tick that fires while
 * the previous walk is still running is dropped, the same discipline
 * `MetricsScheduler` applies to overlapping collects.
 */
export class DirectoryUsageWalker {
  readonly #deps: DirectoryUsageDeps;
  readonly #intervalMs: number;
  readonly #setIntervalFn: typeof setInterval;
  readonly #clearIntervalFn: typeof clearInterval;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #snapshot: DirectoryUsageSnapshot = emptyDirectoryUsageSnapshot();

  constructor(deps: DirectoryUsageDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ?? DIRECTORY_USAGE_WALK_INTERVAL_MS;
    this.#setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.#clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  /** Last completed walk. Every reading is `null` until the first one lands. */
  latest(): DirectoryUsageSnapshot {
    return this.#snapshot;
  }

  /** Arm the interval and kick off an immediate first walk. Idempotent. */
  start(): void {
    if (this.#timer !== undefined) return;
    void this.refresh();
    this.#timer = this.#setIntervalFn(() => {
      void this.refresh();
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer === undefined) return;
    this.#clearIntervalFn(this.#timer);
    this.#timer = undefined;
  }

  /** Run one walk now, dropping the request if one is already in flight. */
  async refresh(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      this.#snapshot = await collectDirectoryUsage(this.#deps);
    } catch (error) {
      // A failed walk leaves the previous snapshot in place: a stale-but-real
      // number beats blanking the panel on one transient I/O error.
      this.#deps.onError?.("directory-usage", error);
    } finally {
      this.#running = false;
    }
  }
}

/** Construct a walker over the real filesystem, with the layout-resolved paths. */
export function createDirectoryUsageWalker(
  deps: Omit<DirectoryUsageDeps, "io"> & { io?: DirectoryUsageIo },
): DirectoryUsageWalker {
  return new DirectoryUsageWalker({ ...deps, io: deps.io ?? defaultIo() });
}

/**
 * Project a snapshot onto `StorageSample`'s seven flat fields. The three
 * per-engine groups are the caller's to supply — nothing here knows about
 * managed databases.
 */
export function storageBytesFromSnapshot(
  snapshot: DirectoryUsageSnapshot,
  dockerUsedBytes: number | null,
): Pick<
  StorageSample,
  | "hostingUsedBytes"
  | "backupUsedBytes"
  | "dockerUsedBytes"
  | "logsUsedBytes"
  | "hostingFreeBytes"
  | "backupFreeBytes"
  | "logsFreeBytes"
> {
  return {
    hostingUsedBytes: snapshot.hosting.usedBytes,
    backupUsedBytes: snapshot.backup.usedBytes,
    dockerUsedBytes,
    logsUsedBytes: snapshot.logs.usedBytes,
    hostingFreeBytes: snapshot.hosting.freeBytes,
    backupFreeBytes: snapshot.backup.freeBytes,
    logsFreeBytes: snapshot.logs.freeBytes,
  };
}
