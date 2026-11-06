import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type {
  EnvironmentDeployHosting,
  TunnelRoute,
} from "../contracts/commands-contracts.ts";
import { buildCaddyHostnameRoutes, caddyfile, siteSnippet } from "./ingress.ts";
import {
  peerUpstreamText,
  renderTunnelFile,
  tunnelLockLines,
  tunnelPeerPaths,
  withTrustedProxies,
} from "./tunnel-caddy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER_A = "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e01";
const SERVER_B = "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e02";
const PEER_DIR = tunnelPeerPaths("/etc/turbopanel/hosting", "abc123");
const INPUTS = {
  peerAddresses: ["10.0.0.5", "10.0.0.6", "fd00::5"],
  listenAddresses: ["10.0.0.7"],
  material: PEER_DIR,
};

const ROUTES: TunnelRoute[] = [
  {
    hostname: "open.example.com",
    local: false,
    lock: false,
    upstreams: [{ serverId: SERVER_A, addresses: ["10.0.0.5"] }],
  },
  {
    hostname: "app.example.com",
    local: false,
    lock: true,
    upstreams: [
      { serverId: SERVER_A, addresses: ["10.0.0.5", "fd00::5"] },
      { serverId: SERVER_B, addresses: ["10.0.0.6"], port: 8443 },
    ],
  },
  { hostname: "here.example.com", local: true, lock: true, upstreams: [] },
];

const PROXY_TAIL = `      lb_policy round_robin
      lb_try_duration 3s
      fail_duration 10s
      max_fails 1
      header_up Host {host}
      trusted_proxies 127.0.0.0/8 ::1 10.0.0.5 10.0.0.6 fd00::5
      transport http {
        tls
        tls_trust_pool file /etc/turbopanel/hosting/peer/abc123/ca.pem
        tls_server_name tp-peer.internal
        versions 2
      }
    }`;

const GOLDEN_TUNNEL_FILE =
  `# Tunnel names that run on other servers. Rewritten by the control plane.
app.example.com {
  tls internal
  @tp_peer remote_ip 10.0.0.5 10.0.0.6 fd00::5
  handle @tp_peer {
    error 421
  }
  @tp_local remote_ip 127.0.0.0/8 ::1
  handle @tp_local {
    reverse_proxy 10.0.0.5:443 [fd00::5]:443 10.0.0.6:8443 {
${PROXY_TAIL}
  }
  handle {
    abort
  }
  handle_errors {
    respond "This site is not running right now." {err.status_code}
  }
}

open.example.com {
  tls internal
  @tp_peer remote_ip 10.0.0.5 10.0.0.6 fd00::5
  handle @tp_peer {
    error 421
  }
  handle {
    reverse_proxy 10.0.0.5:443 {
${PROXY_TAIL}
  }
  handle_errors {
    respond "This site is not running right now." {err.status_code}
  }
}

tp-peer.internal {
  tls /etc/turbopanel/hosting/peer/abc123/leaf.pem /etc/turbopanel/hosting/peer/abc123/leaf.key
  @tp_outside not remote_ip 10.0.0.5 10.0.0.6 fd00::5
  handle @tp_outside {
    abort
  }
  handle {
    respond "" 404
  }
}
`;

test("the tunnel file holds a forward block per remote name and the peer site", () => {
  const rendered = renderTunnelFile(
    ROUTES,
    INPUTS,
    new Set(),
  );
  assertEquals(rendered.contents, GOLDEN_TUNNEL_FILE);
  assertEquals(rendered.forwarded, ["app.example.com", "open.example.com"]);
  assertEquals(rendered.dropped, ["here.example.com"]);
});

test("a name served on this server is left out of the tunnel file", () => {
  const rendered = renderTunnelFile(
    ROUTES,
    INPUTS,
    new Set(["app.example.com"]),
  );
  assertEquals(rendered.contents.includes("app.example.com {"), false);
  assertEquals(rendered.forwarded, ["open.example.com"]);
  assertEquals(rendered.dropped, ["app.example.com", "here.example.com"]);
});

