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
  const env = gitEnvironment(credentialFiles, scratchDir);

  try {
    const init = await runGit(
      ["init", "--bare", "-q"],
      scratchDir,
      env,
      controller.signal,
    );
    if (!init.success) throw new Error(init.stderr || "git init failed");

    const remote = await runGit(
      ["remote", "add", "origin", params.cloneUrl],
      scratchDir,
      env,
      controller.signal,
    );
    if (!remote.success) {
      throw new Error(remote.stderr || "git remote add failed");
    }

    // `--filter=blob:none` needs server-side partial-clone support. The
    // fallback is explicit rather than silent: without it, a server that does
    // not advertise the filter fails the whole read for no good reason.
    let fetched = await runGit(
      ["fetch", "--depth", "1", "--filter=blob:none", "origin", params.ref],
      scratchDir,
      env,
      controller.signal,
    );
    if (!fetched.success) {
      fetched = await runGit(
        ["fetch", "--depth", "1", "origin", params.ref],
        scratchDir,
        env,
        controller.signal,
      );
    }
    if (!fetched.success) throw new Error(fetched.stderr || "git fetch failed");

    const head = await runGit(
      ["rev-parse", "FETCH_HEAD"],
      scratchDir,
      env,
      controller.signal,
    );
    if (!head.success) throw new Error(head.stderr || "git rev-parse failed");
    const commitSha = new TextDecoder().decode(head.stdout).trim();

    const files: RemoteFileEntry[] = [];
    for (const path of params.paths) {
      if (!isSafeRepoPath(path)) {
        files.push({ path, found: false, reason: "not_found" });
        continue;
      }
      // Ask for the size first so an oversized blob is never materialized.
      const size = await runGit(
        ["cat-file", "-s", `FETCH_HEAD:${path}`],
        scratchDir,
        env,
        controller.signal,
      );
      if (!size.success) {
        files.push({ path, found: false, reason: "not_found" });
        continue;
      }
      const bytes = Number.parseInt(
        new TextDecoder().decode(size.stdout).trim(),
        10,
      );
      if (Number.isFinite(bytes) && bytes > params.maxBytesPerFile) {
        files.push({ path, found: false, reason: "too_large" });
        continue;
      }
      const blob = await runGit(
        ["cat-file", "-p", `FETCH_HEAD:${path}`],
        scratchDir,
        env,
        controller.signal,
      );
      if (!blob.success) {
        files.push({ path, found: false, reason: "not_found" });
        continue;
      }
      if (blob.stdout.includes(0)) {
        files.push({ path, found: false, reason: "binary" });
        continue;
      }
      files.push({
        path,
        found: true,
        content: new TextDecoder().decode(blob.stdout),
        bytes: blob.stdout.byteLength,
      });
    }

    const entries: RemoteTreeEntry[] = [];
    if (params.listPath !== undefined) {
      const dir = params.listPath === "" ? "" : `${params.listPath}/`;
      if (dir === "" || isSafeRepoPath(params.listPath)) {
        const tree = await runGit(
          ["ls-tree", "--name-only", "-z", `FETCH_HEAD:${dir}`],
          scratchDir,
          env,
          controller.signal,
        );
        if (tree.success) {
          const listed = new TextDecoder().decode(tree.stdout).split("\0");
          for (const name of listed) {
            if (name.length === 0) continue;
            // `ls-tree` on `rev:dir/` yields names relative to that dir.
            entries.push({ path: `${dir}${name}`, kind: "file" });
          }
        }
      }
    }

    return { commitSha, files, entries };
  } finally {
    clearTimeout(timeout);
    for (
      const path of [
        credentialFiles.askpassPath,
        credentialFiles.sshKeyPath,
        credentialFiles.knownHostsPath,
      ]
    ) {
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
}

/** Exported for the handler's path guard tests. */
export const _internal = { isSafeRepoPath, join };
