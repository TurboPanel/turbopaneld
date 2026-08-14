/**
 * Classify whether a control-plane origin needs bootstrap insecure TLS.
 * Keep in step with instance `src/lib/install-tls.ts`.
 */

const LOCAL_TLDS = new Set([
  "lan",
  "local",
  "internal",
  "home",
  "corp",
  "localhost",
]);

function stripIpv6Brackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateOrLoopbackIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === undefined || b === undefined) return false;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host.startsWith("fe80:")) return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
  }

  const octets = ipv4Octets(host);
  if (octets) return isPrivateOrLoopbackIpv4(octets);

  const tld = host.split(".").at(-1);
  return Boolean(tld && LOCAL_TLDS.has(tld));
}

/** True when bootstrap should skip public TLS verification for this origin. */
export function installOriginNeedsInsecureTls(origin: string): boolean {
  const trimmed = origin.trim();
  if (!trimmed.startsWith("https://")) return false;
  try {
    const url = new URL(trimmed);
    const port = url.port || "443";
    if (port !== "443") return true;
    return isLoopbackOrPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}
