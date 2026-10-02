/**
 * Symlink-safe copy for the build hand-off.
 *
 * Every copy between a tree a build wrote, the build work dir and the release
 * tree goes through here. The build controls every name in its tree, so the
 * copy treats that tree as hostile:
 *
 * - The source directory is reached one `lstat`ed component at a time from a
 *   containment root, refusing any symlink, `..` or absolute segment, and its
 *   real path must still sit under the root's real path.
 * - Entries are `lstat`ed, never followed. Directories are recreated, regular
 *   files are opened and checked on the opened handle (same inode and device
 *   as the `lstat`, still a regular file), so a name swapped for a link between
 *   the check and the open is refused rather than read.
 * - A symlink is kept only when its target is relative and cannot leave the
 *   tree (see {@link linkStaysInside}); every other link is dropped.
 * - FIFOs, sockets and device nodes are dropped. Set-id, sticky and
 *   group/other-write bits are stripped. Nothing is chowned, so no ownership
 *   travels from the source.
 * - An entry not owned by the account that owns the source root is refused:
 *   that is what a hard link to someone else's file looks like.
 * - Destinations are created one component at a time without following
 *   anything: a directory must be created or already be a real directory, and
 *   a file is created with `O_EXCL`, so a link planted at a destination is
 *   refused instead of written through.
 * - Entry count, byte count and depth are capped.
 *
 * What this cannot do from Deno (no `openat2`): pin a directory across the
 * check and the `readDir`, or open a file without following a link. The checks
 * above detect a swap of the entry itself; a directory swapped and swapped
 * back between two calls is out of their reach. The hand-off closes that by
 * construction: the build's processes are gone before the copy starts and the
 * tree belongs to the daemon account again, so nothing is left to race it.
 */

import { join } from "@std/path";
import { createSymlink } from "../../permissions/scoped-writes.ts";
import { forEachSequential } from "../../util/sequential.ts";

/** Never copied — build metadata, not shipped artifacts. */
const EXCLUDED_ENTRIES = new Set([".git"]);

/** Directories are created with this mode; files keep at most 0755. */
const DIRECTORY_MODE = 0o750;
const FILE_MODE_MASK = 0o755;

export type HandoffLimits = {
  /** Entries visited (files, directories, links and dropped specials). */
  maxEntries: number;
  /** Bytes of regular-file content copied. */
  maxBytes: number;
  /** Directory nesting below the source root. */
  maxDepth: number;
};

export const DEFAULT_HANDOFF_LIMITS: Readonly<HandoffLimits> = {
  maxEntries: 500_000,
  maxBytes: 16 * 1024 ** 3,
  maxDepth: 128,
};

/** A tree, entry or destination the hand-off refuses to copy. */
export class UnsafeTreeError extends Error {
  override name = "UnsafeTreeError";
}

export type HandoffReport = {
  entries: number;
  bytes: number;
  /** Tree-relative paths of symlinks dropped because they could escape. */
  droppedLinks: string[];
  /** Tree-relative paths of FIFOs, sockets and devices that were dropped. */
  skippedSpecial: string[];
};

/** A directory named by a root the daemon chose and a tenant-supplied path. */
export type ContainedPath = {
  root: string;
  /** `/`-separated path below `root`; empty or omitted for the root itself. */
  relative?: string;
};

export type ContainedDirState = "directory" | "missing" | "not-directory";

/**
 * Split a tenant-supplied relative path, refusing anything that could name a
 * place outside the root before a single `lstat` runs.
 */
export function containedSegments(relative: string | undefined): string[] {
  const value = relative ?? "";
  if (value.startsWith("/")) {
    throw new UnsafeTreeError(`refusing absolute path ${value}`);
  }
  const segments = value.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new UnsafeTreeError(`refusing ${value}: it leaves its tree`);
  }
  return segments;
}

/**
 * True when a symlink at `linkRelative` (tree-relative, `/`-separated) with
 * this target resolves inside the tree, whatever the other entries are.
 *
 * The rule is purely lexical, so it cannot be raced: the target must be
 * relative, and `..` may only appear as a leading run no longer than the
 * link's own depth. Climbing out of real directories lands on a real directory
 * inside the tree, and every name below it is either a real entry or another
 * link this same rule kept. A `..` after a name is refused, because that name
 * may be a link (`a -> .` makes `a/a/..` the tree's parent).
 */
