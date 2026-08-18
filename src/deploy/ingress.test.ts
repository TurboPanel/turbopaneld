import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  assertSafeHostingPathPrefix,
  assertValidBindAddress,
  buildCaddyHostnameRoutes,
  buildTcpUdpIngressEntries,
  caddyfile,
  caddyHttpUpstream,
  caddyTraefikUpstream,
  cleanupStaleTcpUdpServiceIngress,
  collectTcpUdpIngressEntries,
  ensureHostingIngress,
  ensureServiceIngress,
  formatCaddyPathMatcher,
  hostingIngressComposePath,
  hostingIngressDir,
  inspectHostingIngressContainer,
  listPersistedTcpUdpServiceIds,
  readEnvironmentTcpUdpServiceIds,
  removeEnvironmentTcpUdpServiceIngress,
  removeServiceIngress,
  removeTcpUdpIngressEntries,
  serviceIngressComposePath,
  serviceIngressDir,
  serviceIngressProject,
  serviceTraefikCompose,
  siteSnippet,
  sortCaddySiteRoutes,
  syncTcpUdpIngressEntries,
  TcpUdpPortConflictError,
  TcpUdpPortReservedError,
  traefikCompose,
  ensureHostingCaddyRuntime,
  rewriteHostingCaddySites,
  removeHostingCaddySite,
  setIngressHostCommandForTest,
} from "./ingress.ts";
import type { DockerCliResult } from "./docker-cli.ts";
import {
  LABEL_ROLE,
  LABEL_ROLE_INGRESS,
  LABEL_SERVICE_ID,
  LABEL_SYSTEM_COMPONENT,
} from "./labels.ts";
import {
  assertSafeSystemIngressIdentity,
  PROXYSQL_COMPOSE_SERVICE_NAME,
  readSystemComponentDescriptor,
  SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  writeSystemComponentDescriptor,
} from "./system-component.ts";
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

const SYSTEM_INGRESS_IDENTITY = {
  component: SYSTEM_HOSTING_INGRESS_COMPONENT,
  serviceId: "00000000-0000-4000-8000-0000000000bb",
  composeServiceName: SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
  containerName: "00000000-0000-4000-8000-0000000000bb-in",
  role: "ingress",
} as const;

const MANAGED_INGRESS_SERVICE_ID = "00000000-0000-4000-8000-0000000000cc";
const MANAGED_INGRESS_IDENTITY = {
  component: SYSTEM_MANAGED_INGRESS_COMPONENT,
  serviceId: MANAGED_INGRESS_SERVICE_ID,
  composeServiceName: PROXYSQL_COMPOSE_SERVICE_NAME,
  containerName: `${MANAGED_INGRESS_SERVICE_ID}-sql`,
  role: "turbopanel",
} as const;

test("hostingIngressDir and compose path nest under stateDir/ingress", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(
      hostingIngressDir(layout),
      join(layout.stateDir, "ingress", "traefik"),
    );
    assertEquals(
      hostingIngressComposePath(layout),
      join(layout.stateDir, "ingress", "traefik", "docker-compose.yml"),
    );
    const serviceId = "00000000-0000-4000-8000-0000000000dd";
    assertEquals(
      serviceIngressProject(serviceId),
      `turbopanel-ingress-${serviceId}`,
    );
  } finally {
    await cleanup();
  }
});

test("assertSafeHostingPathPrefix and formatCaddyPathMatcher handle path matchers", () => {
  assertSafeHostingPathPrefix("/api");
  assertEquals(formatCaddyPathMatcher("/api"), "/api/*");
  assertEquals(formatCaddyPathMatcher("/api/"), "/api/*");
  assertEquals(formatCaddyPathMatcher("/"), "/*");
  assertThrows(
    () => assertSafeHostingPathPrefix("/api`evil"),
    Error,
    "unsupported character",
  );
  assertThrows(
    () => formatCaddyPathMatcher("/api\n"),
    Error,
    "unsupported character",
  );
});

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
    throw new TypeError("traefikCompose must not include socat");
  }
  if (compose.includes("ingress-bridge")) {
    throw new TypeError("traefikCompose must not include ingress-bridge");
  }
  if (compose.includes("alpine")) {
    throw new TypeError("traefikCompose must not include alpine");
  }
});

test("traefikCompose without identity stays anonymous", () => {
  const compose = traefikCompose();
  assertEquals(compose.includes("container_name:"), false);
  assertEquals(compose.includes("x-turbopanel:"), false);
  assertEquals(compose.includes("labels:"), false);
});

