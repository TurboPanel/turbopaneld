/**
 * Keep the lock on tunnel names that run here in step with where the tunnel
 * runs, without a site deploy.
 *
 * A deploy writes the lock into the site's own block (`siteSnippet`): only
 * loopback (the local connector) and the listed peers may use the name, and
 * the same peers are trusted to say who the visitor is. The peers are the other
 * servers that carry the tunnel, so adding a carrier used to need a deploy
 * before its forwards were let in. With `inbound` on `server.tunnel.routes` the
 * control plane sends, for every tunnel name whose site runs here, the exact
 * servers allowed to forward it; this module rewrites only the peer lists of
 * those lines in the daemon's own site files.
 *
 * Only lines this daemon writes are touched, in the shape it writes them, and
 * only inside the HTTPS block of a name listed in `inbound`. A block without a
 * lock stays without one (the control plane never opens a name through here),
 * so a missing or empty `inbound` can only leave a lock as it was. A bound site
 * (`bind` holding loopback) also gets this server's own addresses added when it
 * has peers, as a deploy would; nothing is ever taken out of a `bind`.
 */
import type { TunnelInbound } from "../contracts/commands-contracts.ts";
import { addressKey, parseSnippet } from "./caddy-snippet.ts";
import { foldHostname } from "./hostname-fold.ts";
import { tunnelTrustedRanges } from "./tunnel-caddy.ts";

const LOCK_LINE_RE =
  /^ {2}@tp_outside not remote_ip 127\.0\.0\.0\/8 ::1(?: [^\s]+)*$/;
const TRUSTED_LINE_RE =
  /^(\s+)trusted_proxies 127\.0\.0\.0\/8 ::1(?: [^\s]+)*$/;
const BIND_LINE_RE = /^ {2}bind ((?:[^\s]+)(?: [^\s]+)*)$/;

/** Peers per folded name. A name listed twice keeps the first entry (the parser refuses that anyway). */
export function inboundPeers(
  inbound: readonly TunnelInbound[] | undefined,
): Map<string, readonly string[]> {
  const peers = new Map<string, readonly string[]>();
  for (const entry of inbound ?? []) {
    const name = foldHostname(entry.hostname);
    if (!peers.has(name)) peers.set(name, entry.peers);
  }
  return peers;
}

function bindToken(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/** The `bind` line with this server's own addresses added, or the line as it was. */
function widenedBind(line: string, listen: readonly string[]): string {
  const match = BIND_LINE_RE.exec(line);
  if (!match) return line;
  const tokens = match[1]!.split(" ");
  // Only the bind a tunnel name gets (it always holds loopback for the connector).
  if (!tokens.includes("127.0.0.1")) return line;
  const missing = listen.map(bindToken).filter((t) => !tokens.includes(t));
  return missing.length === 0
    ? line
    : `  bind ${[...tokens, ...missing].join(" ")}`;
}

/** One HTTPS block's lines with its peer lists set to `peers`. */
function relockBlock(
  lines: readonly string[],
  peers: readonly string[],
  listen: readonly string[],
): string[] {
  const ranges = tunnelTrustedRanges(peers).join(" ");
  return lines.map((line, index) => {
    if (index === 0) return line;
    if (LOCK_LINE_RE.test(line)) {
      return `  @tp_outside not remote_ip ${ranges}`;
    }
    const trusted = TRUSTED_LINE_RE.exec(line);
    if (trusted) return `${trusted[1]}trusted_proxies ${ranges}`;
    if (peers.length > 0 && listen.length > 0) return widenedBind(line, listen);
    return line;
  });
}

/** The single HTTPS address of a site block, folded, or null for any other block. */
function httpsName(addresses: readonly string[]): string | null {
  if (addresses.length !== 1) return null;
  const address = addresses[0]!;
  if (/^https?:\/\//i.test(address) || address.includes(":")) return null;
  return foldHostname(addressKey(address));
}

/**
 * `contents` with the peer lists of every listed tunnel name set from
 * `peers`; the text is returned unchanged when nothing applies. Peers are
 * checked as exact addresses (a bad one throws, nothing is half-written).
 */
export function relockSiteText(
  contents: string,
  peers: ReadonlyMap<string, readonly string[]>,
  listen: readonly string[] = [],
): string {
  if (peers.size === 0) return contents;
  const parsed = parseSnippet(contents);
  let changed = false;
  const lines = parsed.items.flatMap((item) => {
    if (item.kind !== "site") return item.lines;
    const name = httpsName(item.addresses);
    const wanted = name === null ? undefined : peers.get(name);
    if (wanted === undefined) return item.lines;
    const next = relockBlock(item.lines, wanted, listen);
    if (next.some((line, i) => line !== item.lines[i])) changed = true;
    return next;
  });
  return changed ? lines.join("\n") : contents;
}
