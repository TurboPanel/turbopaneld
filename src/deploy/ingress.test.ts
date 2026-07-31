import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  assertValidBindAddress,
  buildCaddyHostnameRoutes,
  buildTcpUdpIngressEntries,
  caddyfile,
  caddyTraefikUpstream,
  cleanupStaleTcpUdpServiceIngress,
  collectTcpUdpIngressEntries,
  listPersistedTcpUdpServiceIds,
  readEnvironmentTcpUdpServiceIds,
  removeEnvironmentTcpUdpServiceIngress,
  removeServiceIngress,
  removeTcpUdpIngressEntries,
  serviceIngressDir,
  serviceTraefikCompose,
  siteSnippet,
  sortCaddySiteRoutes,
  syncTcpUdpIngressEntries,
  TcpUdpPortConflictError,
  traefikCompose,
} from "./ingress.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";

async function makeTestLayout(): Promise<
  { layout: LayoutPaths; cleanup: () => Promise<void> }
> {
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
  assertStringIncludes(
    compose,
    "--entrypoints.web.proxyProtocol.insecure=true",
  );
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

test("traefikCompose is HTTP-only (no tcp/udp entrypoints or public ports)", () => {
  const compose = traefikCompose();
  assertEquals(compose.includes("entrypoints.tcp"), false);
  assertEquals(compose.includes("entrypoints.udp"), false);
  assertEquals(compose.includes(":5432:5432"), false);
  assertStringIncludes(compose, "--entrypoints.web.address=:7080");
  assertStringIncludes(compose, "--entrypoints.websecure.address=:7443");
});

const SERVICE_INGRESS_IDENTITY = {
  serviceId: "00000000-0000-4000-8000-0000000000aa",
  composeServiceName: "db-ingress",
  containerName: "00000000-0000-4000-8000-0000000000aa-ingress",
};

test("serviceTraefikCompose emits container_name, constraint, and x-turbopanel", () => {
  const compose = serviceTraefikCompose([], SERVICE_INGRESS_IDENTITY);
  assertStringIncludes(
    compose,
    `container_name: ${SERVICE_INGRESS_IDENTITY.containerName}`,
  );
  assertStringIncludes(compose, "kind: ingress");
  assertStringIncludes(
    compose,
    `serviceId: ${SERVICE_INGRESS_IDENTITY.serviceId}`,
  );
  assertStringIncludes(
    compose,
    `Label(\`com.turbopanel.service\`,\`${SERVICE_INGRESS_IDENTITY.serviceId}\`) && Label(\`com.turbopanel.raw-port\`,\`true\`)`,
  );
  assertStringIncludes(compose, "turbopanel-ingress");
  assertEquals(compose.includes("entrypoints.web"), false);
  assertEquals(compose.includes("entrypoints.websecure"), false);
});

test("serviceTraefikCompose adds a static entrypoint and published port per tcp/udp entry", () => {
  const compose = serviceTraefikCompose(
    [
      {
        hostingId: "h1",
        protocol: "tcp",
        publishedPort: 5432,
        bindAddress: "203.0.113.10",
      },
      { hostingId: "h2", protocol: "udp", publishedPort: 53 },
    ],
    SERVICE_INGRESS_IDENTITY,
  );
  assertStringIncludes(compose, "--entrypoints.tcp5432.address=:5432");
  assertStringIncludes(compose, "--entrypoints.udp53.address=:53/udp");
  assertStringIncludes(compose, "203.0.113.10:5432:5432/tcp");
  assertStringIncludes(compose, "0.0.0.0:53:53/udp");
});

test("serviceTraefikCompose dedupes entries claiming the same protocol+port", () => {
  const compose = serviceTraefikCompose(
    [
      { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
      { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
    ],
    SERVICE_INGRESS_IDENTITY,
  );
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
      ports: [{ published: 5432, target: 5432 }, {
        published: 5433,
        target: 5432,
      }],
      bindAddress: "203.0.113.10",
    },
  ]);
  assertEquals(entries, [
    {
      hostingId: "h2",
      protocol: "tcp",
      publishedPort: 5432,
      bindAddress: "203.0.113.10",
    },
    {
      hostingId: "h2",
      protocol: "tcp",
      publishedPort: 5433,
      bindAddress: "203.0.113.10",
    },
  ]);
});

