/**
 * Named Docker volumes for a container that runs as the site owner.
 *
 * A container that mounts one of the site owner's volume folders and names no
 * `user:` of its own is run as the owner's uid and gid (see
 * `apply-storage-volumes.ts`). A named Docker volume it also mounts is created
 * by Docker as `root:root 0755`, and that container could not write it. Before
 * the containers start, the root of each such volume is given to the same uid
 * and gid, once per mount path, by running the service's own image as root for
 * one `chown` of the mount path itself. Nothing inside the volume is touched,
 * and nothing is ever given to root.
 *
 * Best effort: an image with no `chown` (a minimal image), or a service that
 * cannot be started once, only gets a line in the deploy log. The deploy goes
 * on, and the container may then not be able to write the volume.
 */

import { composeFileArgs } from "./compose-files.ts";
import type { DockerCliResult, RunDockerOptions } from "./docker-cli.ts";
import { forEachSequential } from "../util/sequential.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

type ServiceMap = Record<string, Record<string, unknown>>;

/** One mount path of one service that needs its volume root given to a user. */
export type NamedVolumeOwnerTarget = {
  composeServiceName: string;
  /** `uid:gid`, both numeric and not root. */
  user: string;
  /** Absolute path of the volume's mount point inside the container. */
  target: string;
};

const NUMERIC_USER_RE = /^(\d{1,10}):(\d{1,10})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The long-form named-volume mounts of a service, as `docker compose config` writes them. */
function namedVolumeTargets(
  service: Record<string, unknown> | undefined,
): string[] {
  const volumes = service?.volumes;
  if (!Array.isArray(volumes)) return [];
  const targets: string[] = [];
  for (const entry of volumes) {
    if (!isRecord(entry) || entry.type !== "volume") continue;
    const target = entry.target;
    if (typeof target === "string" && target.startsWith("/")) {
      targets.push(target);
    }
  }
  return targets;
}

/**
 * The named-volume mount paths to give to a user. Only a service the daemon
 * itself set a numeric, non-root `user` for (the overlay's `user`, written when
 * the service mounts the owner's folder volume) is returned: a user the
 * compose file declared is the owner's own choice and is left alone.
 */
export function namedVolumeOwnerTargets(
  overlayServices: ServiceMap | undefined,
  resolvedServices: ServiceMap,
): NamedVolumeOwnerTarget[] {
  const out: NamedVolumeOwnerTarget[] = [];
  for (const [name, overlay] of Object.entries(overlayServices ?? {})) {
    const user = overlay.user;
    if (typeof user !== "string") continue;
    const match = NUMERIC_USER_RE.exec(user);
    if (match === null || match[1] === "0") continue;
    const targets = new Set([
      ...namedVolumeTargets(resolvedServices[name]),
      ...namedVolumeTargets(overlay),
    ]);
    for (const target of [...targets].sort()) {
      out.push({ composeServiceName: name, user, target });
    }
  }
  return out;
}

/**
 * Give each target's volume root to its user. Never throws: a failure is
 * written to `log` and the deploy goes on.
 */
export async function ensureNamedVolumeOwners(
  targets: readonly NamedVolumeOwnerTarget[],
  options: {
    projectName: string;
    composePaths: readonly string[];
    run: RunDockerFn;
    log: (line: string) => void;
  },
): Promise<void> {
  await forEachSequential(targets, async (entry) => {
    try {
      const result = await options.run([
        ...composeFileArgs(options.projectName, options.composePaths),
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--user",
        "0",
        "--entrypoint",
        "chown",
        entry.composeServiceName,
        entry.user,
        entry.target,
      ]);
      if (!result.success) {
        options.log(
          `could not give ${entry.target} of ${entry.composeServiceName} to ${entry.user}; the container may not be able to write that volume (${
            firstLine(result.stderr)
          })`,
        );
      }
    } catch (err) {
      options.log(
        `could not give ${entry.target} of ${entry.composeServiceName} to ${entry.user}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ??
    "no reason given";
}