export function linkStaysInside(linkRelative: string, target: string): boolean {
  if (target === "" || target.startsWith("/")) return false;
  const depth = linkRelative.split("/").length - 1;
  const segments = target.split("/").filter((s) => s !== "" && s !== ".");
  const firstName = segments.findIndex((s) => s !== "..");
  const ups = firstName === -1 ? segments.length : firstName;
  if (segments.slice(ups).includes("..")) return false;
  return ups <= depth;
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

function refuseLink(path: string, info: Deno.FileInfo): void {
  if (info.isSymlink) {
    throw new UnsafeTreeError(`refusing ${path}: it is a symlink`);
  }
}

/**
 * Whether `root/relative` is a real directory reached without a symlink.
 *
 * A missing or non-directory component is reported, not thrown, so callers
 * that merely probe (`.next/standalone`, `out/`) can take another branch. A
 * symlink anywhere on the way, the root included, is always refused.
 */
export async function inspectContainedDir(
  target: ContainedPath,
): Promise<ContainedDirState> {
  const segments = containedSegments(target.relative);
  const paths = segments.map((_, index) =>
    join(target.root, ...segments.slice(0, index + 1))
  );
  const walk = { state: "directory" as ContainedDirState };
  await forEachSequential([target.root, ...paths], async (path) => {
    if (walk.state !== "directory") return;
    const info = await lstatOrNull(path);
    if (info === null) {
      walk.state = "missing";
      return;
    }
    refuseLink(path, info);
    if (!info.isDirectory) walk.state = "not-directory";
  });
  if (walk.state !== "directory") return walk.state;
  const dir = join(target.root, ...segments);
  const [realRoot, realDir] = await Promise.all([
    Deno.realPath(target.root),
    Deno.realPath(dir),
  ]);
  if (realDir !== join(realRoot, ...segments)) {
    throw new UnsafeTreeError(`refusing ${dir}: it resolves to ${realDir}`);
  }
  return "directory";
}

/** Like {@link inspectContainedDir}, but anything but a directory throws. */
export async function requireContainedDir(
  target: ContainedPath,
): Promise<string> {
  const dir = join(target.root, ...containedSegments(target.relative));
  const state = await inspectContainedDir(target);
  if (state === "missing") {
    throw new Error(`release output directory not found: ${dir}`);
  }
  if (state === "not-directory") {
    throw new Error(`release output is not a directory: ${dir}`);
  }
  return dir;
}

/** Create one destination directory, or accept a real one already there. */
async function makeDestDir(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { mode: DIRECTORY_MODE });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
    const existing = await Deno.lstat(path);
    refuseLink(path, existing);
    if (!existing.isDirectory) {
      throw new UnsafeTreeError(`refusing ${path}: it is not a directory`);
    }
  }
}

/**
 * Create `root/relative` one component at a time. The root may be created with
 * its parents (the caller chose it), but must end up a real directory; every
 * component below it is created or checked without following a link.
 */
export async function ensureContainedDestDir(
  target: ContainedPath,
): Promise<string> {
  const segments = containedSegments(target.relative);
  await Deno.mkdir(target.root, { recursive: true, mode: DIRECTORY_MODE });
  const rootInfo = await Deno.lstat(target.root);
  refuseLink(target.root, rootInfo);
  let current = target.root;
  await forEachSequential(segments, async (segment) => {
    current = join(current, segment);
    await makeDestDir(current);
  });
  return current;
}

/** Create a new destination file; a regular file already there is replaced. */
async function openNewFile(path: string, mode: number): Promise<Deno.FsFile> {
  const options = { write: true, createNew: true, mode } as const;
  try {
    return await Deno.open(path, options);
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
    const existing = await Deno.lstat(path);
    if (!existing.isFile) {
      throw new UnsafeTreeError(`refusing ${path}: it is not a regular file`);
    }
    await Deno.remove(path);
    return await Deno.open(path, options);
  }
}

function sameInode(a: Deno.FileInfo, b: Deno.FileInfo): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * Copy one regular file whose `lstat` the caller already holds.
 *
 * The source is checked on the opened handle: if the name now leads anywhere
 * else (a symlink swapped in, another file renamed over it) the inode differs
 * and nothing is read. Returns the bytes copied.
 */
export async function copyRegularFile(
  source: string,
  dest: string,
  expected: Deno.FileInfo,
): Promise<number> {
  const file = await Deno.open(source, { read: true });
  let piped = false;
  try {
    const opened = await file.stat();
    if (!opened.isFile || !sameInode(opened, expected)) {
      throw new UnsafeTreeError(
        `refusing ${source}: it changed while being copied`,
      );
    }
    const target = await openNewFile(
      dest,
      (expected.mode ?? 0o644) & FILE_MODE_MASK,
    );
    piped = true;
    await file.readable.pipeTo(target.writable);
    return opened.size;
  } finally {
    if (!piped) file.close();
  }
}