test("traefikCompose with identity emits container_name, system x-turbopanel, and labels", () => {
  const compose = traefikCompose(SYSTEM_INGRESS_IDENTITY);
  assertStringIncludes(
    compose,
    `container_name: ${SYSTEM_INGRESS_IDENTITY.containerName}`,
  );
  assertStringIncludes(compose, "kind: system");
  assertStringIncludes(compose, "component: hosting-ingress");
  assertStringIncludes(
    compose,
    `serviceId: ${SYSTEM_INGRESS_IDENTITY.serviceId}`,
  );
  assertStringIncludes(compose, "turbopanel.role: ingress");
  assertStringIncludes(
    compose,
    'com.turbopanel.system.component: "hosting-ingress"',
  );
  assertStringIncludes(
    compose,
    `com.turbopanel.service: "${SYSTEM_INGRESS_IDENTITY.serviceId}"`,
  );
  assertEquals(compose.includes("traefik.enable"), false);
  assertEquals(compose.includes("com.turbopanel.raw-port"), false);
  // Loopback / PROXY / TLS / socket / network unchanged vs anonymous shape.
  assertStringIncludes(compose, "127.0.0.1:7080:7080");
  assertStringIncludes(compose, "127.0.0.1:7443:7443");
  assertStringIncludes(
    compose,
    "--entrypoints.web.proxyProtocol.insecure=true",
  );
  assertStringIncludes(
    compose,
    "--entrypoints.websecure.proxyProtocol.insecure=true",
  );
  assertStringIncludes(compose, "--entrypoints.websecure.http.tls=true");
  assertStringIncludes(
    compose,
    "/var/run/docker.sock:/var/run/docker.sock:ro",
  );
  assertStringIncludes(compose, "turbopanel-ingress:");
  assertStringIncludes(compose, "external: true");
});

test("assertSafeSystemIngressIdentity rejects unsafe or mismatched identity", () => {
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...SYSTEM_INGRESS_IDENTITY,
        serviceId: "not-a-uuid",
        containerName: "not-a-uuid-in",
      }),
    Error,
    "ingress serviceId is invalid",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...SYSTEM_INGRESS_IDENTITY,
        containerName: `${SYSTEM_INGRESS_IDENTITY.serviceId}-in with space`,
      }),
    Error,
    "ingress containerName contains unsupported characters",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...SYSTEM_INGRESS_IDENTITY,
        containerName: `${SYSTEM_INGRESS_IDENTITY.serviceId}-\`in`,
      }),
    Error,
    "ingress containerName contains unsupported characters",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...SYSTEM_INGRESS_IDENTITY,
        containerName: `${SYSTEM_INGRESS_IDENTITY.serviceId}-other`,
      }),
    Error,
    "ingress containerName must equal <serviceId>-in",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...SYSTEM_INGRESS_IDENTITY,
        composeServiceName: "not-traefik",
      }),
    Error,
    "system ingress composeServiceName must be 'traefik'",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...SYSTEM_INGRESS_IDENTITY,
        // @ts-expect-error — intentional unknown component for guard coverage
        component: "unknown-component",
      }),
    Error,
    "is not allowlisted",
  );
});

test("assertSafeSystemIngressIdentity accepts managed-ingress <serviceId>-sql and rejects bare / -in names", () => {
  assertSafeSystemIngressIdentity({ ...MANAGED_INGRESS_IDENTITY });
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...MANAGED_INGRESS_IDENTITY,
        containerName: MANAGED_INGRESS_SERVICE_ID,
      }),
    Error,
    "system managed-ingress containerName must equal <serviceId>-sql",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...MANAGED_INGRESS_IDENTITY,
        containerName: `${MANAGED_INGRESS_SERVICE_ID}-in`,
      }),
    Error,
    "system managed-ingress containerName must equal <serviceId>-sql",
  );
});

test("system component descriptor round-trips and rejects corrupt state", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    const loaded = await readSystemComponentDescriptor(
      layout,
      SYSTEM_HOSTING_INGRESS_COMPONENT,
    );
    assertEquals(loaded, { ...SYSTEM_INGRESS_IDENTITY });

    const systemDir = join(layout.stateDir, "system");
    for await (const entry of Deno.readDir(systemDir)) {
      if (entry.name.endsWith(".tmp")) {
        throw new TypeError(`leftover temp file: ${entry.name}`);
      }
    }

    const corruptPath = join(systemDir, "hosting-ingress.json");
    await Deno.writeTextFile(corruptPath, "{not-json");
    await assertRejects(
      () =>
        readSystemComponentDescriptor(
          layout,
          SYSTEM_HOSTING_INGRESS_COMPONENT,
        ),
      Error,
      "corrupt system component descriptor",
    );

    await Deno.writeTextFile(
      corruptPath,
      JSON.stringify({ component: "hosting-ingress", serviceId: "x" }),
    );
    await assertRejects(
      () =>
        readSystemComponentDescriptor(
          layout,
          SYSTEM_HOSTING_INGRESS_COMPONENT,
        ),
      Error,
      "corrupt system component descriptor",
    );
  } finally {
    await cleanup();
  }
});

