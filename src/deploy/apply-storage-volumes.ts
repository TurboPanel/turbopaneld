import type { EnvironmentDeployStorageMaterial } from "../instance/commands/contracts.ts";
import type { ComposeOverlayFragment } from "./compose-overlay.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function applyBindMountEntry(
  services: Record<string, Record<string, unknown>>,
  entry: EnvironmentDeployStorageMaterial,
  mountPaths: Map<string, string>,
  resolved: ResolvedComposeModel,
): void {
  if (entry.mounts.length === 0) return;
  const hostPath = requireMountPath(mountPaths, entry.locationId, "host path");
  applyMounts(services, entry, hostPath, "bind", resolved);
}

/**
 * Storage volume / bind-mount fragment for the daemon overlay before
 * `compose up`.
 */
export function buildStorageVolumesFragment(
  entries: EnvironmentDeployStorageMaterial[],
  mountPaths: Map<string, string>,
  resolved: ResolvedComposeModel,
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
      applyBindMountEntry(services, entry, mountPaths, resolved);
    }
  }

  const fragment: ComposeOverlayFragment = {};
  if (Object.keys(services).length > 0) fragment.services = services;
  if (Object.keys(topVolumes).length > 0) fragment.volumes = topVolumes;
  return fragment;
}
