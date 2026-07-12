import type { NetCounters, NetInterfaceCounters } from "./types.ts";

/**
 * Container/bridge/virtual interface prefixes excluded from host-summary totals
 * to avoid double-counting Docker/bridge traffic. Per-interface metrics is
 * future work (separate event type).
 */
const EXCLUDED_PREFIXES = [
  "veth",
  "docker",
  "br-",
  "virbr",
  "vnet",
  "tap",
  "tun",
] as const;

function isExcludedInterface(name: string): boolean {
  if (name === "lo") return true;
  return EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Parse `/proc/net/dev` and return summed rx/tx byte counters.
 * rx = column 1, tx = column 9 (1-indexed) after the `iface:` label.
 */
export function parseNetDev(text: string): NetCounters | null {
  const interfaces: Record<string, NetInterfaceCounters> = {};

  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;

    const name = line.slice(0, colon).trim();
    if (!name || isExcludedInterface(name)) continue;

    const fields = line.slice(colon + 1).trim().split(/\s+/);
    if (fields.length < 9) continue;

    const rx = Number(fields[0]);
    const tx = Number(fields[8]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;

    interfaces[name] = { receiveBytes: rx, transmitBytes: tx };
  }

  if (Object.keys(interfaces).length === 0) return null;
  return { interfaces };
}

/** Exported for tests. */
export function isExcludedNetInterface(name: string): boolean {
  return isExcludedInterface(name);
}
