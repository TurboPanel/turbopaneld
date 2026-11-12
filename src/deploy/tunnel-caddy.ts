/**
 * Caddy text for tunnel traffic that crosses servers of one datacenter.
 *
 * A tunnel connector hands every visitor to this server's own hosting Caddy
 * over `https://localhost`. Caddy then decides:
 *
 * - the site runs here: the site's own file answers (see `siteSnippet`, which
 *   adds the lock below for names listed in `hostings[].tunnel`);
 * - the site runs on another server: the reserved file {@link TUNNEL_SITE_FILE}
 *   holds a forward block that passes the request on over the datacenter
 *   network (this module);
 * - nobody on this server hosts it and no forward block exists: the fallback
 *   answers like any unknown name.
 *
 * This module only builds text. It imports nothing from `ingress.ts` so that
 * file can use it (the closed upstream union there has a `peer` kind that is
 * rendered here). Every value that reaches the text is checked again here: the
 * wire parsers are the first line, this is the last.
 */
import { join } from "@std/path";
import {
  isValidHostname,
  isValidIpv4Literal,
  isValidIpv6Literal,
  TUNNEL_PEER_TLS_NAME,
  type TunnelRoute,
} from "../contracts/commands-contracts.ts";
import { ConfigValueError } from "../contracts/config-values.ts";
import { foldHostname } from "./hostname-fold.ts";

/** The reserved site file (inside `<config>/hosting/sites/`) holding the forward blocks. */
export const TUNNEL_SITE_FILE = "10-tunnels.caddy";
/** The last accepted table, beside the sites folder: `<config>/hosting/tunnel-routes.json`. */
export const TUNNEL_STATE_FILE = "tunnel-routes.json";
/** The folder of peer certificate material: `<config>/hosting/peer/<id>/`. */
export const TUNNEL_PEER_DIR = "peer";
/** The three files of one peer material folder. */
export const TUNNEL_PEER_FILES = {
  certificate: "leaf.pem",
  key: "leaf.key",
  trust: "ca.pem",
} as const;

/** What a visitor sees when the server that runs the site cannot answer. */
export const TUNNEL_ERROR_TEXT = "This site is not running right now.";

const LOOPBACK_RANGES = "127.0.0.0/8 ::1";
const DEFAULT_PEER_PORT = 443;
/** Named matchers are per site block, and these names are used once in each. */
const OUTSIDE_MATCHER = "@tp_outside";
const PEER_MATCHER = "@tp_peer";
const LOCAL_MATCHER = "@tp_local";

const SAFE_PATH_RE = /^\/[A-Za-z0-9_./-]+$/;

/**
 * Where a request for a name that runs on other servers goes: every address of
 * every server that runs a copy, reached with the organization's certificate.
 */
export type PeerUpstream = {
  kind: "peer";
  /** `host:port` targets, IPv6 already bracketed. Round-robin over all. */
  targets: readonly string[];
  /** The organization's trust bundle, used only for this hop. */
  trustFile: string;
  /** Source ranges whose visitor-address headers are kept (loopback and peers). */
  trustedProxies: readonly string[];
};

/** Where one folder of peer material sits and the paths its files get. */
export function tunnelPeerPaths(hostingDir: string, id: string): {
  dir: string;
  certificate: string;
  key: string;
  trust: string;
} {
  const dir = join(hostingDir, TUNNEL_PEER_DIR, id);
  return {
    dir,
    certificate: join(dir, TUNNEL_PEER_FILES.certificate),
    key: join(dir, TUNNEL_PEER_FILES.key),
    trust: join(dir, TUNNEL_PEER_FILES.trust),
  };
}

function assertAddress(value: string): void {
  if (!isValidIpv4Literal(value) && !isValidIpv6Literal(value)) {
    throw new ConfigValueError("tunnel address", "must be an IP address");
  }
}

function assertPath(field: string, value: string): string {
  if (!SAFE_PATH_RE.test(value)) {
    throw new ConfigValueError(field, "must be a plain absolute path");
  }
  return value;
}

