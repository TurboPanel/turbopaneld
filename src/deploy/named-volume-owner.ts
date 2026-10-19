/**
 * Named Docker volumes for a container that runs as the site owner.
 *
 * A container that mounts one of the site owner's volume folders and names no
 * `user:` of its own is run as the owner's uid and gid (see
 * `apply-storage-volumes.ts`). A named Docker volume it also mounts is created
 * by Docker as `root:root 0755`, and that container could not write it. Before
 * the containers start, the root of each such volume is given to the same uid
 * and gid, once per volume, by running the service's own image as root for one
 * `chown` of the mount path itself. Nothing inside the volume is touched, and
 * nothing is ever given to root.
 *
 * A volume is left alone when changing its owner could break another consumer:
 * one the compose file marks `external`, a mount that is read-only, and a
 * volume another service mounts without running as the same user. Best effort:
 * an image with no `chown`, or a service that cannot be started once, only gets
 * a line in the deploy log. The deploy goes on, and the container may then not
 * be able to write the volume.
 *
 * The one-off container is `docker compose run` of the tenant's own service
 * definition (its image, mounts and limits), with only the user and the
 * entrypoint changed, so it is not a daemon helper container and does not carry
 * the helper platform label (the label test names this file). It never pulls a
 * second image or builds: an image that is missing is pulled the way `up` would
 * pull it a moment later (`pull --ignore-buildable`, so nothing is built), and
 * the run itself is `--pull never`.
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
  /** `uid:gid`, both numeric and neither root. */
  user: string;
  /** Absolute path of the volume's mount point inside the container. */
  target: string;
  /** The image the service runs: its `image:`, else the name Compose builds it under. */
  image: string;
  /** True when the service is built from source and names no image. */
  buildOnly: boolean;
};

/** A mount that was looked at and left alone, and why, in plain words. */
export type NamedVolumeOwnerSkip = {
  composeServiceName: string;
  target: string;
  reason: string;
};

export type NamedVolumeOwnerPlan = {
  targets: NamedVolumeOwnerTarget[];
  skipped: NamedVolumeOwnerSkip[];
};

const NUMERIC_USER_RE = /^(\d{1,10}):(\d{1,10})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type VolumeMount = {
  source: string;
  target: string;
  readOnly: boolean;
  subpath: string;
};

/** The long-form named-volume mounts of a service, as `docker compose config` writes them. */
function volumeMounts(
  service: Record<string, unknown> | undefined,
): VolumeMount[] {
  const volumes = service?.volumes;
  if (!Array.isArray(volumes)) return [];
  const mounts: VolumeMount[] = [];
  for (const entry of volumes) {
    if (!isRecord(entry) || entry.type !== "volume") continue;
    const { source, target } = entry;
    if (
      typeof source !== "string" || typeof target !== "string" ||
      !target.startsWith("/")
    ) continue;
    const volume = isRecord(entry.volume) ? entry.volume : {};
    mounts.push({
      source,
      target,
      readOnly: entry.read_only === true,
      subpath: typeof volume.subpath === "string" ? volume.subpath : "",
    });
  }
  return mounts;
}

function userText(value: unknown): string {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : "";
}

/** `uid:gid` when both are numeric and neither is root; otherwise `null`. */
function ownerUser(value: unknown): string | null {
  const match = NUMERIC_USER_RE.exec(userText(value));
  if (match === null || match[1] === "0" || match[2] === "0") return null;
  return userText(value);
}

/** The user a service runs as: the daemon's overlay user, else the one its compose file declares. */
function effectiveUser(
  name: string,
  overlayServices: ServiceMap,
  resolvedServices: ServiceMap,
): string {
  return userText(overlayServices[name]?.user) ||
    userText(resolvedServices[name]?.user);
}

/**
 * The named-volume mounts to give to a user. Only a service the daemon itself
 * set a numeric, non-root `user` for (the overlay's `user`, written when the
 * service mounts the owner's folder volume) is considered: a user the compose
 * file declared is the owner's own choice and is left alone. `topLevelVolumes`
 * is the compose file's own `volumes:` map, before the daemon rewrites it.
 */
