/**
 * Which local NIC carries a WireGuard peer's tunnel traffic.
 *
 * The control plane picks each peer endpoint from the datacenter priority
 * order; this answers the other half for the traffic map: the NIC whose
 * connected subnet holds the endpoint the kernel is actually using. Pure and
 * read-only: it matches the endpoint against the address list the daemon
 * already collects (`collectServerIps`), starts no process and changes no
 * route.
 */
import {
  addressInCidrLiteral,
  type FabricReconcileObservedPeer,
  isValidInterfaceName,
} from "../contracts/commands-contracts.ts";
import type { ServerReportedIp } from "../contracts/server-reported-ip.ts";

/** Host part of a `wg` endpoint (`1.2.3.4:51820` or `[fe80::1]:51820`). */
export function endpointHost(endpoint: string): string | undefined {
  if (endpoint.startsWith("[")) {
    const close = endpoint.indexOf("]");
    return close > 1 ? endpoint.slice(1, close) : undefined;
  }
  const colon = endpoint.lastIndexOf(":");
  return colon > 0 ? endpoint.slice(0, colon) : undefined;
}

function prefixLength(cidr: string): number {
  return Number.parseInt(cidr.slice(cidr.indexOf("/") + 1), 10);
}

/**
 * NIC with the most specific connected subnet that contains the endpoint, or
 * `undefined` when none does (the kernel reaches it by the default route).
 */
export function localInterfaceForEndpoint(
  endpoint: string,
  ips: readonly ServerReportedIp[],
): string | undefined {
  const host = endpointHost(endpoint);
  if (host === undefined) return undefined;
  let best: { name: string; prefix: number } | undefined;
  for (const ip of ips) {
    // The result contract refuses odd names (over 15 bytes, spaces, slashes);
    // leave those unmatched rather than lose the whole reconcile result.
    if (!isValidInterfaceName(ip.interface) || ip.cidr === undefined) continue;
    if (!ip.cidr.includes("/") || !addressInCidrLiteral(host, ip.cidr)) {
      continue;
    }
    const prefix = prefixLength(ip.cidr);
    if (best === undefined || prefix > best.prefix) {
      best = { name: ip.interface, prefix };
    }
  }
  return best?.name;
}

/** Copy of `peers` with `interface` set where the endpoint is on a local subnet. */
export function stampObservedPeerInterfaces(
  peers: readonly FabricReconcileObservedPeer[],
  ips: readonly ServerReportedIp[],
): FabricReconcileObservedPeer[] {
  return peers.map((peer) => {
    const name = peer.endpoint === undefined
      ? undefined
      : localInterfaceForEndpoint(peer.endpoint, ips);
    return name === undefined ? peer : { ...peer, interface: name };
  });
}
