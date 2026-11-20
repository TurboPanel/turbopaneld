/**
 * Check a Git Compose project's repository out into its deployment directory.
 *
 * The layout and why it is this one are in `compose-checkout-marker.ts`. This
 * module does the work: clone the pinned commit into a scratch folder beside
 * the deployment (the clone credential never touches `repo/`), drop `.git`,
 * check that the compose file the Base came from is in the tree, then swap the
 * tree into `repo/` and record the commit in `repo.json`.
 *
 * `repo/` is replaced, never updated in place, so it always equals the commit
 * the deploy names. A container that writes into it would lose the writes at
 * the next deploy; `compose-host-paths.ts` refuses a writable bind that points
 * into the checkout and tells the author to use a named volume.
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
  readComposeCheckoutMarker,
  removeComposeCheckout,
  writeComposeCheckoutMarker,
} from "./compose-checkout-marker.ts";

const SCRATCH_DIRNAME = ".checkout-scratch";
const PREVIOUS_DIRNAME = ".repo-previous";

export type ApplyComposeCheckoutDeps = {
  decryptSecrets: DecryptSecretsFn | undefined;
  onOutput?: ReleaseOutputHandler;
  redactSummary?: (text: string) => string;
  signal?: AbortSignal;
  /** Test seam — defaults to {@link checkoutRelease}. */
  checkoutFn?: typeof checkoutRelease;
};

export type ComposeCheckoutOutcome = ComposeCheckoutDirs & {
  commitSha: string;
  /** False when `repo/` already held this commit and was left alone. */
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

/** Put `fresh` in place of `<deploymentDir>/repo`, keeping the old tree until the swap is done. */
async function swapIntoPlace(
  deploymentDir: string,
  fresh: string,
): Promise<void> {
  const live = join(deploymentDir, COMPOSE_CHECKOUT_DIRNAME);
  const previous = join(deploymentDir, PREVIOUS_DIRNAME);
  await removeIfPresent(previous);
  let hadLive = true;
  try {
    await Deno.rename(live, previous);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    hadLive = false;
  }
  try {
    await Deno.rename(fresh, live);
  } catch (err) {
    if (hadLive) await Deno.rename(previous, live);
    throw err;
  }
  await removeIfPresent(previous);
}

/**
 * Bring `<deploymentDir>/repo` to the commit `checkout` names. A deployment
 * that already holds that exact commit of that repository is left as it is.
 */
export async function applyComposeCheckout(
  deploymentDir: string,
  checkout: EnvironmentDeployComposeCheckout,
  deps: ApplyComposeCheckoutDeps,
): Promise<ComposeCheckoutOutcome> {
  const dirs = composeCheckoutDirs(deploymentDir, checkout.composePath);
  const marker = await readComposeCheckoutMarker(deploymentDir);
  if (
    marker?.commitSha === checkout.commitSha &&
    marker.cloneUrl === checkout.cloneUrl &&
    marker.composePath === checkout.composePath &&
    await isFile(join(dirs.root, checkout.composePath))
  ) {
    return { ...dirs, commitSha: marker.commitSha, fetched: false };
  }

  const scratch = join(deploymentDir, SCRATCH_DIRNAME);
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
    if (!await isFile(join(result.workingDir, checkout.composePath))) {
      throw new Error(
        `the compose file ${checkout.composePath} is not in the repository at commit ${result.commitSha}`,
      );
    }
    await removeIfPresent(join(result.workingDir, ".git"));
    await swapIntoPlace(deploymentDir, result.workingDir);
    await writeComposeCheckoutMarker(deploymentDir, {
      version: 1,
      cloneUrl: checkout.cloneUrl,
      commitSha: result.commitSha,
      composePath: checkout.composePath,
    });
    return { ...dirs, commitSha: result.commitSha, fetched: true };
  } finally {
    await removeIfPresent(scratch);
  }
}

/** A deploy whose payload carries no checkout leaves no tree from an earlier one. */
export async function clearComposeCheckout(
  deploymentDir: string,
): Promise<void> {
  await removeComposeCheckout(deploymentDir);
}
