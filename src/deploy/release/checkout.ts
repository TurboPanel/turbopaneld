/**
 * Sandboxed Git checkout for a source-backed release.
 *
 * The clone lands in an **ephemeral scratch directory** (never under the
 * eventual release path), so a failed or interrupted fetch can never be mistaken
 * for a publishable release.
 *
 * **Credential handling.** The decrypted clone credential never reaches git
 * through the clone URL, argv, or an environment variable the build step could
 * inherit, and it is added to the transcript deny-set *before* the first git
 * invocation, so even a git build that echoes its own remote is redacted. How
 * it *does* reach git depends on the transport, because the two auth mechanisms
 * are not interchangeable:
 *
 * - **HTTPS** (`credentialKind: 'token'`) — a private `GIT_ASKPASS` helper
 *   script (mode `0600`) answers git's `Username`/`Password` prompts with the
 *   opaque pair the control plane sent: `credentialUsername` (when the payload
 *   names one — providers differ on whether the user is load-bearing) and the
 *   decrypted credential. No provider is named or tested here.
 * - **SSH** (`credentialKind: 'ssh_key'`, `ssh://…` / `git@host:path`) — the
 *   private key is written to a `0600` identity file and named to `ssh` via
 *   `GIT_SSH_COMMAND -i … -o IdentitiesOnly=yes`. `GIT_ASKPASS` is useless here:
 *   it answers password prompts, not publickey auth.
 *
 * Both files live in the scratch directory and are unlinked in `finally`; the
 * env carries their *paths*, never the material itself.
 */

import { join } from "@std/path";
import { pumpLines } from "../../logs/line-stream.ts";
import type { CommandSummaryRedactor } from "../../logs/contracts.ts";
import { redactCommandSummary } from "../../logs/redactor.ts";

const GIT_BIN = "git";

/** Fetch ceiling. A repository that cannot clone in 10 minutes is a failure. */
export const CHECKOUT_TIMEOUT_MS = 600_000;

export type ReleaseOutputHandler = (
  stream: "stdout" | "stderr",
  line: string,
) => void;

/** How {@link CheckoutParams.credential} must be handed to git. */
export type CheckoutCredentialKind = "token" | "ssh_key";

export type CheckoutParams = {
  cloneUrl: string;
  ref: string;
  commitSha: string;
  /** Working directory the clone is created in (must already exist, 0700). */
  scratchDir: string;
  /** Decrypted clone credential (PAT / installation token / deploy key). */
  credential?: string;
  /**
   * Auth shape of `credential`. Absent falls back to the clone URL's transport
   * ({@link isSshCloneUrl}), so a payload minted before the control plane
   * started tagging the kind still clones correctly.
   */
  credentialKind?: CheckoutCredentialKind;
  /**
   * HTTPS basic-auth user to answer git's `Username` prompt with. Opaque —
   * whichever provider minted `credential` decided it. Absent falls back to
   * {@link DEFAULT_HTTPS_CREDENTIAL_USERNAME}. Ignored for `ssh_key`, which
   * has no username prompt.
   */
  credentialUsername?: string;
  onOutput?: ReleaseOutputHandler;
  redactSummary?: CommandSummaryRedactor;
};

export type CheckoutResult = {
  /** Absolute path to the checked-out working tree. */
  workingDir: string;
  /** Commit actually checked out (`git rev-parse HEAD`). */
  commitSha: string;
};

const defaultSummaryRedactor: CommandSummaryRedactor = (text) =>
  redactCommandSummary(text);

/**
 * HTTPS basic-auth user when the payload names none.
 *
 * A fallback, not a rule: it is what git-over-HTTPS wanted before the control
 * plane started stating the user, and it keeps a pre-`credentialUsername`
 * payload cloning exactly as it did. A provider that *requires* a particular
 * user says so on the payload rather than being special-cased here.
 */
export const DEFAULT_HTTPS_CREDENTIAL_USERNAME = "x-access-token";

/**
 * Askpass helper: git calls it for `Username` and `Password` separately, and
 * this answers each with the matching half of the opaque credential pair the
 * control plane handed us.
 *
 * The username is **not** decided here. Which user an HTTPS credential
 * authenticates as is provider policy — some providers ignore it, others
 * reject the token under any other user — so the payload carries it and this
 * prints it verbatim. That is why there is no provider test anywhere in this
 * file: the daemon holds a username and a password, not a GitHub token or a
 * GitLab token.
 */
