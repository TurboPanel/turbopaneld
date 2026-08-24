/**
 * Let Docker Compose services reach site vhosts on the host.
 *
 * Public ingress stays on loopback → hosting Caddy. Containers use
 * `host.docker.internal:host-gateway` and env URLs pointed at the same listen
 * ports bound on the docker bridge address.
 */

import type { ComposeOverlayFragment } from "./compose-overlay.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";

// Docker's default docker0 bridge gateway when `ip addr` lookup fails.
const DEFAULT_DOCKER_GATEWAY = "172.17.0.1"; // NOSONAR typescript:S1313 — Docker default bridge gateway fallback, not a reachable public host
const HOST_DOCKER_INTERNAL = "host.docker.internal:host-gateway";
const decoder = new TextDecoder();

export const SITE_ENDPOINTS_ENV = "TURBOPANEL_SITE_ENDPOINTS";

export type SiteDockerEndpoint = {
  composeServiceName: string;
  listenPort: number;
};

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

/** `TURBOPANEL_SITE_<SERVICE>_URL` suffix from compose service name. */
export function siteEnvKeyForService(
  composeServiceName: string,
): string {
  let sanitized = composeServiceName.replaceAll(/\W/g, "_");
  if (/^\d/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return `TURBOPANEL_SITE_${sanitized.toUpperCase()}_URL`;
}

export function buildSiteEndpointMap(
  sites: readonly SiteDockerEndpoint[],
): Record<string, string> {
  const endpoints: Record<string, string> = {};
  for (const site of sites) {
    endpoints[site.composeServiceName] =
      `http://host.docker.internal:${site.listenPort}`;
  }
  return endpoints;
}

/**
 * Daemon-overlay fragment so every resolved container service can dial
 * sites on the host (`host.docker.internal:<listenPort>`).
 */
export function buildSiteReachabilityFragment(
  sites: readonly SiteDockerEndpoint[],
  resolved: ResolvedComposeModel,
): ComposeOverlayFragment {
  if (sites.length === 0 || resolved.serviceNames.length === 0) return {};

  const endpoints = buildSiteEndpointMap(sites);
  const envEntries: Record<string, string> = {
    [SITE_ENDPOINTS_ENV]: JSON.stringify(endpoints),
  };
  for (const site of sites) {
    envEntries[siteEnvKeyForService(site.composeServiceName)] =
      endpoints[site.composeServiceName] ?? "";
  }

  const services: Record<string, Record<string, unknown>> = {};
  for (const name of resolved.serviceNames) {
    services[name] = {
      extra_hosts: [HOST_DOCKER_INTERNAL],
      environment: { ...envEntries },
    };
  }
  return { services };
}
