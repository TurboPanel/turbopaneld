/**
 * Where a Git Compose project's repository checkout sits, and how Compose is
 * pointed at it.
 *
 * Layout under `<stateDir>/deployments/<projectId>/<environmentId>/`:
 *
 * ```
 * compose.yaml        the compiled file the daemon writes (never a repo file)
 * deployment.json     the deployment record
 * repo.json           this marker: which commit is the current one
 * repo/<commit>/      the repository tree at that commit, no `.git`
 *   deploy/compose.yaml   the repo's own file, untouched
 *   vpn/Dockerfile        what `build: ./vpn` reads
 * ```
 *
 * Each commit has its own folder and an older one stays until the new one is
 * up (`pruneComposeCheckout`). Running containers bind into the folder they
 * were started from, so replacing one tree in place would empty or stale
 * their mounts and leave a failed deploy's old containers without files. A
 * new commit also changes every bind source into the tree, so Compose
 * recreates the services that mount it.
 *
 * Compose resolves a relative `build`, bind source or `env_file` against its
 * project directory, which defaults to the folder of the first `-f` file. The
 * compiled file has to keep its name and place (every lifecycle command, the
 * rehydrate pass and the rollback copy find it there), and it must not
 * overwrite a repository file of the same name, so the repository does not go
 * into the folder of `compose.yaml`. Instead Compose is started with
 * `--project-directory repo/<commit>/<folder of the repo's compose file>`, so a path
 * written for the repository resolves exactly as it does in a clone, including
 * for a compose file kept in a repository subfolder. Because the project
 * directory is a flag on every call (see `docker-cli.ts`), nothing in the
 * lifecycle code has to know about it.
 *
 * The marker is a sidecar file rather than a field of `deployment.json` so the
 * Docker layer can read it without depending on the manifest schema, and so it
 * exists before the staged compose is resolved (the manifest is published
 * after).
 */

import { join, normalize } from "@std/path";

export const COMPOSE_CHECKOUT_DIRNAME = "repo";
export const COMPOSE_CHECKOUT_MARKER_FILENAME = "repo.json";
/**
 * The marker of the compose file that is live, i.e. the one the last publish
 * wrote. `repo.json` moves to the new commit when a deploy fetches it, which
 * is before that deploy publishes, so a publish keeps this copy for
 * `previous/` and refreshes it from `repo.json` afterwards.
 */
export const COMPOSE_CHECKOUT_LIVE_MARKER_FILENAME = "repo.live.json";

export type ComposeCheckoutMarker = {
  version: 1;
  /** Clone URL (credential-free) the tree came from. */
  cloneUrl: string;
  /** The current commit: its tree is `repo/<commit>`. */
  commitSha: string;
  /** Repo-relative path of the compose file the project directory comes from. */
  composePath: string;
};

export type ComposeCheckoutDirs = {
  /** `<deploymentDir>/repo/<commit>`: the whole checkout, the build tool's working folder. */
  root: string;
  /** Compose's project directory: the folder of the repo's compose file. */
  projectDir: string;
};

/** Folder of a repo-relative file path; `.` for a file at the repo root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

/** A full commit id; the folder name of a generation, so nothing else is accepted. */
const COMMIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA.test(value);
}

export function composeCheckoutDirs(
  deploymentDir: string,
  composePath: string,
  commitSha: string,
): ComposeCheckoutDirs {
  if (!isCommitSha(commitSha)) {
    throw new Error(`not a commit id: ${commitSha}`);
  }
  const root = join(deploymentDir, COMPOSE_CHECKOUT_DIRNAME, commitSha);
  return { root, projectDir: normalize(join(root, folderOf(composePath))) };
}

export function parseComposeCheckoutMarker(
  text: string,
): ComposeCheckoutMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 || typeof v.cloneUrl !== "string" ||
    typeof v.commitSha !== "string" || !isCommitSha(v.commitSha) ||
    typeof v.composePath !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    cloneUrl: v.cloneUrl,
    commitSha: v.commitSha,
    composePath: v.composePath,
  };
}

export async function readComposeCheckoutMarker(
  deploymentDir: string,
): Promise<ComposeCheckoutMarker | null> {
  try {
    return parseComposeCheckoutMarker(
      await Deno.readTextFile(
        join(deploymentDir, COMPOSE_CHECKOUT_MARKER_FILENAME),
      ),
    );
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

export async function writeComposeCheckoutMarker(
  deploymentDir: string,
  marker: ComposeCheckoutMarker,
): Promise<void> {
  const path = join(deploymentDir, COMPOSE_CHECKOUT_MARKER_FILENAME);
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o640 });
  await Deno.rename(tmp, path);
}

