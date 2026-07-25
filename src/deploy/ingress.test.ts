import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert";
import {
  assertValidBindAddress,
  buildCaddyHostnameRoutes,
  buildTcpUdpIngressEntries,
  caddyfile,
  caddyTraefikUpstream,
  collectTcpUdpIngressEntries,
  removeTcpUdpIngressEntries,
  siteSnippet,
  sortCaddySiteRoutes,
  syncTcpUdpIngressEntries,
  TcpUdpPortConflictError,
  traefikCompose,
} from "./ingress.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";

async function makeTestLayout(): Promise<{ layout: LayoutPaths; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "tp-ingress-test-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  return { layout, cleanup: () => Deno.remove(root, { recursive: true }) };
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CONFIG_DIR = "/etc/turbopanel";
const TLS_DIR = "/etc/turbopanel/tls";

test("traefikCompose publishes loopback ports with proxy protocol and TLS", () => {
  const compose = traefikCompose();
  assertStringIncludes(compose, "127.0.0.1:7080:7080");
  assertStringIncludes(compose, "127.0.0.1:7443:7443");
  assertStringIncludes(compose, "--entrypoints.web.address=:7080");
  assertStringIncludes(compose, "--entrypoints.websecure.address=:7443");
  assertStringIncludes(compose, "--entrypoints.websecure.http.tls=true");
  assertStringIncludes(compose, "--entrypoints.web.proxyProtocol.insecure=true");
  assertStringIncludes(
    compose,
    "--entrypoints.websecure.proxyProtocol.insecure=true",
  );
  if (compose.includes("socat")) {
    throw new Error("traefikCompose must not include socat");
  }
  if (compose.includes("ingress-bridge")) {
    throw new Error("traefikCompose must not include ingress-bridge");
  }
  if (compose.includes("alpine")) {
    throw new Error("traefikCompose must not include alpine");
  }
});

test("caddyTraefikUpstream http hop uses h2c and PROXY v2", () => {
  const upstream = caddyTraefikUpstream("http");
  assertStringIncludes(upstream, "127.0.0.1:7080");
  assertStringIncludes(upstream, "versions h2c");
  assertStringIncludes(upstream, "proxy_protocol v2");
  assertStringIncludes(upstream, "keepalive off");
});

test("caddyTraefikUpstream https hop uses TLS skip-verify and PROXY v2", () => {
  const upstream = caddyTraefikUpstream("https");
  assertStringIncludes(upstream, "127.0.0.1:7443");
  assertStringIncludes(upstream, "tls_insecure_skip_verify");
  assertStringIncludes(upstream, "versions 2");
  assertStringIncludes(upstream, "proxy_protocol v2");
  assertStringIncludes(upstream, "keepalive off");
});

test("caddyfile disables auto_https and advertises h1 h2 h3", () => {
  const config = caddyfile(CONFIG_DIR);
  assertStringIncludes(config, "auto_https off");
  assertStringIncludes(config, "protocols h1 h2 h3");
});

test("siteSnippet without bindAddress matches baseline forceHttps output", () => {
  const snippet = siteSnippet("app.example.com", undefined, TLS_DIR, true);
  assertEquals(
    snippet,
    `http://app.example.com {
  redir https://{host}{uri} permanent
}

app.example.com {
  tls internal
  ${caddyTraefikUpstream("https")}
}
`,
  );
  if (snippet.includes("bind ")) {
    throw new Error("baseline siteSnippet must not emit bind");
  }
});

test("siteSnippet emits IPv4 bind in https block", () => {
  const snippet = siteSnippet(
    "app.example.com",
    undefined,
    TLS_DIR,
    true,
    "203.0.113.10",
  );
  assertStringIncludes(
    snippet,
    `http://app.example.com {
  bind 203.0.113.10
  redir https://{host}{uri} permanent
}
`,
  );
  assertStringIncludes(
    snippet,
    `app.example.com {
  bind 203.0.113.10
  tls internal
`,
  );
});

test("siteSnippet emits bracketed IPv6 bind", () => {
  const snippet = siteSnippet(
    "app.example.com",
    undefined,
    TLS_DIR,
    true,
    "2001:db8::10",
  );
  assertStringIncludes(
    snippet,
    `http://app.example.com {
  bind [2001:db8::10]
  redir https://{host}{uri} permanent
}
`,
  );
  assertStringIncludes(
    snippet,
    `app.example.com {
  bind [2001:db8::10]
  tls internal
`,
  );
});

test("siteSnippet emits loopback bind for local scope", () => {
  const snippet = siteSnippet(
    "app.example.com",
    undefined,
    TLS_DIR,
    true,
    "127.0.0.1",
  );
  assertStringIncludes(
    snippet,
    `http://app.example.com {
  bind 127.0.0.1
  redir https://{host}{uri} permanent
}
`,
  );
  assertStringIncludes(
    snippet,
    `app.example.com {
  bind 127.0.0.1
  tls internal
`,
  );
});

test("siteSnippet routes multiple path prefixes on one hostname", () => {
  const snippet = siteSnippet(
    "app.example.com",
    undefined,
    TLS_DIR,
    true,
    undefined,
    { kind: "traefik" },
    [
      {
        pathPrefix: "/php",
        upstream: { kind: "http", host: "127.0.0.1", port: 18081 },
      },
      {
        upstream: { kind: "http", host: "127.0.0.1", port: 18080 },
      },
    ],
  );
  assertStringIncludes(snippet, "handle /php/*");
  assertStringIncludes(snippet, "reverse_proxy 127.0.0.1:18081");
  assertStringIncludes(snippet, "reverse_proxy 127.0.0.1:18080");
  const phpIndex = snippet.indexOf("/php/*");
  const catchAllIndex = snippet.indexOf("handle {");
  if (phpIndex < 0 || catchAllIndex < 0 || phpIndex > catchAllIndex) {
    throw new Error("path-specific handle must appear before catch-all handle");
  }
});

test("buildCaddyHostnameRoutes groups hostings by hostname", () => {
  const routes = buildCaddyHostnameRoutes({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo",
    composeYaml: "services: {}",
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "static",
        hostnames: ["app.example.com"],
      },
      {
        hostingId: "h2",
        serviceId: "s2",
        composeServiceName: "php",
        hostnames: ["app.example.com"],
        pathPrefix: "/php",
      },
    ],
    traditionalWebSites: [
      {
        composeServiceName: "static",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
      },
      {
        composeServiceName: "php",
        engine: "nginx",
        root: "public",
        listenPort: 18081,
      },
    ],
  });
  const site = routes.get("app.example.com");
  assertEquals(site?.routes.length, 2);
  const sorted = sortCaddySiteRoutes(site!.routes);
  assertEquals(sorted[0]?.pathPrefix, "/php");
  assertEquals(sorted[1]?.pathPrefix, undefined);
});

