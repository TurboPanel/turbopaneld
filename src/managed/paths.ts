/**
 * Managed-engine path helpers and identifier guards.
 *
 * Every handler validates identifiers before joining paths. Payload relative
 * paths are re-checked in {@link resolveManagedRelativePath} even when the
 * wire parser already allowlisted them.
 */

import { join } from "@std/path";
import {
  isManagedBackupArtifactExtension,
  type ManagedApplyPayload,
} from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";

export type { ManagedBackupArtifactExtension } from "../instance/commands/contracts.ts";

/** Mirrors `SAFE_FILE_ID_RE` in `src/deploy/ingress.ts`. */
export const SAFE_MANAGED_ID_RE = /^[A-Za-z0-9_-]+$/;

const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/;
const SAFE_VOLUME_NAME_RE = /^[A-Za-z_]\w*$/;
/** Hyphen-permitting; must stay in sync with instance `DOCKER_RESOURCE_NAME_RE`. */
const SAFE_CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

export function managedDir(layout: LayoutPaths, managedId: string): string {
  return join(layout.stateDir, "managed", managedId);
}

export function managedComposePath(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(managedDir(layout, managedId), "docker-compose.yml");
}

export function managedConfigDir(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(managedDir(layout, managedId), "config");
}

/** Sibling of `config/` — matches the engine-spec `./tls` mount. */
export function managedTlsDir(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(managedDir(layout, managedId), "tls");
}

export function managedEnvFilePath(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(managedDir(layout, managedId), ".env");
}

export function managedComposeProject(managedId: string): string {
  return `turbopanel-managed-${managedId}`;
}

/** Per-service managed Traefik compose project. */
export function managedIngressProject(managedId: string): string {
  return `turbopanel-managed-${managedId}-ingress`;
}

export function managedIngressDir(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(managedDir(layout, managedId), "ingress");
}

export function managedIngressComposePath(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(managedIngressDir(layout, managedId), "docker-compose.yml");
}

/**
 * `<stateDir>/managed/<managedId>/backups` — written 0600 by the daemon
 * user itself (never chowned to the container engine user; see
 * `materialize.ts` `normalizeManagedFileOwnership`, which prunes this
 * subtree).
 */
export function managedBackupsDir(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(managedDir(layout, managedId), "backups");
}

/**
 * Join a backup artifact path under `managedBackupsDir`, re-validating
 * `backupId` (same charset as `managedId` — it becomes a filename) and `ext`
 * against the extension allowlist before joining. Callers must not build
 * this path any other way.
 */
export function managedBackupArtifactPath(
  layout: LayoutPaths,
  managedId: string,
  backupId: string,
  ext: string,
): string {
  if (!SAFE_MANAGED_ID_RE.test(backupId)) {
    throw new Error("backupId contains unsupported characters");
  }
  if (!isManagedBackupArtifactExtension(ext)) {
    throw new Error(`unsupported backup artifact extension: ${ext}`);
  }
  return join(managedBackupsDir(layout, managedId), `${backupId}.${ext}`);
}

/**
 * Join `relative` under `baseDir` after re-validating the relative path.
 * Rejects absolute paths, `..`, backslashes, and shell metacharacters.
 */
export function resolveManagedRelativePath(
  baseDir: string,
  relative: string,
): string {
  if (relative.length === 0 || relative.length > 255) {
    throw new Error("managed relative path is invalid");
  }
  if (relative.startsWith("/") || relative.includes("\\")) {
    throw new Error("managed relative path must not be absolute");
  }
  if (relative.includes("..")) {
    throw new Error("managed relative path must not contain '..'");
  }
  if (SHELL_METACHAR_RE.test(relative)) {
    throw new Error("managed relative path contains unsupported characters");
  }
  const segments = relative.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error("managed relative path is invalid");
    }
  }
  return join(baseDir, ...segments);
}

const COMPOSE_SERVICE_NAME_RE = /^[A-Za-z0-9 ._-]+$/;

export function assertSafeManagedIdentifiers(
  payload: Pick<
    ManagedApplyPayload,
    | "managedId"
    | "environmentId"
    | "projectName"
    | "containerName"
    | "volumes"
    | "ingress"
  >,
): void {
  if (!SAFE_MANAGED_ID_RE.test(payload.managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  if (!SAFE_MANAGED_ID_RE.test(payload.environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }
  if (
    payload.projectName.length === 0 ||
    payload.projectName.length > 64 ||
    !COMPOSE_PROJECT_RE.test(payload.projectName)
  ) {
    throw new Error("projectName must be a valid Docker Compose project name");
  }
  if (!SAFE_CONTAINER_NAME_RE.test(payload.containerName)) {
    throw new Error("containerName contains unsupported characters");
  }
  if (payload.ingress !== undefined) {
    if (!SAFE_CONTAINER_NAME_RE.test(payload.ingress.containerName)) {
      throw new Error("ingress.containerName contains unsupported characters");
    }
    if (
      payload.ingress.composeServiceName.length === 0 ||
      payload.ingress.composeServiceName.length > 255 ||
      !COMPOSE_SERVICE_NAME_RE.test(payload.ingress.composeServiceName)
    ) {
      throw new Error(
        "ingress.composeServiceName contains unsupported characters",
      );
    }
  }
  for (const volume of payload.volumes) {
    if (
      volume.name.length === 0 ||
      volume.name.length > 63 ||
      !SAFE_VOLUME_NAME_RE.test(volume.name)
    ) {
      throw new Error(
        `volume name contains unsupported characters: ${volume.name}`,
      );
    }
  }
}
