import type {
  ServerReportedIp,
  ServerReportedIpLink,
  ServerReportedIpScope,
} from "../contracts/server-reported-ip.ts";

import {
  addressInCidrLiteral,
  isValidIpv4Literal,
  isValidIpv6Literal,
} from "../contracts/commands-contracts.ts";

export type { ServerReportedIp, ServerReportedIpLink, ServerReportedIpScope };

/** Link state per interface name, as read from the kernel. */
export type InterfaceLinkStates = ReadonlyMap<string, ServerReportedIpLink>;

/** Default-route interface per address family, as read from the kernel. */
export type DefaultRouteInterfaces = {
  v4?: string;
  v6?: string;
};

/**
 * TurboFabric mesh interface. Mirrors `FABRIC_INTERFACE_NAME` in
 * `src/commands/fabric.ts` (not imported: that module imports this one, and the
 * value is needed while this module is still loading). Its address belongs to
 * the mesh, not to the server, so it is never reported here.
 */
export const FABRIC_MESH_INTERFACE = "tp0";

const VIRTUAL_INTERFACE = [
  /^lo$/,
  new RegExp(`^${FABRIC_MESH_INTERFACE}$`),
  /^docker\d*$/,
  /^br-/,
  /^veth/,
  /^virbr/,
  /^tun\d*$/,
  /^tap\d*$/,
  /^wg\d*$/,
  /^cni/,
  /^flannel/,
  /^cali/,
  /^kube-/,
  /^tailscale/,
  /^ifb/,
  /^dummy/,
];

function isPhysicalInterface(name: string): boolean {
  return !VIRTUAL_INTERFACE.some((pattern) => pattern.test(name));
}

// The ranges below mirror the control plane's `ipAddressScope`
// (`turbopanel/src/lib/ip-address.ts`: `UNUSABLE_CIDRS`, `LOOPBACK_CIDRS`,
// `LINK_LOCAL_CIDRS`, `PRIVATE_CIDRS`) so the daemon never calls an address
// public that the control plane treats as private. Keep them in step.

/** Never a host address: unspecified, multicast, broadcast. */
const UNUSABLE_CIDRS: readonly string[] = [
  "0.0.0.0/8", // NOSONAR typescript:S1313 — unspecified IPv4, not a host
  "224.0.0.0/4", // NOSONAR typescript:S1313 — IPv4 multicast classification
  "255.255.255.255/32", // NOSONAR typescript:S1313 — IPv4 limited broadcast, not a host
  "::/128", // NOSONAR typescript:S1313 — unspecified IPv6, not a host
  "ff00::/8", // NOSONAR typescript:S1313 — IPv6 multicast classification
];

/** Reachable only from the host itself or the same link: never reported. */
const HOST_OR_LINK_ONLY_CIDRS: readonly string[] = [
  "127.0.0.0/8", // NOSONAR typescript:S1313 — IPv4 loopback classification
  "::1/128", // NOSONAR typescript:S1313 — IPv6 loopback classification
  "169.254.0.0/16", // NOSONAR typescript:S1313 — RFC3927 IPv4 link-local classification
  "fe80::/10", // NOSONAR typescript:S1313 — RFC4291 IPv6 link-local classification
];

/**
 * Not globally routable, but a real host address a peer on the same network
 * can reach: RFC1918, carrier-grade NAT (RFC 6598), unique local IPv6
 * (RFC 4193), and the reserved IPv4 blocks (RFC 6890 protocol assignments,
 * RFC 2544 benchmarking, old class E).
 */
const PRIVATE_CIDRS: readonly string[] = [
  "10.0.0.0/8", // NOSONAR typescript:S1313 — RFC1918 private classification
  "172.16.0.0/12", // NOSONAR typescript:S1313 — RFC1918 private classification
  "192.168.0.0/16", // NOSONAR typescript:S1313 — RFC1918 private classification
  "100.64.0.0/10", // NOSONAR typescript:S1313 — RFC6598 CGNAT classification
  "fc00::/7", // NOSONAR typescript:S1313 — RFC4193 ULA classification
  "192.0.0.0/24", // NOSONAR typescript:S1313 — RFC6890 protocol assignments classification
  "198.18.0.0/15", // NOSONAR typescript:S1313 — RFC2544 benchmarking classification
  "240.0.0.0/4", // NOSONAR typescript:S1313 — reserved class E classification
];

/** IPv6 global unicast; any other IPv6 outside the lists above is dropped. */
const IPV6_GLOBAL_UNICAST_CIDR = "2000::/3"; // NOSONAR typescript:S1313 — RFC4291 global unicast classification

function inAny(address: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => addressInCidrLiteral(address, cidr));
}

/**
 * Scope of one interface address, or `null` when it is not reported
 * (malformed, unusable, loopback, link-local, or IPv6 outside global unicast).
 */
