/**
 * Materialize managed state on disk: config files, optional TLS, ownership.
 *
 * The daemon writes engine-spec config **verbatim** — it never rebuilds
 * postgresql.conf or other engine files. Ownership normalization runs a
 * throwaway container of the engine image so bind-mounted files are readable
 * by the container's engine user.
 */

import { helperLabelArgs } from "../deploy/labels.ts";
import { join } from "@std/path";
import type { ManagedApplyPayload } from "../contracts/commands-contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  managedConfigDir,
  managedDir,
  resolveManagedRelativePath,
} from "./engine-paths.ts";
import {
  type DecryptSecretsFn,
  ensureManagedSelfSignedCert,
  materializeManagedProxySqlTlsMaterial,
} from "./tls.ts";

const DIR_MODE = 0o750;
const MODE_0640 = 0o640;
const MODE_0600 = 0o600;

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

function parseMode(mode: "0640" | "0600"): number {
  return mode === "0600" ? MODE_0600 : MODE_0640;
}

/**
 * Render a failed docker run's output as a readable message.
 *
 * `sanitizeForLog` turns embedded newlines into `_` (log-injection defense),
 * which mashes multi-line stderr — e.g. a shell's own "command not found"
 * diagnostic followed by our `echo` fallback — into one unreadable run-on.
 * Split first, sanitize each line alone (never introduces a newline), join
 * for humans.
 */
function formatDockerFailure(
  result: { stderr: string; stdout: string },
): string {
  const raw = result.stderr || result.stdout || "docker run failed";
  const lines = raw
    .split(/\r?\n/)
    .map((line) => sanitizeForLog(line.trim()))
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join("; ") : "docker run failed";
}

/**
 * Write a config file under the managed config dir.
 *
 * After ownership normalization, existing files are often `root:<engineGroup>`
 * `0640` (or `<engineUser>:<engineGroup>` `0600`) — the daemon cannot open
 * them for write. It still owns the parent directory, so unlink-then-create
 * is the re-apply path (same pattern as replacing a root-owned bind-mount
 * file in place).
 */
