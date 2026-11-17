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
  TUNNEL_PEER_PORT,
  TUNNEL_PEER_TLS_NAME,
  type TunnelInbound,
  type TunnelPeerClientAuth,
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

/**
 * The one status the error page answers with. With one upstream and a three
 * second retry window the error is 502 or 503 at random, and the edge replaces
 * a 502 with its own page, so the page always answers 503, which it passes on.
 */
export const TUNNEL_ERROR_STATUS = 503;

const LOOPBACK_RANGES = "127.0.0.0/8 ::1";
const DEFAULT_PEER_PORT = 443;
/**
 * The port of the peer-facing server when the table sets `peerClientAuth`. It
 * is separate from the hosting port on purpose: Caddy turns on strict SNI
 * matching for a server that checks client certificates, and a certificate
 * check that sat on a name of the shared server would not cover a connection
 * that names a real hostname. The number is a contract constant (the control
 * plane opens the same port in its firewall rule) and is reserved for apps in
 * `RESERVED_HOST_PORT_RANGES`.
 */
export { TUNNEL_PEER_PORT };
/** The header the peer-facing server sets on what it passes to the hosting sites. */
export const TUNNEL_PEER_HOP_HEADER = "X-Tp-Peer-Hop";
/** Carries the real Host from the sender to the peer-facing server. */
export const TUNNEL_PEER_HOST_HEADER = "X-Tp-Peer-Host";
/** Named matchers are per site block, and these names are used once in each. */
const OUTSIDE_MATCHER = "@tp_outside";
const PEER_MATCHER = "@tp_peer";
const LOCAL_MATCHER = "@tp_local";
const REPEATED_HOST_MATCHER = "@tp_repeated_host";
/** Caddy joins a repeated header with a comma, and a hostname never holds one. */
const TUNNEL_PEER_HOST_HEADER_PLACEHOLDER =
  `{http.request.header.${TUNNEL_PEER_HOST_HEADER}}`;

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
  /** Certificate and key shown to the receiving server as a client certificate. */
  clientCertificate?: Readonly<{ certificate: string; key: string }>;
  /**
   * The receiver is a dedicated peer-facing server. It matches the Host header
   * to the connecting name (Caddy does that on any server that checks client
   * certificates), so the request names the fixed peer name as its Host and
   * carries the real one in {@link TUNNEL_PEER_HOST_HEADER}, which the receiver
   * puts back before handing the request to the sites.
   */
  carryHostInHeader?: true;
  /** The source address of the hop (`local_address`); a bare address on this host. */
  localAddress?: string;
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
 * The transport has a dial timeout inside the retry window, a limit on the
 * wait for the first response header only (a long body is never cut off), and
 * a short idle keepalive so a pooled connection to a silent peer is not reused.
 * `tls_server_name` is fixed: the receiving server presents the certificate it
 * loaded for that name, and the sender trusts only the organization's bundle.
 * With `clientCertificate` the sender also shows its own peer certificate
 * (`tls_client_auth`), so the receiving server, which refuses a connection
 * without a certificate of the organization's authority, lets it in.
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
  const clientAuth = upstream.clientCertificate
    ? `    tls_client_auth ${
      assertPath(
        "tunnel client certificate",
        upstream.clientCertificate.certificate,
      )
    } ${assertPath("tunnel client key", upstream.clientCertificate.key)}\n`
    : "";
  if (upstream.localAddress !== undefined) assertAddress(upstream.localAddress);
  const sourceLine = upstream.localAddress === undefined
    ? ""
    : `    local_address ${upstream.localAddress}\n`;
  const hostLines = upstream.carryHostInHeader
    ? `  header_up Host ${TUNNEL_PEER_TLS_NAME}\n  header_up ${TUNNEL_PEER_HOST_HEADER} {host}\n`
    : "  header_up Host {host}\n";
  return `reverse_proxy ${targets.join(" ")} {
  lb_policy round_robin
  lb_try_duration 3s
  fail_duration 10s
  max_fails 1
${hostLines}  trusted_proxies ${upstream.trustedProxies.join(" ")}
  transport http {
    tls
    tls_trust_pool file ${trust}
    tls_server_name ${TUNNEL_PEER_TLS_NAME}
${clientAuth}${sourceLine}    versions 2
    dial_timeout 2s
    response_header_timeout 60s
    keepalive 15s
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
  /**
   * Set = the peer-facing server is its own server on {@link TUNNEL_PEER_PORT}
   * and checks client certificates ({@link TunnelPeerClientAuth}), and forwards
   * go to that port. Absent = the shared hosting port, no client certificate.
   */
  clientAuth?: TunnelPeerClientAuth;
  /**
   * True when the peer certificate allows client use: forward blocks then show
   * it to the receiving server. False (a certificate from before the change)
   * sends nothing, as before.
   */
  presentCertificate?: boolean;
  /**
   * Names that run here and who may forward each (strict mode only): the peer
   * server hands a request on only for a listed name from one of its peers.
   */
  inbound?: readonly TunnelInbound[];
  /**
   * The addresses this host owns. When set, an upstream's `localAddress` is used
   * only if it is in here; otherwise it is left out and a warning is returned.
   * Absent = not checked.
   */
  localAddresses?: ReadonlySet<string>;
}>;

/**
 * One spelling per address: IPv6 compressed and lower case, no zone, so
 * `FD00:0:0::7` and `fd00::7` compare equal. Anything else is returned as is.
 */
export function canonicalAddress(address: string): string {
  const bare = address.split("%")[0].toLowerCase();
  if (!bare.includes(":")) return bare;
  try {
    return new URL(`http://[${bare}]`).hostname.slice(1, -1);
  } catch {
    return bare;
  }
}

