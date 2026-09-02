/**
 * Read files from a remote repository **without a worktree**.
 *
 * Deliberately not {@link checkoutRelease}: that clones a full worktree into a
 * release scratch dir with a 600s budget, because it is building something.
 * This runs on an operator's request path, so it uses a bare, blobless fetch
 * and a 30s budget — nothing from the repository is ever written to disk as a
 * file, only git objects, and with `--filter=blob:none` a large monorepo costs
 * a tree fetch rather than a checkout.
 *
 * Credential handling is reused verbatim from `checkout.ts`: the same `0600`
 * askpass / identity files, unlinked in `finally` whether the read succeeds or
 * throws.
 */

import { join } from "@std/path";
import {
  type CheckoutCredentialKind,
  gitEnvironment,
  writeCheckoutCredentialFiles,
} from "./checkout.ts";

/** An operator is waiting on this, unlike a release checkout. */
export const REPO_READ_TIMEOUT_MS = 30_000;

export type RemoteFileEntry = {
  path: string;
  found: boolean;
  content?: string;
  bytes?: number;
  reason?: "not_found" | "too_large" | "not_a_file" | "binary";
};

export type RemoteTreeEntry = { path: string; kind: "file" | "dir" };

export type ReadRemoteFilesParams = {
  cloneUrl: string;
  ref: string;
  paths: readonly string[];
  listPath?: string;
  maxBytesPerFile: number;
  credential?: string;
  credentialKind?: CheckoutCredentialKind;
  credentialUsername?: string;
};

export type ReadRemoteFilesResult = {
  commitSha: string;
  files: RemoteFileEntry[];
  entries: RemoteTreeEntry[];
};

