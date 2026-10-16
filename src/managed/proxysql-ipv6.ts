/**
 * ProxySQL's own IPv6 Docker network.
 *
 * The organization's managed Docker network is IPv4 only. With the database
 * listener also published on `[::]` (external access on, server with IPv6),
 * Docker had no IPv6 address to forward to, so a host process (docker-proxy)
 * accepted every IPv6 connection and opened a new IPv4 one to the container.
 * ProxySQL then saw the network's gateway (`172.x.0.1`) instead of the real
 * client address.
 *
 * The fix gives the ProxySQL container a second, IPv6-only network that only
 * it joins. Docker picks the IPv4 and IPv6 default gateways separately (the
 * first endpoint, in its gateway order, that has each family), so:
 *
 * - IPv4 is untouched: this network has no IPv4, so the IPv4 gateway (and the
 *   IPv4 publish target) stays on the network it is on today;
 * - this network is the only one with IPv6, so the `[::]` publish is
 *   forwarded by the kernel straight to the container's address on it, and
 *   ProxySQL sees the real IPv6 client address.
 *
 * The network exists only while a client listener is published on an IPv6
 * address. The control plane sends `::` only for a server that reports a
 * real IPv6 address, so a host with IPv6 switched off never has to create an
 * IPv6 network.
 *
 * The subnet is a unique local (`fd00::/8`) /64 derived from a stable seed
 * (the managed-ingress `serviceId`, one per server), so it is the same on
 * every render on one host and two hosts drawing the same 56-bit prefix is
 * vanishingly unlikely (it is local to each host either way: nothing routes
 * it between servers).
 *
 * ProxySQL itself must also listen on IPv6 inside its container for the
 * forwarded connections to land: {@link proxySqlListenerInterfaces}. ProxySQL
 * sets `IPV6_V6ONLY` on IPv6 listeners, so `0.0.0.0:<port>` and
 * `[::]:<port>` side by side do not collide and IPv4 clients keep appearing as
 * plain IPv4 addresses.
 */

import { crypto } from "@std/crypto";

/** Compose key (and, prefixed by the project, Docker name) of the network. */
export const PROXYSQL_IPV6_NETWORK = "proxysql-ipv6";

const ULA_SEED_PREFIX = "turbopanel-proxysql-ipv6:";

/** True when any client listener is published on an IPv6 address. */
export function proxySqlBindsUseIpv6(binds: readonly string[]): boolean {
  return binds.some((bind) => bind.includes(":"));
}

function hexGroup(high: number, low: number): string {
  return ((high << 8) | low).toString(16);
}

/**
 * Unique local /64 for ProxySQL's IPv6 network, e.g. `fd3c:1a2b:9f00:42::/64`.
 *
 * RFC 4193 layout: `fd` + a 40-bit global ID + a 16-bit subnet ID, all 56
 * bits taken from SHA-256 of the seed. Groups are written without leading
 * zeros (the form Docker reports back) so a re-render never looks like a
 * different subnet.
 */
export function proxySqlIpv6Subnet(seed: string): string {
  if (seed.length === 0) {
    throw new TypeError("proxysql ipv6 subnet needs a non-empty seed");
  }
  const digest = new Uint8Array(
    crypto.subtle.digestSync(
      "SHA-256",
      new TextEncoder().encode(`${ULA_SEED_PREFIX}${seed}`),
    ),
  );
  const b = (index: number) => digest[index]!;
  const groups = [
    hexGroup(0xfd, b(0)),
    hexGroup(b(1), b(2)),
    hexGroup(b(3), b(4)),
    hexGroup(b(5), b(6)),
  ];
  return `${groups.join(":")}::/64`;
}

/**
 * ProxySQL `<family>-interfaces` value for one client listener port: always
 * IPv4 all-interfaces, plus IPv6 all-interfaces when the IPv6 network is
 * attached. (Without an IPv6 address in the container there is nothing for an
 * IPv6 listener to serve.)
 */
export function proxySqlListenerInterfaces(
  port: number,
  ipv6: boolean,
): string {
  const ipv4 = `0.0.0.0:${port}`;
  return ipv6 ? `${ipv4};[::]:${port}` : ipv4;
}

/** Service-level `networks:` line joining the IPv6 network. */
export function renderProxySqlIpv6ServiceNetwork(): string {
  // Inline (`{}`) so `readSegmentAttachmentsFromCompose` never mistakes it
  // for a `tpn_*` attachment block.
  return `      ${PROXYSQL_IPV6_NETWORK}: {}`;
}

/**
 * Top-level `networks:` entry. Compose owns this network (not `external`):
 * `up` creates it, `down` removes it. IPv4 is switched off so the IPv4
 * gateway and every IPv4 path stay where they were.
 */
export function renderProxySqlIpv6TopLevelNetwork(subnet: string): string[] {
  return [
    `  ${PROXYSQL_IPV6_NETWORK}:`,
    "    enable_ipv4: false",
    "    enable_ipv6: true",
    "    ipam:",
    "      config:",
    `        - subnet: "${subnet}"`,
  ];
}

const IPV6_SUBNET_LINE_PATTERN = /^ {8}- subnet: "(?<subnet>[0-9a-f:]+\/64)"$/;

/**
 * The IPv6 subnet a previous render wrote, or `null` when the compose file
 * has no IPv6 network. The self-heal path (`system.reconcile`) keeps exactly
 * what is on disk: it neither adds the network (that is the next
 * `managed.ingress.reconcile`'s job, which also switches ProxySQL's own
 * listeners to IPv6) nor drops it.
 */
export function readProxySqlIpv6SubnetFromCompose(
  composeText: string,
): string | null {
  const lines = composeText.split("\n");
  const start = lines.indexOf(`  ${PROXYSQL_IPV6_NETWORK}:`);
  if (start === -1) return null;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith("    ")) break;
    const match = IPV6_SUBNET_LINE_PATTERN.exec(line);
    if (match?.groups) return match.groups.subnet!;
  }
  return null;
}
