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

function ipv6Class(host: string): "loopback" | "private" | "other" {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    h === "::1" || h === "::" || h.startsWith("fe80:") ||
    h.startsWith("::ffff:127.") || h.startsWith("::ffff:169.254.")
  ) {
    return "loopback";
  }
  if (h.startsWith("fc") || h.startsWith("fd")) {
    return h.startsWith("fd00:ec2") ? "loopback" : "private";
  }
  return "other";
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
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "the endpoint must start with https://";
  }
  if (url.username || url.password) {
    return "the endpoint must not contain a user name or password";
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return "the endpoint must be a host name only, without a path";
  }
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