test("an empty table renders nothing and a table of local names keeps only the peer site", () => {
  assertEquals(
    renderTunnelFile([], { peerAddresses: [] }, new Set()).contents,
    "",
  );
  const onlyLocal = renderTunnelFile([ROUTES[2]!], INPUTS, new Set());
  assertEquals(onlyLocal.forwarded, []);
  assertStringIncludes(onlyLocal.contents, "tp-peer.internal {");
  assertEquals(onlyLocal.contents.includes("reverse_proxy"), false);
});

test("the tunnel file refuses values that are not addresses, names or plain paths", () => {
  const bad = (route: Partial<TunnelRoute>) => () =>
    renderTunnelFile(
      [{ ...ROUTES[1]!, ...route }],
      INPUTS,
      new Set(),
    );
  assertThrows(bad({ hostname: "a b.example.com" }));
  assertThrows(bad({
    upstreams: [{ serverId: SERVER_A, addresses: ["10.0.0.5 evil"] }],
  }));
  assertThrows(bad({
    upstreams: [{ serverId: SERVER_A, addresses: ["10.0.0.5"], port: 0 }],
  }));
  assertThrows(() =>
    renderTunnelFile(
      ROUTES,
      { ...INPUTS, material: { ...PEER_DIR, trust: "/etc/x y/ca.pem" } },
      new Set(),
    )
  );
  assertThrows(() =>
    renderTunnelFile(ROUTES, { peerAddresses: INPUTS.peerAddresses }, new Set())
  );
  assertThrows(() =>
    peerUpstreamText({
      kind: "peer",
      targets: [],
      trustFile: "/a/ca.pem",
      trustedProxies: [],
    })
  );
});

test("the lock lets loopback and the listed peers in and drops everyone else", () => {
  assertEquals(
    tunnelLockLines(["10.0.0.5", "fd00::5"]),
    `  @tp_outside not remote_ip 127.0.0.0/8 ::1 10.0.0.5 fd00::5
  handle @tp_outside {
    abort
  }
`,
  );
  assertThrows(() => tunnelLockLines(["10.0.0.0/24"]));
});

test("trusted_proxies is added to a one-line and a block reverse_proxy", () => {
  assertEquals(
    withTrustedProxies("reverse_proxy 127.0.0.1:8080", "127.0.0.0/8"),
    "reverse_proxy 127.0.0.1:8080 {\n  trusted_proxies 127.0.0.0/8\n}",
  );
  assertEquals(
    withTrustedProxies("reverse_proxy a:1 {\n  x\n}", "127.0.0.0/8"),
    "reverse_proxy a:1 {\n  trusted_proxies 127.0.0.0/8\n  x\n}",
  );
});

const TUNNEL = {
  lock: true,
  peers: ["10.0.0.5"],
  extraBind: ["10.0.0.7"],
} as const;

test("a locked tunnel name gets the lock, trusted peers, an HTTPS site and no HTTP site", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: "/etc/turbopanel/tls",
    forceHttps: false,
    tunnel: TUNNEL,
    upstream: { kind: "http", host: "127.0.0.1", port: 8080 },
  });
  assertEquals(
    snippet,
    `app.example.com {
  tls internal
  @tp_outside not remote_ip 127.0.0.0/8 ::1 10.0.0.5
  handle @tp_outside {
    abort
  }
  reverse_proxy 127.0.0.1:8080 {
  trusted_proxies 127.0.0.0/8 ::1 10.0.0.5
}
}
`,
  );
});

test("a locked path-routed name puts the lock before every route", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: "/etc/turbopanel/tls",
    tunnel: TUNNEL,
    routes: [
      {
        pathPrefix: "/api",
        upstream: { kind: "http", host: "127.0.0.1", port: 8080 },
      },
      { upstream: { kind: "traefik" } },
    ],
  });
  assert(
    snippet.indexOf("handle @tp_outside") < snippet.indexOf("handle /api"),
  );
  assertEquals(
    snippet.split("trusted_proxies 127.0.0.0/8 ::1 10.0.0.5").length,
    3,
  );
  assertEquals(snippet.includes("http://app.example.com"), false);
});