test("readSystemComponentDescriptor migrates legacy bare managed-ingress containerName", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const serviceId = MANAGED_INGRESS_SERVICE_ID;
    const systemDir = join(layout.stateDir, "system");
    await Deno.mkdir(systemDir, { recursive: true });
    await Deno.writeTextFile(
      join(systemDir, "managed-ingress.json"),
      JSON.stringify({
        component: "managed-ingress",
        serviceId,
        composeServiceName: "proxysql",
        containerName: serviceId,
        role: "turbopanel",
      }),
    );
    const loaded = await readSystemComponentDescriptor(
      layout,
      "managed-ingress",
    );
    assertEquals(loaded?.containerName, `${serviceId}-sql`);
    const onDisk = JSON.parse(
      await Deno.readTextFile(join(systemDir, "managed-ingress.json")),
    ) as { containerName: string };
    assertEquals(onDisk.containerName, `${serviceId}-sql`);
  } finally {
    await cleanup();
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
  containerName: "00000000-0000-4000-8000-0000000000aa-in",
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

test("syncTcpUdpIngressEntries rejects ports reserved for ProxySQL managed listeners", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(layout, "svc-a", [
          { hostingId: "h1", protocol: "tcp", publishedPort: 15432 },
        ]),
      TcpUdpPortReservedError,
    );
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(layout, "svc-b", [
          { hostingId: "h2", protocol: "tcp", publishedPort: 16306 },
        ]),
      TcpUdpPortReservedError,
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
      { hostingId: "h1", protocol: "tcp", publishedPort: 5432 },
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

function fakeDockerOk(stdout = ""): DockerCliResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fakeDockerFail(stderr: string): DockerCliResult {
  return { success: false, code: 1, stdout: "", stderr };
}

test("ensureHostingIngress creates network + compose and skips real Caddy via deps", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  let caddyCalls = 0;
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await ensureHostingIngress(layout, {
      runDocker: (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "inspect") {
          return Promise.resolve(fakeDockerFail("not found"));
        }
        return Promise.resolve(fakeDockerOk());
      },
      ensureHostingCaddyRuntime: () => {
        caddyCalls += 1;
        return Promise.resolve();
      },
    });

    assertEquals(caddyCalls, 1);
    assertEquals(
      calls.some((a) =>
        a[0] === "network" && a[1] === "create" &&
        a[2] === "turbopanel-ingress"
      ),
      true,
    );
    assertEquals(
      calls.some((a) => a[0] === "compose" && a.includes("up")),
      true,
    );
    const compose = await Deno.readTextFile(hostingIngressComposePath(layout));
    assertStringIncludes(compose, SYSTEM_INGRESS_IDENTITY.containerName);
    assertStringIncludes(compose, "traefik");
  } finally {
    await cleanup();
  }
});

test("ensureHostingIngress reuses existing ingress network", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  try {
    await ensureHostingIngress(layout, {
      runDocker: (args) => {
        calls.push([...args]);
        return Promise.resolve(fakeDockerOk());
      },
      ensureHostingCaddyRuntime: () => Promise.resolve(),
    });
    assertEquals(
      calls.some((a) => a[0] === "network" && a[1] === "create"),
      false,
    );
  } finally {
    await cleanup();
  }
});

test("ensureHostingIngress throws when compose up fails", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(
      () =>
        ensureHostingIngress(layout, {
          runDocker: (args) => {
            if (args[0] === "compose") {
              return Promise.resolve(fakeDockerFail("compose boom"));
            }
            return Promise.resolve(fakeDockerOk());
          },
          ensureHostingCaddyRuntime: () => Promise.resolve(),
        }),
      Error,
      "compose boom",
    );
  } finally {
    await cleanup();
  }
});

test("inspectHostingIngressContainer returns labelled Traefik row", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await Deno.mkdir(hostingIngressDir(layout), {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      hostingIngressComposePath(layout),
      traefikCompose(SYSTEM_INGRESS_IDENTITY),
      { mode: 0o640 },
    );

    const labels = {
      [LABEL_ROLE]: LABEL_ROLE_INGRESS,
      [LABEL_SYSTEM_COMPONENT]: SYSTEM_HOSTING_INGRESS_COMPONENT,
      [LABEL_SERVICE_ID]: SYSTEM_INGRESS_IDENTITY.serviceId,
    };
    const row = {
      ID: "abc123",
      Name: SYSTEM_INGRESS_IDENTITY.containerName,
      Service: SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
      State: "running",
      Labels: labels,
    };

    const observed = await inspectHostingIngressContainer(layout, {
      runDocker: (args) => {
        if (args.includes("ps")) {
          return Promise.resolve(fakeDockerOk(JSON.stringify([row])));
        }
        return Promise.resolve(fakeDockerOk());
      },
    });
    assertEquals(observed?.containerId, "abc123");
    assertEquals(observed?.serviceId, SYSTEM_INGRESS_IDENTITY.serviceId);
    assertEquals(observed?.role, "ingress");
  } finally {
    await cleanup();
  }
});