/** `host:port` with an IPv6 address bracketed. */
export function formatTunnelTarget(address: string, port: number): string {
  assertAddress(address);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigValueError("tunnel port", "must be a port number");
  }
  const host = address.includes(":") ? `[${address}]` : address;
  return `${host}:${port}`;
}

/** Loopback plus the exact peer addresses: who is trusted to say who the visitor is. */
export function tunnelTrustedRanges(peers: readonly string[]): string[] {
  peers.forEach(assertAddress);
  return ["127.0.0.0/8", "::1", ...peers];
}

/**
 * The lock for a name that only the local connector and listed peers may use:
 * everyone else gets the connection dropped, with no hint the site exists.
 * `handle` runs before `reverse_proxy`, so this holds for plain and
 * path-routed sites alike. Two-space indent, to sit in a site block.
 */
export function tunnelLockLines(peers: readonly string[]): string {
  peers.forEach(assertAddress);
  const sources = [LOOPBACK_RANGES, ...peers].join(" ");
  return `  ${OUTSIDE_MATCHER} not remote_ip ${sources}
  handle ${OUTSIDE_MATCHER} {
    abort
  }
`;
}

/**
 * The `reverse_proxy` for a peer upstream. Passive checks only: a target that
 * fails to connect is skipped for ten seconds, and a request is retried on the
 * other targets for up to three seconds before the error page answers.
 * `header_up Host` is needed because Caddy rewrites Host on a TLS hop.
 * `tls_server_name` is fixed: the receiving server presents the certificate it
 * loaded for that name, and the sender trusts only the organization's bundle.
 */
export function peerUpstreamText(upstream: PeerUpstream): string {
  if (upstream.targets.length === 0) {
    throw new ConfigValueError("tunnel upstream", "needs a target");
  }
  const targets = upstream.targets.map((target) => {
    if (!/^(\[[\dA-Fa-f:.]+\]|[\d.]+):\d{1,5}$/.test(target)) {
      throw new ConfigValueError("tunnel target", "must be address:port");
    }
    return target;
  });
  const trust = assertPath("tunnel trust file", upstream.trustFile);
  upstream.trustedProxies.forEach((range) => {
    if (!/^[\dA-Fa-f:.]+(\/\d{1,3})?$/.test(range)) {
      throw new ConfigValueError("tunnel trusted range", "must be an address");
    }
  });
  return `reverse_proxy ${targets.join(" ")} {
  lb_policy round_robin
  lb_try_duration 3s
  fail_duration 10s
  max_fails 1
  header_up Host {host}
  trusted_proxies ${upstream.trustedProxies.join(" ")}
  transport http {
    tls
    tls_trust_pool file ${trust}
    tls_server_name ${TUNNEL_PEER_TLS_NAME}
    versions 2
  }
}`;
}

/** Put `trusted_proxies` into a `reverse_proxy` that has none (a one-liner becomes a block). */
export function withTrustedProxies(upstream: string, ranges: string): string {
  const [first, ...rest] = upstream.split("\n");
  if (rest.length === 0) return `${first} {\n  trusted_proxies ${ranges}\n}`;
  return [first, `  trusted_proxies ${ranges}`, ...rest].join("\n");
}

/** The material paths a rendered file refers to (absolute, already written). */
export type TunnelFileInputs = Readonly<{
  /** Exact addresses of the servers allowed to forward to this one. */
  peerAddresses: readonly string[];
  /**
   * Accepted from the control plane for wire compatibility. The peer site no
   * longer binds to them (see {@link peerSite}), so nothing here changes the file.
   */
  listenAddresses?: readonly string[];
  /** Absent when the table has nothing to receive or forward. */
  material?: Readonly<{ certificate: string; key: string; trust: string }>;
}>;

