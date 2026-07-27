/**
 * Materialize managed state on disk: config files, optional TLS, ownership.
 *
 * The daemon writes engine-spec config **verbatim** — it never rebuilds
 * postgresql.conf or other engine files. Ownership normalization runs a
 * throwaway container of the engine image so bind-mounted files are readable
 * by the container's engine user.
 */

import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  managedConfigDir,
  managedDir,
  resolveManagedRelativePath,
} from "./paths.ts";
import { ensureManagedSelfSignedCert } from "./tls.ts";

const DIR_MODE = 0o750;
const MODE_0640 = 0o640;
const MODE_0600 = 0o600;

function parseMode(mode: "0640" | "0600"): number {
  return mode === "0600" ? MODE_0600 : MODE_0640;
}

/**
 * Write config files and optional TLS material under
 * `<stateDir>/managed/<managedId>/`.
 */
export async function materializeManagedState(
  layout: LayoutPaths,
  payload: ManagedApplyPayload,
): Promise<string> {
  const root = managedDir(layout, payload.managedId);
  const configDir = managedConfigDir(layout, payload.managedId);
  await Deno.mkdir(root, { recursive: true, mode: DIR_MODE });
  await Deno.mkdir(configDir, { recursive: true, mode: DIR_MODE });

  for (const file of payload.configFiles) {
    const dest = resolveManagedRelativePath(configDir, file.path);
    await Deno.mkdir(dirnameOf(dest), { recursive: true, mode: DIR_MODE });
    await Deno.writeTextFile(dest, file.contents);
    await Deno.chmod(dest, parseMode(file.mode));
  }

  if (payload.tlsMaterial) {
    await ensureManagedSelfSignedCert(root, payload.tlsMaterial);
  }

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
 */
export async function normalizeManagedFileOwnership(
  image: string,
  managedRoot: string,
  containerUser: string,
  containerGroup: string,
): Promise<void> {
  // Shell script runs as root inside a throwaway engine image.
  // 0640 → root:<engineGroup>; 0600 → <engineUser>:<engineGroup>.
  // `backups/` is pruned from every find below: backup artifacts are written
  // 0600 by the daemon user itself (`src/managed/backup.ts`) so it can read
  // them back for restore/checksum — chowning them to the container engine
  // user here would make the daemon unable to read its own dumps.
  const script = [
    "set -eu",
    `USER_NAME=${shellSingleQuote(containerUser)}`,
    `GROUP_NAME=${shellSingleQuote(containerGroup)}`,
    'find /managed -path /managed/backups -prune -o -type f -perm 640 -exec chown "root:$GROUP_NAME" {} +',
    'find /managed -path /managed/backups -prune -o -type f -perm 640 -exec chmod 0640 {} +',
    'find /managed -path /managed/backups -prune -o -type f -perm 600 -exec chown "$USER_NAME:$GROUP_NAME" {} +',
    'find /managed -path /managed/backups -prune -o -type f -perm 600 -exec chmod 0600 {} +',
    'find /managed -path /managed/backups -prune -o -type d -exec chmod 0750 {} +',
  ].join("\n");

  const result = await runDocker([
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
}

function shellSingleQuote(value: string): string {
  const escapedSingleQuote = String.raw`'\''`;
  return `'${value.replaceAll("'", escapedSingleQuote)}'`;
}