async function writeManagedConfigFile(
  dest: string,
  contents: string,
  mode: number,
): Promise<void> {
  try {
    await Deno.remove(dest);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.writeTextFile(dest, contents);
  await Deno.chmod(dest, mode);
}

/**
 * Write config files and optional TLS material under
 * `<stateDir>/managed/<managedId>/`.
 *
 * When `payload.orgTlsMaterial` is set, `decryptSecrets` is required so the
 * leaf private key envelope can be unwrapped before writing ProxySQL PEMs.
 */
export async function materializeManagedState(
  layout: LayoutPaths,
  payload: ManagedApplyPayload,
  decryptSecrets?: DecryptSecretsFn,
): Promise<string> {
  const root = managedDir(layout, payload.managedId);
  const configDir = managedConfigDir(layout, payload.managedId);
  await Deno.mkdir(root, { recursive: true, mode: DIR_MODE });
  await Deno.mkdir(configDir, { recursive: true, mode: DIR_MODE });

  await forEachSequential(payload.configFiles, async (file) => {
    const dest = resolveManagedRelativePath(configDir, file.path);
    await Deno.mkdir(dirnameOf(dest), { recursive: true, mode: DIR_MODE });
    await writeManagedConfigFile(dest, file.contents, parseMode(file.mode));
  });

  if (payload.tlsMaterial) {
    await ensureManagedSelfSignedCert(root, payload.tlsMaterial);
  }

  if (payload.orgTlsMaterial) {
    if (!decryptSecrets) {
      throw new Error(
        "managed.apply orgTlsMaterial requires decryptSecrets",
      );
    }
    await materializeManagedProxySqlTlsMaterial(
      root,
      payload.orgTlsMaterial,
      decryptSecrets,
    );
  }

  // Standby replication passwords must not be written as durable plaintext
  // under managed/<id>/auth. Bootstrap uses a short-lived 0600 env-file for
  // pg_basebackup only; ongoing streaming relies on password seeded into the
  // data volume via `pg_basebackup -R` (postgresql.auto.conf), not managed state.

  return root;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return ".";
  return path.slice(0, idx);
}

/**
 * Normalize ownership/modes so the container engine user can read bind mounts.
 *
 * Daemon-written files are owned by the daemon user; Postgres (and peers)
 * refuse keys not owned by root-with-0640 or the DB user. Owner/group names
 * come from the engine runtime descriptor — never hardcoded here.
 *
 * Directories keep the daemon UID as owner (so re-apply can rewrite files) but
 * take the engine group + `0750` so the engine user can traverse bind mounts
 * like `./config:/etc/postgresql`. File-only chown left dirs as
 * `daemon:daemon` `0750`, which blocked the engine UID with "Permission denied"
 * on the conf path.
 */
export async function normalizeManagedFileOwnership(
  image: string,
  managedRoot: string,
  containerUser: string,
  containerGroup: string,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  // Shell script runs as root inside a throwaway engine image.
  // Scope to bind-mounted trees only (`config/`, `tls/`) — never
  // `docker-compose.yml` or the short-lived `.env` (daemon-owned). Backups
  // are not in this tree at all since v6 — they live under `backupDir`.
  // Whole-tree chown left compose as root:<engineGroup> 0640 and broke
  // re-apply with writefile Permission denied.
  // 0640 → root:<engineGroup>; 0600 → <engineUser>:<engineGroup>.
  // dirs → keep owner, set group to <engineGroup>, mode 0750.
  // Exclude `tls/proxysql/` — those PEMs are daemon-rewritten on every apply
  // (org-CA leaf for ProxySQL), not engine-bind-mounted material.
  // prune/find escapes: String.raw keeps `\(` / `\)` for the shell script.
  const pruneTlsProxySql = String
    .raw`\( -path "/managed/tls/proxysql" -o -path "/managed/tls/proxysql/*" \) -prune -o`;
  const script = [
    "set -eu",
    `USER_NAME=${shellSingleQuote(containerUser)}`,
    `GROUP_NAME=${shellSingleQuote(containerGroup)}`,
    "for TREE in /managed/config /managed/tls; do",
    '  [ -d "$TREE" ] || continue',
    `  find "$TREE" ${pruneTlsProxySql} -type f -perm 640 -exec chown "root:$GROUP_NAME" {} +`,
    `  find "$TREE" ${pruneTlsProxySql} -type f -perm 640 -exec chmod 0640 {} +`,
    `  find "$TREE" ${pruneTlsProxySql} -type f -perm 600 -exec chown "$USER_NAME:$GROUP_NAME" {} +`,
    `  find "$TREE" ${pruneTlsProxySql} -type f -perm 600 -exec chmod 0600 {} +`,
    // Group-only chown keeps the daemon UID as owner for re-apply writes.
    `  find "$TREE" ${pruneTlsProxySql} -type d -exec chown ":$GROUP_NAME" {} +`,
    `  find "$TREE" ${pruneTlsProxySql} -type d -exec chmod 0750 {} +`,
    "done",
  ].join("\n");

  const result = await run([
    "run",
    "--rm",
    ...helperLabelArgs("managed-files"),
    "--user",
    "0",
    "--entrypoint",
    "sh",
    "-v",
    `${managedRoot}:/managed`,
    image,
    "-c",
    script,
  ]);

  if (!result.success) {
    throw new Error(
      `failed to normalize managed file ownership: ${
        formatDockerFailure(result)
      }`,
    );
  }

  // Verify the result AS THE ENGINE USER, with the subtrees mounted exactly
  // the way the engine compose mounts them (subdirs directly — the engine
  // never traverses the daemon-only managed root). A daemon-owned directory
  // blocks traversal even when every file inside is correctly owned, and the
  // engine then crash-loops on unreadable config/TLS with no hint in the
  // apply — fail the apply loudly instead. Run the container directly as
  // `<engineUser>:<engineGroup>` (Docker resolves the names from the image's
  // own /etc/passwd before the entrypoint runs) instead of shelling out to
  // `su` — some engine images (e.g. Oracle's mysql:9.7-oracle) ship no `su`
  // binary at all, so a `su`-based check fails on those images regardless of
  // whether the actual ownership is correct.
  const verifyMounts: string[] = [];
  await forEachSequential(["config", "tls"], async (subdir) => {
    try {
      const info = await Deno.stat(join(managedRoot, subdir));
      if (info.isDirectory) {
        verifyMounts.push(
          "-v",
          `${join(managedRoot, subdir)}:/verify/${subdir}:ro`,
        );
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  });
  if (verifyMounts.length === 0) return;

  const verifyScript = [
    "set -eu",
    "[ ! -d /verify/config ] ||",
    "  ls /verify/config > /dev/null ||",
    '  { echo "engine user cannot traverse config/" >&2; exit 1; }',
    "[ ! -d /verify/tls ] ||",
    "  ls /verify/tls > /dev/null ||",
    '  { echo "engine user cannot traverse tls/" >&2; exit 1; }',
    "[ ! -f /verify/tls/server.crt ] ||",
    "  cat /verify/tls/server.crt > /dev/null ||",
    '  { echo "engine user cannot read tls/server.crt" >&2; exit 1; }',
    "[ ! -f /verify/tls/server.key ] ||",
    "  cat /verify/tls/server.key > /dev/null ||",
    '  { echo "engine user cannot read tls/server.key" >&2; exit 1; }',
  ].join("\n");

  const verified = await run([
    "run",
    "--rm",
    ...helperLabelArgs("managed-files"),
    "--user",
    `${containerUser}:${containerGroup}`,
    "--entrypoint",
    "sh",
    ...verifyMounts,
    image,
    "-c",
    verifyScript,
  ]);
  if (!verified.success) {
    throw new Error(
      `managed file ownership verification failed: ${
        formatDockerFailure(verified)
      }`,
    );
  }
}

/**
 * Hand the engine root password file to the engine's own user: owner
 * `<engineUser>:<engineGroup>`, mode 0400, with `secrets/` group-traversable
 * (daemon stays owner so it can replace the file). Same throwaway-root-
 * container approach as {@link normalizeManagedFileOwnership}; the secret
 * value never appears in the command line.
 */
export async function normalizeManagedSecretOwnership(
  image: string,
  managedRoot: string,
  containerUser: string,
  containerGroup: string,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  const secretsDir = join(managedRoot, "secrets");
  // Mode first, then owner: after the chown the file is no longer the
  // daemon's, and chmod on a file root does not own needs CAP_FOWNER anyway.
  // The directory is the daemon's (0700, then group-traversable for the engine
  // group only), so root also needs CAP_DAC_READ_SEARCH to reach the file in it.
  const script = [
    "set -eu",
    `USER_NAME=${shellSingleQuote(containerUser)}`,
    `GROUP_NAME=${shellSingleQuote(containerGroup)}`,
    "chmod 0750 /managed/secrets",
    'chown ":$GROUP_NAME" /managed/secrets',
    "chmod 0400 /managed/secrets/root-password",
    'chown "$USER_NAME:$GROUP_NAME" /managed/secrets/root-password',
  ].join("\n");
  // Only the secrets directory is mounted, with no network and only the three
  // capabilities needed: CHOWN and FOWNER to chown/chmod files root does not
  // own, and DAC_READ_SEARCH so root can read and search the daemon-owned 0700
  // secrets directory.
  const result = await run([
    "run",
    "--rm",
    ...helperLabelArgs("managed-files"),
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "DAC_READ_SEARCH",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "0",
    "--entrypoint",
    "sh",
    "-v",
    `${secretsDir}:/managed/secrets`,
    image,
    "-c",
    script,
  ]);
  if (!result.success) {
    throw new Error(
      `failed to hand the engine root password file to the engine user: ${
        formatDockerFailure(result)
      }`,
    );
  }

  // Fail closed: the engine user must be able to read it, or the engine
  // would crash-loop on first start with no hint.
  const verified = await run([
    "run",
    "--rm",
    ...helperLabelArgs("managed-files"),
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${containerUser}:${containerGroup}`,
    "--entrypoint",
    "sh",
    "-v",
    `${secretsDir}:/verify/secrets:ro`,
    image,
    "-c",
    'test -r /verify/secrets/root-password || { echo "engine user cannot read the root password file" >&2; exit 1; }',
  ]);
  if (!verified.success) {
    throw new Error(
      `engine root password file verification failed: ${
        formatDockerFailure(verified)
      }`,
    );
  }
}

function shellSingleQuote(value: string): string {
  const escapedSingleQuote = String.raw`'\''`;
  return `'${value.replaceAll("'", escapedSingleQuote)}'`;
}