test("inspectHostingIngressContainer returns null without descriptor or compose file", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(
      await inspectHostingIngressContainer(layout, {
        runDocker: () => Promise.resolve(fakeDockerOk()),
      }),
      null,
    );

    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    assertEquals(
      await inspectHostingIngressContainer(layout, {
        runDocker: () => {
          throw new TypeError("docker must not run without compose file");
        },
      }),
      null,
    );
  } finally {
    await cleanup();
  }
});

test("inspectHostingIngressContainer returns undefined when compose ps fails", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await Deno.mkdir(hostingIngressDir(layout), {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      hostingIngressComposePath(layout),
      "services: {}\n",
      { mode: 0o640 },
    );
    assertEquals(
      await inspectHostingIngressContainer(layout, {
        runDocker: () => Promise.resolve(fakeDockerFail("ps failed")),
      }),
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test("ensureServiceIngress and removeServiceIngress use injected runDocker", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000dd";
  const identity = {
    serviceId,
    composeServiceName: "traefik",
    containerName: `${serviceId}-in`,
  };
  const ups: string[][] = [];
  const downs: string[][] = [];
  try {
    await ensureServiceIngress(
      layout,
      serviceId,
      [{ protocol: "tcp", publishedPort: 5432, hostingId: "h1" }],
      identity,
      {
        runDocker: (args) => {
          ups.push([...args]);
          return Promise.resolve(fakeDockerOk());
        },
      },
    );
    assertEquals(ups.some((a) => a.includes("up")), true);
    assertEquals(
      await Deno.stat(serviceIngressComposePath(layout, serviceId)).then(() =>
        true
      ),
      true,
    );

    await removeServiceIngress(layout, serviceId, {
      runDocker: (args) => {
        downs.push([...args]);
        return Promise.resolve(fakeDockerOk());
      },
    });
    assertEquals(downs.some((a) => a.includes("down")), true);
    await assertRejects(
      () => Deno.stat(serviceIngressDir(layout, serviceId)),
      Deno.errors.NotFound,
    );
  } finally {
    await cleanup();
  }
});

test("ensureServiceIngress rejects identity serviceId mismatch", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(
      () =>
        ensureServiceIngress(
          layout,
          "00000000-0000-4000-8000-0000000000ee",
          [],
          {
            serviceId: "00000000-0000-4000-8000-0000000000ff",
            composeServiceName: "traefik",
            containerName: "00000000-0000-4000-8000-0000000000ff-in",
          },
          { runDocker: () => Promise.resolve(fakeDockerOk()) },
        ),
      Error,
      "ingress identity serviceId mismatch",
    );
  } finally {
    await cleanup();
  }
});

test("rewriteHostingCaddySites writes site snippet and best-effort reloads", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const reloads: string[][] = [];
  const restore = setIngressHostCommandForTest((_command, args) => {
    reloads.push([...args]);
    return Promise.resolve({ success: false, stderr: "unit not installed" });
  });
  try {
    await rewriteHostingCaddySites(layout, {
      environmentId: "env-caddy-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "demo",
      composeYaml: "services: {}",
      hostings: [
        {
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: ["app.example.com"],
          bindAddress: "203.0.113.10",
        },
      ],
    });
    const sitePath = join(
      layout.configDir,
      "hosting",
      "sites",
      "env-caddy-1.caddy",
    );
    const content = await Deno.readTextFile(sitePath);
    assertStringIncludes(content, "app.example.com");
    assertStringIncludes(content, "203.0.113.10");
    assertEquals(reloads.some((a) => a.includes("reload")), true);
  } finally {
    restore();
    await cleanup();
  }
});

test("rewriteHostingCaddySites rejects unsafe environmentId", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(
      () =>
        rewriteHostingCaddySites(layout, {
          environmentId: "../evil",
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "demo",
          composeYaml: "services: {}",
          hostings: [],
        }),
      Error,
      "environmentId contains unsupported characters",
    );
  } finally {
    await cleanup();
  }
});

test("removeHostingCaddySite deletes snippet and tolerates missing file", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const sitesDir = join(layout.configDir, "hosting", "sites");
  await Deno.mkdir(sitesDir, { recursive: true });
  const sitePath = join(sitesDir, "env-rm.caddy");
  await Deno.writeTextFile(sitePath, "# stale\n");
  let reloadCount = 0;
  const restore = setIngressHostCommandForTest(() => {
    reloadCount += 1;
    return Promise.resolve({ success: true, stderr: "" });
  });
  try {
    await removeHostingCaddySite(layout, "env-rm");
    await assertRejects(() => Deno.stat(sitePath), Deno.errors.NotFound);
    await removeHostingCaddySite(layout, "env-rm");
    assertEquals(reloadCount, 2);
  } finally {
    restore();
    await cleanup();
  }
});

