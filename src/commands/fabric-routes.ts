/**
 * Kernel routes on the fabric interface `tp0`.
 *
 * `wg syncconf` only configures the WireGuard device; it adds no route. The
 * daemon therefore owns one main-table route per peer `AllowedIPs` entry
 * (peer `tp0` /32s, container prefixes, a gateway's advertised LAN ranges),
 * read back with `ip -4|-6 route show` and changed with
 * `ip route replace|del <cidr> dev tp0` (the only route shapes `tp-host`
 * allows).
 *
 * A range that already has a route on another interface (an equal route, or a
 * connected subnet that holds it, e.g. a gateway's LAN on a server that sits
 * on that LAN) is skipped: taking it over through `tp0` would cut this host
 * off from its own network. Only routes with `dev tp0` are ever removed, and
 * never one the kernel made (`proto kernel`), a link-local or multicast range,
 * or a range broader than the policy allows (`fabric-allowed-ips.ts`).
 */
import {
  parseCidrLiteral,
  type ParsedCidrLiteral,
} from "../contracts/commands-contracts.ts";
import { FABRIC_INTERFACE_NAME } from "../host/fabric-interface.ts";

const MIN_PREFIX: Readonly<Record<4 | 6, number>> = { 4: 8, 6: 48 };
const HOST_PREFIX: Readonly<Record<4 | 6, number>> = { 4: 32, 6: 128 };

/** `a.b.c.d/prefix` from its parts (well-known ranges, not hosts). */
function ipv4Range(octets: readonly number[], prefix: number): string {
  return `${octets.join(".")}/${prefix}`;
}

/** `xxxx::/prefix` from its first group (well-known ranges, not hosts). */
function ipv6Range(firstGroup: number, prefix: number): string {
  return `${firstGroup.toString(16)}::/${prefix}`;
}

/** Ranges the daemon never removes from `tp0`: link-local and multicast. */
const UNMANAGED_RANGES: readonly ParsedCidrLiteral[] = [
  ipv4Range([169, 254, 0, 0], 16),
  ipv4Range([224, 0, 0, 0], 4),
  ipv6Range(0xfe80, 10),
  ipv6Range(0xff00, 8),
].map((cidr) => parseCidrLiteral(cidr)).filter((
  parsed,
): parsed is ParsedCidrLiteral => parsed !== null);

/** `ip route` line types that are not plain unicast routes. */
const ROUTE_TYPES = new Set([
  "unreachable",
  "blackhole",
  "prohibit",
  "local",
  "broadcast",
  "multicast",
  "throw",
  "nat",
  "anycast",
]);

/** One route, keyed so that equal ranges written differently compare equal. */
export type FabricRoute = {
  key: string;
  /** Canonical text with the host bits cleared, as `ip route` accepts it. */
  cidr: string;
  parsed: ParsedCidrLiteral;
};

/** A line of `ip route show` (main table). */
export type ObservedRoute = FabricRoute & {
  dev: string | null;
  kernel: boolean;
  /** Next hop (`via`), when the route has one. */
  via: string | null;
  /** The kernel marks the route `linkdown` (its interface has no carrier). */
  linkdown: boolean;
};

export type FabricRoutePlan = {
  add: string[];
  remove: string[];
  /** Desired ranges left out because another interface already routes them. */
  skipped: { cidr: string; dev: string }[];
};

function ipv4Text(value: bigint): string {
  const octets: string[] = [];
  for (let shift = 24n; shift >= 0n; shift -= 8n) {
    octets.push(String((value >> shift) & 0xffn));
  }
  return octets.join(".");
}

function ipv6Text(value: bigint): string {
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((value >> shift) & 0xffffn).toString(16));
  }
  return groups.join(":");
}

/** A range in canonical form, or `null` when it is not a valid CIDR. */
export function fabricRoute(value: string): FabricRoute | null {
  const trimmed = value.trim();
  const parsed = parseCidrLiteral(trimmed);
  if (!parsed) return null;
  const address = parsed.version === 4
    ? ipv4Text(parsed.base)
    : ipv6Text(parsed.base);
  return {
    key: `${parsed.version}|${parsed.base}|${parsed.prefix}`,
    cidr: `${address}/${parsed.prefix}`,
    parsed,
  };
}

export function rangeInside(
  inner: ParsedCidrLiteral,
  outer: ParsedCidrLiteral,
): boolean {
  return inner.version === outer.version && inner.base >= outer.base &&
    inner.last <= outer.last;
}