type WalkState = {
  limits: HandoffLimits;
  ownerUid: number | null;
  report: HandoffReport;
};

function countEntry(state: WalkState, relative: string): void {
  state.report.entries += 1;
  if (state.report.entries > state.limits.maxEntries) {
    throw new UnsafeTreeError(
      `refusing the tree: more than ${state.limits.maxEntries} entries (at ${relative})`,
    );
  }
}

function checkOwner(state: WalkState, relative: string, info: Deno.FileInfo) {
  if (state.ownerUid === null || info.uid === null) return;
  if (info.uid !== state.ownerUid) {
    throw new UnsafeTreeError(
      `refusing ${relative}: owned by uid ${info.uid}, not the tree's owner`,
    );
  }
}

async function copyLink(
  source: string,
  dest: string,
  relative: string,
  state: WalkState,
): Promise<void> {
  const target = await Deno.readLink(source);
  if (!linkStaysInside(relative, target)) {
    state.report.droppedLinks.push(relative);
    return;
  }
  await createSymlink(target, dest);
}

async function copyFileEntry(
  source: string,
  dest: string,
  info: Deno.FileInfo,
  state: WalkState,
): Promise<void> {
  if (state.report.bytes + info.size > state.limits.maxBytes) {
    throw new UnsafeTreeError(
      `refusing the tree: more than ${state.limits.maxBytes} bytes`,
    );
  }
  state.report.bytes += await copyRegularFile(source, dest, info);
}

async function copyEntry(
  parent: { source: string; dest: string; relative: string; depth: number },
  name: string,
  state: WalkState,
): Promise<void> {
  if (EXCLUDED_ENTRIES.has(name)) return;
  const source = join(parent.source, name);
  const dest = join(parent.dest, name);
  const relative = parent.relative ? `${parent.relative}/${name}` : name;
  const info = await Deno.lstat(source);
  countEntry(state, relative);
  checkOwner(state, relative, info);
  if (info.isSymlink) return await copyLink(source, dest, relative, state);
  if (info.isFile) return await copyFileEntry(source, dest, info, state);
  if (!info.isDirectory) {
    state.report.skippedSpecial.push(relative);
    return;
  }
  if (parent.depth + 1 > state.limits.maxDepth) {
    throw new UnsafeTreeError(
      `refusing ${relative}: deeper than ${state.limits.maxDepth} levels`,
    );
  }
  await makeDestDir(dest);
  await copyDirectory(
    { source, dest, relative, depth: parent.depth + 1 },
    info,
    state,
  );
}

async function copyDirectory(
  dir: { source: string; dest: string; relative: string; depth: number },
  expected: Deno.FileInfo,
  state: WalkState,
): Promise<void> {
  const entries = await Array.fromAsync(Deno.readDir(dir.source));
  // The listing must have come from the directory that was checked.
  const after = await Deno.lstat(dir.source);
  if (after.isSymlink || !after.isDirectory || !sameInode(after, expected)) {
    throw new UnsafeTreeError(
      `refusing ${dir.source}: it changed while being copied`,
    );
  }
  const names = entries.map((entry) => entry.name).sort();
  await forEachSequential(names, (name) => copyEntry(dir, name, state));
}

/**
 * Copy the contained directory `source` into the contained directory `dest`
 * under the rules in this module's header. Returns what was copied and what
 * was dropped; throws {@link UnsafeTreeError} on a refusal, leaving whatever
 * was already written for the caller to remove.
 */
export async function copyContainedTree(params: {
  source: ContainedPath;
  dest: ContainedPath;
  limits?: Partial<HandoffLimits>;
}): Promise<HandoffReport> {
  const sourceDir = await requireContainedDir(params.source);
  const [rootInfo, sourceInfo] = await Promise.all([
    Deno.lstat(params.source.root),
    Deno.lstat(sourceDir),
  ]);
  const destDir = await ensureContainedDestDir(params.dest);
  const state: WalkState = {
    limits: { ...DEFAULT_HANDOFF_LIMITS, ...params.limits },
    ownerUid: rootInfo.uid,
    report: { entries: 0, bytes: 0, droppedLinks: [], skippedSpecial: [] },
  };
  await copyDirectory(
    { source: sourceDir, dest: destDir, relative: "", depth: 0 },
    sourceInfo,
    state,
  );
  return state.report;
}
