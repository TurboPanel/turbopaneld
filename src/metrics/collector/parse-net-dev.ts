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

export type NetInterfaceDetailedCounters = {
  rx: number;
  tx: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
};

/**
 * Fallback source for per-NIC directional stats when a sysfs
 * `statistics/<field>` file is missing (some virtual devices) — `/proc/net/dev`
 * carries the same six counters as columns, at fixed positions:
 * rx `bytes packets errs drop fifo frame compressed multicast`, tx `bytes
 * packets errs drop fifo colls carrier compressed`.
 */
export function parseNetDevDetailedCounters(
  text: string,
): Record<string, NetInterfaceDetailedCounters> {
  const interfaces: Record<string, NetInterfaceDetailedCounters> = {};

  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;

    const name = line.slice(0, colon).trim();
    if (!name || name.includes("|")) continue;

    const fields = line.slice(colon + 1).trim().split(/\s+/);
    if (fields.length < 16) continue;

    const rx = Number(fields[0]);
    const rxErrors = Number(fields[2]);
    const rxDropped = Number(fields[3]);
    const tx = Number(fields[8]);
    const txErrors = Number(fields[10]);
    const txDropped = Number(fields[11]);

    if (
      [rx, rxErrors, rxDropped, tx, txErrors, txDropped].some((n) =>
        !Number.isFinite(n)
      )
    ) {
      continue;
    }

    interfaces[name] = { rx, tx, rxErrors, txErrors, rxDropped, txDropped };
  }

  return interfaces;
}
