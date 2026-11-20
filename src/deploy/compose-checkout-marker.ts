/**
 * Where a Git Compose project's repository checkout sits, and how Compose is
 * pointed at it.
 *
 * Layout under `<stateDir>/deployments/<projectId>/<environmentId>/`:
 *
 * ```
 * compose.yaml        the compiled file the daemon writes (never a repo file)
 * deployment.json     the deployment record
 * repo.json           this marker: which commit `repo/` holds
 * repo/               the repository tree at that commit, no `.git`
 *   deploy/compose.yaml   the repo's own file, untouched
 *   vpn/Dockerfile        what `build: ./vpn` reads
 * ```
 *
 * Compose resolves a relative `build`, bind source or `env_file` against its
 * project directory, which defaults to the folder of the first `-f` file. The
 * compiled file has to keep its name and place (every lifecycle command, the
 * rehydrate pass and the rollback copy find it there), and it must not
 * overwrite a repository file of the same name, so the repository does not go
 * into the folder of `compose.yaml`. Instead Compose is started with
 * `--project-directory repo/<folder of the repo's compose file>`, so a path
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

export type ComposeCheckoutMarker = {
  version: 1;
  /** Clone URL (credential-free) the tree came from. */
  cloneUrl: string;
  /** The commit `repo/` holds. */
  commitSha: string;
  /** Repo-relative path of the compose file the project directory comes from. */
  composePath: string;
};

export type ComposeCheckoutDirs = {
  /** `<deploymentDir>/repo`: the whole checkout, the build tool's working folder. */
  root: string;
  /** Compose's project directory: the folder of the repo's compose file. */
  projectDir: string;
};

/** Folder of a repo-relative file path; `.` for a file at the repo root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

export function composeCheckoutDirs(
  deploymentDir: string,
  composePath: string,
): ComposeCheckoutDirs {
  const root = join(deploymentDir, COMPOSE_CHECKOUT_DIRNAME);
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
    typeof v.commitSha !== "string" || typeof v.composePath !== "string"
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
    [COMPOSE_CHECKOUT_MARKER_FILENAME, COMPOSE_CHECKOUT_DIRNAME].map(
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
 * The checkout directories for a compose call whose first file is
 * `composeFile`, or `null` when the deployment has none. A file under the
 * staging directory belongs to its parent deployment.
 */
export async function composeCheckoutDirsForFile(
  composeFile: string,
  stageDirname: string,
): Promise<ComposeCheckoutDirs | null> {
  let dir = composeFile.slice(0, Math.max(0, composeFile.lastIndexOf("/")));
  if (dir.endsWith(`/${stageDirname}`)) {
    dir = dir.slice(0, -(stageDirname.length + 1));
  }
  if (dir === "") return null;
  const marker = await readComposeCheckoutMarker(dir);
  return marker ? composeCheckoutDirs(dir, marker.composePath) : null;
}

/** {@link composeCheckoutDirs} for a deployment directory, `null` without a checkout. */
export async function readComposeCheckoutDirs(
  deploymentDir: string,
): Promise<ComposeCheckoutDirs | null> {
  const marker = await readComposeCheckoutMarker(deploymentDir);
  return marker ? composeCheckoutDirs(deploymentDir, marker.composePath) : null;
}