test("ensureHostingCaddyRuntime writes unit and attempts install via host command", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-ingress-caddy-rt-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
      TURBOPANEL_RUNTIMES_DIR: `${root}/runtimes`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  const caddyDir = join(layout.runtimesDir, "caddy", "current");
  await Deno.mkdir(caddyDir, { recursive: true });
  await Deno.writeTextFile(join(caddyDir, "caddy"), "#!/bin/true\n");
  const hostCalls: Array<{ command: string; args: string[] }> = [];
  const restore = setIngressHostCommandForTest((command, args) => {
    hostCalls.push({ command, args: [...args] });
    if (args.includes("install") && args.includes("0640")) {
      return Promise.resolve({ success: true, stderr: "" });
    }
    if (args.includes("daemon-reload")) {
      return Promise.resolve({ success: true, stderr: "" });
    }
    if (args.includes("enable")) {
      return Promise.resolve({ success: false, stderr: "start blocked" });
    }
    return Promise.resolve({ success: false, stderr: "unexpected" });
  });
  try {
    await ensureHostingCaddyRuntime(layout);
    const caddyfilePath = join(layout.configDir, "hosting", "Caddyfile");
    assertStringIncludes(await Deno.readTextFile(caddyfilePath), "auto_https off");
    assertEquals(hostCalls.some((c) => c.args.includes("install")), true);
    assertEquals(hostCalls.some((c) => c.args.includes("enable")), true);
  } finally {
    restore();
    await Deno.remove(root, { recursive: true });
  }
});

test("ensureHostingIngress throws when network create fails", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(
      () =>
        ensureHostingIngress(layout, {
          runDocker: (args) => {
            if (args[0] === "network" && args[1] === "inspect") {
              return Promise.resolve({
                success: false,
                code: 1,
                stdout: "",
                stderr: "not found",
              });
            }
            if (args[0] === "network" && args[1] === "create") {
              return Promise.resolve({
                success: false,
                code: 1,
                stdout: "",
                stderr: "cannot create network",
              });
            }
            return Promise.resolve(fakeDockerOk());
          },
          ensureHostingCaddyRuntime: () => Promise.resolve(),
        }),
      Error,
      "cannot create network",
    );
  } finally {
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries deletes claim file when entries empty", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000aa";
  try {
    await syncTcpUdpIngressEntries(layout, serviceId, [
      {
        hostingId: "h1",
        protocol: "tcp",
        publishedPort: 9000,
      },
    ]);
    const claimPath = join(
      layout.stateDir,
      "ingress",
      "tcp-udp",
      `${serviceId}.json`,
    );
    await Deno.stat(claimPath);
    const cleared = await syncTcpUdpIngressEntries(layout, serviceId, []);
    assertEquals(cleared, []);
    await assertRejects(() => Deno.stat(claimPath), Deno.errors.NotFound);
    // Second empty sync tolerates already-missing file.
    assertEquals(await syncTcpUdpIngressEntries(layout, serviceId, []), []);
  } finally {
    await cleanup();
  }
});