type RunResult = { success: boolean; stdout: Uint8Array; stderr: string };

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<RunResult> {
  try {
    const command = new Deno.Command("git", {
      args,
      cwd,
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
      signal,
    });
    const { code, stdout, stderr } = await command.output();
    return {
      success: code === 0,
      stdout,
      stderr: new TextDecoder().decode(stderr),
    };
  } catch (error) {
    return {
      success: false,
      stdout: new Uint8Array(),
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A path that could escape the repository, or confuse git's rev syntax. */
function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("..") || path.includes("\0")) return false;
  // `:` separates rev from path in `rev:path`, so it must never appear here.
  if (path.includes(":")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(path);
}

/** Everything the per-path helpers need from an opened bare fetch. */
type RepoReadContext = {
  scratchDir: string;
  env: Record<string, string>;
  signal: AbortSignal;
};

/**
 * `--filter=blob:none` needs server-side partial-clone support. The fallback is
 * explicit rather than silent: without it, a server that does not advertise the
 * filter fails the whole read for no good reason.
 */
async function fetchRef(ctx: RepoReadContext, ref: string): Promise<void> {
  let fetched = await runGit(
    ["fetch", "--depth", "1", "--filter=blob:none", "origin", ref],
    ctx.scratchDir,
    ctx.env,
    ctx.signal,
  );
  if (!fetched.success) {
    fetched = await runGit(
      ["fetch", "--depth", "1", "origin", ref],
      ctx.scratchDir,
      ctx.env,
      ctx.signal,
    );
  }
  if (!fetched.success) throw new Error(fetched.stderr || "git fetch failed");
}

async function readOneFile(
  ctx: RepoReadContext,
  path: string,
  maxBytes: number,
): Promise<RemoteFileEntry> {
  if (!isSafeRepoPath(path)) return { path, found: false, reason: "not_found" };
  // Ask for the size first so an oversized blob is never materialized.
  const size = await runGit(
    ["cat-file", "-s", `FETCH_HEAD:${path}`],
    ctx.scratchDir,
    ctx.env,
    ctx.signal,
  );
  if (!size.success) return { path, found: false, reason: "not_found" };
  const bytes = Number.parseInt(
    new TextDecoder().decode(size.stdout).trim(),
    10,
  );
  if (Number.isFinite(bytes) && bytes > maxBytes) {
    return { path, found: false, reason: "too_large" };
  }
  const blob = await runGit(
    ["cat-file", "-p", `FETCH_HEAD:${path}`],
    ctx.scratchDir,
    ctx.env,
    ctx.signal,
  );
  if (!blob.success) return { path, found: false, reason: "not_found" };
  if (blob.stdout.includes(0)) return { path, found: false, reason: "binary" };
  return {
    path,
    found: true,
    content: new TextDecoder().decode(blob.stdout),
    bytes: blob.stdout.byteLength,
  };
}

async function listTree(
  ctx: RepoReadContext,
  listPath: string,
): Promise<RemoteTreeEntry[]> {
  const dir = listPath === "" ? "" : `${listPath}/`;
  if (dir !== "" && !isSafeRepoPath(listPath)) return [];
  const tree = await runGit(
    ["ls-tree", "--name-only", "-z", `FETCH_HEAD:${dir}`],
    ctx.scratchDir,
    ctx.env,
    ctx.signal,
  );
  if (!tree.success) return [];
  const entries: RemoteTreeEntry[] = [];
  for (const name of new TextDecoder().decode(tree.stdout).split("\0")) {
    if (name.length === 0) continue;
    // `ls-tree` on `rev:dir/` yields names relative to that dir.
    entries.push({ path: `${dir}${name}`, kind: "file" });
  }
  return entries;
}

/** Best effort per file; the scratch dir removal is the real guarantee. */
async function discardScratch(
  scratchDir: string,
  credentialPaths: readonly (string | null | undefined)[],
): Promise<void> {
  for (const path of credentialPaths) {
    if (!path) continue;
    try {
      await Deno.remove(path);
    } catch {
      // Best effort: the scratch dir removal below is the real guarantee.
    }
  }
  try {
    await Deno.remove(scratchDir, { recursive: true });
  } catch {
    // Nothing to do; the object store lives only here.
  }
}

export type ResolveDefaultBranchResult = { defaultBranch: string | null };

/** `ref: refs/heads/<name>\tHEAD` — the line `ls-remote --symref` answers with. */
const SYMREF_HEAD_RE = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m;

/**
 * The remote's default branch, via `ls-remote --symref` — no clone, no
 * credential, no scratch git repository to init.
 *
 * Anonymous only: this is for a public clone URL that named no default
 * branch, so the operator does not have to look one up by hand. A private
 * remote still needs a name from the operator — resolving it would mean
 * running this same read with the deploy key before they have confirmed it
 * is even added to the repository, which `checkout.ts` does not do either.
 */
export async function resolveDefaultBranch(
  cloneUrl: string,
  scratchRoot = "/tmp",
): Promise<ResolveDefaultBranchResult> {
  const scratchDir = await Deno.makeTempDir({
    dir: scratchRoot,
    prefix: "tp-repo-branch-",
  });
  await Deno.chmod(scratchDir, 0o700);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPO_READ_TIMEOUT_MS);
  const env = gitEnvironment(
    { askpassPath: null, sshKeyPath: null, knownHostsPath: null },
    scratchDir,
  );

  try {
    const result = await runGit(
      ["ls-remote", "--symref", cloneUrl, "HEAD"],
      scratchDir,
      env,
      controller.signal,
    );
    if (!result.success) {
      throw new Error(result.stderr || "git ls-remote failed");
    }
    const match = SYMREF_HEAD_RE.exec(new TextDecoder().decode(result.stdout));
    return { defaultBranch: match?.[1] ?? null };
  } finally {
    clearTimeout(timeout);
    await discardScratch(scratchDir, []);
  }
}

export async function readRemoteFiles(
  params: ReadRemoteFilesParams,
  scratchRoot = "/tmp",
): Promise<ReadRemoteFilesResult> {
  const scratchDir = await Deno.makeTempDir({
    dir: scratchRoot,
    prefix: "tp-repo-read-",
  });
  await Deno.chmod(scratchDir, 0o700);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPO_READ_TIMEOUT_MS);
  const credentialFiles = await writeCheckoutCredentialFiles({
    cloneUrl: params.cloneUrl,
    ref: params.ref,
    commitSha: "",
    scratchDir,
    ...(params.credential === undefined
      ? {}
      : { credential: params.credential }),
    ...(params.credentialKind === undefined
      ? {}
      : { credentialKind: params.credentialKind }),
    ...(params.credentialUsername === undefined
      ? {}
      : { credentialUsername: params.credentialUsername }),
  });
  const ctx: RepoReadContext = {
    scratchDir,
    env: gitEnvironment(credentialFiles, scratchDir),
    signal: controller.signal,
  };

  try {
    const init = await runGit(
      ["init", "--bare", "-q"],
      ctx.scratchDir,
      ctx.env,
      ctx.signal,
    );
    if (!init.success) throw new Error(init.stderr || "git init failed");

    const remote = await runGit(
      ["remote", "add", "origin", params.cloneUrl],
      ctx.scratchDir,
      ctx.env,
      ctx.signal,
    );
    if (!remote.success) {
      throw new Error(remote.stderr || "git remote add failed");
    }

    await fetchRef(ctx, params.ref);

    const head = await runGit(
      ["rev-parse", "FETCH_HEAD"],
      ctx.scratchDir,
      ctx.env,
      ctx.signal,
    );
    if (!head.success) throw new Error(head.stderr || "git rev-parse failed");
    const commitSha = new TextDecoder().decode(head.stdout).trim();

    const files: RemoteFileEntry[] = [];
    for (const path of params.paths) {
      files.push(await readOneFile(ctx, path, params.maxBytesPerFile));
    }

    const entries = params.listPath === undefined
      ? []
      : await listTree(ctx, params.listPath);

    return { commitSha, files, entries };
  } finally {
    clearTimeout(timeout);
    await discardScratch(scratchDir, [
      credentialFiles.askpassPath,
      credentialFiles.sshKeyPath,
      credentialFiles.knownHostsPath,
    ]);
  }
}

/** Exported for the handler's path guard tests. */
export const _internal = { isSafeRepoPath, join };
