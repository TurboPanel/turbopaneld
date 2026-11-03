/**
 * Classify a development checkout's local changes (owner decision: only a
 * real content change blocks a pull).
 *
 * - `content`: a tracked file whose content changed, or that was added,
 *   deleted, renamed or changed type. Blocks the pull.
 * - `mode`: a tracked file whose only change is its permission bit
 *   (`git diff --numstat` reports 0 added and 0 deleted lines). Shown, not
 *   blocking.
 * - `generated`: a known generated file (`next-env.d.ts` in the website
 *   checkout). Shown, not blocking.
 * - `untracked`: a new file git does not track. Shown, not blocking.
 * - `runtime`: tool state under `.config/`, `.local/` or `.cache/`. Shown, not
 *   blocking.
 *
 * Nothing here decides whether the pull succeeds: `git merge --ff-only
 * origin/trunk` stays the hard gate, so an untracked file the merge would
 * overwrite still stops it, with git's own message.
 */
import {
  type DevHostDirty,
  type DevHostDirtyEntry,
  MAX_DEV_HOST_DIRTY_ENTRIES,
  MAX_DEV_HOST_PATH_CHARS,
} from "../contracts/cell-messages.ts";
import { clipText, type RunCommand } from "./commands.ts";
import { gitIn } from "./git.ts";

/** Same prefixes as the control plane's `isRuntimePorcelainLine`. */
const RUNTIME_DIR_PREFIXES = [".config/", ".local/", ".cache/"] as const;

/** Generated files per checkout folder that never block a pull. */
export const GENERATED_FILES: Readonly<Record<string, readonly string[]>> = {
  website: ["next-env.d.ts"],
};

export type PorcelainEntry = { xy: string; path: string };

/**
 * Parse `git status --porcelain=v1 -z --no-renames`: `XY path` records
 * separated by NUL. Rename records (two paths) are not produced with
 * `--no-renames` but are skipped safely if present.
 */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    out.push({ xy, path: record.slice(3) });
    if (xy[0] === "R" || xy[0] === "C") i += 1;
  }
  return out;
}

/** Parse `git diff --numstat -z --no-renames`: `added\tdeleted\tpath` per NUL record. */
export function parseNumstatZ(
  stdout: string,
): Map<string, { added: string; deleted: string }> {
  const out = new Map<string, { added: string; deleted: string }>();
  for (const record of stdout.split("\0")) {
    const first = record.indexOf("\t");
    const second = first === -1 ? -1 : record.indexOf("\t", first + 1);
    if (second === -1) continue;
    out.set(record.slice(second + 1), {
      added: record.slice(0, first),
      deleted: record.slice(first + 1, second),
    });
  }
  return out;
}

function isRuntimePath(path: string): boolean {
  return RUNTIME_DIR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Only `M` in either column (no add, delete, rename, copy, type change or conflict). */
function onlyModified(xy: string): boolean {
  const cols = [xy[0], xy[1]];
  return cols.includes("M") && cols.every((c) => c === "M" || c === " ");
}

/** Kind of one porcelain entry; `numstat` covers tracked changes against HEAD. */
export function classifyEntry(
  entry: PorcelainEntry,
  numstat: ReadonlyMap<string, { added: string; deleted: string }>,
  generated: readonly string[],
): DevHostDirtyEntry["kind"] {
  if (isRuntimePath(entry.path)) return "runtime";
  if (entry.xy === "??") return "untracked";
  if (generated.includes(entry.path)) return "generated";
  if (onlyModified(entry.xy)) {
    const stat = numstat.get(entry.path);
    if (stat?.added === "0" && stat.deleted === "0") return "mode";
  }
  return "content";
}

/** Build the wire object from classified entries (bounded list). */
export function summarizeDirty(entries: DevHostDirtyEntry[]): DevHostDirty {
  // Blocking entries first so a long list never hides the reason.
  const sorted = [...entries].sort((a, b) => {
    const rank = (e: DevHostDirtyEntry) => (e.kind === "content" ? 0 : 1);
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  });
  return {
    files: entries.length,
    blocking: entries.some((e) => e.kind === "content"),
    kinds: sorted.slice(0, MAX_DEV_HOST_DIRTY_ENTRIES).map((e) => ({
      path: clipText(e.path, MAX_DEV_HOST_PATH_CHARS),
      kind: e.kind,
    })),
  };
}

export const CLEAN: DevHostDirty = { files: 0, blocking: false, kinds: [] };

/**
 * Read and classify a checkout's local changes. One `git status`, plus one
 * `git diff --numstat` only when a tracked file shows as modified. A failed
 * status read counts as blocking: the checkout is not pulled when its state
 * is unknown.
 */
export async function readDirty(
  run: RunCommand,
  repo: string,
  repoFolder: string,
  env?: Record<string, string>,
): Promise<{ dirty: DevHostDirty; error?: string }> {
  const status = await gitIn(
    run,
    repo,
    ["status", "--porcelain=v1", "-z", "--no-renames"],
    { env, timeoutMs: 60_000 },
  );
  if (status.code !== 0) {
    return {
      dirty: { files: 0, blocking: true, kinds: [] },
      error: "git status failed",
    };
  }
  const entries = parsePorcelainZ(status.stdout);
  if (entries.length === 0) return { dirty: CLEAN };
  let numstat = new Map<string, { added: string; deleted: string }>();
  if (entries.some((e) => onlyModified(e.xy) && !isRuntimePath(e.path))) {
    const diff = await gitIn(
      run,
      repo,
      ["diff", "HEAD", "--numstat", "-z", "--no-renames"],
      { env, timeoutMs: 60_000 },
    );
    if (diff.code === 0) numstat = parseNumstatZ(diff.stdout);
  }
  const generated = GENERATED_FILES[repoFolder] ?? [];
  return {
    dirty: summarizeDirty(
      entries.map((entry) => ({
        path: entry.path,
        kind: classifyEntry(entry, numstat, generated),
      })),
    ),
  };
}