function askpassScript(
  credentialValue: string,
  username: string,
): string {
  const escaped = credentialValue.replaceAll("'", `'"'"'`);
  const escapedUsername = username.replaceAll("'", `'"'"'`);
  return [
    "#!/bin/sh",
    'case "$1" in',
    `  Username*) printf '%s' '${escapedUsername}' ;;`,
    `  *) printf '%s' '${escaped}' ;;`,
    "esac",
    "",
  ].join("\n");
}

/** Payload-supplied user, else the HTTPS default. */
export function resolveCredentialUsername(
  params: Pick<CheckoutParams, "credentialUsername">,
): string {
  return params.credentialUsername && params.credentialUsername.length > 0
    ? params.credentialUsername
    : DEFAULT_HTTPS_CREDENTIAL_USERNAME;
}

/** `git@host:owner/repo.git` — the scp-like form git accepts. */
const SCP_LIKE_SSH_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

/**
 * Does this clone URL use the SSH transport?
 *
 * Mirrors the instance-side rule (`validateRepositoryUrl` /
 * `isSshCloneUrl` in `client/environments/deploy-sources.ts`) so a payload that
 * predates `credentialKind` is still handled by transport rather than by
 * assuming HTTPS and failing publickey auth.
 */
export function isSshCloneUrl(cloneUrl: string): boolean {
  return cloneUrl.startsWith("ssh://") || SCP_LIKE_SSH_RE.test(cloneUrl);
}

/** Explicit kind wins; otherwise the transport decides. */
export function resolveCredentialKind(
  params: Pick<CheckoutParams, "cloneUrl" | "credentialKind">,
): CheckoutCredentialKind {
  if (params.credentialKind) return params.credentialKind;
  return isSshCloneUrl(params.cloneUrl) ? "ssh_key" : "token";
}

/** Single-quote a path for the `GIT_SSH_COMMAND` shell string. */
function shellQuote(value: string): string {
  const escaped = value.replaceAll("'", `'"'"'`);
  return `'${escaped}'`;
}

/**
 * OpenSSH rejects a key file whose final line is not terminated, and a sealed
 * envelope round-trip is exactly where a trailing newline gets lost.
 */
function sshKeyMaterial(credentialValue: string): string {
  return credentialValue.endsWith("\n")
    ? credentialValue
    : `${credentialValue}\n`;
}

/**
 * Credential files materialized in the scratch dir for one checkout.
 *
 * Every field is a **path**, never the secret: the paths are what the git
 * environment carries, and `finally` unlinks the two that hold credential
 * material. `knownHostsPath` holds host keys, not a secret, and goes away with
 * the scratch dir like the checkout itself.
 */
export type CheckoutCredentialFiles = {
  askpassPath: string | null;
  sshKeyPath: string | null;
  knownHostsPath: string | null;
};

const NO_CREDENTIAL_FILES: CheckoutCredentialFiles = {
  askpassPath: null,
  sshKeyPath: null,
  knownHostsPath: null,
};

/**
 * Write the credential to the file shape its transport needs.
 *
 * Both files are created `0600` inside the ephemeral scratch dir, which the
 * release engine removes after the deploy either way; `finally` in
 * {@link checkoutRelease} unlinks them as soon as git is done, so the window is
 * the clone itself.
 */
export async function writeCheckoutCredentialFiles(
  params: CheckoutParams,
): Promise<CheckoutCredentialFiles> {
  if (!params.credential) return NO_CREDENTIAL_FILES;
  if (resolveCredentialKind(params) === "ssh_key") {
    const sshKeyPath = join(params.scratchDir, ".git-ssh-key");
    await Deno.writeTextFile(sshKeyPath, sshKeyMaterial(params.credential), {
      mode: 0o600,
    });
    await Deno.chmod(sshKeyPath, 0o600);
    // `accept-new` has to be able to write somewhere; point it at the scratch
    // dir so ssh never touches (or creates) a known_hosts in a real home.
    const knownHostsPath = join(params.scratchDir, ".git-known-hosts");
    await Deno.writeTextFile(knownHostsPath, "", { mode: 0o600 });
    return { askpassPath: null, sshKeyPath, knownHostsPath };
  }
  const askpassPath = join(params.scratchDir, ".git-askpass");
  await Deno.writeTextFile(
    askpassPath,
    askpassScript(params.credential, resolveCredentialUsername(params)),
    { mode: 0o600 },
  );
  await Deno.chmod(askpassPath, 0o700);
  return { askpassPath, sshKeyPath: null, knownHostsPath: null };
}

/** Best-effort unlink of every credential file this checkout wrote. */
export async function removeCheckoutCredentialFiles(
  files: CheckoutCredentialFiles,
): Promise<void> {
  for (const path of [files.askpassPath, files.sshKeyPath]) {
    if (!path) continue;
    try {
      await Deno.remove(path);
    } catch {
      // Scratch teardown removes the whole tree; a missing file is fine.
    }
  }
}