test("a tunnel name that is also public keeps its HTTP redirect and has no lock", () => {
  const snippet = siteSnippet({
    hostname: "pub.example.com",
    tlsDir: "/etc/turbopanel/tls",
    tunnel: { ...TUNNEL, lock: false },
    upstream: { kind: "http", host: "127.0.0.1", port: 8080 },
  });
  assertStringIncludes(snippet, "http://pub.example.com {");
  assertEquals(snippet.includes("@tp_outside"), false);
  assertStringIncludes(snippet, "trusted_proxies 127.0.0.0/8 ::1 10.0.0.5");
  // One block per address: the name appears as a site head twice (HTTP, HTTPS).
  assertEquals(
    snippet.match(/^(?:http:\/\/)?pub\.example\.com \{$/gm)?.length,
    2,
  );
});

test("a tunnel name on a single bind address also listens on loopback and the peer address", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: "/etc/turbopanel/tls",
    bindAddress: "10.0.0.7",
    tunnel: TUNNEL,
  });
  assertStringIncludes(snippet, "  bind 10.0.0.7 127.0.0.1\n");
  const unbound = siteSnippet({
    hostname: "app.example.com",
    tlsDir: "/etc/turbopanel/tls",
    tunnel: TUNNEL,
  });
  assertEquals(unbound.includes("bind"), false);
});

test("a name without a tunnel is written exactly as before, and the Caddyfile has no trusted proxies", () => {
  const plain = siteSnippet({
    hostname: "app.example.com",
    tlsDir: "/etc/turbopanel/tls",
    bindAddress: "10.0.0.7",
    upstream: { kind: "http", host: "127.0.0.1", port: 8080 },
  });
  assertEquals(
    plain,
    `http://app.example.com {
  bind 10.0.0.7
  redir https://{host}{uri} permanent
}

app.example.com {
  bind 10.0.0.7
  tls internal
  reverse_proxy 127.0.0.1:8080
}
`,
  );
  assertEquals(caddyfile("/etc/turbopanel").includes("trusted_proxies"), false);
});

test("a peer upstream is a closed upstream kind that renders the forwarding proxy", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: "/etc/turbopanel/tls",
    upstream: {
      kind: "peer",
      targets: ["10.0.0.5:443"],
      trustFile: "/etc/turbopanel/hosting/peer/abc123/ca.pem",
      trustedProxies: ["127.0.0.0/8"],
    },
  });
  assertStringIncludes(snippet, "tls_server_name tp-peer.internal");
  assertStringIncludes(snippet, "reverse_proxy 10.0.0.5:443 {");
});

function hosting(
  patch: Partial<EnvironmentDeployHosting>,
): EnvironmentDeployHosting {
  return {
    hostingId: "h1",
    serviceId: "s1",
    composeServiceName: "web",
    hostnames: ["app.example.com", "pub.example.com", "plain.example.com"],
    ...patch,
  };
}

test("only the names a hosting lists as tunnel names are locked, and open ones are not", () => {
  const sites = buildCaddyHostnameRoutes({
    environmentId: "env-1",
    projectId: "p",
    organizationId: "o",
    projectName: "demo",
    composeFiles: [],
    hostings: [hosting({
      tunnel: {
        hostnames: ["app.example.com", "pub.example.com"],
        openHostnames: ["pub.example.com"],
        peers: ["10.0.0.5"],
        extraBind: ["10.0.0.7"],
      },
    })],
  } as never);
  assertEquals(sites.get("app.example.com")?.tunnel, {
    lock: true,
    peers: ["10.0.0.5"],
    extraBind: ["10.0.0.7"],
  });
  assertEquals(sites.get("pub.example.com")?.tunnel?.lock, false);
  assertEquals(sites.get("plain.example.com")?.tunnel, undefined);
});