const familyOf = (address: string): 4 | 6 => address.includes(":") ? 6 : 4;

/**
 * The source address for one forward block, or why there is none. One
 * `reverse_proxy` has one transport, so every upstream must name the same
 * address; targets of the other address family could not be dialed from it and
 * are dropped.
 */
function pinnedSource(
  route: TunnelRoute,
  inputs: TunnelFileInputs,
): { address?: string; warning?: string } {
  const named = new Set(
    route.upstreams.map((upstream) => upstream.localAddress),
  );
  if (named.size === 1 && named.has(undefined)) return {};
  const [address] = named;
  if (named.size !== 1 || address === undefined) {
    return {
      warning:
        `${route.hostname}: the servers that carry it name different source addresses, so none is pinned`,
    };
  }
  assertAddress(address);
  if (
    inputs.localAddresses &&
    ![...inputs.localAddresses].some((own) =>
      canonicalAddress(own) === canonicalAddress(address)
    )
  ) {
    return {
      warning:
        `${route.hostname}: source address ${address} is not on this server, so none is pinned`,
    };
  }
  return { address: canonicalAddress(address) };
}

/** One forward block for a site that runs on other servers. */
function forwardBlock(
  route: TunnelRoute,
  inputs: TunnelFileInputs,
  warnings: string[],
): string {
  if (!isValidHostname(route.hostname)) {
    throw new ConfigValueError("tunnel hostname", "must be a hostname");
  }
  const material = inputs.material;
  if (!material) {
    throw new ConfigValueError("tunnel material", "is required to forward");
  }
  const source = pinnedSource(route, inputs);
  if (source.warning) warnings.push(source.warning);
  const allTargets = (pinned: string | undefined) =>
    route.upstreams.flatMap((upstream) =>
      upstream.addresses
        .filter((address) =>
          pinned === undefined || familyOf(address) === familyOf(pinned)
        )
        .map((address) =>
          formatTunnelTarget(
            address,
            upstream.port ??
              (inputs.clientAuth ? TUNNEL_PEER_PORT : DEFAULT_PEER_PORT),
          )
        )
    );
  // Targets of the other family cannot be dialed from the pinned address; if
  // none are left, the pin is dropped rather than the route.
  let pinned = source.address;
  let targets = allTargets(pinned);
  if (pinned !== undefined) {
    const all = allTargets(undefined).length;
    if (targets.length > 0 && targets.length < all) {
      warnings.push(
        `${route.hostname}: ${
          all - targets.length
        } target(s) of the other address family than source address ${pinned} are left out`,
      );
    }
  }
  if (pinned !== undefined && targets.length === 0) {
    warnings.push(
      `${route.hostname}: no target shares the family of source address ${pinned}, so none is pinned`,
    );
    pinned = undefined;
    targets = allTargets(undefined);
  }
  const proxy = peerUpstreamText({
    kind: "peer",
    targets,
    ...(pinned === undefined ? {} : { localAddress: pinned }),
    trustFile: material.trust,
    ...(inputs.clientAuth ? { carryHostInHeader: true as const } : {}),
    ...(inputs.presentCertificate
      ? {
        clientCertificate: {
          certificate: material.certificate,
          key: material.key,
        },
      }
      : {}),
    trustedProxies: tunnelTrustedRanges(inputs.peerAddresses),
  }).split("\n").map((line) => `    ${line}`).join("\n");
  // A request that came from a peer is never passed on again, so a moved site
  // with a stale table shows the error page instead of looping. A server that
  // only carries tunnels has no peers sending to it, so it has no such rule.
  // With the dedicated peer port (`clientAuth`) a forwarded request reaches
  // the sites over loopback and says where it came from in a header the
  // peer-facing server always sets; otherwise it is told by its source address.
  const peerMatch = inputs.clientAuth
    ? `header ${TUNNEL_PEER_HOP_HEADER} 1`
    : `remote_ip ${inputs.peerAddresses.join(" ")}`;
  const peerRule = inputs.peerAddresses.length === 0
    ? ""
    : `  ${PEER_MATCHER} ${peerMatch}
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
    respond "${TUNNEL_ERROR_TEXT}" ${TUNNEL_ERROR_STATUS}
  }
}
`;
}