export function namedVolumeOwnerTargets(
  overlayServices: ServiceMap | undefined,
  resolvedServices: ServiceMap,
  topLevelVolumes: Record<string, unknown> | undefined,
  projectName = "project",
): NamedVolumeOwnerPlan {
  const overlay = overlayServices ?? {};
  const plan: NamedVolumeOwnerPlan = { targets: [], skipped: [] };
  const claimed = new Set<string>();
  for (const name of Object.keys(overlay).sort((a, b) => a.localeCompare(b))) {
    const user = ownerUser(overlay[name]?.user);
    if (user === null) continue;
    const { image, buildOnly } = serviceImage(
      resolvedServices[name],
      projectName,
      name,
    );
    const mounts = [
      ...volumeMounts(resolvedServices[name]),
      ...volumeMounts(overlay[name]),
    ];
    for (const mount of mounts) {
      const reason = skipReason(
        { name, user, mount },
        { overlay, resolvedServices, topLevelVolumes },
      );
      if (reason !== null) {
        plan.skipped.push({
          composeServiceName: name,
          target: mount.target,
          reason,
        });
        continue;
      }
      const key = `${mount.source}|${mount.subpath}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      plan.targets.push({
        composeServiceName: name,
        user,
        target: mount.target,
        image,
        buildOnly,
      });
    }
  }
  return plan;
}

function serviceImage(
  service: Record<string, unknown> | undefined,
  projectName: string,
  name: string,
): { image: string; buildOnly: boolean } {
  const image = service?.image;
  if (typeof image === "string" && image !== "") {
    return { image, buildOnly: false };
  }
  return { image: `${projectName}-${name}`, buildOnly: true };
}

/** Why a mount is left alone, or `null` when its volume may be given to the user. */
function skipReason(
  mounting: { name: string; user: string; mount: VolumeMount },
  context: {
    overlay: ServiceMap;
    resolvedServices: ServiceMap;
    topLevelVolumes: Record<string, unknown> | undefined;
  },
): string | null {
  const { name, user, mount } = mounting;
  const declared = context.topLevelVolumes?.[mount.source];
  if (isRecord(declared) && declared.external === true) {
    return "the volume is external, so something else owns it";
  }
  if (mount.readOnly) return "the mount is read-only";
  const shared = Object.keys(context.resolvedServices).some((other) =>
    other !== name &&
    volumeMounts(context.resolvedServices[other]).some((m) =>
      m.source === mount.source
    ) &&
    effectiveUser(other, context.overlay, context.resolvedServices) !== user
  );
  return shared
    ? "another service that runs as a different user mounts the volume"
    : null;
}

/**
 * Give each target's volume root to its user. Never throws: a failure is
 * written to `log` and the deploy goes on.
 */
export async function ensureNamedVolumeOwners(
  plan: NamedVolumeOwnerPlan,
  options: {
    projectName: string;
    composePaths: readonly string[];
    run: RunDockerFn;
    log: (line: string) => void;
  },
): Promise<void> {
  for (const skip of plan.skipped) {
    options.log(
      `left ${skip.target} of ${skip.composeServiceName} as it is: ${skip.reason}`,
    );
  }
  await forEachSequential(plan.targets, async (entry) => {
    const label = `${entry.target} of ${entry.composeServiceName}`;
    try {
      if (!(await imageReady(entry, options))) {
        options.log(
          `could not give ${label} to ${entry.user}: the image is not on this host yet, so the container may not be able to write that volume`,
        );
        return;
      }
      const result = await options.run([
        ...composeFileArgs(options.projectName, options.composePaths),
        "run",
        "--pull",
        "never",
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
          `could not give ${label} to ${entry.user}; the container may not be able to write that volume (${
            firstLine(result.stderr)
          })`,
        );
      }
    } catch (err) {
      options.log(
        `could not give ${label} to ${entry.user}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

/** Whether the service's image is on the host; an image from a registry is pulled once if it is not. */
async function imageReady(
  entry: NamedVolumeOwnerTarget,
  options: {
    projectName: string;
    composePaths: readonly string[];
    run: RunDockerFn;
  },
): Promise<boolean> {
  const present = () =>
    options.run(["image", "inspect", "--format", "{{.Id}}", entry.image]);
  if ((await present()).success) return true;
  // A service built from source is never built here: `up` builds it.
  if (entry.buildOnly) return false;
  await options.run([
    ...composeFileArgs(options.projectName, options.composePaths),
    "pull",
    "--ignore-buildable",
    entry.composeServiceName,
  ]);
  return (await present()).success;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ??
    "no reason given";
}
