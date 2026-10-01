/**
 * Storage-copy backups: a live gzipped tar (no pause) of one copy's bytes,
 * made by a throwaway helper container so the daemon never reads a tenant's
 * files itself.
 *
 * - The copy is mounted **read-only** into the helper: a Docker volume by
 *   name, or a host directory by path. Only directories under `/srv/users/`
 *   or this host's own storage root (`<stateDir>/storage/`) are accepted —
 *   never `/var/lib/docker/volumes` or any other host path.
 * - The helper runs with no network, a read-only root filesystem and
 *   `no-new-privileges`, from an image pinned by digest. A scheduled run uses
 *   `--pull never` (the image is pulled when the policy set is applied, not
 *   when the timer fires); a manual backup may pull it first.
 * - The archive streams straight to `<artifact>.part` (0600), is checksummed,
 *   renamed into place and pruned exactly like a managed-engine dump.
 *
 * Artifacts: `<backupDir>/copies/<copyId>/<backupId>.tar.gz` for a manual
 * backup, `<backupDir>/copies/<copyId>/policy-<policyId>/…` for a scheduled
 * one (its retention prunes only that directory).
 */

import { helperLabelArgs } from "../deploy/labels.ts";
import { join } from "@std/path";
import {
  COPY_BACKUP_ARTIFACT_EXTENSION,
  type CopyBackupSource,
  isSafeCopyHostPath,
} from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  spawnDockerStreaming,
} from "../deploy/docker-cli.ts";
import { storageHostPath } from "../deploy/materialize-storage.ts";
import {
  digestFileSha256,
  pipeDumpOutput,
  pruneBackupArtifacts,
  removeIfExists,
} from "../managed/backup.ts";
import { SAFE_MANAGED_ID_RE } from "../managed/engine-paths.ts";
import { sanitizeForLog } from "../util/logger.ts";

/**
 * The helper image: Alpine 3.22's multi-arch index, pinned by digest (busybox
 * `tar`, `sh`, `find`). Changing it is a code change, never a runtime choice.
 */
export const COPY_BACKUP_HELPER_IMAGE =
  "docker.io/library/alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";

/** Tenant directories (`/srv/users/<user>/volumes/<storageId>`, explicit copy paths). */
const PRINCIPAL_ROOT = "/srv/users/";

type StreamExecOutcome = { success: boolean; stderr: string };

/** How a copy is mounted into the helper container. */
export type CopyMount =
  | { type: "volume"; name: string }
  | { type: "bind"; path: string };

export type CopyBackupDeps = {
  /** Non-streaming docker calls (volume inspect, image inspect / pull). */
  runDocker?: (args: string[]) => Promise<DockerCliResult>;
  /** Pipes the helper's stdout (the archive) into `destination`. */
  runArchive?: (
    argv: string[],
    destination: WritableStream<Uint8Array>,
  ) => Promise<StreamExecOutcome>;
};