export function reportedAddressScope(
  address: string,
  version: 4 | 6,
): ServerReportedIpScope | null {
  const bare = version === 6 ? address.split("%")[0] : address;
  const valid = version === 4
    ? isValidIpv4Literal(bare)
    : isValidIpv6Literal(bare);
  if (!valid) return null;
  if (inAny(bare, UNUSABLE_CIDRS) || inAny(bare, HOST_OR_LINK_ONLY_CIDRS)) {
    return null;
  }
  if (inAny(bare, PRIVATE_CIDRS)) return "private";
  if (version === 6 && !addressInCidrLiteral(bare, IPV6_GLOBAL_UNICAST_CIDR)) {
    return null;
  }
  return "public";
}

function parseIpv4Octets(
  address: string,
): [number, number, number, number] | null {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return null;
  }
  return octets as [number, number, number, number];
}

function ipv4PrefixFromNetmask(netmask: string): number | null {
  const octets = parseIpv4Octets(netmask);
  if (!octets) return null;
  const value = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) |
    octets[3];
  let bits = 0;
  let seenZero = false;
  for (let i = 31; i >= 0; i--) {
    const bit = (value >>> i) & 1;
    if (bit === 1) {
      if (seenZero) return null;
      bits += 1;
      continue;
    }
    seenZero = true;
  }
  return bits;
}

function prefixFromInterface(addr: Deno.NetworkInterfaceInfo): number | null {
  const cidr = addr.cidr;
  if (typeof cidr === "string") {
    const slash = cidr.lastIndexOf("/");
    if (slash > 0) {
      const prefix = Number(cidr.slice(slash + 1));
      const max = addr.family === "IPv4" ? 32 : 128;
      if (Number.isInteger(prefix) && prefix >= 0 && prefix <= max) {
        return prefix;
      }
    }
  }
  if (addr.family === "IPv4" && typeof addr.netmask === "string") {
    return ipv4PrefixFromNetmask(addr.netmask);
  }
  return null;
}

function cidrForAddress(
  address: string,
  addr: Deno.NetworkInterfaceInfo,
): string | undefined {
  const prefix = prefixFromInterface(addr);
  if (prefix === null) return undefined;
  return `${address}/${prefix}`;
}

function rememberIp(
  byAddress: Map<string, ServerReportedIp>,
  entry: ServerReportedIp,
): void {
  const existing = byAddress.get(entry.address);
  if (!existing) {
    byAddress.set(entry.address, entry);
    return;
  }
  // Prefer an entry that carries a CIDR (or the default-route marker) when we
  // learn one later.
  if (
    (!existing.cidr && entry.cidr) || (!existing.preferred && entry.preferred)
  ) {
    byAddress.set(entry.address, entry);
  }
}

function buildReportedIp(
  address: string,
  version: 4 | 6,
  scope: ServerReportedIpScope,
  addr: Deno.NetworkInterfaceInfo,
  defaultRoute: DefaultRouteInterfaces | undefined,
  linkStates: InterfaceLinkStates | undefined,
): ServerReportedIp {
  const entry: ServerReportedIp = { address, version, scope };
  const cidr = cidrForAddress(address, addr);
  if (cidr) entry.cidr = cidr;
  const iface = addr.name.trim();
  if (iface.length > 0 && iface.length <= 64) entry.interface = iface;
  const routeIface = version === 4 ? defaultRoute?.v4 : defaultRoute?.v6;
  if (routeIface && routeIface === entry.interface) entry.preferred = true;
  const link = entry.interface === undefined
    ? undefined
    : linkStates?.get(entry.interface);
  if (link) entry.link = link;
  return entry;
}

const IPV4_DEFAULT_DESTINATION = "00000000";
const IPV6_UNSPECIFIED = "0".repeat(32);

/**
 * Default-route interface name for IPv4, from `/proc/net/route`.
 *
 * Columns are tab-separated: `Iface Destination Gateway Flags ...`, with
 * destination and mask as little-endian hex. The default route is the row whose
 * destination *and* mask are both zero; when several exist (multiple uplinks)
 * the lowest metric wins, matching the kernel's own selection.
 */
export function parseIpv4DefaultRouteInterface(
  text: string,
): string | undefined {
  let best: { iface: string; metric: number } | undefined;
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const [iface, destination, , , , , metric, mask] = fields;
    if (destination !== IPV4_DEFAULT_DESTINATION) continue;
    if (mask !== IPV4_DEFAULT_DESTINATION) continue;
    const parsedMetric = Number(metric);
    const weight = Number.isFinite(parsedMetric) ? parsedMetric : 0;
    if (!best || weight < best.metric) best = { iface, metric: weight };
  }
  return best?.iface;
}

