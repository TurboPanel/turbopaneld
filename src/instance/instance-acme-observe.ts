/**
 * Let's Encrypt hostnames for this control plane, from the JSON sidecar
 * `instance-certs-apply` writes beside the rendered Caddyfile.
 *
 * Renewal lives in `instance-acme-renew.ts`. This module only reads the
 * sidecar. The tenant `AcmeIssuanceObserver` still probes organization
 * names; panel names are files on disk.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";

export const INSTANCE_HOSTNAME_SIDECAR = "instance-hostnames.json";

export function instanceHostnameSidecarPath(layout: LayoutPaths): string {
  return join(layout.configDir, "caddy", INSTANCE_HOSTNAME_SIDECAR);
}

export type InstanceAcmeIssuanceEventMessage = {
  type: "instance-acme-issuance-event";
  hostname: string;
  ok: boolean;
  errorMessage?: string;
  /** Installed leaf expiry. Present when the certificate file could be read. */
  notAfter?: string;
  at: string;
};

type SidecarEntry = {
  host?: unknown;
  source?: unknown;
  cert_id?: unknown;
};

/** Public-edge hostname from the instance-certs sidecar. */
export type InstanceEdgeHostname = {
  host: string;
  source: "uploaded" | "lets-encrypt";
  certId: string;
};

const EDGE_HOST_LABEL = /^[A-Za-z0-9.-]+$/;

function isEdgeSource(
  value: unknown,
): value is InstanceEdgeHostname["source"] {
  return value === "uploaded" || value === "lets-encrypt";
}

/** DNS name Caddy can serve. URL entries become hostnames. */
export function instanceSiteHostname(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) return null;
  try {
    const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const hostname = new URL(withScheme).hostname;
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Uploaded and Let's Encrypt names from the sidecar. Platform CA names stay
 * on `:8443` and are omitted. Wildcard uploaded names keep the `*.` label.
 */
export async function readInstanceEdgeHostnames(
  layout: LayoutPaths,
): Promise<InstanceEdgeHostname[]> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(instanceHostnameSidecarPath(layout));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byKey = new Map<string, InstanceEdgeHostname>();
  for (const entry of parsed) {
    const edge = edgeHostnameFromSidecar(entry);
    if (!edge) continue;
    byKey.set(`${edge.source}\0${edge.host}`, edge);
  }
  return [...byKey.values()].sort((a, b) => {
    const byHost = a.host.localeCompare(b.host);
    if (byHost !== 0) return byHost;
    return a.source.localeCompare(b.source);
  });
}

export async function readInstanceLetsEncryptHostnames(
  layout: LayoutPaths,
): Promise<string[]> {
  const entries = await readInstanceEdgeHostnames(layout);
  return entries
    .filter((entry) => entry.source === "lets-encrypt")
    .map((entry) => entry.host);
}

function edgeHostnameFromSidecar(value: unknown): InstanceEdgeHostname | null {
  if (!isSidecarEntry(value) || typeof value.host !== "string") return null;
  if (!isEdgeSource(value.source)) return null;
  const host = instanceEdgeHostname(value.host);
  if (!host) return null;
  const certId = typeof value.cert_id === "string" ? value.cert_id : "";
  return { host, source: value.source, certId };
}

/** Like {@link instanceSiteHostname}, and also a leading `*.` label. */
export function instanceEdgeHostname(host: string): string | null {
  const wildcard = wildcardHostname(host);
  if (wildcard) return wildcard;
  return instanceSiteHostname(host);
}

function wildcardHostname(host: string): string | null {
  let trimmed = host.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    trimmed = trimmed.slice(trimmed.indexOf("://") + 3);
  }
  const pathCut = trimmed.indexOf("/");
  if (pathCut >= 0) trimmed = trimmed.slice(0, pathCut);
  if (!trimmed.startsWith("*.")) return null;
  const rest = trimmed.slice(2).split(":")[0] ?? "";
  if (!EDGE_HOST_LABEL.test(rest) || rest.includes("..") || rest.length === 0) {
    return null;
  }
  return `*.${rest.toLowerCase()}`;
}

function isSidecarEntry(value: unknown): value is SidecarEntry {
  return typeof value === "object" && value !== null;
}
