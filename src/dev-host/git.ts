/**
 * Git facts for a development checkout, read from files where possible.
 *
 * HEAD and `origin/trunk` are plain file reads (loose ref, then
 * `packed-refs`), so the status tick forks git only for the periodic fetch,
 * a `rev-list --count` when HEAD or the remote ref moved, and the status
 * read. A checkout that is itself a worktree (`.git` is a file) resolves its
 * own HEAD and the shared refs.
 */
import { isAbsolute, join } from "@std/path";
import { firstSequential } from "../util/sequential.ts";
import type { CommandResult, RunCommand } from "./commands.ts";

export const TRUNK = "trunk";
export const REMOTE_TRUNK_REF = "refs/remotes/origin/trunk";

type GitDirs = { gitDir: string; commonDir: string };

const SHA_RE = /^[0-9a-f]{40}$/;

async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** The checkout's git folder and the folder that holds the shared refs. */
export async function resolveGitDirs(repo: string): Promise<GitDirs | null> {
  const dotGit = join(repo, ".git");
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(dotGit);
  } catch {
    return null;
  }
  if (info.isDirectory) return { gitDir: dotGit, commonDir: dotGit };
  const text = (await readText(dotGit))?.trim() ?? "";
  if (!text.startsWith("gitdir:")) return null;
  const raw = text.slice("gitdir:".length).trim();
  const gitDir = isAbsolute(raw) ? raw : join(repo, raw);
  const common = (await readText(join(gitDir, "commondir")))?.trim();
  if (!common) return { gitDir, commonDir: gitDir };
  return {
    gitDir,
    commonDir: isAbsolute(common) ? common : join(gitDir, common),
  };
}

/** Resolve a full ref name to a sha from the loose file or `packed-refs`. */
export async function readRef(
  repo: string,
  ref: string,
  dirs?: GitDirs | null,
): Promise<string | null> {
  const resolved = dirs ?? await resolveGitDirs(repo);
  if (!resolved) return null;
  const loose = await firstSequential(
    new Set([resolved.gitDir, resolved.commonDir]),
    async (base) => {
      const text = (await readText(join(base, ref)))?.trim().toLowerCase();
      return text && SHA_RE.test(text) ? text : undefined;
    },
  );
  if (loose) return loose;
  const packed = await readText(join(resolved.commonDir, "packed-refs"));
  if (!packed) return null;
  for (const line of packed.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) {
      continue;
    }
    const space = trimmed.indexOf(" ");
    if (space !== 40) continue;
    if (trimmed.slice(space + 1) !== ref) continue;
    const sha = trimmed.slice(0, space).toLowerCase();
    return SHA_RE.test(sha) ? sha : null;
  }
  return null;
}

export type HeadInfo = {
  /** Branch name, or null on a detached head. */
  branch: string | null;
  commit: string | null;
};

/** Branch and commit of the checkout's HEAD, or null when it is not a checkout. */
export async function readHead(repo: string): Promise<HeadInfo | null> {
  const dirs = await resolveGitDirs(repo);
  if (!dirs) return null;
  const head = (await readText(join(dirs.gitDir, "HEAD")))?.trim();
  if (!head) return null;
  if (head.startsWith("ref: ")) {
    const ref = head.slice("ref: ".length).trim();
    const branch = ref.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : null;
    return { branch, commit: await readRef(repo, ref, dirs) };
  }
  const commit = head.toLowerCase();
  return { branch: null, commit: SHA_RE.test(commit) ? commit : null };
}

/** Run git in a checkout. Prompts are off so a fetch never waits for input. */
export function gitIn(
  run: RunCommand,
  repo: string,
  args: string[],
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return run("git", ["-C", repo, ...args], {
    env: { GIT_TERMINAL_PROMPT: "0", ...options.env },
    timeoutMs: options.timeoutMs,
  });
}

/** `git fetch -q origin trunk`. */
export function fetchTrunk(
  run: RunCommand,
  repo: string,
  env?: Record<string, string>,
): Promise<CommandResult> {
  return gitIn(run, repo, ["fetch", "-q", "origin", TRUNK], {
    env,
    timeoutMs: 120_000,
  });
}

/** Commits on `origin/trunk` not in HEAD; null when git could not say. */
export async function countBehind(
  run: RunCommand,
  repo: string,
  env?: Record<string, string>,
): Promise<number | null> {
  const result = await gitIn(
    run,
    repo,
    ["rev-list", "--count", `HEAD..origin/${TRUNK}`],
    { env, timeoutMs: 30_000 },
  );
  if (result.code !== 0) return null;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

/** The hard gate: `git merge --ff-only origin/trunk`, never anything else. */
export function fastForwardTrunk(
  run: RunCommand,
  repo: string,
  env?: Record<string, string>,
): Promise<CommandResult> {
  return gitIn(run, repo, ["merge", "--ff-only", `origin/${TRUNK}`], {
    env: { GIT_MERGE_AUTOEDIT: "no", ...env },
    timeoutMs: 120_000,
  });
}

/**
 * The commit HEAD pointed at `atMs`, from a HEAD reflog's text: the new
 * commit of the last entry made at or before that time. Null when the reflog
 * starts after `atMs` (or is empty), so the caller cannot tell.
 *
 * An entry is `<old> <new> <name> <<email>> <unix seconds> <zone>\t<message>`.
 */
export function commitAtFromReflog(text: string, atMs: number): string | null {
  let found: string | null = null;
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    const head = tab === -1 ? line : line.slice(0, tab);
    const close = head.lastIndexOf("> ");
    if (close === -1) continue;
    const seconds = Number.parseInt(head.slice(close + 2).trim(), 10);
    const commit = head.slice(41, 81).toLowerCase();
    if (!Number.isFinite(seconds) || !SHA_RE.test(commit)) continue;
    if (seconds * 1000 > atMs) break;
    found = commit;
  }
  return found;
}

/** The HEAD reflog's path, size and modification time, or null when it is missing. */
export async function statHeadReflog(
  repo: string,
): Promise<{ path: string; key: string } | null> {
  const dirs = await resolveGitDirs(repo);
  if (!dirs) return null;
  const path = join(dirs.gitDir, "logs", "HEAD");
  try {
    const info = await Deno.stat(path);
    return { path, key: `${info.size}:${info.mtime?.getTime() ?? 0}` };
  } catch {
    return null;
  }
}

/**
 * The commit a process started at `atMs` was running, from the checkout's
 * HEAD reflog; null when there is no reflog or it does not reach back that
 * far.
 */
export async function headCommitAt(
  path: string,
  atMs: number,
): Promise<string | null> {
  const text = await readText(path);
  return text === null ? null : commitAtFromReflog(text, atMs);
}
