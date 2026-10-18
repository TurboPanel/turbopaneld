import type { EnvironmentDeployStorageMaterial } from "../contracts/commands-contracts.ts";
import type { ComposeOverlayFragment } from "./compose-overlay.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";
import type { VolumeOwnerIds } from "./materialize-storage.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A container path is absolute with no `..` or empty step; a volume subpath is
 * relative with no `..` step. Anything else could name a place the mount was
 * never meant to reach.
 */
export function assertMountShape(
  storageId: string,
  mount: { destinationPath: string; subpath?: string },
): void {
  const steps = (path: string) => path.split("/").slice(1);
  const bad = (path: string) =>
    steps(path).some((step) => step === ".." || step === ".");
  if (
    !mount.destinationPath.startsWith("/") ||
    mount.destinationPath.includes("//") ||
    mount.destinationPath.includes("\0") ||
    bad(mount.destinationPath)
  ) {
    throw new Error(
      `storage ${storageId}: the mount path ${mount.destinationPath} must be an absolute container path without . or .. steps`,
    );
  }
  const sub = mount.subpath;
  if (
    sub !== undefined && sub.length > 0 &&
    (sub.startsWith("/") || sub.includes("//") ||
      sub.split("/").some((step) => step === ".." || step === "."))
  ) {
    throw new Error(
      `storage ${storageId}: the subpath ${sub} must be relative, without . or .. steps`,
    );
  }
}

function requireMountPath(
  mountPaths: Map<string, string>,
  locationId: string,
  label: string,
): string {
  const path = mountPaths.get(locationId);
  if (!path) {
    throw new Error(`Missing ${label} for location ${locationId}`);
  }
  return path;
}

function requireResolvedService(
  resolved: ResolvedComposeModel,
  composeServiceName: string,
  storageId: string,
): void {
  if (!isRecord(resolved.services[composeServiceName])) {
    throw new Error(
      `Compose service ${composeServiceName} not found for storage ${storageId}`,
    );
  }
}

function appendServiceVolume(
  services: Record<string, Record<string, unknown>>,
  composeServiceName: string,
  mount: Record<string, unknown>,
): void {
  const existing = services[composeServiceName] ?? {};
  const volumes = Array.isArray(existing.volumes) ? [...existing.volumes] : [];
  volumes.push(mount);
  services[composeServiceName] = { ...existing, volumes };
}

function applyMounts(
  services: Record<string, Record<string, unknown>>,
  entry: EnvironmentDeployStorageMaterial,
  source: string,
  type: "volume" | "bind",
  resolved: ResolvedComposeModel,
): void {
  for (const mount of entry.mounts) {
    if (!mount.composeServiceName) continue;
    assertMountShape(entry.storageId, mount);
    requireResolvedService(resolved, mount.composeServiceName, entry.storageId);
    const spec: Record<string, unknown> = {
      type,
      source,
      target: mount.destinationPath,
    };
    if (mount.readOnly) spec.read_only = true;
    if (
      type === "volume" &&
      typeof mount.subpath === "string" &&
      mount.subpath.length > 0
    ) {
      spec.volume = { subpath: mount.subpath };
    }
    appendServiceVolume(services, mount.composeServiceName, spec);
  }
}

function applyDockerVolumeEntry(
  services: Record<string, Record<string, unknown>>,
  topVolumes: Record<string, unknown>,
  entry: EnvironmentDeployStorageMaterial,
  mountPaths: Map<string, string>,
  resolved: ResolvedComposeModel,
): void {
  const volumeName = entry.volumeName && entry.volumeName.length > 0
    ? entry.volumeName
    : requireMountPath(
      mountPaths,
      entry.locationId,
      "docker volume path",
    );
  // Point compose at the pre-created volume (do not let Compose invent
  // `<project>_<name>` orphans).
  topVolumes[volumeName] = { name: volumeName, external: true };

  // Compose-declared volumes already have service mounts; skip append when
  // the payload has no mount rows.
  if (entry.mounts.length === 0) return;
  applyMounts(services, entry, volumeName, "volume", resolved);
}

/**
 * Run a container that mounts an owner's volume folder as the owner's user and
 * group, so what it writes belongs to the owner the folder belongs to.
 *
 * Only when the compose file names no `user:` for the service. A compose file
 * that does is never refused or rewritten: the container runs as that user,
 * and what it creates is owned by that user (see the volume ownership notes in
 * `src/deploy/AGENTS.md`).
 */
function applyVolumeUser(
  services: Record<string, Record<string, unknown>>,
  entry: EnvironmentDeployStorageMaterial,
  resolved: ResolvedComposeModel,
  ownerIds: VolumeOwnerIds | undefined,
): void {
  const ids = ownerIds?.get(entry.storageId);
  if (entry.folder === undefined || ids === undefined) return;
  const user = `${ids.uid}:${ids.gid}`;
  for (const mount of entry.mounts) {
    const name = mount.composeServiceName;
    if (!name) continue;
    const declared = resolved.services[name]?.user;
    if (declared !== undefined && declared !== null && declared !== "") {
      continue;
    }
    const existing = services[name] ?? {};
    if (existing.user !== undefined && existing.user !== user) {
      throw new Error(
        `service ${name} mounts volumes of two site owners, and one container cannot run as both`,
      );
    }
    services[name] = { ...existing, user };
  }
}