export async function removeComposeCheckout(
  deploymentDir: string,
): Promise<void> {
  await Promise.all(
    [
      COMPOSE_CHECKOUT_MARKER_FILENAME,
      COMPOSE_CHECKOUT_LIVE_MARKER_FILENAME,
      COMPOSE_CHECKOUT_DIRNAME,
    ].map(
      async (name) => {
        try {
          await Deno.remove(join(deploymentDir, name), { recursive: true });
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
      },
    ),
  );
}

/**
 * A deploy that names no checkout stops following the repository: the current
 * marker goes so the new compose file runs without a project directory, but
 * the trees and the live marker stay for the containers that still run from
 * them (and for a restore) until {@link pruneComposeCheckout} runs.
 */
export async function unfollowComposeCheckout(
  deploymentDir: string,
): Promise<void> {
  await Deno.remove(join(deploymentDir, COMPOSE_CHECKOUT_MARKER_FILENAME))
    .catch((err) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
}

/**
 * A deploy that failed before it published leaves the live compose file in
 * place: make the live marker the current one again, so Compose calls for it
 * still use the tree its containers run from.
 */
export async function restoreLiveComposeCheckoutMarker(
  deploymentDir: string,
): Promise<void> {
  const live = join(deploymentDir, COMPOSE_CHECKOUT_LIVE_MARKER_FILENAME);
  let text: string;
  try {
    text = await Deno.readTextFile(live);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  if (parseComposeCheckoutMarker(text) === null) return;
  await Deno.writeTextFile(
    join(deploymentDir, COMPOSE_CHECKOUT_MARKER_FILENAME),
    text,
    { mode: 0o640 },
  );
}

/**
 * Remove every checkout tree but the current commit's, or all of them when
 * the deploy follows no repository. Called once a deploy has brought the
 * current one up: until then the previous generation's containers still run
 * from their own tree.
 */
export async function pruneComposeCheckout(
  deploymentDir: string,
): Promise<void> {
  const marker = await readComposeCheckoutMarker(deploymentDir);
  if (!marker) {
    await Deno.remove(join(deploymentDir, COMPOSE_CHECKOUT_DIRNAME), {
      recursive: true,
    }).catch((err) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
    return;
  }
  const parent = join(deploymentDir, COMPOSE_CHECKOUT_DIRNAME);
  let names: string[];
  try {
    names = await Array.fromAsync(Deno.readDir(parent), (e) => e.name);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  await Promise.all(
    names.filter((name) => name !== marker.commitSha).map((name) =>
      Deno.remove(join(parent, name), { recursive: true })
    ),
  );
}

/**
 * The checkout directories for a compose call whose first file is
 * `composeFile`, or `null` when the deployment has none. A file under the
 * staging directory belongs to its parent deployment and its marker. A file
 * under `previous/` belongs to the parent deployment too, but to the commit
 * recorded in the marker kept beside it, so the earlier compose file runs
 * against its own tree.
 */
export async function composeCheckoutDirsForFile(
  composeFile: string,
  stageDirname: string,
  previousDirname: string,
): Promise<ComposeCheckoutDirs | null> {
  const dir = composeFile.slice(0, Math.max(0, composeFile.lastIndexOf("/")));
  if (dir.endsWith(`/${previousDirname}`)) {
    const deploymentDir = dir.slice(0, -(previousDirname.length + 1));
    const marker = await readComposeCheckoutMarker(dir);
    return marker && deploymentDir !== ""
      ? composeCheckoutDirs(deploymentDir, marker.composePath, marker.commitSha)
      : null;
  }
  const deploymentDir = dir.endsWith(`/${stageDirname}`)
    ? dir.slice(0, -(stageDirname.length + 1))
    : dir;
  return deploymentDir === ""
    ? null
    : await readComposeCheckoutDirs(deploymentDir);
}

/** {@link composeCheckoutDirs} for a deployment directory, `null` without a checkout. */
export async function readComposeCheckoutDirs(
  deploymentDir: string,
): Promise<ComposeCheckoutDirs | null> {
  const marker = await readComposeCheckoutMarker(deploymentDir);
  return marker
    ? composeCheckoutDirs(deploymentDir, marker.composePath, marker.commitSha)
    : null;
}
