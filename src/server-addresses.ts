export type ServerReportedIpScope = "private" | "public";

export type ServerReportedIp = {
  address: string;
  version: 4 | 6;
  scope: ServerReportedIpScope;
  /** Interface CIDR when known (host form `address/prefix` is fine). */
  cidr?: string;
  /** Host interface name (e.g. `eth0`, `enp1s0`). */
  interface?: string;
};

function isLoopbackIpv4(address: string): boolean {
  return address.startsWith("127.");
}

function isLoopbackIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
}

function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith("169.254.");
}

function isLinkLocalIpv6(address: string): boolean {
  return address.toLowerCase().startsWith("fe80:");
}

const VIRTUAL_INTERFACE = [
  /^lo$/,
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

function isUsableIpv4(address: string): boolean {
  if (isLoopbackIpv4(address) || isLinkLocalIpv4(address)) return false;

  const octets = parseIpv4Octets(address);
  if (!octets) return false;

  const [a] = octets;
  return a > 0 && a < 224;
}

function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) return false;

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPublicIpv4(address: string): boolean {
  return isUsableIpv4(address) && !isPrivateIpv4(address);
}

function isUsableIpv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0];
  if (isLoopbackIpv6(lower) || isLinkLocalIpv6(lower)) return false;
  if (lower.startsWith("ff")) return false;
  return true;
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0];
  // Unique local addresses (ULA), fc00::/7
  return lower.startsWith("fc") || lower.startsWith("fd");
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0];
  if (!isUsableIpv6(lower) || isPrivateIpv6(lower)) return false;

  // Global unicast, 2000::/3
  const first = lower.replace(/^::/, "")[0];
  return first === "2" || first === "3";
}

function ipv4PrefixFromNetmask(netmask: string): number | null {
  const octets = parseIpv4Octets(netmask);
  if (!octets) return null;
  const value =
    (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];
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
  // Prefer an entry that carries a CIDR when we learn one later.
  if (!existing.cidr && entry.cidr) {
    byAddress.set(entry.address, entry);
  }
}

function buildReportedIp(
  address: string,
  version: 4 | 6,
  scope: ServerReportedIpScope,
  addr: Deno.NetworkInterfaceInfo,
): ServerReportedIp {
  const entry: ServerReportedIp = { address, version, scope };
  const cidr = cidrForAddress(address, addr);
  if (cidr) entry.cidr = cidr;
  const iface = addr.name.trim();
  if (iface.length > 0 && iface.length <= 64) entry.interface = iface;
  return entry;
}

export function collectServerIps(): ServerReportedIp[] {
  const byAddress = new Map<string, ServerReportedIp>();

  for (const addr of Deno.networkInterfaces()) {
    if (!isPhysicalInterface(addr.name)) continue;

    if (addr.family === "IPv4") {
      if (isPrivateIpv4(addr.address)) {
        rememberIp(
          byAddress,
          buildReportedIp(addr.address, 4, "private", addr),
        );
      } else if (isPublicIpv4(addr.address)) {
        rememberIp(
          byAddress,
          buildReportedIp(addr.address, 4, "public", addr),
        );
      }
      continue;
    }

    if (isPrivateIpv6(addr.address)) {
      rememberIp(
        byAddress,
        buildReportedIp(addr.address, 6, "private", addr),
      );
    } else if (isPublicIpv6(addr.address)) {
      rememberIp(
        byAddress,
        buildReportedIp(addr.address, 6, "public", addr),
      );
    }
  }

  return [...byAddress.values()].sort((a, b) =>
    a.address.localeCompare(b.address)
  );
}
