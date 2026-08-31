/**
 * Pure `/proc/net/dev` line parsing. Every interface is parsed and returned —
 * classification (loopback / container-bridge / fabric / uplink) and
 * aggregation happen afterwards in `network.ts`, never during parsing.
 */
import type { NetInterfaceCounters } from "./types.ts";

/**
 * Parse `/proc/net/dev` into per-interface rx/tx byte counters.
 * rx = column 1, tx = column 9 (1-indexed) after the `iface:` label.
 */
export function parseNetDev(
  text: string,
): Record<string, NetInterfaceCounters> | null {
  const interfaces: Record<string, NetInterfaceCounters> = {};

  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;

    const name = line.slice(0, colon).trim();
    if (!name || name.includes("|")) continue;

    const fields = line.slice(colon + 1).trim().split(/\s+/);
    if (fields.length < 9) continue;

    const rx = Number(fields[0]);
    const tx = Number(fields[8]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;

    interfaces[name] = { receiveBytes: rx, transmitBytes: tx };
  }

  if (Object.keys(interfaces).length === 0) return null;
  return interfaces;
}