async function withCaddyRuntimeLayout(
  fn: (layout: ReturnType<typeof resolveLayout>) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-ingress-caddy-rt-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
      TURBOPANEL_RUNTIMES_DIR: `${root}/runtimes`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  const caddyDir = join(layout.runtimesDir, "caddy", "current");
  await Deno.mkdir(caddyDir, { recursive: true });
  await Deno.writeTextFile(join(caddyDir, "caddy"), "#!/bin/true\n");
  try {
    await fn(layout);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("installAndStartCaddy returns early when unit install fails", async () => {
  await withCaddyRuntimeLayout(async (layout) => {
    const restore = setIngressHostCommandForTest((_command, args) => {
      if (args.includes("install")) {
        return Promise.resolve({ success: false, stderr: "install denied" });
      }
      throw new TypeError(`unexpected host command: ${args.join(" ")}`);
    });
    try {
      await ensureHostingCaddyRuntime(layout);
      await Deno.stat(join(layout.configDir, "hosting", "Caddyfile"));
    } finally {
      restore();
    }
  });
});

test("installAndStartCaddy returns early when daemon-reload fails", async () => {
  await withCaddyRuntimeLayout(async (layout) => {
    const restore = setIngressHostCommandForTest((_command, args) => {
      if (args.includes("install")) {
        return Promise.resolve({ success: true, stderr: "" });
      }
      if (args.includes("daemon-reload")) {
        return Promise.resolve({ success: false, stderr: "reload denied" });
      }
      throw new TypeError(`unexpected host command: ${args.join(" ")}`);
    });
    try {
      await ensureHostingCaddyRuntime(layout);
    } finally {
      restore();
    }
  });
});

test("installAndStartCaddy succeeds when enable --now works", async () => {
  await withCaddyRuntimeLayout(async (layout) => {
    const stages: string[] = [];
    const restore = setIngressHostCommandForTest((_command, args) => {
      if (args.includes("install")) {
        stages.push("install");
        return Promise.resolve({ success: true, stderr: "" });
      }
      if (args.includes("daemon-reload")) {
        stages.push("daemon-reload");
        return Promise.resolve({ success: true, stderr: "" });
      }
      if (args.includes("enable")) {
        stages.push("enable");
        return Promise.resolve({ success: true, stderr: "" });
      }
      throw new TypeError(`unexpected host command: ${args.join(" ")}`);
    });
    try {
      await ensureHostingCaddyRuntime(layout);
      assertEquals(stages, ["install", "daemon-reload", "enable"]);
    } finally {
      restore();
    }
  });
});

test("serviceIngressProject and Dir reject unsafe serviceId", () => {
  assertThrows(
    () => serviceIngressProject("../evil"),
    Error,
    "serviceId contains unsupported characters",
  );
  const layout = { stateDir: "/tmp/tp" } as Parameters<
    typeof serviceIngressDir
  >[0];
  assertThrows(
    () => serviceIngressDir(layout, "bad id"),
    Error,
    "serviceId contains unsupported characters",
  );
});

test("ensureHostingIngress falls back to anonymous Traefik when descriptor is corrupt", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const systemDir = join(layout.stateDir, "system");
    await Deno.mkdir(systemDir, { recursive: true });
    await Deno.writeTextFile(
      join(systemDir, "hosting-ingress.json"),
      "{not-json",
    );
    let wroteCompose = "";
    await ensureHostingIngress(layout, {
      runDocker: (args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          return Promise.resolve(fakeDockerOk());
        }
        if (args.includes("up")) {
          return Promise.resolve(fakeDockerOk());
        }
        return Promise.resolve(fakeDockerOk());
      },
      ensureHostingCaddyRuntime: () => Promise.resolve(),
    });
    wroteCompose = await Deno.readTextFile(hostingIngressComposePath(layout));
    assertEquals(wroteCompose.includes("container_name:"), false);
  } finally {
    await cleanup();
  }
});

test("inspectHostingIngressContainer skips mismatched or unlabelled rows", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await Deno.mkdir(hostingIngressDir(layout), {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      hostingIngressComposePath(layout),
      traefikCompose(SYSTEM_INGRESS_IDENTITY),
      { mode: 0o640 },
    );

    const wrongName = {
      ID: "x1",
      Name: "wrong-name",
      Service: SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
      State: "running",
      Labels: {
        [LABEL_ROLE]: LABEL_ROLE_INGRESS,
        [LABEL_SYSTEM_COMPONENT]: SYSTEM_HOSTING_INGRESS_COMPONENT,
        [LABEL_SERVICE_ID]: SYSTEM_INGRESS_IDENTITY.serviceId,
      },
    };
    const unlabelled = {
      ID: "x2",
      Name: SYSTEM_INGRESS_IDENTITY.containerName,
      Service: SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
      State: "running",
      Labels: {},
    };
    assertEquals(
      await inspectHostingIngressContainer(layout, {
        runDocker: () =>
          Promise.resolve(fakeDockerOk(JSON.stringify([wrongName, unlabelled]))),
      }),
      null,
    );
  } finally {
    await cleanup();
  }
});

test("inspectHostingIngressContainer returns undefined when descriptor read throws", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const systemDir = join(layout.stateDir, "system");
    await Deno.mkdir(systemDir, { recursive: true });
    await Deno.writeTextFile(
      join(systemDir, "hosting-ingress.json"),
      JSON.stringify({
        component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        serviceId: "not-a-uuid",
        composeServiceName: SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
        containerName: "not-a-uuid-in",
        role: "ingress",
      }),
    );
    assertEquals(
      await inspectHostingIngressContainer(layout, {
        runDocker: () => Promise.resolve(fakeDockerOk()),
      }),
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test("ensureServiceIngress throws commandError with empty stderr fallback", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000ee";
  try {
    await assertRejects(
      () =>
        ensureServiceIngress(
          layout,
          serviceId,
          [{ hostingId: "h1", protocol: "tcp", publishedPort: 9100 }],
          {
            serviceId,
            composeServiceName: "traefik",
            containerName: `${serviceId}-in`,
          },
          {
            runDocker: (args) => {
              if (args.includes("up")) {
                return Promise.resolve({
                  success: false,
                  code: 1,
                  stdout: "",
                  stderr: "",
                });
              }
              return Promise.resolve(fakeDockerOk());
            },
          },
        ),
      Error,
      "Starting service Traefik ingress failed",
    );
  } finally {
    await cleanup();
  }
});

test("removeServiceIngress soft-fails compose down and dir remove", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000ef";
  const servicesParent = join(layout.stateDir, "ingress", "services");
  try {
    await Deno.mkdir(serviceIngressDir(layout, serviceId), {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      serviceIngressComposePath(layout, serviceId),
      "services: {}\n",
    );
    await Deno.chmod(servicesParent, 0o555);
    await removeServiceIngress(layout, serviceId, {
      runDocker: () =>
        Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "down failed",
        }),
    });
  } finally {
    try {
      await Deno.chmod(servicesParent, 0o755);
    } catch {
      // best-effort restore for cleanup
    }
    await cleanup();
  }
});

