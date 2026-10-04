/**
 * Checks a storage copy's source right before the helper mounts it, for both
 * a backup (read-only) and a restore (read-write, as root).
 *
 * - A **host directory** must sit inside the site owner's own tree
 *   (`/srv/users/<owner>/volumes/…`) or the host's storage root, and no
 *   component below the owner's home (or below the storage root) may be a
 *   symbolic link: docker resolves a bind source as root, so a link planted in
 *   its place would redirect the mount. Behind a directory the daemon may not
 *   traverse the check is answered by tp-host, which refuses any path with a
 *   link component.
 * - A **Docker volume** must be the storage's own (its name is the storage
 *   id) or carry the project's compose label, and must be an ordinary local
 *   volume: one backed by a host directory (`device` / bind options) or a
 *   volume driver is refused.
 *
 * Not checked: the directory's owning uid (the volumes directory's ownership
 * model is not part of the wire), and the gap between this check and the
 * mount itself, which only the owner's Linux user could race.
 */

import { join } from "@std/path";
import type { CopyBackupSource } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { directoryExists } from "../permissions/privileged-read.ts";
import { sanitizeForLog } from "../util/logger.ts";

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

export type CopyGuardDeps = {
  runDocker: (args: string[]) => Promise<DockerCliResult>;
  /** Defaults to `Deno.lstat`; tests inject a fake tree. */
  lstat?: (path: string) => Promise<{ isSymlink: boolean }>;
  /** Defaults to `Deno.realPath`. */
  realPath?: (path: string) => Promise<string>;
  /** Defaults to the tp-host-backed {@link directoryExists}. */
  privilegedDirectoryExists?: (path: string) => Promise<boolean>;
};

function needsRoot(err: unknown): boolean {
  return err instanceof Deno.errors.PermissionDenied ||
    err instanceof Deno.errors.NotCapable;
}

/** The directories on the way to `path`, below `base` (`base` itself excluded), outermost first. */
function componentsBelow(base: string, path: string): string[] {
  const rest = path.slice(base.length).split("/").filter(Boolean);
  const out: string[] = [];
  let current = base;
  for (const segment of rest) {
    current = `${current}/${segment}`;
    out.push(current);
  }
  return out;
}

/**
 * Refuse `path` unless every component below `base` is a real directory (or
 * file) and the resolved path equals the lexical one.
 */
export async function assertNoSymlinkBelow(
  base: string,
  path: string,
  deps: Pick<
    CopyGuardDeps,
    "lstat" | "realPath" | "privilegedDirectoryExists"
  > = {},
): Promise<void> {
  if (path !== base && !path.startsWith(`${base}/`)) {
    throw new Error(`${path} is outside ${base}`);
  }
  const lstat = deps.lstat ?? ((p: string) => Deno.lstat(p));
  const realPath = deps.realPath ?? ((p: string) => Deno.realPath(p));
  const viaHost = deps.privilegedDirectoryExists ??
    ((p: string) => directoryExists(p));
  for (const component of componentsBelow(base, path)) {
    try {
      const info = await lstat(component);
      if (info.isSymlink) {
        throw new Error(`refusing ${path}: ${component} is a symbolic link`);
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(`directory ${path} not found on this host`);
      }
      if (!needsRoot(err)) throw err;
      // Not traversable by the daemon: tp-host answers, and refuses a path
      // with a link component, so a "yes" means none is there.
      if (!(await viaHost(path))) {
        throw new Error(
          `refusing ${path}: it could not be confirmed to be free of symbolic links`,
        );
      }
      return;
    }
  }
  try {
    // Compare below the base: the base itself may sit behind a harmless link.
    const expected = `${await realPath(base)}${path.slice(base.length)}`;
    const resolved = await realPath(path);
    if (resolved !== expected) {
      throw new Error(`refusing ${path}: it resolves to ${resolved}`);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`directory ${path} not found on this host`);
    }
    if (!needsRoot(err)) throw err;
  }
}

type VolumeInspect = {
  Driver?: unknown;
  Labels?: unknown;
  Options?: unknown;
};

function parseVolumeInspect(stdout: string): VolumeInspect {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first === "object" && first !== null) {
      return first as VolumeInspect;
    }
  } catch { /* fall through */ }
  throw new Error("could not read the docker volume's details");
}

/** Exported for tests: volume ownership and backing checks, from `docker volume inspect`. */
export function assertVolumeIsTheCopys(
  source: CopyBackupSource,
  volumeName: string,
  details: VolumeInspect,
): void {
  const driver = details.Driver ?? "local";
  if (driver !== "local") {
    throw new Error(
      `docker volume ${volumeName} does not use the local driver`,
    );
  }
  const options = details.Options;
  if (typeof options === "object" && options !== null) {
    const keys = Object.keys(options);
    if (keys.some((key) => key === "device" || key === "o")) {
      throw new Error(
        `docker volume ${volumeName} is backed by a host path and cannot be backed up`,
      );
    }
  }
  if (volumeName === source.storageId) return;
  const labels = details.Labels;
  const project = typeof labels === "object" && labels !== null
    ? (labels as Record<string, unknown>)[COMPOSE_PROJECT_LABEL]
    : undefined;
  if (source.composeProject && project === source.composeProject) return;
  throw new Error(
    `docker volume ${volumeName} does not belong to this storage or project`,
  );
}

async function assertDockerVolume(
  source: CopyBackupSource,
  volumeName: string,
  deps: CopyGuardDeps,
): Promise<void> {
  const inspect = await deps.runDocker([
    "volume",
    "inspect",
    "--format",
    "{{json .}}",
    volumeName,
  ]);
  if (!inspect.success) {
    throw new Error(`docker volume ${volumeName} not found on this host`);
  }
  try {
    assertVolumeIsTheCopys(
      source,
      volumeName,
      parseVolumeInspect(inspect.stdout),
    );
  } catch (err) {
    throw new Error(
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
  }
}

/** The directory `assertNoSymlinkBelow` starts from for a host-path copy. */
export function copyPathBase(
  layout: Pick<LayoutPaths, "stateDir">,
  source: CopyBackupSource,
  principalRoot: string,
): string {
  return source.hostPath && source.ownerUsername
    ? `${principalRoot}/${source.ownerUsername}`
    : join(layout.stateDir, "storage");
}

/** Run every check for one resolved mount; throws with the reason. */
export async function assertCopyMountSafe(
  layout: Pick<LayoutPaths, "stateDir">,
  source: CopyBackupSource,
  mount: { type: "volume"; name: string } | { type: "bind"; path: string },
  deps: CopyGuardDeps,
  principalRoot = "/srv/users",
): Promise<void> {
  if (mount.type === "volume") {
    await assertDockerVolume(source, mount.name, deps);
    return;
  }
  await assertNoSymlinkBelow(
    copyPathBase(layout, source, principalRoot),
    mount.path,
    deps,
  );
}
