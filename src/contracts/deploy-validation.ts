/**
 * Deploy payload validators — keep in sync with instance `src/contracts/commands/deploy-validation.ts`.
 */

import { isValidHostname, wwwSiblingHostname } from "./commands-contracts.ts";
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployStorageMaterial,
} from "./commands-contracts.ts";

const STORAGE_KINDS = new Set(["volume", "directory", "file"]);
const STORAGE_PROVIDERS = new Set(["docker", "path"]);
const DOCKER_RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

export function validateDeployPathPrefix(
  pathPrefix: string | undefined,
): boolean {
  if (pathPrefix === undefined) return true;
  return pathPrefix.startsWith("/");
}

export function normalizeDeployPathPrefix(
  pathPrefix: string | undefined,
): string | undefined {
  if (pathPrefix === undefined) return undefined;
  const trimmed = pathPrefix.trim();
  if (trimmed.length === 0 || trimmed === "/") return undefined;
  return trimmed;
}

export function pathPrefixHasUnsupportedCharacters(
  pathPrefix: string,
): boolean {
  return pathPrefix.includes("`") || /[\r\n]/.test(pathPrefix);
}

type HostnameRoutingState = {
  catchAllCount: number;
  prefixes: Set<string>;
  bindAddress?: string;
  hasAcme: boolean;
  hasDisabledHttps: boolean;
};

function getOrCreateHostnameState(
  byHostname: Map<string, HostnameRoutingState>,
  hostname: string,
): HostnameRoutingState {
  let state = byHostname.get(hostname);
  if (!state) {
    state = {
      catchAllCount: 0,
      prefixes: new Set(),
      hasAcme: false,
      hasDisabledHttps: false,
    };
    byHostname.set(hostname, state);
  }
  return state;
}

function recordHostnamePathPrefix(
  state: HostnameRoutingState,
  hostname: string,
  pathPrefix: string | undefined,
): string | null {
  const normalized = normalizeDeployPathPrefix(pathPrefix);
  if (normalized === undefined) {
    state.catchAllCount += 1;
    return null;
  }
  if (!validateDeployPathPrefix(normalized)) {
    return "pathPrefix must start with /";
  }
  if (pathPrefixHasUnsupportedCharacters(normalized)) {
    return `pathPrefix contains unsupported characters for hostname ${hostname}`;
  }
  if (state.prefixes.has(normalized)) {
    return `duplicate pathPrefix ${normalized} for hostname ${hostname}`;
  }
  state.prefixes.add(normalized);
  return null;
}

function recordHostnameBindAddress(
  state: HostnameRoutingState,
  hostname: string,
  bindAddress: string | undefined,
): string | null {
  if (!bindAddress) return null;
  if (state.bindAddress && state.bindAddress !== bindAddress) {
    return `conflicting bindAddress for hostname ${hostname}`;
  }
  state.bindAddress = bindAddress;
  return null;
}

function findDuplicateCatchAllHostname(
  byHostname: Map<string, HostnameRoutingState>,
): string | null {
  for (const [hostname, state] of byHostname) {
    if (state.catchAllCount > 1) {
      return `multiple catch-all hostings for hostname ${hostname}`;
    }
  }
  return null;
}

function recordHostnameAcmeHttps(
  state: HostnameRoutingState,
  hostname: string,
  hosting: EnvironmentDeployHosting,
): string | null {
  if (hosting.tlsMode === "acme") {
    state.hasAcme = true;
  }
  if (hosting.proxy?.forceHttps === false) {
    state.hasDisabledHttps = true;
  }
  if (state.hasAcme && state.hasDisabledHttps) {
    return `forceHttps:false is incompatible with ACME TLS on hostname ${hostname}`;
  }
  return null;
}

/**
 * HTTP hostings that share a hostname must have unique path prefixes and at most
 * one catch-all route; bind addresses must agree when set. A hostname that
 * resolves to `tlsMode: "acme"` cannot share a `forceHttps: false` route —
 * Caddy needs the HTTPS site to issue the certificate.
 *
 * Keep in sync with instance `src/contracts/commands/deploy-validation.ts`.
 */
export function validateDeployHostnameRouting(
  hostings: EnvironmentDeployHosting[],
): string | null {
  const byHostname = new Map<string, HostnameRoutingState>();

  for (const hosting of hostings) {
    if ((hosting.protocol ?? "http") !== "http") continue;
    for (const hostname of hosting.hostnames) {
      const state = getOrCreateHostnameState(byHostname, hostname);

      const pathError = recordHostnamePathPrefix(
        state,
        hostname,
        hosting.pathPrefix,
      );
      if (pathError) return pathError;

      const bindError = recordHostnameBindAddress(
        state,
        hostname,
        hosting.bindAddress,
      );
      if (bindError) return bindError;

      const acmeError = recordHostnameAcmeHttps(state, hostname, hosting);
      if (acmeError) return acmeError;
    }
  }

  return findDuplicateCatchAllHostname(byHostname);
}

