/**
 * Is the shared ProxySQL frontend running with a host binding for every client
 * mapping its compose file publishes? Shared by the boot repair and by the
 * reconcile paths: a container whose publish bind failed at boot (the datacenter
 * address was not up yet) stays "running" under Docker's restart policy with
 * no bindings, and a plain `compose up -d` sees an unchanged config and leaves
 * it alone. Callers use this to decide on `--force-recreate`.
 */

import type { DockerCliResult } from "../deploy/docker-cli.ts";

export const ANY_ADDRESSES = new Set(["0.0.0.0", "::", "[::]"]);

export function normaliseAddress(address: string): string {
  let out = address.toLowerCase();
  if (out.startsWith("[")) out = out.slice(1);
  if (out.endsWith("]")) out = out.slice(0, -1);
  const zone = out.indexOf("%");
  return zone === -1 ? out : out.slice(0, zone);
}

export type Mapping = { host: string; port: number };

/** Normalise and sort the `{host, port}` pairs read from a compose file. */
export function wantedMappings(
  published: ReadonlyArray<{ host: string; port: number }>,
): Mapping[] {
  return published
    .map((m) => ({ host: normaliseAddress(m.host), port: m.port }))
    .sort((a, b) => `${a.host}:${a.port}`.localeCompare(`${b.host}:${b.port}`));
}

export function mappingKey(mappings: Mapping[]): string {
  return mappings.map((m) => `${m.host}:${m.port}`).join(",");
}

export function specificAddresses(mappings: Mapping[]): string[] {
  const out = new Set<string>();
  for (const m of mappings) if (!ANY_ADDRESSES.has(m.host)) out.add(m.host);
  return [...out];
}

/** True when every wanted mapping appears in one `NetworkSettings.Ports`. */
export function hasBindings(portsJson: string, mappings: Mapping[]): boolean {
  let ports: Record<
    string,
    Array<{ HostIp?: string; HostPort?: string }> | null
  >;
  try {
    ports = JSON.parse(portsJson) ?? {};
  } catch {
    return false;
  }
  return mappings.every((m) => {
    const bound = ports[`${m.port}/tcp`] ?? [];
    return bound.some((b) =>
      b.HostPort === String(m.port) &&
      (ANY_ADDRESSES.has(m.host) || normaliseAddress(b.HostIp ?? "") === m.host)
    );
  });
}

export type FrontendHealth =
  | { ok: true; healthy: boolean; present: boolean }
  | { ok: false; reason: string };

/**
 * Healthy means the frontend container is running AND docker shows a host
 * binding for every wanted mapping. No container yet reads as not healthy.
 */
export async function frontendBindingsHealth(
  docker: (args: string[]) => Promise<DockerCliResult>,
  composePath: string,
  wanted: Mapping[],
): Promise<FrontendHealth> {
  const ps = await docker(["compose", "-f", composePath, "ps", "-a", "-q"]);
  if (!ps.success) {
    return { ok: false, reason: ps.stderr.trim() || "docker not ready" };
  }
  const ids = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: true, healthy: false, present: false };
  const inspect = await docker([
    "inspect",
    "--format",
    "{{.State.Running}}|{{json .NetworkSettings.Ports}}",
    ...ids,
  ]);
  if (!inspect.success) {
    return { ok: false, reason: inspect.stderr.trim() || "inspect failed" };
  }
  const lines = inspect.stdout.split("\n").filter((l) => l.trim());
  const healthy = lines.length > 0 && lines.every((line) => {
    const cut = line.indexOf("|");
    return line.slice(0, cut) === "true" &&
      hasBindings(line.slice(cut + 1), wanted);
  });
  return { ok: true, healthy, present: true };
}