test("assertValidBindAddress rejects garbage before interpolation", () => {
  assertThrows(
    () => assertValidBindAddress("not an ip; rm -rf /"),
    Error,
    "unsupported characters",
  );
  assertThrows(
    () => siteSnippet("app.example.com", undefined, TLS_DIR, true, "evil;bind"),
    Error,
    "unsupported characters",
  );
});

test("traefikCompose with no tcp/udp entries matches baseline (no extra entrypoints/ports)", () => {
  assertEquals(traefikCompose([]), traefikCompose());
});

test("traefikCompose adds a static entrypoint and published port per tcp/udp entry", () => {
  const compose = traefikCompose([
    { hostingId: "h1", protocol: "tcp", publishedPort: 5432, bindAddress: "203.0.113.10" },
    { hostingId: "h2", protocol: "udp", publishedPort: 53 },
  ]);
  assertStringIncludes(compose, "--entrypoints.tcp5432.address=:5432");
  assertStringIncludes(compose, "--entrypoints.udp53.address=:53/udp");
  assertStringIncludes(compose, "203.0.113.10:5432:5432/tcp");
  assertStringIncludes(compose, "0.0.0.0:53:53/udp");
});

test("traefikCompose dedupes entries claiming the same protocol+port", () => {
  const compose = traefikCompose([
    { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
    { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
  ]);
  const occurrences = compose.split("entrypoints.tcp5432").length - 1;
  assertEquals(occurrences, 1);
});

test("buildTcpUdpIngressEntries extracts one entry per port for tcp/udp hostings only", () => {
  const entries = buildTcpUdpIngressEntries([
    {
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: ["app.example.com"],
    },
    {
      hostingId: "h2",
      serviceId: "s2",
      composeServiceName: "db",
      hostnames: [],
      protocol: "tcp",
      ports: [{ published: 5432, target: 5432 }, { published: 5433, target: 5432 }],
      bindAddress: "203.0.113.10",
    },
  ]);
  assertEquals(entries, [
    { hostingId: "h2", protocol: "tcp", publishedPort: 5432, bindAddress: "203.0.113.10" },
    { hostingId: "h2", protocol: "tcp", publishedPort: 5433, bindAddress: "203.0.113.10" },
  ]);
});

test("syncTcpUdpIngressEntries persists, merges across environments, and removeTcpUdpIngressEntries cleans up", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const mergedAfterEnvA = await syncTcpUdpIngressEntries(layout, "env-a", [
      { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
    ]);
    assertEquals(mergedAfterEnvA.length, 1);

    const mergedAfterEnvB = await syncTcpUdpIngressEntries(layout, "env-b", [
      { hostingId: "h2", protocol: "udp", publishedPort: 53 },
    ]);
    assertEquals(mergedAfterEnvB.length, 2);

    const all = await collectTcpUdpIngressEntries(layout);
    assertEquals(all.length, 2);

    const remainingAfterRemoveA = await removeTcpUdpIngressEntries(layout, "env-a");
    assertEquals(remainingAfterRemoveA?.length, 1);
    assertEquals(remainingAfterRemoveA?.[0]?.hostingId, "h2");

    const noopRemove = await removeTcpUdpIngressEntries(layout, "env-a");
    assertEquals(noopRemove, null);
  } finally {
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries throws TcpUdpPortConflictError when another environment already claims the port", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await syncTcpUdpIngressEntries(layout, "env-a", [
      { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
    ]);
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(layout, "env-b", [
          { hostingId: "h2", protocol: "tcp", publishedPort: 5432 },
        ]),
      TcpUdpPortConflictError,
    );
  } finally {
    await cleanup();
  }
});
