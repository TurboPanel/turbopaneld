/**
 * Network domain: interface classification and per-class aggregation.
 *
 * `parse-net-dev.ts` stays the pure line parser; this module classifies every
 * interface (loopback / container-bridge / fabric / uplink) and aggregates
 * uplink and fabric byte rates as two independent, non-additive totals.
 * Container-bridge traffic is classified but never aggregated into either.
 */
import { parseNetDev } from "./parse-net-dev.ts";
import { type NetRates, netRates } from "./rates.ts";
import type {
  NetCounters,
  NetInterfaceClassification,
  NetInterfaceCounters,
} from "./types.ts";

/** Container/bridge/virtual interface prefixes (Docker, libvirt, taps). */
const CONTAINER_BRIDGE_PREFIXES = [
  "veth",
  "docker",
  "br-",
  "virbr",
  "vnet",
  "tap",
] as const;

/**
 * Classify one interface. Fabric membership comes from the injected
 * TurboFabric interface list (seeded with `tp0`), checked before the
 * container-bridge prefixes so a fabric tunnel named like a bridge still
 * counts as fabric. Everything unmatched is an uplink.
 */
export function classifyInterface(
  name: string,
  fabricInterfaces: string[],
): NetInterfaceClassification {
  if (name === "lo") return "loopback";
  if (fabricInterfaces.includes(name)) return "fabric";
  if (CONTAINER_BRIDGE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "container-bridge";
  }
  // Generic tunnel devices (tun/tap without fabric registration) carry
  // overlay traffic already counted on the underlying uplink.
  if (name.startsWith("tun")) return "container-bridge";
  return "uplink";
}

/** Parse and classify `/proc/net/dev`; `null` when nothing is parsable. */
export function readNetCounters(
  text: string,
  fabricInterfaces: string[],
): NetCounters | null {
  const parsed = parseNetDev(text);
  if (!parsed) return null;

  const interfaces: NetCounters["interfaces"] = {};
  for (const [name, counters] of Object.entries(parsed)) {
    interfaces[name] = {
      ...counters,
      classification: classifyInterface(name, fabricInterfaces),
    };
  }
  return { interfaces };
}

/** Names of interfaces in `net` with the given classification, sorted. */
export function interfaceNamesByClass(
  net: NetCounters | null,
  classification: NetInterfaceClassification,
): string[] {
  if (!net) return [];
  return Object.entries(net.interfaces)
    .filter(([, value]) => value.classification === classification)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

function classSubset(
  net: NetCounters | null,
  classification: NetInterfaceClassification,
): Record<string, NetInterfaceCounters> | null {
  if (!net) return null;
  const subset: Record<string, NetInterfaceCounters> = {};
  for (const [name, value] of Object.entries(net.interfaces)) {
    if (value.classification !== classification) continue;
    subset[name] = {
      receiveBytes: value.receiveBytes,
      transmitBytes: value.transmitBytes,
    };
  }
  return subset;
}

/**
 * Per-second byte rates summed over one classification. Membership churn or
 * a counter reset within the class nulls only that class — a `veth` coming
 * and going never nulls uplink or fabric rates.
 */
export function classifiedNetRates(
  prev: NetCounters | null,
  curr: NetCounters | null,
  classification: NetInterfaceClassification,
  seconds: number,
): NetRates {
  return netRates(
    classSubset(prev, classification),
    classSubset(curr, classification),
    seconds,
  );
}

function singleInterfaceSubset(
  net: NetCounters | null,
  name: string,
): Record<string, NetInterfaceCounters> | null {
  if (!net) return null;
  const value = net.interfaces[name];
  if (!value) return {};
  return {
    [name]: {
      receiveBytes: value.receiveBytes,
      transmitBytes: value.transmitBytes,
    },
  };
}

/**
 * Per-second byte rates for one operator-named interface (`HardwareProfile
 * .nic1`/`.nic2`) — a parallel, independent lookup path alongside
 * classification-based aggregation, so an interface can be both part of the
 * `uplink` aggregate and individually reported as `nic1`/`nic2`. An unset
 * slot (`null` name) always nulls; an assigned slot missing from either
 * snapshot (unplugged, renamed) nulls only via the same membership-churn
 * rule `netRates` already applies to classes.
 */
export function namedInterfaceRates(
  prev: NetCounters | null,
  curr: NetCounters | null,
  name: string | null,
  seconds: number,
): NetRates {
  if (name === null) {
    return { receiveBytesPerSecond: null, transmitBytesPerSecond: null };
  }
  return netRates(
    singleInterfaceSubset(prev, name),
    singleInterfaceSubset(curr, name),
    seconds,
  );
}
