import type { EnvironmentDeployStorageMaterial } from "../instance/commands/contracts.ts";
import type { ComposeOverlayFragment } from "./compose-overlay.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireMountPath(
  mountPaths: Map<string, string>,
  storageId: string,
  label: string,
): string {
  const path = mountPaths.get(storageId);
  if (!path) {
    throw new Error(`Missing ${label} for storage ${storageId}`);
  }
  return path;
}

function requireComposeServiceName(
  entry: EnvironmentDeployStorageMaterial,
): string {
  if (!entry.composeServiceName) {
    throw new Error(
      `Storage ${entry.storageId} requires composeServiceName for ${entry.kind}`,
    );
  }
  return entry.composeServiceName;
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
      entry.storageId,
      "docker volume path",
    );
  // Point compose at the pre-created volume (do not let Compose invent
  // `<project>_<name>` orphans).
  topVolumes[volumeName] = { name: volumeName, external: true };

  // Compose-declared volumes already have service mounts; skip append when
  // there is no destinationPath (or no composeServiceName).
  if (!entry.destinationPath || !entry.composeServiceName) return;

  requireResolvedService(resolved, entry.composeServiceName, entry.storageId);
  appendServiceVolume(services, entry.composeServiceName, {
    type: "volume",
    source: volumeName,
    target: entry.destinationPath,
  });
}

function applyBindMountEntry(
  services: Record<string, Record<string, unknown>>,
  entry: EnvironmentDeployStorageMaterial,
  mountPaths: Map<string, string>,
  resolved: ResolvedComposeModel,
): void {
  const composeServiceName = requireComposeServiceName(entry);
  requireResolvedService(resolved, composeServiceName, entry.storageId);
  const hostPath = requireMountPath(mountPaths, entry.storageId, "host path");
  appendServiceVolume(services, composeServiceName, {
    type: "bind",
    source: hostPath,
    target: entry.destinationPath,
  });
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
    if (entry.kind === "docker_volume") {
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
