import { parse, stringify } from "yaml";
import type { EnvironmentDeployStorageMaterial } from "../instance/commands/contracts.ts";

type ComposeService = Record<string, unknown>;
type ComposeDocument = Record<string, unknown> & {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseComposeDocument(composeYaml: string): ComposeDocument {
  const parsed: unknown = parse(composeYaml);
  if (!isRecord(parsed)) {
    throw new Error("Compose YAML must be an object");
  }
  if (!isRecord(parsed.services)) {
    throw new Error("Compose YAML must define a services object");
  }
  return parsed as ComposeDocument;
}

function appendServiceVolume(
  service: ComposeService,
  mount: Record<string, unknown>,
): void {
  const existing = service.volumes;
  if (Array.isArray(existing)) {
    service.volumes = [...existing, mount];
    return;
  }
  service.volumes = [mount];
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

function requireComposeService(
  services: Record<string, ComposeService>,
  composeServiceName: string,
  storageId: string,
): ComposeService {
  const service = services[composeServiceName];
  if (!isRecord(service)) {
    throw new Error(
      `Compose service ${composeServiceName} not found for storage ${storageId}`,
    );
  }
  return service;
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

function applyDockerVolumeEntry(
  services: Record<string, ComposeService>,
  topVolumes: Record<string, unknown>,
  entry: EnvironmentDeployStorageMaterial,
  mountPaths: Map<string, string>,
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

  const service = requireComposeService(
    services,
    entry.composeServiceName,
    entry.storageId,
  );
  appendServiceVolume(service, {
    type: "volume",
    source: volumeName,
    target: entry.destinationPath,
  });
}

function applyBindMountEntry(
  services: Record<string, ComposeService>,
  entry: EnvironmentDeployStorageMaterial,
  mountPaths: Map<string, string>,
): void {
  const composeServiceName = requireComposeServiceName(entry);
  const service = requireComposeService(
    services,
    composeServiceName,
    entry.storageId,
  );
  const hostPath = requireMountPath(mountPaths, entry.storageId, "host path");
  appendServiceVolume(service, {
    type: "bind",
    source: hostPath,
    target: entry.destinationPath,
  });
}

function applyStorageEntry(
  services: Record<string, ComposeService>,
  topVolumes: Record<string, unknown>,
  entry: EnvironmentDeployStorageMaterial,
  mountPaths: Map<string, string>,
): void {
  if (entry.kind === "docker_volume") {
    applyDockerVolumeEntry(services, topVolumes, entry, mountPaths);
    return;
  }
  applyBindMountEntry(services, entry, mountPaths);
}

/**
 * Patch resolved host/volume paths into compose services before `compose up`.
 */
export function applyStorageVolumesToCompose(
  composeYaml: string,
  entries: EnvironmentDeployStorageMaterial[],
  mountPaths: Map<string, string>,
): string {
  const parsed = parseComposeDocument(composeYaml);
  const topVolumes = isRecord(parsed.volumes) ? { ...parsed.volumes } : {};

  for (const entry of entries) {
    applyStorageEntry(parsed.services, topVolumes, entry, mountPaths);
  }

  if (Object.keys(topVolumes).length > 0) {
    parsed.volumes = topVolumes;
  }

  return stringify(parsed);
}
