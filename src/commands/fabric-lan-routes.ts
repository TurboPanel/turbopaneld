/**
 * Routes to other members' container subnets over a shared trusted LAN
 * (`server.fabric.reconcile` `lanRoutes`, `fabric-lan-routes-v1`).
 *
 * Two servers on the same trusted datacenter network have no tunnel between
 * them: each container subnet of the other member is routed via that member's
 * LAN address, `ip route replace <cidr> via <via> dev <nic>`, where `<nic>` is
 * the local interface whose connected subnet holds `<via>`. The daemon finds
 * the interface itself from the main table it already reads for `tp0`.
 *
 * Safety, as for the `tp0` routes (`fabric-routes.ts`): a range another
 * interface already routes (an equal route that is not ours, or a connected
 * subnet that holds it) is skipped, and so is a range that overlaps a local
 * bridge subnet. Only routes the daemon recorded as installed are removed, and
 * only when the table still shows exactly that route (`cidr`, `via`, `dev`).
 *
 * IPv6 entries are validated but not installed: container forwarding
 * (`TP-FORWARD`) is IPv4 only, and the host wrapper takes only the IPv4 form.
 *
 * Return path: the peer's container traffic arrives on the LAN interface with
 * its container address as the source. Strict reverse-path filtering looks up
 * the route back to that source; the installed LAN route sends it out of the
 * same interface, so the packet passes without loosening `rp_filter`. Replies
 * from a local container arrive on its bridge, whose connected subnet is the
 * route back. This holds only for routes actually installed: a skipped range
 * has no route back over the LAN, so its traffic does not flow (its warning
 * says so).
 */
import type { FabricReconcileLanRoute } from "../contracts/commands-contracts.ts";
import {
  claimsOwnAddress,
  fabricRangeProblem,
  rangesOverlap,
} from "./fabric-allowed-ips.ts";
import {
  type FabricRoute,
  fabricRoute,
  type ObservedRoute,
  rangeInside,
} from "./fabric-routes.ts";
import { FABRIC_INTERFACE_NAME } from "../host/fabric-interface.ts";

/** A LAN route the daemon installed, as recorded in `state.json`. */
export type InstalledLanRoute = {
  cidr: string;
  via: string;
  dev: string;
};

export type LanRouteSkip = { cidr: string; via: string; reason: string };

export type LanRoutePlan = {
  /** Routes to install (`ip route replace`). */
  add: InstalledLanRoute[];
  /** Desired routes already present exactly as wanted. */
  keep: InstalledLanRoute[];
  /** Routes this daemon installed earlier that nothing wants any more. */
  remove: InstalledLanRoute[];
  skipped: LanRouteSkip[];
};

type LanPolicyPayload = {
  address?: string;
  prefix: string;
  peers: readonly { allowedIPs: readonly string[] }[];
  lanRoutes?: readonly FabricReconcileLanRoute[];
};

/** Interfaces a LAN route never uses. */
const NEVER_LAN_DEVS = new Set([FABRIC_INTERFACE_NAME, "lo"]);

function sameRange(a: string, b: string): boolean {
  const left = fabricRoute(a)?.key;
  return left !== undefined && left === fabricRoute(b)?.key;
}

function peerClaims(cidr: string, payload: LanPolicyPayload): boolean {
  return payload.peers.some((peer) =>
    peer.allowedIPs.some((range) => sameRange(range, cidr))
  );
}

function overlapsEarlierLanRoute(
  cidr: string,
  index: number,
  routes: readonly FabricReconcileLanRoute[],
): string | null {
  for (const earlier of routes.slice(0, index)) {
    if (rangesOverlap(cidr, earlier.cidr)) return earlier.cidr;
  }
  return null;
}

function lanRouteProblem(
  route: FabricReconcileLanRoute,
  index: number,
  payload: LanPolicyPayload,
): string | null {
  const problem = fabricRangeProblem(route.cidr);
  if (problem) return problem;
  if (claimsOwnAddress(route.cidr, payload)) {
    return `${route.cidr} overlaps this server's own fabric range`;
  }
  if (peerClaims(route.cidr, payload)) {
    return `${route.cidr} is also a tunnel peer's range`;
  }
  const clash = overlapsEarlierLanRoute(
    route.cidr,
    index,
    payload.lanRoutes ?? [],
  );
  if (clash) return `${route.cidr} overlaps another LAN route ${clash}`;
  return null;
}

/**
 * `null` when every `lanRoutes` entry passes the same private-range policy as
 * a peer's AllowedIPs, otherwise a plain message naming the first bad entry.
 * One bad entry fails the whole payload.
 */
export function fabricLanRoutesPolicyError(
  payload: LanPolicyPayload,
): string | null {
  for (const [index, route] of (payload.lanRoutes ?? []).entries()) {
    const problem = lanRouteProblem(route, index, payload);
    if (problem) return `TurboFabric refused a LAN route: ${problem}`;
  }
  return null;
}

function hostRange(address: string): FabricRoute | null {
  return fabricRoute(`${address}/${address.includes(":") ? 128 : 32}`);
}

function isUsableConnectedRoute(
  route: ObservedRoute,
  bridgeKeys: ReadonlySet<string>,
): boolean {
  if (!route.kernel || route.linkdown || !route.dev) return false;
  if (NEVER_LAN_DEVS.has(route.dev)) return false;
  return !bridgeKeys.has(route.key);
}

/**
 * The local interface whose connected subnet holds `via` (the most specific
 * one), never `tp0`, `lo`, an interface without carrier or a local bridge.
 */
