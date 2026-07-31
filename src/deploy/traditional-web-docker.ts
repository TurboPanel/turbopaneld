/**
 * Let Docker Compose services reach traditional-web vhosts on the host.
 *
 * Public ingress stays on loopback → hosting Caddy. Containers use
 * `host.docker.internal:host-gateway` and env URLs pointed at the same listen
 * ports bound on the docker bridge address.
 */

import { parse, stringify } from "yaml";

// Docker's default docker0 bridge gateway when `ip addr` lookup fails.
const DEFAULT_DOCKER_GATEWAY = "172.17.0.1"; // NOSONAR typescript:S1313 — Docker default bridge gateway fallback, not a reachable public host
const HOST_DOCKER_INTERNAL = "host.docker.internal:host-gateway";
const decoder = new TextDecoder();

export const TRADITIONAL_WEB_ENDPOINTS_ENV =
  "TURBOPANEL_TRADITIONAL_WEB_ENDPOINTS";

export type TraditionalWebDockerSite = {
  composeServiceName: string;
  listenPort: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === part;
  });
}

/** Host IP on `docker0` (containers reach the host here). Override via env. */
export async function resolveDockerHostGatewayAddress(): Promise<string> {
  const override = Deno.env.get("TURBOPANEL_DOCKER_HOST_GATEWAY")?.trim();
  if (override && isValidIpv4(override)) return override;

  const result = await new Deno.Command("ip", {
    args: ["-4", "-o", "addr", "show", "dev", "docker0"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  if (result.success) {
    const text = decoder.decode(result.stdout);
    const match = /\binet\s+(\d+\.\d+\.\d+\.\d+)/.exec(text);
    if (match?.[1] && isValidIpv4(match[1])) return match[1];
  }

  return DEFAULT_DOCKER_GATEWAY;
}

/** `TURBOPANEL_TRADITIONAL_WEB_<SERVICE>_URL` suffix from compose service name. */
export function traditionalWebEnvKeyForService(
  composeServiceName: string,
): string {
  let sanitized = composeServiceName.replaceAll(/\W/g, "_");
  if (/^\d/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return `TURBOPANEL_TRADITIONAL_WEB_${sanitized.toUpperCase()}_URL`;
}

export function buildTraditionalWebEndpointMap(
  sites: readonly TraditionalWebDockerSite[],
): Record<string, string> {
  const endpoints: Record<string, string> = {};
  for (const site of sites) {
    endpoints[site.composeServiceName] =
      `http://host.docker.internal:${site.listenPort}`;
  }
  return endpoints;
}

function mergeExtraHosts(service: Record<string, unknown>): void {
  const existing = service.extra_hosts;
  const hosts: string[] = [];
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (typeof entry === "string" && entry.length > 0) hosts.push(entry);
    }
  }
  if (!hosts.includes(HOST_DOCKER_INTERNAL)) {
    hosts.push(HOST_DOCKER_INTERNAL);
  }
  service.extra_hosts = hosts;
}

function mergeEnvironment(
  service: Record<string, unknown>,
  envEntries: Record<string, string>,
): void {
  const existing = service.environment;
  if (Array.isArray(existing)) {
    for (const [key, value] of Object.entries(envEntries)) {
      existing.push(`${key}=${value}`);
    }
    service.environment = existing;
    return;
  }
  if (isRecord(existing)) {
    service.environment = { ...existing, ...envEntries };
    return;
  }
  service.environment = { ...envEntries };
}

/**
 * Patch runtime compose so every container service can dial traditional-web
 * sites on the host (`host.docker.internal:<listenPort>`).
 */
export function injectTraditionalWebDockerReachability(
  composeYaml: string,
  sites: readonly TraditionalWebDockerSite[],
): string {
  if (sites.length === 0) return composeYaml;

  const parsed: unknown = parse(composeYaml);
  if (!isRecord(parsed) || !isRecord(parsed.services)) {
    throw new Error("Compose YAML must define a services object");
  }

  const endpoints = buildTraditionalWebEndpointMap(sites);
  const envEntries: Record<string, string> = {
    [TRADITIONAL_WEB_ENDPOINTS_ENV]: JSON.stringify(endpoints),
  };
  for (const site of sites) {
    envEntries[traditionalWebEnvKeyForService(site.composeServiceName)] =
      endpoints[site.composeServiceName] ?? "";
  }

  for (const service of Object.values(parsed.services)) {
    if (!isRecord(service)) continue;
    mergeExtraHosts(service);
    mergeEnvironment(service, envEntries);
  }

  return stringify(parsed);
}