/**
 * Default-route interface name for IPv6, from `/proc/net/ipv6_route`.
 *
 * Whitespace-separated: `dest dest_prefix src src_prefix next_hop metric
 * refcnt use flags iface`. The default route is `::/0`, i.e. an all-zero
 * destination with a zero prefix length.
 */
export function parseIpv6DefaultRouteInterface(
  text: string,
): string | undefined {
  let best: { iface: string; metric: number } | undefined;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[0] !== IPV6_UNSPECIFIED || fields[1] !== "00") continue;
    const iface = fields.at(-1);
    if (!iface || iface === "lo") continue;
    const parsedMetric = Number.parseInt(fields[5], 16);
    const weight = Number.isFinite(parsedMetric) ? parsedMetric : 0;
    if (!best || weight < best.metric) best = { iface, metric: weight };
  }
  return best?.iface;
}

/**
 * A kernel text file (`/proc/net/route`, `/sys/class/net/<nic>/operstate`), or
 * `undefined` on a non-Linux host, with /proc or /sys not mounted, or when the
 * kernel refuses the read (`carrier` on an administratively down NIC): the
 * addresses still report, just without a preferred marker or a link state.
 */
function readOptionalText(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Read the host's default-route interface per family. Best-effort: returns an
 * empty object when the kernel tables are unreadable.
 */
export function readDefaultRouteInterfaces(): DefaultRouteInterfaces {
  const out: DefaultRouteInterfaces = {};
  const v4 = readOptionalText("/proc/net/route");
  if (v4) {
    const iface = parseIpv4DefaultRouteInterface(v4);
    if (iface) out.v4 = iface;
  }
  const v6 = readOptionalText("/proc/net/ipv6_route");
  if (v6) {
    const iface = parseIpv6DefaultRouteInterface(v6);
    if (iface) out.v6 = iface;
  }
  return out;
}

/**
 * Link state from the two kernel files of one interface.
 *
 * `operstate` decides when it is definite (`up`, or `down` / `lowerlayerdown` /
 * `notpresent`). A NIC that reports `unknown`, `dormant` or `testing` is
 * settled by `carrier` (`1` up, `0` down). Anything else is `undefined`: the
 * daemon does not guess.
 */
export function parseLinkState(
  operstate: string | undefined,
  carrier: string | undefined,
): ServerReportedIpLink | undefined {
  const state = operstate?.trim().toLowerCase();
  if (state === "up") return "up";
  if (
    state === "down" || state === "lowerlayerdown" || state === "notpresent"
  ) {
    return "down";
  }
  const wire = carrier?.trim();
  if (wire === "1") return "up";
  if (wire === "0") return "down";
  return undefined;
}

/**
 * Link state of every named interface. Read-only: two small sysfs reads per
 * NIC, no process and no route change. An interface the kernel does not
 * describe is left out of the map.
 */
export function readInterfaceLinkStates(
  names: Iterable<string>,
  readText: (path: string) => string | undefined = readOptionalText,
): Map<string, ServerReportedIpLink> {
  const out = new Map<string, ServerReportedIpLink>();
  for (const name of names) {
    if (out.has(name) || name.length === 0 || /[/\s]/.test(name)) continue;
    const base = `/sys/class/net/${name}`;
    const link = parseLinkState(
      readText(`${base}/operstate`),
      readText(`${base}/carrier`),
    );
    if (link) out.set(name, link);
  }
  return out;
}

/** Link states for the interfaces {@link collectServerIps} would report on. */
export function readHostInterfaceLinkStates(): Map<
  string,
  ServerReportedIpLink
> {
  try {
    const names = new Set<string>();
    for (const addr of Deno.networkInterfaces()) {
      if (isPhysicalInterface(addr.name)) names.add(addr.name);
    }
    return readInterfaceLinkStates(names);
  } catch {
    return new Map();
  }
}

/**
 * Enumerate reportable host addresses.
 *
 * Pass {@link readDefaultRouteInterfaces} output to mark the addresses on the
 * default-route NIC as `preferred`, and {@link readHostInterfaceLinkStates}
 * output to stamp each address with its NIC's `link`; omit them (tests,
 * non-Linux) and the list is unmarked but otherwise identical.
 */
export function collectServerIps(
  defaultRoute?: DefaultRouteInterfaces,
  linkStates?: InterfaceLinkStates,
): ServerReportedIp[] {
  const byAddress = new Map<string, ServerReportedIp>();

  for (const addr of Deno.networkInterfaces()) {
    if (!isPhysicalInterface(addr.name)) continue;
    const version = addr.family === "IPv4" ? 4 : 6;
    const scope = reportedAddressScope(addr.address, version);
    if (scope === null) continue;
    rememberIp(
      byAddress,
      buildReportedIp(
        addr.address,
        version,
        scope,
        addr,
        defaultRoute,
        linkStates,
      ),
    );
  }

  return [...byAddress.values()].sort((a, b) =>
    a.address.localeCompare(b.address)
  );
}