test("removeServiceIngress rejects unsafe serviceId", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(
      () =>
        removeServiceIngress(layout, "../evil", {
          runDocker: () => Promise.resolve(fakeDockerOk()),
        }),
      Error,
      "serviceId contains unsupported characters",
    );
  } finally {
    await cleanup();
  }
});

test("siteSnippet stripPrefix and forceHttps=false paths", () => {
  const multi = siteSnippet(
    "app.example.com",
    "tls-1",
    TLS_DIR,
    true,
    undefined,
    { kind: "traefik" },
    [
      {
        pathPrefix: "/api",
        stripPrefix: "/api",
        upstream: { kind: "http", host: "127.0.0.1", port: 18080 },
      },
      { upstream: { kind: "traefik" } },
    ],
  );
  assertStringIncludes(multi, "uri strip_prefix /api");
  assertStringIncludes(multi, "tls ");

  const plainHttp = siteSnippet(
    "plain.example.com",
    undefined,
    TLS_DIR,
    false,
  );
  assertStringIncludes(plainHttp, "http://plain.example.com");
  assertEquals(plainHttp.includes("redir https://"), false);

  const multiNoForce = siteSnippet(
    "multi.example.com",
    undefined,
    TLS_DIR,
    false,
    undefined,
    { kind: "traefik" },
    [
      {
        pathPrefix: "/v1",
        upstream: { kind: "http", host: "127.0.0.1", port: 18081 },
      },
      { upstream: { kind: "traefik" } },
    ],
  );
  assertStringIncludes(multiNoForce, "handle /v1/*");
  assertEquals(multiNoForce.includes("redir https://"), false);
});

test("caddyHttpUpstream rejects invalid port and non-loopback host", () => {
  assertThrows(
    () => caddyHttpUpstream("127.0.0.1", 0),
    Error,
    "upstream port is invalid",
  );
  assertThrows(
    () => caddyHttpUpstream("203.0.113.50", 8080),
    Error,
    "upstream host is not allowed",
  );
  assertEquals(caddyHttpUpstream("::1", 8080), "reverse_proxy [::1]:8080");
});

test("buildCaddyHostnameRoutes skips tcp and empty hostnames", () => {
  const routes = buildCaddyHostnameRoutes({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}",
    hostings: [
      {
        hostingId: "tcp",
        serviceId: "s-tcp",
        composeServiceName: "db",
        hostnames: ["db.example.com"],
        protocol: "tcp",
        ports: [{ published: 5432, target: 5432 }],
      },
      {
        hostingId: "empty",
        serviceId: "s-empty",
        composeServiceName: "web",
        hostnames: [],
      },
      {
        hostingId: "http",
        serviceId: "s-http",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
        proxy: { forceHttps: false },
      },
    ],
  });
  assertEquals([...routes.keys()], ["app.example.com"]);
  assertEquals(routes.get("app.example.com")?.forceHttps, false);
});

test("removeHostingCaddySite rejects unsafe environmentId", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(
      () => removeHostingCaddySite(layout, "../evil"),
      Error,
      "environmentId contains unsupported characters",
    );
  } finally {
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries rejects unsafe serviceId", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(layout, "bad id", [
          { hostingId: "h1", protocol: "udp", publishedPort: 9001 },
        ]),
      Error,
      "serviceId contains unsupported characters",
    );
  } finally {
    await cleanup();
  }
});

test("collectTcpUdpIngressEntries rejects non-array claim payloads", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const dir = join(layout.stateDir, "ingress", "tcp-udp");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "00000000-0000-4000-8000-0000000000bb.json"),
      JSON.stringify({ hostingId: "h1" }),
    );
    await assertRejects(
      () => collectTcpUdpIngressEntries(layout),
      Error,
      "expected an array of tcp/udp ingress entries",
    );
  } finally {
    await cleanup();
  }
});

test("listPersistedTcpUdpServiceIds ignores tmp files and unsafe dir names", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const goodId = "00000000-0000-4000-8000-0000000000cc";
  try {
    const claimDir = join(layout.stateDir, "ingress", "tcp-udp");
    const servicesDir = join(layout.stateDir, "ingress", "services");
    await Deno.mkdir(claimDir, { recursive: true });
    await Deno.mkdir(join(servicesDir, goodId), { recursive: true });
    await Deno.mkdir(join(servicesDir, "bad name"), { recursive: true });
    await Deno.writeTextFile(join(claimDir, `.${goodId}.tmp`), "[]");
    await Deno.writeTextFile(join(claimDir, "notes.txt"), "ignore");
    await Deno.writeTextFile(
      join(claimDir, `${goodId}.json`),
      JSON.stringify([
        { hostingId: "h1", protocol: "tcp", publishedPort: 9200 },
      ]),
    );
    assertEquals(await listPersistedTcpUdpServiceIds(layout), [goodId]);
  } finally {
    await cleanup();
  }
});

