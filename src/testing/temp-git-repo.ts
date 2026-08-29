/**
 * Test-only helpers — do not import from production code.
 *
 * A throwaway git repository in a temp dir, for suites that need to exercise
 * the *real* `git` binary rather than a stubbed runner.
 *
 * Suites used to run those paths against the ambient checkout
 * (`new URL("..", import.meta.url)`), which couples them to how the tree
 * happens to be laid out: they fail in a `git worktree` whose `.git` file
 * points outside the visible filesystem, in an exported tarball, and in any
 * container that copies sources without `.git`. A temp repo keeps the real-git
 * coverage while making the assertions hermetic and location-independent.
 *
 * The repo is fully isolated from the developer's git configuration —
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` are pointed at /dev/null and
 * identity is passed per-invocation — so a global `commit.gpgsign`,
 * `init.defaultBranch`, or hook template cannot change the result.
 */

/** Env that detaches git from the developer's global/system configuration. */
const ISOLATED_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "TurboPanel Test",
  GIT_AUTHOR_EMAIL: "test@turbopanel.invalid",
  GIT_COMMITTER_NAME: "TurboPanel Test",
  GIT_COMMITTER_EMAIL: "test@turbopanel.invalid",
};

export type TempGitRepo = {
  /** Absolute path to the repository working tree. */
  path: string;
  /** Full lowercase 40-hex sha of the initial commit. */
  head: string;
  /** Run git inside the repo, returning trimmed stdout. Throws on failure. */
  git: (...args: string[]) => Promise<string>;
  /** Write (and create parents for) a file relative to the repo root. */
  write: (relativePath: string, contents: string) => Promise<void>;
  /** Stage everything and commit, returning the new full sha. */
  commit: (message: string) => Promise<string>;
  cleanup: () => Promise<void>;
};

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    env: ISOLATED_GIT_ENV,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * Create a temp repo with a single commit. `files` seeds the initial commit
 * and defaults to one small file, because several fingerprint paths need a
 * non-empty tree to diff against.
 */
export async function createTempGitRepo(
  files: Record<string, string> = { "README.md": "temp git repo\n" },
): Promise<TempGitRepo> {
  const path = await Deno.makeTempDir({ prefix: "turbopaneld-git-" });

  const write = async (relativePath: string, contents: string) => {
    const target = `${path}/${relativePath}`;
    const parent = target.slice(0, target.lastIndexOf("/"));
    await Deno.mkdir(parent, { recursive: true });
    await Deno.writeTextFile(target, contents);
  };

  // `-b` pins the branch name so a global init.defaultBranch cannot leak in.
  await runGit(path, ["init", "-q", "-b", "main"]);
  for (const [relativePath, contents] of Object.entries(files)) {
    await write(relativePath, contents);
  }

  const commit = async (message: string): Promise<string> => {
    await runGit(path, ["add", "-A"]);
    await runGit(path, ["commit", "-q", "--no-verify", "-m", message]);
    return (await runGit(path, ["rev-parse", "HEAD"])).toLowerCase();
  };

  const head = await commit("initial");

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  };

  return {
    path,
    head,
    git: (...args: string[]) => runGit(path, args),
    write,
    commit,
    cleanup,
  };
}

/** Run `fn` against a fresh temp repo, cleaning up even when it throws. */
export async function withTempGitRepo<T>(
  fn: (repo: TempGitRepo) => Promise<T>,
  files?: Record<string, string>,
): Promise<T> {
  const repo = await createTempGitRepo(files);
  try {
    return await fn(repo);
  } finally {
    await repo.cleanup();
  }
}

/**
 * Whether `cwd` is a git checkout this process can actually query.
 *
 * Guards the handful of tests that deliberately exercise a helper's *default*
 * `cwd = ROOT` argument. Those need the ambient checkout, so they are skipped
 * — rather than failed — where it is unusable (worktree pointing outside the
 * visible filesystem, exported tarball, container without `.git`). CI checks
 * out a real repository, so the default-argument paths stay covered there.
 */
export async function ambientCheckoutIsGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await new Deno.Command("git", {
      args: ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return result.success;
  } catch {
    return false;
  }
}