test("no tunnel block can ask for a certificate: every one names its own tls", () => {
  const file = renderTunnelFile(ROUTES, INPUTS, new Set()).contents;
  const blocks = file.split(/\n(?=\S)/).filter((b) => /^\S.* \{$/m.test(b));
  for (const block of blocks) {
    assertEquals(/^ {2}tls (internal|\/\S+ \/\S+)$/m.test(block), true, block);
  }
  assertEquals(file.includes("on_demand"), false);
  // An automatic-certificate mode on a locked tunnel name still gets tls internal.
  const locked = siteSnippet({
    hostname: "app.example.com",
    tlsDir: "/etc/turbopanel/tls",
    tlsMode: "acme",
    tunnel: TUNNEL,
  });
  assertStringIncludes(locked, "  tls internal\n");
});

test("a server that only carries tunnels gets forward blocks with no peer rule and no peer site", () => {
  const rendered = renderTunnelFile(
    [ROUTES[1]!],
    { peerAddresses: [], material: PEER_DIR },
    new Set(),
  );
  assertStringIncludes(rendered.contents, "app.example.com {");
  assertEquals(rendered.contents.includes("@tp_peer"), false);
  assertEquals(rendered.contents.includes("tp-peer.internal {"), false);
  assertStringIncludes(rendered.contents, "trusted_proxies 127.0.0.0/8 ::1\n");
});

test("the peer site never binds, so it shares the server of the sites that listen everywhere", () => {
  const withListen = renderTunnelFile(ROUTES, INPUTS, new Set()).contents;
  const without = renderTunnelFile(
    ROUTES,
    { peerAddresses: INPUTS.peerAddresses, material: PEER_DIR },
    new Set(),
  ).contents;
  // Listen addresses from the control plane are accepted but change nothing.
  assertEquals(withListen, without);
  const peerBlock = withListen.slice(withListen.indexOf("tp-peer.internal {"));
  assertEquals(/^\s*bind\b/m.test(peerBlock), false);
  // A bound peer site would be a Caddy server of its own that holds only this
  // name and would answer a forwarded request for a real hostname with nothing.
  assertEquals(/^\s*bind\b/m.test(withListen), false);
});

// Runs only where a real Caddy is named (TP_TEST_CADDY=/path/to/caddy), as the
// other real-Caddy tests do. `caddy adapt` shows how Caddy groups the sites
// into servers: the peer site and a normal site must share one.
test({
  name: "a real Caddy puts the peer site and a normal site in one server",
  ignore: !Deno.env.get("TP_TEST_CADDY"),
  fn: async () => {
    const rendered = renderTunnelFile(ROUTES, INPUTS, new Set()).contents;
    const site =
      'plain.example.com {\n  tls internal\n  respond "app" 200\n}\n';
    const child = new Deno.Command(Deno.env.get("TP_TEST_CADDY")!, {
      args: ["adapt", "--adapter", "caddyfile", "--config", "/dev/stdin"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(`${site}\n${rendered}`));
    await writer.close();
    const out = await child.output();
    assertEquals(out.success, true, new TextDecoder().decode(out.stderr));
    const config = JSON.parse(new TextDecoder().decode(out.stdout));
    const servers = Object.values(
      config.apps.http.servers as Record<
        string,
        { listen: string[]; routes: { match?: { host?: string[] }[] }[] }
      >,
    );
    const serverOf = (host: string) =>
      servers.filter((server) =>
        server.routes.some((route) =>
          route.match?.some((m) => m.host?.includes(host))
        )
      );
    assertEquals(serverOf("tp-peer.internal").length, 1);
    assertEquals(serverOf("plain.example.com"), serverOf("tp-peer.internal"));
    assertEquals(serverOf("app.example.com"), serverOf("tp-peer.internal"));
  },
});
