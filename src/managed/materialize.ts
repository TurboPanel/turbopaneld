/**
 * Materialize managed state on disk: config files, optional TLS, ownership.
 *
 * The daemon writes engine-spec config **verbatim** — it never rebuilds
 * postgresql.conf or other engine files. Ownership normalization runs a
 * throwaway container of the engine image so bind-mounted files are readable
 * by the container's engine user.
 */

import { join } from "@std/path";
import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  managedConfigDir,
  managedDir,
  resolveManagedRelativePath,
} from "./paths.ts";
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

  for (const file of payload.configFiles) {
    const dest = resolveManagedRelativePath(configDir, file.path);
    await Deno.mkdir(dirnameOf(dest), { recursive: true, mode: DIR_MODE });
    await writeManagedConfigFile(dest, file.contents, parseMode(file.mode));
  }

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
  // `docker-compose.yml`, short-lived `.env`, or `backups/` (daemon-owned).
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
        sanitizeForLog(result.stderr || result.stdout || "docker run failed")
      }`,
    );
  }

  // Verify the result AS THE ENGINE USER, with the subtrees mounted exactly
  // the way the engine compose mounts them (subdirs directly — the engine
  // never traverses the daemon-only managed root). A daemon-owned directory
  // blocks traversal even when every file inside is correctly owned, and the
  // engine then crash-loops on unreadable config/TLS with no hint in the
  // apply — fail the apply loudly instead. `su -s /bin/sh` works on both
  // shadow su (debian/ubuntu) and busybox su (alpine).
  const verifyMounts: string[] = [];
  for (const subdir of ["config", "tls"]) {
    try {
      const info = await Deno.stat(join(managedRoot, subdir));
      if (info.isDirectory) {
        verifyMounts.push("-v", `${join(managedRoot, subdir)}:/verify/${subdir}:ro`);
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  if (verifyMounts.length === 0) return;

  const verifyScript = [
    "set -eu",
    `USER_NAME=${shellSingleQuote(containerUser)}`,
    '[ ! -d /verify/config ] ||',
    '  su -s /bin/sh "$USER_NAME" -c "ls /verify/config > /dev/null" ||',
    '  { echo "engine user cannot traverse config/" >&2; exit 1; }',
    '[ ! -d /verify/tls ] ||',
    '  su -s /bin/sh "$USER_NAME" -c "ls /verify/tls > /dev/null" ||',
    '  { echo "engine user cannot traverse tls/" >&2; exit 1; }',
    "[ ! -f /verify/tls/server.crt ] ||",
    '  su -s /bin/sh "$USER_NAME" -c "cat /verify/tls/server.crt > /dev/null" ||',
    '  { echo "engine user cannot read tls/server.crt" >&2; exit 1; }',
    "[ ! -f /verify/tls/server.key ] ||",
    '  su -s /bin/sh "$USER_NAME" -c "cat /verify/tls/server.key > /dev/null" ||',
    '  { echo "engine user cannot read tls/server.key" >&2; exit 1; }',
  ].join("\n");

  const verified = await run([
    "run",
    "--rm",
    "--user",
    "0",
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
        sanitizeForLog(verified.stderr || verified.stdout || "docker run failed")
      }`,
    );
  }
}

function shellSingleQuote(value: string): string {
  const escapedSingleQuote = String.raw`'\''`;
  return `'${value.replaceAll("'", escapedSingleQuote)}'`;
}