test("syncTcpUdpIngressEntries persists per service, returns own entries, and remove cleans up", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const ownAfterSvcA = await syncTcpUdpIngressEntries(layout, "svc-a", [
      { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
    ]);
    assertEquals(ownAfterSvcA.length, 1);

    const ownAfterSvcB = await syncTcpUdpIngressEntries(layout, "svc-b", [
      { hostingId: "h2", protocol: "udp", publishedPort: 53 },
    ]);
    assertEquals(ownAfterSvcB.length, 1);
    assertEquals(ownAfterSvcB[0]?.hostingId, "h2");

    const all = await collectTcpUdpIngressEntries(layout);
    assertEquals(all.length, 2);

    const remainingAfterRemoveA = await removeTcpUdpIngressEntries(
      layout,
      "svc-a",
    );
    assertEquals(remainingAfterRemoveA?.length, 1);
    assertEquals(remainingAfterRemoveA?.[0]?.hostingId, "h2");

    const noopRemove = await removeTcpUdpIngressEntries(layout, "svc-a");
    assertEquals(noopRemove, null);
  } finally {
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries throws TcpUdpPortConflictError when another service already claims the port", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await syncTcpUdpIngressEntries(layout, "svc-a", [
      { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
    ]);
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(layout, "svc-b", [
          { hostingId: "h2", protocol: "tcp", publishedPort: 5432 },
        ]),
      TcpUdpPortConflictError,
    );
  } finally {
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries serializes concurrent same-port claims — only one commits", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const results = await Promise.allSettled([
      syncTcpUdpIngressEntries(layout, "svc-a", [
        { hostingId: "h1", protocol: "tcp", publishedPort: 25432 },
      ]),
      syncTcpUdpIngressEntries(layout, "svc-b", [
        { hostingId: "h2", protocol: "tcp", publishedPort: 25432 },
      ]),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assertEquals(fulfilled.length, 1);
    assertEquals(rejected.length, 1);
    if (rejected[0]?.status === "rejected") {
      if (!(rejected[0].reason instanceof TcpUdpPortConflictError)) {
        throw new TypeError(
          "expected the losing concurrent claim to reject with TcpUdpPortConflictError",
        );
      }
    }

    const all = await collectTcpUdpIngressEntries(layout);
    assertEquals(all.length, 1);
    assertEquals(all[0]?.publishedPort, 25432);
  } finally {
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries never leaves a temp file behind after a successful write", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await syncTcpUdpIngressEntries(layout, "svc-a", [
      { hostingId: "h1", protocol: "tcp", publishedPort: 15432 },
    ]);

    const dir = join(layout.stateDir, "ingress", "tcp-udp");
    const names: string[] = [];
    for await (const dirEntry of Deno.readDir(dir)) names.push(dirEntry.name);
    assertEquals(names, ["svc-a.json"]);
  } finally {
    await cleanup();
  }
});

test("collectTcpUdpIngressEntries rejects corrupt/partially-written state with a clear error", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const dir = join(layout.stateDir, "ingress", "tcp-udp");
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

    await Deno.writeTextFile(
      join(dir, "svc-crashed.json"),
      '[{"hostingId":"h1","protocol":"tcp","publishedPort":543',
    );

    await assertRejects(
      () => collectTcpUdpIngressEntries(layout),
      Error,
      "corrupt tcp/udp ingress state file",
    );
  } finally {
    await cleanup();
  }
});

test("cleanupStaleTcpUdpServiceIngress removes claim+project on tcp/udp→HTTP-only redeploy", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000bb";
  const environmentId = "env-http-only";
  try {
    await syncTcpUdpIngressEntries(layout, serviceId, [
      { hostingId: "h-tcp", protocol: "tcp", publishedPort: 5432 },
    ]);
    // Seed a per-service project dir the way ensureServiceIngress would.
    const projectDir = serviceIngressDir(layout, serviceId);
    await Deno.mkdir(projectDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(projectDir, "docker-compose.yml"),
      "services: {}\n",
      { mode: 0o640 },
    );

    // First deploy records the active raw-port service in the env index.
    await cleanupStaleTcpUdpServiceIngress(
      layout,
      environmentId,
      new Set([serviceId]),
      new Set([serviceId]),
    );
    assertEquals(
      await readEnvironmentTcpUdpServiceIds(layout, environmentId),
      [serviceId],
    );

    // Redeploy as HTTP-only: service still in the environment, but not in
    // ingressServices[] — claim file + Traefik project must be removed.
    const removed = await cleanupStaleTcpUdpServiceIngress(
      layout,
      environmentId,
      new Set([serviceId]),
      new Set(),
    );
    assertEquals(removed, [serviceId]);
    assertEquals(await listPersistedTcpUdpServiceIds(layout), []);
    assertEquals(
      await readEnvironmentTcpUdpServiceIds(layout, environmentId),
      [],
    );
    await assertRejects(
      () =>
        Deno.stat(
          join(layout.stateDir, "ingress", "tcp-udp", `${serviceId}.json`),
        ),
      Deno.errors.NotFound,
    );
  } finally {
    await cleanup();
  }
});

test("removeEnvironmentTcpUdpServiceIngress tears down from index when payload is empty", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000cc";
  const environmentId = "env-then-stop";
  try {
    await syncTcpUdpIngressEntries(layout, serviceId, [
      { hostingId: "h-tcp", protocol: "tcp", publishedPort: 6432 },
    ]);
    const projectDir = serviceIngressDir(layout, serviceId);
    await Deno.mkdir(projectDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(projectDir, "docker-compose.yml"),
      "services: {}\n",
      { mode: 0o640 },
    );
    await cleanupStaleTcpUdpServiceIngress(
      layout,
      environmentId,
      new Set([serviceId]),
      new Set([serviceId]),
    );
    assertEquals(
      await readEnvironmentTcpUdpServiceIds(layout, environmentId),
      [serviceId],
    );

    // Stop with empty payload service ids (hosting gone) — index is truth.
    const removed = await removeEnvironmentTcpUdpServiceIngress(
      layout,
      environmentId,
      [],
    );
    assertEquals(removed, [serviceId]);
    assertEquals(await listPersistedTcpUdpServiceIds(layout), []);
    assertEquals(
      await readEnvironmentTcpUdpServiceIds(layout, environmentId),
      [],
    );
    assertEquals(await collectTcpUdpIngressEntries(layout), []);
    await assertRejects(() => Deno.stat(projectDir), Deno.errors.NotFound);
  } finally {
    await cleanup();
  }
});
