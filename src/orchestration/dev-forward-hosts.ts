/**
 * Host LAN names the Vagrant guest cannot see on its own interfaces.
 *
 * `dev/Vagrantfile` writes them to {@link DEV_FORWARD_HOSTS_PATH} because
 * port 8443 is an SSH forward: the Platform CA leaf is minted inside the
 * guest, and Add Server from another machine dials the host's LAN address.
 * Those names travel as `turbopanel_public_urls` so the cert generator
 * emits IP SANs for addresses and DNS SANs for hostnames. Configured LAN
 * aliases (`TURBOPANEL_DEV_LAN_ALIASES`, or `local/lan-aliases` via the
 * Vagrant provisioner) are the same kind of name: they are not discovered
 * from a NIC.
 */

export const DEV_FORWARD_HOSTS_PATH = "/etc/turbopanel/dev-forward-hosts";

const FORWARD_HOST_TOKEN = /^[A-Za-z0-9.:_-]+$/;

function isCertPublicUrlToken(value: string): boolean {
  if (value.length === 0 || value.length > 300) return false;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname.length > 0 &&
        !url.username && !url.password;
    } catch {
      return false;
    }
  }
  return FORWARD_HOST_TOKEN.test(value);
}

/**
 * Configured public URLs plus forwarded host LAN names, comma-separated.
 * Blank and unsafe tokens are dropped. Order is preserved, duplicates once.
 */
export function mergeDevCertPublicUrls(
  configured: string | undefined,
  forwardHosts: string,
): string {
  const parts = [
    ...(configured ?? "").split(","),
    ...forwardHosts.split(/[,\n\r]+/),
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!isCertPublicUrlToken(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique.join(",");
}

/** Guest file of host LAN names, or `""` when it has not been published. */
export function readDevForwardHostsFile(
  path = DEV_FORWARD_HOSTS_PATH,
  read: (file: string) => string = (file) => Deno.readTextFileSync(file),
): string {
  try {
    return read(path);
  } catch {
    return "";
  }
}