export function connectedDevFor(
  via: string,
  table: readonly ObservedRoute[],
  bridgeSubnets: readonly string[] = [],
): string | null {
  const host = hostRange(via);
  if (!host) return null;
  const bridgeKeys = new Set(
    bridgeSubnets.map((subnet) => fabricRoute(subnet)?.key ?? ""),
  );
  let best: ObservedRoute | null = null;
  for (const route of table) {
    if (!isUsableConnectedRoute(route, bridgeKeys)) continue;
    if (!rangeInside(host.parsed, route.parsed)) continue;
    if (route.parsed.prefix > (best?.parsed.prefix ?? -1)) best = route;
  }
  return best?.dev ?? null;
}

function isExactly(
  observed: ObservedRoute,
  route: FabricRoute,
  via: string,
  dev: string,
): boolean {
  return observed.key === route.key && observed.dev === dev &&
    observed.via !== null && sameAddress(observed.via, via);
}

function sameAddress(a: string, b: string): boolean {
  return hostRange(a)?.key === hostRange(b)?.key;
}

function wasInstalled(
  observed: ObservedRoute,
  installed: readonly InstalledLanRoute[],
): boolean {
  return installed.some((entry) => {
    const route = fabricRoute(entry.cidr);
    return route !== null && isExactly(observed, route, entry.via, entry.dev);
  });
}

/** Why another route stands in the way of `route`, or `null`. */
function routedElsewhere(
  route: FabricRoute,
  table: readonly ObservedRoute[],
  installed: readonly InstalledLanRoute[],
): string | null {
  for (const other of table) {
    const connected = other.kernel && rangeInside(route.parsed, other.parsed);
    const equal = other.key === route.key && !wasInstalled(other, installed);
    if (connected || equal) {
      return `${other.dev ?? "another interface"} already routes it`;
    }
  }
  return null;
}

function overlappingBridge(
  route: FabricRoute,
  bridgeSubnets: readonly string[],
): string | null {
  return bridgeSubnets.find((subnet) => rangesOverlap(route.cidr, subnet)) ??
    null;
}

type PlanInput = {
  desired: readonly FabricReconcileLanRoute[];
  table: readonly ObservedRoute[];
  bridgeSubnets: readonly string[];
  installed: readonly InstalledLanRoute[];
};

type Placement =
  | { route: InstalledLanRoute; present: boolean }
  | { skip: string };

function placeLanRoute(
  wanted: FabricReconcileLanRoute,
  input: PlanInput,
): Placement {
  const route = fabricRoute(wanted.cidr);
  if (route?.parsed.version !== 4) {
    return { skip: "IPv6 LAN routes are not installed (forwarding is IPv4)" };
  }
  if (hostRange(wanted.via)?.parsed.version !== 4) {
    return { skip: `next hop ${wanted.via} is not an IPv4 address` };
  }
  const bridge = overlappingBridge(route, input.bridgeSubnets);
  if (bridge) return { skip: `it overlaps the local bridge subnet ${bridge}` };
  const dev = connectedDevFor(wanted.via, input.table, input.bridgeSubnets);
  if (!dev) return { skip: `no connected subnet holds ${wanted.via}` };
  const conflict = routedElsewhere(route, input.table, input.installed);
  const exact = input.table.some((observed) =>
    isExactly(observed, route, wanted.via, dev)
  );
  if (conflict && !exact) return { skip: conflict };
  return { route: { cidr: route.cidr, via: wanted.via, dev }, present: exact };
}

/**
 * What to change so the main table carries exactly the wanted LAN routes:
 * `add` what is missing, `keep` what is already right, `remove` routes this
 * daemon installed earlier that nothing wants (still present exactly), and
 * report the `skipped` ones.
 */
export function planLanRoutes(input: PlanInput): LanRoutePlan {
  const plan: LanRoutePlan = { add: [], keep: [], remove: [], skipped: [] };
  const placedKeys = new Set<string>();
  for (const wanted of input.desired) {
    const placement = placeLanRoute(wanted, input);
    if ("skip" in placement) {
      plan.skipped.push({ ...wanted, reason: placement.skip });
      continue;
    }
    const { route, present } = placement;
    placedKeys.add(fabricRoute(route.cidr)?.key ?? route.cidr);
    (present ? plan.keep : plan.add).push(route);
  }
  plan.remove = staleInstalledRoutes(input, placedKeys);
  return plan;
}

function staleInstalledRoutes(
  input: PlanInput,
  placedKeys: ReadonlySet<string>,
): InstalledLanRoute[] {
  return input.installed.filter((entry) => {
    const route = fabricRoute(entry.cidr);
    if (route === null || placedKeys.has(route.key)) return false;
    return input.table.some((observed) =>
      isExactly(observed, route, entry.via, entry.dev)
    );
  });
}

/** The plan changes nothing. */
export function lanRoutePlanIsEmpty(plan: LanRoutePlan): boolean {
  return plan.add.length === 0 && plan.remove.length === 0;
}

/** Container prefixes reached over a LAN (IPv4 only, like forwarding). */
export function lanRoutePrefixes(
  lanRoutes: readonly FabricReconcileLanRoute[] | undefined,
): string[] {
  const prefixes = new Set<string>();
  for (const route of lanRoutes ?? []) {
    const parsed = fabricRoute(route.cidr);
    if (parsed?.parsed.version === 4) prefixes.add(parsed.cidr);
  }
  return [...prefixes];
}
