/**
 * Which endpoint URLs a copy target may use. An organization manager picks the
 * endpoint, and the host sends signed requests to it, so the daemon refuses
 * addresses that would reach the host itself or the cloud metadata service.
 * The control plane applies the same rules when it saves a target.
 */

export type EndpointGuardOptions = {
  /** Tests only: allow a loopback address over plain http. */
  allowLoopback?: boolean;
};

const BLOCKED_NAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

function ipv4Parts(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isLoopbackOrLinkLocalV4(p: number[]): boolean {
  return p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254);
}

function isPrivateV4(p: number[]): boolean {
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127);
}

/** The eight 16-bit groups of an IPv6 literal (no brackets), or null. */
function v6Groups(h: string): number[] | null {
  let text = h;
  // A trailing dotted quad is two groups (`::ffff:127.0.0.1`).
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const p = ipv4Parts(dotted[2]!);
    if (!p) return null;
    const hi = ((p[0]! << 8) | p[1]!).toString(16);
    const lo = ((p[2]! << 8) | p[3]!).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * The IPv4 address an IPv6 literal carries: IPv4-mapped (`::ffff:a.b.c.d`),
 * IPv4-compatible (`::a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`). `new URL` writes
 * these as hex groups (`[::ffff:7f00:1]`), so the groups are read, not the text.
 */
function embeddedV4(g: number[]): number[] | null {
  const zeros = g.slice(0, 5).every((x) => x === 0);
  const mapped = zeros && g[5] === 0xffff;
  const compat = zeros && g[5] === 0;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b &&
    g.slice(2, 6).every((x) => x === 0);
  if (!mapped && !compat && !nat64) return null;
  return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
}

function ipv6Class(host: string): "loopback" | "private" | "other" {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::" || h.startsWith("fe80:")) return "loopback";
  const groups = v6Groups(h);
  const v4 = groups ? embeddedV4(groups) : null;
  if (v4) {
    if (isLoopbackOrLinkLocalV4(v4)) return "loopback";
    return isPrivateV4(v4) ? "private" : "other";
  }
  if (h.startsWith("fc") || h.startsWith("fd")) {
    return h.startsWith("fd00:ec2") ? "loopback" : "private";
  }
  return "other";
}

/** A plain reason when the URL is not a bare http(s) host, else null. */
function shapeRefusal(url: URL): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "the endpoint must start with https://";
  }
  if (url.username || url.password) {
    return "the endpoint must not contain a user name or password";
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return "the endpoint must be a host name only, without a path";
  }
  return null;
}

/** A plain reason when the endpoint may not be used, else null. */
export function endpointRefusal(
  endpoint: string,
  options: EndpointGuardOptions = {},
): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "the endpoint is not a valid URL";
  }
  const shape = shapeRefusal(url);
  if (shape) return shape;
  const host = url.hostname.toLowerCase();
  const v4 = ipv4Parts(host);
  const isV6 = host.startsWith("[");
  const v6 = isV6 ? ipv6Class(host) : null;
  const loopback = (v4 !== null && isLoopbackOrLinkLocalV4(v4)) ||
    v6 === "loopback" || BLOCKED_NAMES.has(host) || host.endsWith(".localhost");
  if (loopback) {
    if (options.allowLoopback && url.protocol === "http:") return null;
    return "the endpoint points at this server itself or a metadata address, which is not allowed";
  }
  if (url.protocol === "http:") {
    const priv = (v4 !== null && isPrivateV4(v4)) || v6 === "private";
    return priv
      ? null
      : "plain http:// is only allowed for an address on a private network; use https://";
  }
  return null;
}
