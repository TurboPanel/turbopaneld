/**
 * Check a Git Compose project's repository out into its deployment directory.
 *
 * The layout and why it is this one are in `compose-checkout-marker.ts`. This
 * module does the work: clone the pinned commit into a scratch folder outside
 * the deployment directory (the clone credential never lands where a bind
 * mount could reach it), drop `.git`, check that the compose file the Base
 * came from is in the tree, then move the tree to `repo/<commit>` and record
 * the commit in `repo.json`.
 *
 * Every commit has its own folder and a folder is never rewritten once in
 * place, so containers started from an earlier commit keep their files until a
 * deploy has brought the new generation up. A container that writes into the
 * tree would see its writes disappear with the folder; `compose-host-paths.ts`
 * refuses a writable bind that points into the checkout and tells the author
 * to use a named volume.
 *
 * Reuses the release engine's `checkoutRelease` (clone-url guard, pinned
 * commit, askpass / identity file removed afterwards) and the same credential
 * decrypt as `sourceMaterial[]`.
 */

import { join } from "@std/path";
import type { EnvironmentDeployComposeCheckout } from "../contracts/commands-contracts.ts";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import {
  checkoutRelease,
  type ReleaseOutputHandler,
} from "./release/checkout.ts";
import {
  COMPOSE_CHECKOUT_DIRNAME,
  type ComposeCheckoutDirs,
  composeCheckoutDirs,
  isCommitSha,
  readComposeCheckoutMarker,
  writeComposeCheckoutMarker,
} from "./compose-checkout-marker.ts";

export type ApplyComposeCheckoutDeps = {
  /**
   * Where the clone is made: an empty or absent folder on the same file system
   * as the deployment directory, outside it (a bind mount of the deployment
   * directory must never reach the clone credential).
   */
  scratchDir: string;
  decryptSecrets: DecryptSecretsFn | undefined;
  onOutput?: ReleaseOutputHandler;
  redactSummary?: (text: string) => string;
  signal?: AbortSignal;
  /** Test seam — defaults to {@link checkoutRelease}. */
  checkoutFn?: typeof checkoutRelease;
};

export type ComposeCheckoutOutcome = ComposeCheckoutDirs & {
  commitSha: string;
  /** False when `repo/<commit>` was already in place and was left alone. */
  fetched: boolean;
};

async function decryptCredential(
  envelope: string | undefined,
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<string | undefined> {
  if (!envelope) return undefined;
  if (!decryptSecrets) {
    throw new Error(
      "composeCheckout carries a clone credential but secrets decrypt is unavailable",
    );
  }
  const [plaintext] = await decryptSecrets([envelope]);
  if (!plaintext) throw new Error("clone credential could not be decrypted");
  return plaintext;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Move `from` to `to` with one rename. The scratch folder is under the daemon
 * state directory and the deployments under the state directory: when an
 * override puts them on different file systems the rename fails (`EXDEV`),
 * and the error says what to change rather than copying a tree that may hold
 * links.
 */
async function moveTree(from: string, to: string): Promise<void> {
  try {
    await Deno.rename(from, to);
  } catch (err) {
    if ((err as { code?: string }).code === "EXDEV") {
      throw new Error(
        "the checkout scratch folder (under the daemon state directory) is on a different file system than the deployments (under the state directory); put both on one",
      );
    }
    throw err;
  }
}

/** Move the finished tree to `repo/<commit>`. */
async function placeGeneration(
  deploymentDir: string,
  fresh: string,
  commitSha: string,
): Promise<void> {
  const parent = join(deploymentDir, COMPOSE_CHECKOUT_DIRNAME);
  const target = join(parent, commitSha);
  const partial = join(parent, `.${commitSha}.partial`);
  await Deno.mkdir(parent, { recursive: true });
  await removeIfPresent(partial);
  await moveTree(fresh, partial);
  // A leftover folder without the compose file is a half-made one.
  await removeIfPresent(target);
  await Deno.rename(partial, target);
}

/**
 * Make `repo/<commit>` the current checkout. A commit whose folder is already
 * in place (an unchanged deploy, or a rollback to a commit not yet pruned) is
 * reused as it is, never refetched or rewritten under running containers.
 */
export async function applyComposeCheckout(
  deploymentDir: string,
  checkout: EnvironmentDeployComposeCheckout,
  deps: ApplyComposeCheckoutDeps,
): Promise<ComposeCheckoutOutcome> {
  if (!isCommitSha(checkout.commitSha)) {
    throw new Error(`composeCheckout commitSha is not a commit id`);
  }
  const marker = {
    version: 1 as const,
    cloneUrl: checkout.cloneUrl,
    commitSha: checkout.commitSha,
    composePath: checkout.composePath,
  };
  const dirs = composeCheckoutDirs(
    deploymentDir,
    checkout.composePath,
    checkout.commitSha,
  );
  if (await isFile(join(dirs.root, checkout.composePath))) {
    const current = await readComposeCheckoutMarker(deploymentDir);
    if (JSON.stringify(current) !== JSON.stringify(marker)) {
      await writeComposeCheckoutMarker(deploymentDir, marker);
    }
    return { ...dirs, commitSha: checkout.commitSha, fetched: false };
  }

  const scratch = deps.scratchDir;
  await removeIfPresent(scratch);
  await Deno.mkdir(scratch, { recursive: true, mode: 0o700 });
  try {
    const credential = await decryptCredential(
      checkout.credential,
      deps.decryptSecrets,
    );
    const result = await (deps.checkoutFn ?? checkoutRelease)({
      cloneUrl: checkout.cloneUrl,
      ref: checkout.ref,
      commitSha: checkout.commitSha,
      scratchDir: scratch,
      ...(deps.onOutput ? { onOutput: deps.onOutput } : {}),
      ...(deps.redactSummary ? { redactSummary: deps.redactSummary } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(credential === undefined ? {} : {
        credential,
        ...(checkout.credentialKind
          ? { credentialKind: checkout.credentialKind }
          : {}),
        ...(checkout.credentialUsername
          ? { credentialUsername: checkout.credentialUsername }
          : {}),
      }),
    });
    if (result.commitSha !== checkout.commitSha) {
      throw new Error(
        `the clone is at ${result.commitSha}, not the commit ${checkout.commitSha} the deploy names`,
      );
    }
    if (!await isFile(join(result.workingDir, checkout.composePath))) {
      throw new Error(
        `the compose file ${checkout.composePath} is not in the repository at commit ${result.commitSha}`,
      );
    }
    await removeIfPresent(join(result.workingDir, ".git"));
    await placeGeneration(deploymentDir, result.workingDir, result.commitSha);
    await writeComposeCheckoutMarker(deploymentDir, marker);
    return { ...dirs, commitSha: result.commitSha, fetched: true };
  } finally {
    await removeIfPresent(scratch);
  }
}