function assertSafeId(label: string, value: string): void {
  if (!SAFE_MANAGED_ID_RE.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

/** `<backupDir>/copies/<copyId>`, plus `policy-<policyId>` for a scheduled backup. */
export function copyBackupArtifactDir(
  layout: Pick<LayoutPaths, "backupDir">,
  copyId: string,
  policyId?: string,
): string {
  assertSafeId("copyId", copyId);
  const copyDir = join(layout.backupDir, "copies", copyId);
  if (policyId === undefined) return copyDir;
  assertSafeId("policyId", policyId);
  return join(copyDir, `policy-${policyId}`);
}

export function copyBackupArtifactPath(
  layout: Pick<LayoutPaths, "backupDir">,
  copyId: string,
  backupId: string,
  policyId?: string,
): string {
  assertSafeId("backupId", backupId);
  return join(
    copyBackupArtifactDir(layout, copyId, policyId),
    `${backupId}.${COPY_BACKUP_ARTIFACT_EXTENSION}`,
  );
}

/** Whether `path` is inside one of the directories a copy may live in. */
function isAllowedCopyDirectory(layout: LayoutPaths, path: string): boolean {
  const storageRoot = `${join(layout.stateDir, "storage")}/`;
  return path.startsWith(PRINCIPAL_ROOT) || path.startsWith(storageRoot);
}

/**
 * Where the copy's bytes are, as the helper mounts them. Throws for a source
 * this host will not touch (a path outside the allowed roots).
 */
/** The copy's host directory: its own path, or the default deploy materializes. */
function copyHostPath(
  layout: LayoutPaths,
  source: CopyBackupSource,
): string | undefined {
  if (source.hostPath) return source.hostPath;
  if (!source.organizationId || !source.storageId) return undefined;
  return storageHostPath(
    layout,
    source.organizationId,
    source.storageId,
    source.copyId,
  );
}

export function resolveCopyMount(
  layout: LayoutPaths,
  source: CopyBackupSource,
): CopyMount {
  if (source.copyProvider === "docker") {
    if (!source.volumeName) {
      throw new Error("a docker copy source needs a volume name");
    }
    return { type: "volume", name: source.volumeName };
  }
  const path = copyHostPath(layout, source);
  if (!path || !isSafeCopyHostPath(path)) {
    throw new Error("the copy has no usable host directory");
  }
  if (!isAllowedCopyDirectory(layout, path)) {
    throw new Error(
      `refusing to back up ${path}: only /srv/users/ and the storage root can be backed up`,
    );
  }
  return { type: "bind", path };
}

/** A `docker --mount` value; names and paths were validated, so no `,` can occur. */
export function copyMountArg(
  mount: CopyMount,
  target: string,
  readonly: boolean,
): string {
  const kind = mount.type === "volume"
    ? `type=volume,src=${mount.name}`
    : `type=bind,src=${mount.path}`;
  return readonly ? `${kind},dst=${target},readonly` : `${kind},dst=${target}`;
}

/** The helper invocation that writes the copy's gzipped tar to stdout. */
export function copyArchiveArgv(mount: CopyMount): string[] {
  return [
    "run",
    "--rm",
    ...helperLabelArgs("backup-copy"),
    "--network",
    "none",
    "--pull",
    "never",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    copyMountArg(mount, "/src", true),
    COPY_BACKUP_HELPER_IMAGE,
    "tar",
    "-C",
    "/src",
    "-czf",
    "-",
    ".",
  ];
}

async function defaultRunArchive(
  argv: string[],
  destination: WritableStream<Uint8Array>,
): Promise<StreamExecOutcome> {
  const child = await spawnDockerStreaming(argv, { stdout: "piped" });
  return await pipeDumpOutput(child, destination);
}

/** `docker run -v <name>` would create a missing volume empty; refuse instead. */
async function assertVolumeExists(
  mount: CopyMount,
  runDocker: NonNullable<CopyBackupDeps["runDocker"]>,
): Promise<void> {
  if (mount.type !== "volume") return;
  const inspect = await runDocker(["volume", "inspect", mount.name]);
  if (!inspect.success) {
    throw new Error(`docker volume ${mount.name} not found on this host`);
  }
}

/**
 * Make sure the helper image is on this host: inspect, then pull only when it
 * is missing. Returns an error string instead of throwing, so a caller can
 * report it as a warning.
 */
export async function ensureCopyBackupImage(
  deps: Pick<CopyBackupDeps, "runDocker"> = {},
): Promise<string | undefined> {
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const inspect = await runDocker([
    "image",
    "inspect",
    COPY_BACKUP_HELPER_IMAGE,
  ]);
  if (inspect.success) return undefined;
  const pull = await runDocker(["pull", COPY_BACKUP_HELPER_IMAGE]);
  if (pull.success) return undefined;
  return `could not pull the backup helper image: ${
    sanitizeForLog(pull.stderr || "docker pull failed")
  }`;
}

/** One archive to write; `policyId` marks a scheduled backup. */
export type CopyBackupRequest = {
  source: CopyBackupSource;
  backupId: string;
  retentionKeep?: number;
  policyId?: string;
};

/** What was written — never the bytes themselves. */
export type CopyBackupArtifact = {
  path: string;
  sizeBytes: number;
  checksum: string;
  /** Artifact ids removed by the retention prune (same directory only). */
  pruned: string[];
};

async function archiveToPartFile(
  partPath: string,
  argv: string[],
  runArchive: NonNullable<CopyBackupDeps["runArchive"]>,
): Promise<void> {
  const file = await Deno.open(partPath, {
    write: true,
    create: true,
    truncate: true,
    mode: 0o600,
  });
  let outcome: StreamExecOutcome;
  try {
    outcome = await runArchive(argv, file.writable);
  } catch (err) {
    await removeIfExists(partPath);
    throw new Error(
      `copy archive failed: ${
        sanitizeForLog(err instanceof Error ? err.message : String(err))
      }`,
    );
  }
  if (!outcome.success) {
    await removeIfExists(partPath);
    throw new Error(
      `copy archive failed: ${sanitizeForLog(outcome.stderr || "tar failed")}`,
    );
  }
}

/**
 * Archive one storage copy: stream the helper's gzipped tar into
 * `<artifact>.part` (0600), checksum it, rename it into place, then prune the
 * artifact's own directory down to `retentionKeep`. Shared by the
 * `storage.backup` command and scheduled runs. Ids and the source are
 * re-checked here, so a second entry point cannot write or read elsewhere.
 */
export async function createCopyBackupArtifact(
  layout: LayoutPaths,
  request: CopyBackupRequest,
  deps: CopyBackupDeps = {},
): Promise<CopyBackupArtifact> {
  const { source } = request;
  const artifactPath = copyBackupArtifactPath(
    layout,
    source.copyId,
    request.backupId,
    request.policyId,
  );
  const mount = resolveCopyMount(layout, source);
  await assertVolumeExists(mount, deps.runDocker ?? defaultRunDocker);

  const dir = copyBackupArtifactDir(layout, source.copyId, request.policyId);
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

  const partPath = `${artifactPath}.part`;
  await archiveToPartFile(
    partPath,
    copyArchiveArgv(mount),
    deps.runArchive ?? defaultRunArchive,
  );

  const checksum = await digestFileSha256(partPath);
  const stat = await Deno.stat(partPath);
  await Deno.rename(partPath, artifactPath);
  await Deno.chmod(artifactPath, 0o600);

  const pruned = await pruneBackupArtifacts(
    dir,
    COPY_BACKUP_ARTIFACT_EXTENSION,
    request.retentionKeep,
    request.backupId,
  );
  return { path: artifactPath, sizeBytes: stat.size, checksum, pruned };
}