function isHttpHosting(hosting: EnvironmentDeployHosting): boolean {
  return (hosting.protocol ?? "http") === "http";
}

function validateWwwHostnames(
  hosting: EnvironmentDeployHosting,
  typed: ReadonlySet<string>,
): string | null {
  for (const hostname of hosting.hostnames) {
    const sibling = wwwSiblingHostname(hostname);
    if (sibling === null) {
      return `www: ${hostname} has no www or bare spelling to use`;
    }
    if (typed.has(sibling)) {
      return `www: ${sibling} is already a hostname in this environment, so ${hostname} cannot also claim it`;
    }
  }
  return null;
}

/** Hostings on different paths of one name must make the same www choice. */
function findMixedWwwModes(
  hostings: readonly EnvironmentDeployHosting[],
): string | null {
  const modeByName = new Map<string, string>();
  for (const hosting of hostings) {
    const mode = hosting.www ?? "off";
    for (const hostname of hosting.hostnames) {
      const seen = modeByName.get(hostname);
      if (seen !== undefined && seen !== mode) {
        return `www: every path of ${hostname} must use the same www choice (found ${seen} and ${mode})`;
      }
      modeByName.set(hostname, mode);
    }
  }
  return null;
}

/**
 * `www` answers on a second name per hostname, so it only makes sense on
 * `http`, every such name must be a valid hostname, none may already be a
 * hostname in the same deploy (that would be two sites for one name), every
 * path of one name must make the same choice (so one spelling is never a
 * redirect for one path and the site for another).
 */
export function validateDeployWwwModes(
  hostings: EnvironmentDeployHosting[],
): string | null {
  const http = hostings.filter(isHttpHosting);
  const typed = new Set(http.flatMap((hosting) => hosting.hostnames));
  for (const hosting of hostings.filter((h) => h.www !== undefined)) {
    const error = isHttpHosting(hosting)
      ? validateWwwHostnames(hosting, typed)
      : "www requires the http protocol";
    if (error) return error;
  }
  return findMixedWwwModes(http);
}

export function validateDeployTargetPort(
  targetPort: number | undefined,
): boolean {
  if (targetPort === undefined) return true;
  return Number.isInteger(targetPort) && targetPort >= 1 && targetPort <= 65535;
}

function validateDeployHostingPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function validateDeployHostingEntry(
  hosting: EnvironmentDeployHosting,
): string | null {
  const protocol = hosting.protocol ?? "http";

  if (protocol === "http") {
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

  if (!hosting.ports || hosting.ports.length === 0) {
    return `hostings[].ports must not be empty for ${protocol} protocol`;
  }
  for (const port of hosting.ports) {
    if (
      !validateDeployHostingPort(port.published) ||
      !validateDeployHostingPort(port.target)
    ) {
      return "hostings[].ports entries must be integers between 1 and 65535";
    }
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
  return (
    validateDeployHostnameRouting(hostings) ??
      validateDeployWwwModes(hostings)
  );
}

function validateStorageKindAndProvider(
  entry: EnvironmentDeployStorageMaterial,
): string | null {
  if (!STORAGE_KINDS.has(entry.kind)) {
    return `invalid storage kind: ${entry.kind}`;
  }
  if (!STORAGE_PROVIDERS.has(entry.provider)) {
    return `invalid storage provider: ${entry.provider}`;
  }
  if (entry.kind === "volume" && entry.provider !== "docker") {
    return `storage ${entry.storageId} volume kind requires docker provider`;
  }
  if (entry.kind !== "volume" && entry.provider !== "path") {
    return `storage ${entry.storageId} ${entry.kind} kind requires path provider`;
  }
  return null;
}

function validateDockerVolumeName(
  entry: EnvironmentDeployStorageMaterial,
): string | null {
  if (entry.provider !== "docker") return null;
  if (typeof entry.volumeName !== "string" || entry.volumeName.length === 0) {
    return `storage ${entry.storageId} missing volumeName`;
  }
  if (!DOCKER_RESOURCE_NAME_RE.test(entry.volumeName)) {
    return `storage ${entry.storageId} has invalid volumeName`;
  }
  return null;
}

function validateStorageMounts(
  entry: EnvironmentDeployStorageMaterial,
): string | null {
  for (const mount of entry.mounts) {
    if (!mount.destinationPath) {
      return `storage ${entry.storageId} mount missing destinationPath`;
    }
    if (!mount.composeServiceName) {
      return `storage ${entry.storageId} missing composeServiceName for mount`;
    }
  }
  return null;
}

export function validateDeployStorageMaterial(
  entry: EnvironmentDeployStorageMaterial,
): string | null {
  return (
    validateStorageKindAndProvider(entry) ??
      validateDockerVolumeName(entry) ??
      validateStorageMounts(entry)
  );
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