type GitRunResult = { success: boolean; stdout: string; stderr: string };

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onOutput?: ReleaseOutputHandler,
): Promise<GitRunResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECKOUT_TIMEOUT_MS);
  try {
    const child = new Deno.Command(GIT_BIN, {
      args,
      cwd,
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      pumpLines(
        child.stdout,
        onOutput ? (line) => onOutput("stdout", line) : undefined,
      ),
      pumpLines(
        child.stderr,
        onOutput ? (line) => onOutput("stderr", line) : undefined,
      ),
    ]);
    return {
      success: status.success,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        success: false,
        stdout: "",
        stderr: `git timed out after ${CHECKOUT_TIMEOUT_MS}ms`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      stdout: "",
      stderr: `git spawn failed: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Minimal, credential-free environment for git.
 *
 * `clearEnv` plus this bag is the sandbox boundary: the build step later runs
 * with its own environment, and neither inherits the daemon's. The credential
 * material is not in here — only the paths of the `0600` files that hold it,
 * both of which are unlinked as soon as the checkout finishes.
 */
export function gitEnvironment(
  files: CheckoutCredentialFiles,
  homeDir: string,
): Record<string, string> {
  // No interactive host-key or passphrase prompt; a new host or an encrypted
  // key fails the clone instead of hanging the deploy.
  const ssh = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (files.sshKeyPath) {
    // `IdentitiesOnly` keeps ssh from walking a default key or an inherited
    // agent: this release clones with the deploy key the control plane sealed
    // for it, or it fails.
    ssh.push(
      "-i",
      shellQuote(files.sshKeyPath),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
    );
    if (files.knownHostsPath) {
      ssh.push("-o", `UserKnownHostsFile=${shellQuote(files.knownHostsPath)}`);
    }
  }
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: homeDir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSH_COMMAND: ssh.join(" "),
  };
  if (files.askpassPath) env.GIT_ASKPASS = files.askpassPath;
  return env;
}

/**
 * Shallow-clone `ref` into `<scratchDir>/source`, then pin the exact commit.
 *
 * `--depth 1 --branch <ref>` covers the common branch/tag case in one round
 * trip. When the resolved `commitSha` differs from what that produced (the
 * branch moved between prepare and apply, or `ref` was itself a SHA), the clone
 * is deepened just enough to fetch and check out that exact object — the
 * control plane pinned it, so the build must not drift off it.
 */
export async function checkoutRelease(
  params: CheckoutParams,
): Promise<CheckoutResult> {
  const redactSummary = params.redactSummary ?? defaultSummaryRedactor;
  const workingDir = join(params.scratchDir, "source");
  const credentialFiles = await writeCheckoutCredentialFiles(params);
  const env = gitEnvironment(credentialFiles, params.scratchDir);
  try {
    const clone = await runGit(
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        params.ref,
        "--single-branch",
        "--no-tags",
        "--",
        params.cloneUrl,
        workingDir,
      ],
      params.scratchDir,
      env,
      params.onOutput,
    );
    if (!clone.success) {
      throw new Error(
        redactSummary(clone.stderr) || redactSummary(clone.stdout) ||
          "git clone failed",
      );
    }

    const head = await runGit(["rev-parse", "HEAD"], workingDir, env);
    const clonedSha = head.success ? head.stdout : "";
    if (clonedSha === params.commitSha) {
      return { workingDir, commitSha: clonedSha };
    }

    // The pinned commit is not what `--branch <ref>` produced — fetch it
    // explicitly rather than silently building a different commit.
    const fetch = await runGit(
      ["fetch", "--depth", "1", "origin", params.commitSha],
      workingDir,
      env,
      params.onOutput,
    );
    if (!fetch.success) {
      throw new Error(
        redactSummary(fetch.stderr) ||
          `git fetch of pinned commit failed`,
      );
    }
    const checkout = await runGit(
      ["checkout", "--detach", "FETCH_HEAD"],
      workingDir,
      env,
      params.onOutput,
    );
    if (!checkout.success) {
      throw new Error(
        redactSummary(checkout.stderr) ||
          "git checkout of pinned commit failed",
      );
    }
    const pinned = await runGit(["rev-parse", "HEAD"], workingDir, env);
    return {
      workingDir,
      commitSha: pinned.success ? pinned.stdout : params.commitSha,
    };
  } finally {
    await removeCheckoutCredentialFiles(credentialFiles);
  }
}