/** One forward block for a site that runs on other servers. */
function forwardBlock(route: TunnelRoute, inputs: TunnelFileInputs): string {
  if (!isValidHostname(route.hostname)) {
    throw new ConfigValueError("tunnel hostname", "must be a hostname");
  }
  const material = inputs.material;
  if (!material) {
    throw new ConfigValueError("tunnel material", "is required to forward");
  }
  const targets = route.upstreams.flatMap((upstream) =>
    upstream.addresses.map((address) =>
      formatTunnelTarget(address, upstream.port ?? DEFAULT_PEER_PORT)
    )
  );
  const proxy = peerUpstreamText({
    kind: "peer",
    targets,
    trustFile: material.trust,
    trustedProxies: tunnelTrustedRanges(inputs.peerAddresses),
  }).split("\n").map((line) => `    ${line}`).join("\n");
  // A request that came from a peer is never passed on again, so a moved site
  // with a stale table shows the error page instead of looping. A server that
  // only carries tunnels has no peers sending to it, so it has no such rule.
  const peerRule = inputs.peerAddresses.length === 0
    ? ""
    : `  ${PEER_MATCHER} remote_ip ${inputs.peerAddresses.join(" ")}
  handle ${PEER_MATCHER} {
    error 421
  }
`;
  // Locked: only this server's own connector is passed on. Open (the name is
  // also public here): every visitor that is not a peer is.
  const forward = route.lock
    ? `  ${LOCAL_MATCHER} remote_ip ${LOOPBACK_RANGES}
  handle ${LOCAL_MATCHER} {
${proxy}
  }
  handle {
    abort
  }
`
    : `  handle {
${proxy}
  }
`;
  return `${route.hostname} {
  tls internal
${peerRule}${forward}  handle_errors {
    respond "${TUNNEL_ERROR_TEXT}" {err.status_code}
  }
}
`;
}

/**
 * The small site that makes this server present the peer certificate when
 * another server connects with the fixed name. Caddy picks a certificate by the
 * connecting name, not by the Host header, so without a site that loads the
 * certificate the sender would be shown the wrong one and refuse it. Only
 * listed peers get any answer.
 *
 * The site has no `bind`. Caddy makes one server per set of listen addresses,
 * so a site bound to this server's own address would become a server of its own
 * that holds only this name, and a forwarded request for a real hostname that
 * arrives on that address would find no route and get an empty answer. Without
 * a `bind` it shares the server of the other sites that listen everywhere, and
 * the `remote_ip` check below is what keeps everyone but the listed peers out.
 */
function peerSite(inputs: TunnelFileInputs): string {
  const material = inputs.material!;
  const certificate = assertPath("tunnel certificate", material.certificate);
  const key = assertPath("tunnel key", material.key);
  const peers = inputs.peerAddresses.join(" ");
  return `${TUNNEL_PEER_TLS_NAME} {
  tls ${certificate} ${key}
  ${OUTSIDE_MATCHER} not remote_ip ${peers}
  handle ${OUTSIDE_MATCHER} {
    abort
  }
  handle {
    respond "" 404
  }
}
`;
}

/** What {@link renderTunnelFile} made and what it left out. */
export type RenderedTunnelFile = {
  contents: string;
  /** Names with a forward block in the file. */
  forwarded: string[];
  /** Names left out because a site on this server answers them. */
  dropped: string[];
};

/**
 * The whole reserved file. A name that is served on this server (the panel
 * says it runs here, or a site file in the folder holds it) gets no forward
 * block, so a site that moves here never makes two blocks for one name. An
 * empty result (no peers, nothing forwarded) is the empty string.
 */
export function renderTunnelFile(
  routes: readonly TunnelRoute[],
  inputs: TunnelFileInputs,
  localNames: ReadonlySet<string>,
): RenderedTunnelFile {
  const forwarded: string[] = [];
  const dropped: string[] = [];
  const blocks: string[] = [];
  const ordered = routes.toSorted((a, b) =>
    foldHostname(a.hostname).localeCompare(foldHostname(b.hostname))
  );
  for (const route of ordered) {
    if (route.local || localNames.has(foldHostname(route.hostname))) {
      dropped.push(route.hostname);
      continue;
    }
    blocks.push(forwardBlock(route, inputs));
    forwarded.push(route.hostname);
  }
  if (inputs.material && inputs.peerAddresses.length > 0) {
    blocks.push(peerSite(inputs));
  }
  if (blocks.length === 0) return { contents: "", forwarded, dropped };
  const contents =
    `# Tunnel names that run on other servers. Rewritten by the control plane.\n${
      blocks.join("\n")
    }`;
  return { contents, forwarded, dropped };
}
