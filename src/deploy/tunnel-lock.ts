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
 * lock stays without one unless its entry says `lock: true` (feature
 * `tunnel-lock-add-v1`, a local-only name): then the block is made into what a
 * deploy with a lock renders (the lock lines, `trusted_proxies` on every
 * `reverse_proxy`, loopback in a `bind`, no plain HTTP block). Nothing is ever
 * opened here, so a missing or empty `inbound` can only leave a lock as it was,
 * and an entry without `lock: true` never adds one. A bound site
 * (`bind` holding loopback) also gets this server's own addresses added when it
 * has peers, as a deploy would; nothing is ever taken out of a `bind`.
 */
import type { TunnelInbound } from "../contracts/commands-contracts.ts";
import { addressKey, parseSnippet } from "./caddy-snippet.ts";
import { foldHostname } from "./hostname-fold.ts";
import { tunnelLockLines, tunnelTrustedRanges } from "./tunnel-caddy.ts";

const LOCK_LINE_RE =
  /^ {2}@tp_outside not remote_ip 127\.0\.0\.0\/8 ::1( \S+)*$/;
const TRUSTED_LINE_RE = /^( +)trusted_proxies 127\.0\.0\.0\/8 ::1( \S+)*$/;
const BIND_LINE_RE = /^ {2}bind (\S+( \S+)*)$/;

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

/** Folded names whose entry asks for a lock to be added where a block has none. */
export function inboundLockNames(
  inbound: readonly TunnelInbound[] | undefined,
): Set<string> {
  return new Set(
    (inbound ?? []).filter((entry) => entry.lock === true).map((entry) =>
      foldHostname(entry.hostname)
    ),
  );
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

const TLS_LINE_RE = /^ {2}tls /;
const REVERSE_PROXY_RE = /^( *)reverse_proxy [^{]*$/;
const REVERSE_PROXY_BLOCK_RE = /^( *)reverse_proxy .*\{$/;

/**
 * Every `reverse_proxy` given a `trusted_proxies` line when it has none, in the
 * shape the deploy writes: the line sits right after the first one, indented two
 * spaces whatever the nesting, and a one-line `reverse_proxy` becomes a block
 * closed at column zero (only the first line of an upstream is indented).
 */
function withTrustedLines(lines: readonly string[], ranges: string): string[] {
  const trusted = `  trusted_proxies ${ranges}`;
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (REVERSE_PROXY_RE.test(line)) {
      out.push(`${line} {`, trusted, "}");
      return;
    }
    out.push(line);
    const next = lines[i + 1];
    if (
      REVERSE_PROXY_BLOCK_RE.test(line) && !(next && TRUSTED_LINE_RE.test(next))
    ) {
      out.push(trusted);
    }
  });
  return out;
}

/** The `bind` line with loopback after its first address, as a tunnel name's bind has it. */
function withLoopbackBind(line: string): string {
  const match = BIND_LINE_RE.exec(line);
  if (!match) return line;
  const tokens = match[1]!.split(" ");
  if (tokens.includes("127.0.0.1")) return line;
  return `  bind ${[tokens[0], "127.0.0.1", ...tokens.slice(1)].join(" ")}`;
}

/**
 * A block with no lock made into the locked block a deploy renders, or null
 * when its shape is not one the deploy writes (no `tls` line: an automatic
 * certificate block is left to the next deploy).
 */
function lockedBlock(
  lines: readonly string[],
  peers: readonly string[],
  listen: readonly string[],
): string[] | null {
  const tls = lines.findIndex((line, index) =>
    index > 0 && TLS_LINE_RE.test(line)
  );
  if (tls < 0) return null;
  const ranges = tunnelTrustedRanges(peers).join(" ");
  const lock = tunnelLockLines(peers).trimEnd().split("\n");
  const withLock = [
    ...lines.slice(0, tls + 1).map(withLoopbackBind),
    ...lock,
    ...withTrustedLines(lines.slice(tls + 1), ranges),
  ];
  return relockBlock(withLock, peers, listen);
}

/** The single HTTPS address of a site block, folded, or null for any other block. */
function httpsName(addresses: readonly string[]): string | null {
  if (addresses.length !== 1) return null;
  const address = addresses[0]!;
  if (/^https?:\/\//i.test(address) || address.includes(":")) return null;
  return foldHostname(addressKey(address));
}

/** One HTTPS block set from `peers`; with `mayAddLock` a block without a lock is first made locked. */
function relockItem(
  lines: readonly string[],
  peers: readonly string[],
  listen: readonly string[],
  mayAddLock: boolean,
): { lines: string[]; added: boolean } {
  const unlocked = !lines.some((line) => LOCK_LINE_RE.test(line));
  const made = unlocked && mayAddLock
    ? lockedBlock(lines, peers, listen)
    : null;
  return made === null
    ? { lines: relockBlock(lines, peers, listen), added: false }
    : { lines: made, added: true };
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
  addLock: ReadonlySet<string> = new Set(),
): string {
  if (peers.size === 0) return contents;
  // Same exact-address check as the peers: nothing else reaches a `bind` line.
  tunnelTrustedRanges(listen);
  const parsed = parseSnippet(contents);
  let changed = false;
  const locked = new Set<string>();
  const lines = parsed.items.flatMap((item) => {
    if (item.kind !== "site") return item.lines;
    const name = httpsName(item.addresses);
    const wanted = name === null ? undefined : peers.get(name);
    if (name === null || wanted === undefined) return item.lines;
    const { lines: next, added } = relockItem(
      item.lines,
      wanted,
      listen,
      addLock.has(name),
    );
    if (added) locked.add(name);
    if (
      next.length !== item.lines.length ||
      next.some((line, i) => line !== item.lines[i])
    ) {
      changed = true;
    }
    return next;
  });
  if (!changed) return contents;
  return locked.size === 0
    ? lines.join("\n")
    : dropPlainHttpBlocks(lines.join("\n"), locked);
}

/** The single plain-HTTP address of a site block, folded, or null. */
function httpOnlyName(addresses: readonly string[]): string | null {
  if (addresses.length !== 1) return null;
  const match = /^http:\/\/([^/:]+)$/i.exec(addresses[0]!);
  return match ? foldHostname(match[1]!) : null;
}

/**
 * A locked tunnel name has no plain-HTTP site (the catch-all answers plain
 * HTTP like any unknown name), so its redirect block goes, with the blank line
 * a deploy writes after it.
 */
function dropPlainHttpBlocks(
  contents: string,
  names: ReadonlySet<string>,
): string {
  const items = parseSnippet(contents).items;
  const kept: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const name = item.kind === "site" ? httpOnlyName(item.addresses) : null;
    if (name !== null && names.has(name)) {
      const after = items[i + 1];
      if (
        after?.kind === "other" && !after.meaningful && after.lines[0] === ""
      ) i++;
      continue;
    }
    kept.push(...item.lines);
  }
  return kept.join("\n");
}
