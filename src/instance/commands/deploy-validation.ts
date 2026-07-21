/**
 * Deploy payload validators — keep in sync with instance `src/lib/commands/deploy-validation.ts`.
 */

import { isValidHostname } from "./contracts.ts";
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployStorageMaterial,
} from "./contracts.ts";

const STORAGE_KINDS = new Set([
  "docker_volume",
  "bind_mount",
  "file",
  "directory",
]);

export function validateDeployPathPrefix(pathPrefix: string | undefined): boolean {
  if (pathPrefix === undefined) return true;
  return pathPrefix.startsWith("/");
}

export function validateDeployTargetPort(targetPort: number | undefined): boolean {
  if (targetPort === undefined) return true;
  return Number.isInteger(targetPort) && targetPort >= 1 && targetPort <= 65535;
}

export function validateDeployHostingEntry(
  hosting: EnvironmentDeployHosting,
): string | null {
  for (const hostname of hosting.hostnames) {
    if (!isValidHostname(hostname)) {
      return `invalid hostname: ${hostname}`;
    }
  }
  if (!validateDeployPathPrefix(hosting.pathPrefix)) {
    return "pathPrefix must start with /";
  }
  if (!validateDeployTargetPort(hosting.targetPort)) {
    return "targetPort must be an integer between 1 and 65535";
  }
  return null;
}

export function validateDeployHostings(
  hostings: EnvironmentDeployHosting[],
): string | null {
  for (const hosting of hostings) {
    const error = validateDeployHostingEntry(hosting);
    if (error) return error;
  }
  return null;
}

export function validateDeployStorageMaterial(
  entry: EnvironmentDeployStorageMaterial,
): string | null {
  if (!STORAGE_KINDS.has(entry.kind)) {
    return `invalid storage kind: ${entry.kind}`;
  }
  if (!entry.destinationPath) {
    return `storage ${entry.storageId} missing destinationPath`;
  }
  if (entry.kind !== "docker_volume" && !entry.composeServiceName) {
    return `storage ${entry.storageId} missing composeServiceName for mount`;
  }
  return null;
}

export function validateDeployStorageMaterialList(
  entries: EnvironmentDeployStorageMaterial[],
): string | null {
  for (const entry of entries) {
    const error = validateDeployStorageMaterial(entry);
    if (error) return error;
  }
  return null;
}