test("readEnvironmentTcpUdpServiceIds rejects corrupt index and unsafe id", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const environmentId = "env-idx";
  try {
    await assertRejects(
      () => readEnvironmentTcpUdpServiceIds(layout, "../evil"),
      Error,
      "environmentId contains unsupported characters",
    );
    const path = join(
      layout.stateDir,
      "ingress",
      "by-environment",
      `${environmentId}.json`,
    );
    await Deno.mkdir(join(layout.stateDir, "ingress", "by-environment"), {
      recursive: true,
    });
    await Deno.writeTextFile(path, JSON.stringify([123]));
    await assertRejects(
      () => readEnvironmentTcpUdpServiceIds(layout, environmentId),
      Error,
      "corrupt environment tcp/udp ingress index",
    );
  } finally {
    await cleanup();
  }
});

test("removeEnvironmentTcpUdpServiceIngress clears empty index NotFound", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const environmentId = "env-empty-idx";
  try {
    const removed = await removeEnvironmentTcpUdpServiceIngress(
      layout,
      environmentId,
      [],
    );
    assertEquals(removed, []);
  } finally {
    await cleanup();
  }
});

test("buildCaddyHostnameRoutes drops empty and slash-only pathPrefix", () => {
  const routes = buildCaddyHostnameRoutes({
    environmentId: "env-prefix",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}",
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
        pathPrefix: "/",
      },
      {
        hostingId: "h2",
        serviceId: "s2",
        composeServiceName: "api",
        hostnames: ["app.example.com"],
        pathPrefix: "   ",
      },
    ],
  });
  const site = routes.get("app.example.com");
  assertEquals(site?.routes.length, 2);
  assertEquals(site?.routes.every((r) => r.pathPrefix === undefined), true);
});

test("collectTcpUdpIngressEntries rejects invalid entry shapes in array", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const dir = join(layout.stateDir, "ingress", "tcp-udp");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "00000000-0000-4000-8000-0000000000dd.json"),
      JSON.stringify([
        { hostingId: "", protocol: "tcp", publishedPort: 9000 },
      ]),
    );
    await assertRejects(
      () => collectTcpUdpIngressEntries(layout),
      Error,
      "expected an array of tcp/udp ingress entries",
    );

    await Deno.writeTextFile(
      join(dir, "00000000-0000-4000-8000-0000000000de.json"),
      JSON.stringify([
        {
          hostingId: "h1",
          protocol: "sctp",
          publishedPort: 9000,
        },
      ]),
    );
    await Deno.remove(join(dir, "00000000-0000-4000-8000-0000000000dd.json"));
    await assertRejects(
      () => collectTcpUdpIngressEntries(layout),
      Error,
      "expected an array of tcp/udp ingress entries",
    );

    await Deno.writeTextFile(
      join(dir, "00000000-0000-4000-8000-0000000000de.json"),
      JSON.stringify([
        {
          hostingId: "h1",
          protocol: "tcp",
          publishedPort: 9000,
          bindAddress: 123,
        },
      ]),
    );
    await assertRejects(
      () => collectTcpUdpIngressEntries(layout),
      Error,
      "expected an array of tcp/udp ingress entries",
    );

    await Deno.writeTextFile(
      join(dir, "00000000-0000-4000-8000-0000000000de.json"),
      JSON.stringify([null, { hostingId: "h1", protocol: "tcp", publishedPort: 0 }]),
    );
    await assertRejects(
      () => collectTcpUdpIngressEntries(layout),
      Error,
      "expected an array of tcp/udp ingress entries",
    );
  } finally {
    await cleanup();
  }
});

test("removeTcpUdpIngressEntries returns null when claim file is absent", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(
      await removeTcpUdpIngressEntries(
        layout,
        "00000000-0000-4000-8000-0000000000df",
      ),
      null,
    );
  } finally {
    await cleanup();
  }
});

test("inspectHostingIngressContainer skips null compose-ps rows", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await Deno.mkdir(hostingIngressDir(layout), {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      hostingIngressComposePath(layout),
      traefikCompose(SYSTEM_INGRESS_IDENTITY),
      { mode: 0o640 },
    );
    // Missing Name/Service/State → readComposePsContainer returns null.
    assertEquals(
      await inspectHostingIngressContainer(layout, {
        runDocker: () =>
          Promise.resolve(fakeDockerOk(JSON.stringify([{ ID: "only-id" }]))),
      }),
      null,
    );
  } finally {
    await cleanup();
  }
});