export function withHostPrefix(destination: string, version: 4 | 6): string {
  if (destination.includes("/")) return destination;
  return `${destination}/${HOST_PREFIX[version]}`;
}

function tokenAfter(tokens: readonly string[], word: string): string | null {
  const index = tokens.indexOf(word);
  return index >= 0 ? tokens[index + 1] ?? null : null;
}

function isKernelRoute(tokens: readonly string[]): boolean {
  return tokenAfter(tokens, "proto") === "kernel";
}

function parseRouteLine(line: string, version: 4 | 6): ObservedRoute | null {
  const tokens = line.trim().split(/\s+/);
  const destination = tokens[0];
  if (!destination || destination === "default") return null;
  if (ROUTE_TYPES.has(destination)) return null;
  const route = fabricRoute(withHostPrefix(destination, version));
  if (route?.parsed.version !== version) return null;
  return {
    ...route,
    dev: tokenAfter(tokens, "dev"),
    kernel: isKernelRoute(tokens),
    via: tokenAfter(tokens, "via"),
    linkdown: tokens.includes("linkdown"),
  };
}

/** Unicast routes of one family from `ip -4|-6 route show` output. */
export function parseRouteShow(
  stdout: string,
  version: 4 | 6,
): ObservedRoute[] {
  const routes: ObservedRoute[] = [];
  for (const line of stdout.split("\n")) {
    const route = parseRouteLine(line, version);
    if (route) routes.push(route);
  }
  return routes;
}

/**
 * Unique canonical ranges of every peer's `AllowedIPs`, without this server's
 * own `tp0` address.
 */
export function desiredFabricRoutes(
  payload: {
    address?: string;
    peers: readonly { allowedIPs: readonly string[] }[];
  },
): FabricRoute[] {
  const ownAddress = payload.address?.split("/")[0] ?? "";
  const own = fabricRoute(
    withHostPrefix(ownAddress, ownAddress.includes(":") ? 6 : 4),
  );
  const routes = new Map<string, FabricRoute>();
  for (const peer of payload.peers) {
    for (const cidr of peer.allowedIPs) {
      const route = fabricRoute(cidr);
      if (!route || route.key === own?.key) continue;
      routes.set(route.key, route);
    }
  }
  return [...routes.values()];
}

/** The interface of another route that already covers `route`, if any. */
function conflictingDev(
  route: FabricRoute,
  others: readonly ObservedRoute[],
): string | null {
  for (const other of others) {
    const equal = other.key === route.key;
    const connected = other.kernel && rangeInside(route.parsed, other.parsed);
    if (equal || connected) return other.dev ?? "another interface";
  }
  return null;
}

/** A `tp0` route the daemon may remove when no peer wants it. */
function isManagedTp0Route(route: ObservedRoute): boolean {
  if (route.kernel) return false;
  if (route.parsed.prefix < MIN_PREFIX[route.parsed.version]) return false;
  return !UNMANAGED_RANGES.some((range) => rangeInside(route.parsed, range));
}

/**
 * What to change so `tp0` carries exactly the wanted ranges: `add` what is
 * missing, `remove` `tp0` routes nobody wants (or that another interface now
 * routes), and report the `skipped` ranges.
 */
export function planFabricRoutes(
  desired: readonly FabricRoute[],
  table: readonly ObservedRoute[],
): FabricRoutePlan {
  const onTp0 = table.filter((route) => route.dev === FABRIC_INTERFACE_NAME);
  const elsewhere = table.filter((route) =>
    route.dev !== FABRIC_INTERFACE_NAME
  );
  const wanted = new Set<string>();
  const skipped: FabricRoutePlan["skipped"] = [];
  for (const route of desired) {
    const dev = conflictingDev(route, elsewhere);
    if (dev) skipped.push({ cidr: route.cidr, dev });
    else wanted.add(route.key);
  }
  const present = new Set(onTp0.map((route) => route.key));
  const add = desired.filter((route) =>
    wanted.has(route.key) && !present.has(route.key)
  ).map((route) => route.cidr);
  const remove = onTp0.filter((route) =>
    !wanted.has(route.key) && isManagedTp0Route(route)
  ).map((route) => route.cidr);
  return { add, remove, skipped };
}

/** The plan changes nothing. */
export function fabricRoutePlanIsEmpty(plan: FabricRoutePlan): boolean {
  return plan.add.length === 0 && plan.remove.length === 0;
}