/**
 * The small site that makes this server present the peer certificate when
 * another server connects with the fixed name (table without `peerClientAuth`).
 * Caddy picks a certificate by the connecting name, not by the Host header, so
 * without a site that loads the certificate the sender would be shown the
 * wrong one and refuse it. Only listed peers get any answer.
 *
 * The site has no `bind`. Caddy makes one server per set of listen addresses,
 * so a site bound to this server's own address would become a server of its own
 * that holds only this name, and a forwarded request for a real hostname that
 * arrives on that address would find no route and get an empty answer. Without
 * a `bind` it shares the server of the other sites that listen everywhere, and
 * the `remote_ip` check below is what keeps everyone but the listed peers out.
 */
function sharedPeerSite(inputs: TunnelFileInputs): string {
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

/**
 * The peer-facing server (table with `peerClientAuth`): its own Caddy server on
 * {@link TUNNEL_PEER_PORT}, so nothing about it touches the hosting sites on
 * 443. A connection needs a client certificate of the organization's
 * authority (`require`; `verify` only checks one that is shown) and a listed
 * source address. What passes is handed to the hosting sites over loopback with
 * the original Host, marked with {@link TUNNEL_PEER_HOP_HEADER} (set here, so a
 * visitor cannot make it up on the way in), and so reaches the site, or its
 * forward block, as local traffic. Locked sites therefore admit loopback only
 * and nothing that connects to 443 with a peer address gets in on that alone.
 */
function dedicatedPeerSite(inputs: TunnelFileInputs): string {
  const material = inputs.material!;
  const certificate = assertPath("tunnel certificate", material.certificate);
  const key = assertPath("tunnel key", material.key);
  const trust = assertPath("tunnel trust file", material.trust);
  const mode = inputs.clientAuth === "require"
    ? "require_and_verify"
    : "verify_if_given";
  const peers = inputs.peerAddresses.join(" ");
  const proxy = `    reverse_proxy https://127.0.0.1:443 {
      header_up Host {header.${TUNNEL_PEER_HOST_HEADER}}
      header_up -${TUNNEL_PEER_HOST_HEADER}
      header_up ${TUNNEL_PEER_HOP_HEADER} 1
      trusted_proxies ${tunnelTrustedRanges(inputs.peerAddresses).join(" ")}
      transport http {
        tls_server_name {http.request.header.${TUNNEL_PEER_HOST_HEADER}}
        tls_insecure_skip_verify
        dial_timeout 2s
        response_header_timeout 60s
      }
    }`;
  // A repeated peer-host header is refused outright, before any door: the
  // header matcher alone passes on any one value, and the Host would then be
  // the joined list.
  // One door per name the table lists with peers: the name in the header and a
  // source address that name allows. Anything else (a name not listed, a
  // local-only name with no peers, a listed name from an unlisted peer) is cut,
  // so a valid certificate alone reaches nothing.
  const byName = new Map<string, readonly string[]>();
  for (const entry of inputs.inbound ?? []) {
    const name = foldHostname(entry.hostname);
    if (!byName.has(name)) byName.set(name, entry.peers);
  }
  const doors = [...byName].filter(([, who]) => who.length > 0).map((
    [name, who],
    index,
  ) => {
    if (!isValidHostname(name)) {
      throw new ConfigValueError("tunnel hostname", "must be a hostname");
    }
    const matcher = `@tp_door_${index}`;
    return `  ${matcher} {
    header ${TUNNEL_PEER_HOST_HEADER} ${name}
    remote_ip ${who.join(" ")}
  }
  handle ${matcher} {
${proxy}
  }
`;
  }).join("");
  return `https://:${TUNNEL_PEER_PORT} {
  tls ${certificate} ${key} {
    client_auth {
      mode ${mode}
      trust_pool file ${trust}
    }
  }
  ${OUTSIDE_MATCHER} not remote_ip ${peers}
  handle ${OUTSIDE_MATCHER} {
    abort
  }
  ${REPEATED_HOST_MATCHER} {
    vars_regexp ${TUNNEL_PEER_HOST_HEADER_PLACEHOLDER} ,
  }
  handle ${REPEATED_HOST_MATCHER} {
    abort
  }
${doors}  handle {
    abort
  }
}
`;
}

function peerSite(inputs: TunnelFileInputs): string {
  return inputs.clientAuth ? dedicatedPeerSite(inputs) : sharedPeerSite(inputs);
}

/** What {@link renderTunnelFile} made and what it left out. */
export type RenderedTunnelFile = {
  contents: string;
  /** Names with a forward block in the file. */
  forwarded: string[];
  /** Names left out because a site on this server answers them. */
  dropped: string[];
  /** Source addresses that were not used, and why. */
  warnings: string[];
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
  const warnings: string[] = [];
  const ordered = routes.toSorted((a, b) =>
    foldHostname(a.hostname).localeCompare(foldHostname(b.hostname))
  );
  for (const route of ordered) {
    if (route.local || localNames.has(foldHostname(route.hostname))) {
      dropped.push(route.hostname);
      continue;
    }
    blocks.push(forwardBlock(route, inputs, warnings));
    forwarded.push(route.hostname);
  }
  if (inputs.material && inputs.peerAddresses.length > 0) {
    blocks.push(peerSite(inputs));
  }
  if (blocks.length === 0) {
    return { contents: "", forwarded, dropped, warnings };
  }
  const contents =
    `# Tunnel names that run on other servers. Rewritten by the control plane.\n${
      blocks.join("\n")
    }`;
  return { contents, forwarded, dropped, warnings };
}
