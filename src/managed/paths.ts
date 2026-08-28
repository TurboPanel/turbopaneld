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

/**
 * Compose project for the shared ProxySQL managed ingress — the persisted
 * `managed-ingress` system-component descriptor's `serviceId` (a bare UUID),
 * never a readable literal. Callers that do not already hold the descriptor
 * read it with `readSystemComponentDescriptor(layout, 'managed-ingress')`.
 *
 * The daemon-written `docker-compose.yml` carries the same value as its
 * top-level `name:` key, so `docker compose -f <path> …` resolves the project
 * without `-p` (which is what lets the Ansible stack unit stop templating a
 * project name it cannot know at converge time).
 */
export function proxysqlProject(serviceId: string): string {
  return serviceId;
}

export function proxysqlConfigDir(layout: LayoutPaths): string {
  return join(layout.configDir, "proxysql");
}

export function proxysqlComposePath(layout: LayoutPaths): string {
  return join(proxysqlConfigDir(layout), "docker-compose.yml");
}

export function proxysqlConfigPath(layout: LayoutPaths): string {
  return join(proxysqlConfigDir(layout), "proxysql.cnf");
}

export function proxysqlTlsDir(layout: LayoutPaths): string {
  return join(proxysqlConfigDir(layout), "tls");
}

export function proxysqlDataDir(layout: LayoutPaths): string {
  return join(layout.stateDir, "proxysql");
}

export function proxysqlAdminCnfPath(layout: LayoutPaths): string {
  return join(proxysqlConfigDir(layout), "admin.cnf");
}

/** Host-wide ProxySQL → engine health-check credentials (`tp_monitor`). */
export function proxysqlMonitorCnfPath(layout: LayoutPaths): string {
  return join(proxysqlConfigDir(layout), "monitor.cnf");
}

/**
 * Compose project for the per-org Orchestrator Raft group — the persisted
 * `managed-ha` system-component descriptor's `serviceId` (a bare UUID). Same
 * compose-file `name:` contract as {@link proxysqlProject}.
 */
export function orchestratorProject(serviceId: string): string {
  return serviceId;
}

export function orchestratorConfigDir(layout: LayoutPaths): string {
  return join(layout.configDir, "orchestrator");
}

export function orchestratorComposePath(layout: LayoutPaths): string {
  return join(orchestratorConfigDir(layout), "docker-compose.yml");
}

export function orchestratorConfPath(layout: LayoutPaths): string {
  return join(orchestratorConfigDir(layout), "orchestrator.conf.json");
}

export function orchestratorApiCnfPath(layout: LayoutPaths): string {
  return join(orchestratorConfigDir(layout), "api.cnf");
}

export function orchestratorRaftCnfPath(layout: LayoutPaths): string {
  return join(orchestratorConfigDir(layout), "raft.cnf");
}

export function orchestratorTlsDir(layout: LayoutPaths): string {
  return join(orchestratorConfigDir(layout), "tls");
}

export function orchestratorDataDir(layout: LayoutPaths): string {
  return join(layout.stateDir, "orchestrator");
}

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

/**
 * Compose project for one managed engine — the bare `managedId` (already a
 * UUID), with no readable prefix. `assertSafeManagedIdentifiers` still
 * enforces `COMPOSE_PROJECT_RE` and the 64-char bound on the instance-supplied
 * `projectName`, which a lowercase UUID satisfies.
 */
export function managedComposeProject(managedId: string): string {
  return managedId;
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

export function assertSafeManagedIdentifiers(
  payload: Pick<
    ManagedApplyPayload,
    | "managedId"
    | "environmentId"
    | "projectName"
    | "containerName"
    | "volumes"
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