function applyBindMountEntry(
  services: Record<string, Record<string, unknown>>,
  entry: EnvironmentDeployStorageMaterial,
  mountPaths: Map<string, string>,
  resolved: ResolvedComposeModel,
  ownerIds: VolumeOwnerIds | undefined,
): void {
  if (entry.mounts.length === 0) return;
  const hostPath = requireMountPath(mountPaths, entry.locationId, "host path");
  applyMounts(services, entry, hostPath, "bind", resolved);
  applyVolumeUser(services, entry, resolved, ownerIds);
}

/**
 * Storage volume / bind-mount fragment for the daemon overlay before
 * `compose up`.
 */
export function buildStorageVolumesFragment(
  entries: EnvironmentDeployStorageMaterial[],
  mountPaths: Map<string, string>,
  resolved: ResolvedComposeModel,
  ownerIds?: VolumeOwnerIds,
): ComposeOverlayFragment {
  if (entries.length === 0) return {};

  const services: Record<string, Record<string, unknown>> = {};
  const topVolumes: Record<string, unknown> = {};

  for (const entry of entries) {
    if (entry.kind === "volume" || entry.provider === "docker") {
      applyDockerVolumeEntry(
        services,
        topVolumes,
        entry,
        mountPaths,
        resolved,
      );
    } else {
      applyBindMountEntry(services, entry, mountPaths, resolved, ownerIds);
    }
  }

  const fragment: ComposeOverlayFragment = {};
  if (Object.keys(services).length > 0) fragment.services = services;
  if (Object.keys(topVolumes).length > 0) fragment.volumes = topVolumes;
  return fragment;
}

/** A numeric user a container declares, other than the owner's, and the volume it mounts. */
export type DeclaredVolumeUser = {
  storageId: string;
  uid: number;
};

/** Why a declared user could not be given access, in plain words. */
export type UndeclaredVolumeUser = {
  storageId: string;
  composeServiceName: string;
  user: string;
};

/**
 * The uid a compose `user:` names, when it is a number (`1000` or `1000:1000`).
 * A name (`app`) lives in the image's own account list, which the host cannot
 * read, so it cannot be turned into an id here.
 */
export function numericComposeUser(declared: unknown): number | null {
  const text = typeof declared === "number" ? String(declared) : declared;
  if (typeof text !== "string") return null;
  const uid = text.split(":")[0] ?? "";
  if (!/^\d{1,10}$/.test(uid)) return null;
  const value = Number(uid);
  return Number.isSafeInteger(value) && value <= 4294967294 ? value : null;
}

/**
 * Containers that mount an owner's volume folder under a declared user other
 * than the owner's, from the compose file the owner wrote. Each distinct uid
 * per volume is returned once; root (uid 0) needs no entry. A declared user
 * given by name is returned in `named` so the caller can say it was not
 * handled. A compose file is never refused for any of this.
 */
/** The container services that mount one owner-folder volume, with the user each declares. */
function declaredMountUsers(
  entry: EnvironmentDeployStorageMaterial,
  resolved: ResolvedComposeModel,
): Array<{ name: string; declared: unknown }> {
  const out: Array<{ name: string; declared: unknown }> = [];
  for (const mount of entry.mounts) {
    const name = mount.composeServiceName;
    const declared = name ? resolved.services[name]?.user : undefined;
    const none = declared === undefined || declared === null || declared === "";
    if (name && !none) out.push({ name, declared });
  }
  return out;
}

export function declaredVolumeUsers(
  entries: readonly EnvironmentDeployStorageMaterial[],
  resolved: ResolvedComposeModel,
  ownerIds: VolumeOwnerIds | undefined,
): { users: DeclaredVolumeUser[]; named: UndeclaredVolumeUser[] } {
  const users: DeclaredVolumeUser[] = [];
  const named: UndeclaredVolumeUser[] = [];
  const seen = new Set<string>();
  const once = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const volumes = entries.filter((entry) =>
    entry.folder !== undefined && entry.kind === "directory" &&
    ownerIds?.has(entry.storageId)
  );
  for (const entry of volumes) {
    const ownerUid = ownerIds?.get(entry.storageId)?.uid;
    for (const { name, declared } of declaredMountUsers(entry, resolved)) {
      const uid = numericComposeUser(declared);
      if (uid === null && once(`${entry.storageId}:${name}`)) {
        named.push({
          storageId: entry.storageId,
          composeServiceName: name,
          user: typeof declared === "string"
            ? declared
            : JSON.stringify(declared),
        });
      } else if (
        uid !== null && uid !== 0 && uid !== ownerUid &&
        once(`${entry.storageId}:${uid}`)
      ) {
        users.push({ storageId: entry.storageId, uid });
      }
    }
  }
  return { users, named };
}
