/**
 * IPv4 CIDR helpers for pinning ProxySQL on spanning `tpn_*` segments.
 *
 * Equivalent to instance `reservedManagedIngressAddress()` — last usable host
 * in the subnet, reserved so tenant tasks never collide with the platform
 * attachment.
 */

type Ipv4Cidr = {
  network: number;
  prefix: number;
  hostCount: number;
};

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

function maskForPrefix(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function parseIpv4Cidr(value: string): Ipv4Cidr | null {
  const trimmed = value.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return null;
  const address = trimmed.slice(0, slash);
  const prefix = Number.parseInt(trimmed.slice(slash + 1), 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const ip = ipv4ToInt(address);
  if (ip === null) return null;
  const mask = maskForPrefix(prefix);
  const network = ip & mask;
  const hostCount = prefix >= 32 ? 1 : 2 ** (32 - prefix);
  return { network, prefix, hostCount };
}

/**
 * Last usable host in a segment CIDR — reserved for the ProxySQL platform
 * attachment so tenant tasks never collide with it.
 */
export function reservedManagedIngressAddress(
  cidrValue: string,
): string | null {
  const parsed = parseIpv4Cidr(cidrValue);
  if (!parsed || parsed.prefix >= 31) return null;
  const lastUsableIndex = parsed.hostCount - 3;
  if (lastUsableIndex < 0) return null;
  return intToIpv4(parsed.network + 1 + lastUsableIndex);
}
