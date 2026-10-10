import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import type { EnvironmentDeployHosting } from "../contracts/commands-contracts.ts";
import { INSTANCE_ACME_HTTP01_SITE } from "./instance-acme-http01.ts";
import {
  assertHostingNamesFree,
  assertSafeComposeProjectName,
  assertSafeHostingPathPrefix,
  assertValidBindAddress,
  buildCaddyHostnameRoutes,
  buildProxysqlReservedPublishedPorts,
  buildTcpUdpIngressEntries,
  caddyfile,
  caddyHttpUpstream,
  caddyTraefikUpstream,
  caddyUnit,
  cleanupStaleTcpUdpServiceIngress,
  collectTcpUdpIngressEntries,
  ensureHostingCaddyRuntime,
  ensureHostingIngress,
  ensureServiceIngress,
  formatCaddyPathMatcher,
  guardHostingCaddySites,
  HOSTING_CADDY_ADMIN_SOCKET,
  HOSTING_CADDY_METRICS_ADDR,
  HOSTING_CADDY_RUNTIME_DIRECTORY,
  hostingCaddyValidateNeedsEdgeRuntime,
  hostingIngressComposePath,
  hostingIngressDir,
  INGRESS_GATE_SOCKET_DIR,
  INGRESS_GATE_SWITCH_FILE,
  ingressDockerGateEnabled,
  inspectHostingIngressContainer,
  listPersistedTcpUdpServiceIds,
  parseIngressNetworkGateways,
  readAcmeModeHostnames,
  readEnvironmentTcpUdpServiceIds,
  removeEnvironmentTcpUdpServiceIngress,
  removeHostingCaddySite,
  removeServiceIngress,
  removeTcpUdpIngressEntries,
  rewriteHostingCaddySites,
  serviceIngressComposePath,
  serviceIngressDir,
  serviceIngressProject,
  serviceIngressUsesSocketProxy,
  serviceTraefikCompose,
  setEnsureHostingCaddyRuntimeForTest,
  setIngressHostCommandForTest,
  siteSnippet,
  snippetSiteAddresses,
  sortCaddySiteRoutes,
  syncTcpUdpIngressEntries,
  TcpUdpPortConflictError,
  TcpUdpPortReservedError,
  traefikCompose,
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
  // The hosting unit's state folder (`/var/lib/turbopanel-hosting-caddy`),
  // which systemd creates when the unit starts.
  await Deno.mkdir(`${root}/turbopanel-hosting-caddy`);
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

/** The shared ingress network / project *is* the hosting-ingress serviceId. */
const HOSTING_INGRESS_NETWORK = SYSTEM_INGRESS_IDENTITY.serviceId;

/** The ingress network's bridge gateway: the shared Traefik's PROXY peer. */
const INGRESS_GATEWAYS = ["172.19.0.1"];

/** `docker network inspect` output for the ingress network. */
const INGRESS_NETWORK_INSPECT = JSON.stringify([{
  Name: SYSTEM_INGRESS_IDENTITY.serviceId,
  IPAM: { Config: [{ Subnet: "172.19.0.0/16", Gateway: "172.19.0.1" }] },
}]);

const MANAGED_INGRESS_SERVICE_ID = "00000000-0000-4000-8000-0000000000cc";
const MANAGED_INGRESS_IDENTITY = {
  component: SYSTEM_MANAGED_INGRESS_COMPONENT,
  serviceId: MANAGED_INGRESS_SERVICE_ID,
  composeServiceName: PROXYSQL_COMPOSE_SERVICE_NAME,
  containerName: `${MANAGED_INGRESS_SERVICE_ID}-in`,
  role: "ingress",
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
    // Bare serviceId — no readable prefix.
    assertEquals(serviceIngressProject(serviceId), serviceId);
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
    "hostings[].pathPrefix must be",
  );
  assertThrows(
    () => formatCaddyPathMatcher("/api\n"),
    Error,
    "hostings[].pathPrefix must be",
  );
});

test("traefikCompose publishes loopback ports with proxy protocol and TLS", () => {
  const compose = traefikCompose(HOSTING_INGRESS_NETWORK, INGRESS_GATEWAYS);
  assertStringIncludes(compose, "127.0.0.1:7080:7080");
  assertStringIncludes(compose, "127.0.0.1:7443:7443");
  assertStringIncludes(compose, "--entrypoints.web.address=:7080");
  assertStringIncludes(compose, "--entrypoints.websecure.address=:7443");
  assertStringIncludes(compose, "--entrypoints.websecure.http.tls=true");
  assertProxyProtocolTrustsOnly(compose, "172.19.0.1");
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

/**
 * PROXY protocol on both shared entrypoints, believed only from `trusted`:
 * never `insecure`, which let any tenant container or local process forge
 * the client address every other tenant's app sees.
 */
function assertProxyProtocolTrustsOnly(compose: string, trusted: string) {
  assertStringIncludes(
    compose,
    `--entrypoints.web.proxyProtocol.trustedIPs=${trusted}\n`,
  );
  assertStringIncludes(
    compose,
    `--entrypoints.websecure.proxyProtocol.trustedIPs=${trusted}\n`,
  );
  assertEquals(compose.includes("proxyProtocol.insecure"), false);
}

test("traefikCompose never trusts every PROXY protocol peer", () => {
  for (
    const docker of [
      { source: "socket-proxy" },
      { source: "gate", keepSocketProxy: false },
      { source: "gate", keepSocketProxy: true },
    ] as const
  ) {
    const compose = traefikCompose(
      HOSTING_INGRESS_NETWORK,
      ["172.19.0.1", "fd00:19::1", "172.19.0.1"],
      SYSTEM_INGRESS_IDENTITY,
      docker,
    );
    assertProxyProtocolTrustsOnly(compose, "172.19.0.1,fd00:19::1");
  }
});

test("traefikCompose refuses a missing or malformed PROXY protocol peer", () => {
  assertThrows(
    () => traefikCompose(HOSTING_INGRESS_NETWORK, []),
    Error,
    "at least one trusted PROXY protocol peer",
  );
  for (
    const bad of [
      "172.19.0.0/16",
      "0.0.0.0/0",
      "172.19.0.1,1.2.3.4",
      "172.19.0.1\n      - --api.insecure=true",
      "",
    ]
  ) {
    assertThrows(
      () => traefikCompose(HOSTING_INGRESS_NETWORK, [bad]),
      Error,
      "Invalid PROXY protocol trusted address",
    );
  }
});

test("parseIngressNetworkGateways reads the bridge gateway from network inspect", () => {
  assertEquals(
    parseIngressNetworkGateways("net", INGRESS_NETWORK_INSPECT),
    ["172.19.0.1"],
  );
  for (
    const stdout of [
      "",
      "not json",
      "[]",
      JSON.stringify([{ IPAM: { Config: [] } }]),
      JSON.stringify([{ IPAM: { Config: [{ Subnet: "172.19.0.0/16" }] } }]),
    ]
  ) {
    assertThrows(
      () => parseIngressNetworkGateways("net", stdout),
      Error,
      "reports no IPAM gateway",
    );
  }
});

test("traefikCompose publishes a loopback-only Prometheus metrics entrypoint", () => {
  const compose = traefikCompose(HOSTING_INGRESS_NETWORK, INGRESS_GATEWAYS);
  assertStringIncludes(compose, "127.0.0.1:7081:7081");
  assertStringIncludes(compose, "--entrypoints.metrics.address=:7081");
  assertStringIncludes(compose, "--metrics.prometheus=true");
  assertStringIncludes(compose, "--metrics.prometheus.entryPoint=metrics");
  // Required for `traefik_router_*` to exist at all — Traefik defaults it off.
  assertStringIncludes(compose, "--metrics.prometheus.addRoutersLabels=true");
  // Six bounds: 10ms/50ms are what make the read-time p50 meaningful.
  assertStringIncludes(
    compose,
    "--metrics.prometheus.buckets=0.01,0.05,0.1,0.5,1.0,5.0",
  );
});

test("traefikCompose without identity stays anonymous", () => {
  const compose = traefikCompose(HOSTING_INGRESS_NETWORK, INGRESS_GATEWAYS);
  assertEquals(compose.includes("container_name:"), false);
  assertEquals(compose.includes("x-turbopanel:"), false);
  assertEquals(compose.includes("labels:"), false);
});

test("traefikCompose with identity emits container_name, system x-turbopanel, and labels", () => {
  const compose = traefikCompose(
    HOSTING_INGRESS_NETWORK,
    INGRESS_GATEWAYS,
    SYSTEM_INGRESS_IDENTITY,
  );
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
  assertProxyProtocolTrustsOnly(compose, "172.19.0.1");
  assertStringIncludes(compose, "--entrypoints.websecure.http.tls=true");
  assertStringIncludes(
    compose,
    "/var/run/docker.sock:/var/run/docker.sock:ro",
  );
  assertStringIncludes(compose, `${HOSTING_INGRESS_NETWORK}:`);
  assertStringIncludes(compose, "external: true");
});

test("traefikCompose declares its compose project through the name: key", () => {
  const compose = traefikCompose(
    HOSTING_INGRESS_NETWORK,
    INGRESS_GATEWAYS,
    SYSTEM_INGRESS_IDENTITY,
  );
  // `name:` carries the project so every `docker compose -f <path> …` (and the
  // Ansible-installed stack unit) resolves it without `-p`.
  assertStringIncludes(compose, `name: ${HOSTING_INGRESS_NETWORK}`);
  assertEquals(compose.startsWith(`name: ${HOSTING_INGRESS_NETWORK}\n`), true);
});

test("compose project names must be lowercase, bounded, and Compose-safe", () => {
  assertSafeComposeProjectName("00000000-0000-4000-8000-0000000000bb");
  assertThrows(() => assertSafeComposeProjectName(""), Error);
  assertThrows(() => assertSafeComposeProjectName("Upper-Case"), Error);
  assertThrows(() => assertSafeComposeProjectName("-leading-hyphen"), Error);
  assertThrows(() => assertSafeComposeProjectName("has space"), Error);
  assertThrows(() => assertSafeComposeProjectName("a".repeat(65)), Error);
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

test("assertSafeSystemIngressIdentity accepts managed-ingress <serviceId>-in and rejects bare / -ha names", () => {
  assertSafeSystemIngressIdentity({ ...MANAGED_INGRESS_IDENTITY });
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...MANAGED_INGRESS_IDENTITY,
        containerName: MANAGED_INGRESS_SERVICE_ID,
      }),
    Error,
    "system managed-ingress containerName must equal <serviceId>-in",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        ...MANAGED_INGRESS_IDENTITY,
        containerName: `${MANAGED_INGRESS_SERVICE_ID}-ha`,
      }),
    Error,
    "system managed-ingress containerName must equal <serviceId>-in",
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

test("caddyTraefikUpstream http hop uses h2c and PROXY v2", () => {
  const upstream = caddyTraefikUpstream("http");
  assertStringIncludes(upstream, "127.0.0.1:7080");
  assertStringIncludes(upstream, "versions h2c");
  assertStringIncludes(upstream, "proxy_protocol v2");
  assertStringIncludes(upstream, "keepalive off");
});

test("caddyTraefikUpstream https hop preserves the original Host header", () => {
  // Without this Caddy sends Host: 127.0.0.1:7443 and Traefik answers 404.
  assertStringIncludes(caddyTraefikUpstream("https"), "header_up Host {host}");
  assertEquals(caddyTraefikUpstream("http").includes("header_up"), false);
});

test("caddyTraefikUpstream https hop uses TLS skip-verify and PROXY v2", () => {
  const upstream = caddyTraefikUpstream("https");
  assertStringIncludes(upstream, "127.0.0.1:7443");
  assertStringIncludes(upstream, "tls_insecure_skip_verify");
  assertStringIncludes(upstream, "versions 2");
  assertStringIncludes(upstream, "proxy_protocol v2");
  assertStringIncludes(upstream, "keepalive off");
});

test("caddyfile disables auto_https redirects and advertises h1 h2 h3", () => {
  const config = caddyfile(CONFIG_DIR);
  // Redirects only — `auto_https off` would also kill `tls internal` issuance.
  assertStringIncludes(config, "auto_https disable_redirects");
  assertStringIncludes(config, "skip_install_trust");
  assertStringIncludes(config, "protocols h1 h2 h3");
});

test("caddyfile serves the admin API on a private unix socket only", () => {
  // Audit P0-1: a loopback TCP admin is reachable by every tenant process and
  // loads config as tpedge, which reads every uploaded TLS key.
  const config = caddyfile(CONFIG_DIR);
  assertEquals(
    HOSTING_CADDY_ADMIN_SOCKET,
    "/run/turbopanel-hosting-caddy/admin.sock",
  );
  assertEquals(
    config.match(/^\s*admin\s.*$/gm)?.map((line) => line.trim()),
    [`admin unix/${HOSTING_CADDY_ADMIN_SOCKET}|0600`],
  );
  // The one loopback listener is the metrics-only site block, not the admin.
  const withoutMetrics = config.replace(
    `http://${HOSTING_CADDY_METRICS_ADDR} {`,
    "",
  );
  assertEquals(
    /\b127\.0\.0\.1:|localhost:|:20[0-9]9\b/.test(withoutMetrics),
    false,
  );
});

test("caddyUnit reloads through the admin socket in a 0700 runtime directory", () => {
  const unit = caddyUnit(
    {
      runtimesDir: "/opt/turbopanel/vendor",
      configDir: CONFIG_DIR,
    } as Parameters<typeof caddyUnit>[0],
  );
  assertStringIncludes(
    unit,
    `--adapter caddyfile --address unix/${HOSTING_CADDY_ADMIN_SOCKET}\n`,
  );
  assertStringIncludes(
    unit,
    `RuntimeDirectory=${HOSTING_CADDY_RUNTIME_DIRECTORY}\nRuntimeDirectoryMode=0700\n`,
  );
  assertEquals(/--address (?!unix\/)/.test(unit), false);
});

test("siteSnippet acme mode still emits HTTPS when forceHttps is false", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    forceHttps: false,
    tlsMode: "acme",
  });
  assertStringIncludes(
    snippet,
    `http://app.example.com {
  redir https://{host}{uri} permanent
}
`,
  );
  assertEquals(/^ {2}tls /m.test(snippet), false);
  assertEquals(snippet.includes("tls internal"), false);
  assertStringIncludes(snippet, `app.example.com {`);
  assertStringIncludes(snippet, caddyTraefikUpstream("https"));
  assertStringIncludes(snippet, "header_up Host {host}");
});

test("siteSnippet acme mode keeps HTTPS for multi-route forceHttps:false", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    forceHttps: false,
    routes: [
      {
        pathPrefix: "/api",
        upstream: { kind: "http", host: "127.0.0.1", port: 18080 },
      },
      { upstream: { kind: "traefik" } },
    ],
    tlsMode: "acme",
  });
  assertStringIncludes(snippet, "redir https://{host}{uri} permanent");
  assertStringIncludes(snippet, `app.example.com {`);
  assertStringIncludes(snippet, "handle /api/*");
  assertEquals(/^ {2}tls /m.test(snippet), false);
});

test("siteSnippet acme mode omits the tls line and keeps the redirect block", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    tlsMode: "acme",
  });
  assertStringIncludes(
    snippet,
    `http://app.example.com {
  redir https://{host}{uri} permanent
}
`,
  );
  // Site-level `tls` only — Traefik hop transport still uses `tls` /
  // `tls_insecure_skip_verify` inside `reverse_proxy`.
  assertEquals(/^ {2}tls /m.test(snippet), false);
  assertEquals(snippet.includes("tls internal"), false);
  assertStringIncludes(snippet, `app.example.com {`);
  assertStringIncludes(snippet, caddyTraefikUpstream("https"));
  assertStringIncludes(snippet, "header_up Host {host}");
  // Manual `caddy adapt` of this snippet (when the binary is available)
  // succeeds: omitting `tls` leaves Caddy's ACME client on :80/:443.
});

test("siteSnippet without bindAddress matches baseline forceHttps output", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
  });
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
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    bindAddress: "203.0.113.10",
  });
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
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    bindAddress: "2001:db8::10",
  });
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
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    bindAddress: "127.0.0.1",
  });
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
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    routes: [
      {
        pathPrefix: "/php",
        upstream: { kind: "http", host: "127.0.0.1", port: 18081 },
      },
      {
        upstream: { kind: "http", host: "127.0.0.1", port: 18080 },
      },
    ],
  });
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
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime",
      content: "services: {}",
    }],
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
    sites: [
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
    () =>
      siteSnippet({
        hostname: "app.example.com",
        tlsDir: TLS_DIR,
        bindAddress: "evil;bind",
      }),
    Error,
    "unsupported characters",
  );
});

test("traefikCompose is HTTP-only (no tcp/udp entrypoints or public ports)", () => {
  const compose = traefikCompose(HOSTING_INGRESS_NETWORK, INGRESS_GATEWAYS);
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
  const compose = serviceTraefikCompose(
    [],
    SERVICE_INGRESS_IDENTITY,
    HOSTING_INGRESS_NETWORK,
  );
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
  assertStringIncludes(compose, HOSTING_INGRESS_NETWORK);
  assertEquals(compose.includes("entrypoints.web"), false);
  assertEquals(compose.includes("entrypoints.websecure"), false);
});

test("serviceTraefikCompose names its project after the bare serviceId", () => {
  const compose = serviceTraefikCompose(
    [],
    SERVICE_INGRESS_IDENTITY,
    HOSTING_INGRESS_NETWORK,
  );
  assertStringIncludes(
    compose,
    `name: ${SERVICE_INGRESS_IDENTITY.serviceId}`,
  );
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
    HOSTING_INGRESS_NETWORK,
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
    HOSTING_INGRESS_NETWORK,
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
          { hostingId: "h2", protocol: "tcp", publishedPort: 13306 },
        ]),
      TcpUdpPortReservedError,
    );
  } finally {
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries rejects org-overridden ProxySQL listener ports", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const listenerPorts = { postgres: 18_432, mysqlFamily: 18_306 };
  try {
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(
          layout,
          "svc-a",
          [{ hostingId: "h1", protocol: "tcp", publishedPort: 18_432 }],
          listenerPorts,
        ),
      TcpUdpPortReservedError,
    );
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(
          layout,
          "svc-b",
          [{ hostingId: "h2", protocol: "tcp", publishedPort: 18_306 }],
          listenerPorts,
        ),
      TcpUdpPortReservedError,
    );
    // Platform defaults stay reserved alongside org overrides.
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(
          layout,
          "svc-c",
          [{ hostingId: "h3", protocol: "tcp", publishedPort: 15_432 }],
          listenerPorts,
        ),
      TcpUdpPortReservedError,
    );
    await syncTcpUdpIngressEntries(
      layout,
      "svc-d",
      [{ hostingId: "h4", protocol: "tcp", publishedPort: 17_432 }],
      listenerPorts,
    );
  } finally {
    await cleanup();
  }
});

test("buildProxysqlReservedPublishedPorts unions defaults with effective org ports", () => {
  assertEquals(
    [...buildProxysqlReservedPublishedPorts({
      postgres: 18_432,
      mysqlFamily: 18_306,
    })].sort(
      (a, b) => a - b,
    ),
    [13_306, 15_432, 18_306, 18_432, 33_001, 33_002],
  );
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

/** Success, with the ingress network's inspect JSON for `network inspect`. */
function dockerOkFor(args: readonly string[]): DockerCliResult {
  return args[0] === "network" && args[1] === "inspect"
    ? fakeDockerOk(INGRESS_NETWORK_INSPECT)
    : fakeDockerOk();
}

function fakeDockerFail(stderr: string): DockerCliResult {
  return { success: false, code: 1, stdout: "", stderr };
}

test("ensureHostingIngress creates network + compose and skips real Caddy via deps", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  let caddyCalls = 0;
  let created = false;
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
      runDocker: (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "create") created = true;
        if (args[0] === "network" && args[1] === "inspect" && !created) {
          return Promise.resolve(fakeDockerFail("not found"));
        }
        return Promise.resolve(dockerOkFor(args));
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
        a[2] === HOSTING_INGRESS_NETWORK
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
    // The new network's gateway, read back after create, is the PROXY peer.
    assertProxyProtocolTrustsOnly(compose, "172.19.0.1");
  } finally {
    await cleanup();
  }
});

test("ensureHostingIngress reuses existing ingress network", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  try {
    await ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
      runDocker: (args) => {
        calls.push([...args]);
        return Promise.resolve(dockerOkFor(args));
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
        ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
          runDocker: (args) => {
            if (args[0] === "compose") {
              return Promise.resolve(fakeDockerFail("compose boom"));
            }
            return Promise.resolve(dockerOkFor(args));
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
      traefikCompose(
        HOSTING_INGRESS_NETWORK,
        INGRESS_GATEWAYS,
        SYSTEM_INGRESS_IDENTITY,
      ),
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
        runDocker: (args) => Promise.resolve(dockerOkFor(args)),
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
      HOSTING_INGRESS_NETWORK,
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
          HOSTING_INGRESS_NETWORK,
          { runDocker: () => Promise.resolve(fakeDockerOk()) },
        ),
      Error,
      "ingress identity serviceId mismatch",
    );
  } finally {
    await cleanup();
  }
});

function hostingDirOf(layout: LayoutPaths): string {
  return join(layout.configDir, "hosting");
}

function hostingPayload(environmentId: string, hostname: string) {
  return {
    environmentId,
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services: {}",
    }],
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "web",
        hostnames: [hostname],
        bindAddress: "203.0.113.10",
      },
    ],
  };
}

const noGrant = () => Promise.resolve();

test("hostingCaddyValidateNeedsEdgeRuntime ignores reserved snippets and empty content", () => {
  assertEquals(
    hostingCaddyValidateNeedsEdgeRuntime("", [], "env.caddy"),
    false,
  );
  assertEquals(
    hostingCaddyValidateNeedsEdgeRuntime(
      "",
      [INSTANCE_ACME_HTTP01_SITE, "00-empty.caddy"],
      "env.caddy",
    ),
    false,
  );
  assertEquals(
    hostingCaddyValidateNeedsEdgeRuntime(
      "app.example.com {\n}\n",
      [],
      "env.caddy",
    ),
    true,
  );
  assertEquals(
    hostingCaddyValidateNeedsEdgeRuntime("", ["other-env.caddy"], "env.caddy"),
    true,
  );
});

test("rewriteHostingCaddySites skips edge runtime when nothing needs Caddy", async () => {
  const { layout, cleanup } = await makeTestLayout();
  let ensured = 0;
  const restoreEnsure = setEnsureHostingCaddyRuntimeForTest(() => {
    ensured += 1;
    return Promise.resolve();
  });
  const restoreHost = setIngressHostCommandForTest(() =>
    Promise.resolve({ success: true, stderr: "" })
  );
  try {
    await rewriteHostingCaddySites(
      layout,
      {
        ...hostingPayload("env-tcp", "unused.example.com"),
        hostings: [{
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "db",
          hostnames: [],
          protocol: "tcp",
          ports: [{ published: 5432, target: 5432 }],
        }],
      },
      undefined,
      noGrant,
    );
    assertEquals(ensured, 0);
  } finally {
    restoreHost();
    restoreEnsure();
    await cleanup();
  }
});

test("guardHostingCaddySites ensures hosting Caddy edge before caddy validate", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const events: string[] = [];
  const restoreEnsure = setEnsureHostingCaddyRuntimeForTest(() => {
    events.push("ensure-edge-runtime");
    return Promise.resolve();
  });
  const restoreHost = setIngressHostCommandForTest((_command, args) => {
    if (args.includes("validate")) {
      events.push("caddy-validate");
    }
    return Promise.resolve({ success: true, stderr: "" });
  });
  try {
    const sitesDir = join(layout.configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    await Deno.writeTextFile(
      join(sitesDir, "env-a.caddy"),
      "a.example.com {\n}\n",
    );
    await guardHostingCaddySites(layout, noGrant);
    const ensureIdx = events.indexOf("ensure-edge-runtime");
    const validateIdx = events.indexOf("caddy-validate");
    assertEquals(ensureIdx >= 0, true);
    assertEquals(validateIdx >= 0, true);
    assertEquals(ensureIdx < validateIdx, true);
  } finally {
    restoreHost();
    restoreEnsure();
    await cleanup();
  }
});

/**
 * What `caddy validate` says about the staged set, as far as these tests care:
 * a snippet marked BAD does not load, and neither does a hostname served twice
 * ("ambiguous site definition"). `null` when the set loads.
 */
function fakeCaddyRefusal(layout: LayoutPaths): string | null {
  const sites = join(layout.configDir, "hosting", "sites.next");
  const seen = new Set<string>();
  for (const entry of Deno.readDirSync(sites)) {
    const text = Deno.readTextFileSync(join(sites, entry.name));
    if (text.includes("BAD")) return `unrecognized directive in ${entry.name}`;
    const own = new Set(
      [...text.matchAll(/^(?:http:\/\/)?([a-z0-9.-]+) \{$/gm)].map((m) =>
        m[1]!
      ),
    );
    for (const host of own) {
      if (seen.has(host)) return `ambiguous site definition: ${host}`;
      seen.add(host);
    }
  }
  return null;
}

/** A `run` that validates with {@link fakeCaddyRefusal} and accepts the rest. */
function fakeHostRun(layout: LayoutPaths, calls?: string[][]) {
  return (_command: string, args: string[]) => {
    calls?.push([...args]);
    if (args.includes("validate")) {
      const refusal = fakeCaddyRefusal(layout);
      return Promise.resolve(
        refusal === null
          ? { success: true, stderr: "" }
          : { success: false, stderr: refusal },
      );
    }
    return Promise.resolve({ success: true, stderr: "" });
  };
}

test("rewriteHostingCaddySites validates the staged set, then activates and reloads", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  const restore = setIngressHostCommandForTest((_command, args) => {
    calls.push([...args]);
    return Promise.resolve({ success: true, stderr: "" });
  });
  try {
    await rewriteHostingCaddySites(
      layout,
      hostingPayload("env-caddy-1", "app.example.com"),
      undefined,
      noGrant,
    );
    const hostingDir = join(layout.configDir, "hosting");
    const sitesDir = join(hostingDir, "sites");
    const content = await Deno.readTextFile(
      join(sitesDir, "env-caddy-1.caddy"),
    );
    assertStringIncludes(content, "app.example.com");
    assertStringIncludes(content, "203.0.113.10");

    // The account that runs Caddy validates the pinned argv, on the staged
    // Caddyfile, before the reload.
    const validateAt = calls.findIndex((a) => a.includes("validate"));
    const reloadAt = calls.findIndex((a) => a.includes("reload"));
    assertEquals(validateAt >= 0 && reloadAt > validateAt, true);
    const validate = calls[validateAt]!;
    assertEquals(validate.slice(validate.indexOf("-u")), [
      "-u",
      "tpedge",
      "--",
      join(layout.runtimesDir, "caddy", "current", "caddy"),
      "validate",
      "--adapter",
      "caddyfile",
      "--config",
      join(hostingDir, "Caddyfile.next"),
    ]);

    // Nothing is left beside the live glob.
    assertEquals(
      [...Deno.readDirSync(sitesDir)].map((e) => e.name).sort(),
      ["env-caddy-1.acme-hostnames.json", "env-caddy-1.caddy"],
    );
    assertEquals(
      [...Deno.readDirSync(hostingDir)].some((e) => e.name.endsWith(".next")),
      false,
    );
  } finally {
    restore();
    await cleanup();
  }
});

test("rewriteHostingCaddySites refuses a set the hosting Caddy cannot load and leaves the live files alone", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  const restore = setIngressHostCommandForTest(fakeHostRun(layout, calls));
  try {
    await rewriteHostingCaddySites(
      layout,
      hostingPayload("env-a", "app.example.com"),
      undefined,
      noGrant,
    );
    const sitesDir = join(layout.configDir, "hosting", "sites");
    const before = await Deno.readTextFile(join(sitesDir, "env-a.caddy"));

    calls.length = 0;
    await assertRejects(
      () =>
        rewriteHostingCaddySites(
          layout,
          hostingPayload("env-b", "app.example.com"),
          undefined,
          noGrant,
        ),
      Error,
      "ambiguous site definition",
    );
    // Nothing reached the live glob, no reload ran, nothing was left behind,
    // and the other environment's file was not touched.
    assertEquals(calls.some((a) => a.includes("reload")), false);
    assertEquals(
      [...Deno.readDirSync(sitesDir)].map((e) => e.name).sort(),
      ["env-a.acme-hostnames.json", "env-a.caddy"],
    );
    assertEquals(
      await Deno.readTextFile(join(sitesDir, "env-a.caddy")),
      before,
    );
  } finally {
    restore();
    await cleanup();
  }
});

test("a stale snippet already on disk is set aside, not allowed to fail every other deploy", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest(fakeHostRun(layout));
  try {
    const sitesDir = join(layout.configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    await Deno.writeTextFile(
      join(sitesDir, "env-good.caddy"),
      "good.example.com {\n}\n",
    );
    await Deno.writeTextFile(
      join(sitesDir, "env-old.caddy"),
      "BAD.example.com {\n}\n",
    );

    await rewriteHostingCaddySites(
      layout,
      hostingPayload("env-new", "new.example.com"),
      undefined,
      noGrant,
    );
    assertEquals(
      [...Deno.readDirSync(sitesDir)].map((e) => e.name).sort(),
      [
        "env-good.caddy",
        "env-new.acme-hostnames.json",
        "env-new.caddy",
        "env-old.caddy.quarantined",
      ],
    );
    // The set-aside file is kept, and goes with its environment.
    await removeHostingCaddySite(layout, "env-old");
    await assertRejects(
      () => Deno.stat(join(sitesDir, "env-old.caddy.quarantined")),
      Deno.errors.NotFound,
    );
  } finally {
    restore();
    await cleanup();
  }
});

test("when two environments serve one hostname the later file is set aside, the earlier keeps serving", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest(fakeHostRun(layout));
  try {
    const sitesDir = join(layout.configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    await Deno.writeTextFile(
      join(sitesDir, "env-a.caddy"),
      "dup.example.com {\n}\n",
    );
    await Deno.writeTextFile(
      join(sitesDir, "env-b.caddy"),
      "dup.example.com {\n}\n",
    );
    const quarantined = await guardHostingCaddySites(layout, noGrant);
    assertEquals(quarantined, ["env-b.caddy"]);
    assertEquals(
      [...Deno.readDirSync(sitesDir)].map((e) => e.name).sort(),
      ["env-a.caddy", "env-b.caddy.quarantined"],
    );
  } finally {
    restore();
    await cleanup();
  }
});

test("guardHostingCaddySites leaves a loadable set alone and reloads only after setting one aside", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  const restore = setIngressHostCommandForTest(fakeHostRun(layout, calls));
  try {
    // No sites folder, then an empty one.
    assertEquals(await guardHostingCaddySites(layout, noGrant), []);
    const sitesDir = join(layout.configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    assertEquals(await guardHostingCaddySites(layout, noGrant), []);

    await Deno.writeTextFile(
      join(sitesDir, "env-a.caddy"),
      "a.example.com {\n}\n",
    );
    assertEquals(await guardHostingCaddySites(layout, noGrant), []);
    assertEquals(calls.some((a) => a.includes("reload")), false);

    await Deno.writeTextFile(join(sitesDir, "env-b.caddy"), "BAD {\n}\n");
    assertEquals(await guardHostingCaddySites(layout, noGrant), [
      "env-b.caddy",
    ]);
    assertEquals(calls.some((a) => a.includes("reload")), true);
    assertEquals(
      [...Deno.readDirSync(hostingDirOf(layout))].some((e) =>
        e.name.endsWith(".next")
      ),
      false,
    );
  } finally {
    restore();
    await cleanup();
  }
});

test("validation needs the hosting unit's state folder: a never-started unit is started once first", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const state = join(dirname(layout.stateDir), "turbopanel-hosting-caddy");
  await Deno.remove(state);
  const calls: string[][] = [];
  const restore = setIngressHostCommandForTest((_command, args) => {
    calls.push([...args]);
    if (args.includes("start")) Deno.mkdirSync(state);
    return Promise.resolve({ success: true, stderr: "" });
  });
  try {
    await rewriteHostingCaddySites(
      layout,
      hostingPayload("env-s", "s.example.com"),
      undefined,
      noGrant,
    );
    const startAt = calls.findIndex((a) => a.includes("start"));
    const validateAt = calls.findIndex((a) => a.includes("validate"));
    assertEquals(startAt >= 0 && validateAt > startAt, true);

    // With the folder there, the unit is not started again.
    calls.length = 0;
    await rewriteHostingCaddySites(
      layout,
      hostingPayload("env-s", "s.example.com"),
      undefined,
      noGrant,
    );
    assertEquals(calls.some((a) => a.includes("start")), false);
  } finally {
    restore();
    await cleanup();
  }
});

test("a validator that cannot run at all sets nothing aside, whatever the failure looks like", async () => {
  for (
    const stderr of [
      "sudo: /opt/turbopanel/vendor/caddy/current/caddy: command not found",
      "Error: loading config: open /etc/turbopanel/hosting/Caddyfile.next: permission denied",
    ]
  ) {
    const { layout, cleanup } = await makeTestLayout();
    const restore = setIngressHostCommandForTest((_command, args) =>
      Promise.resolve(
        args.includes("validate")
          ? { success: false, stderr }
          : { success: true, stderr: "" },
      )
    );
    try {
      const sitesDir = join(layout.configDir, "hosting", "sites");
      await Deno.mkdir(sitesDir, { recursive: true });
      await Deno.writeTextFile(
        join(sitesDir, "env-a.caddy"),
        "a.example.com {\n}\n",
      );
      await Deno.writeTextFile(
        join(sitesDir, "env-b.caddy"),
        "b.example.com {\n}\n",
      );
      await assertRejects(
        () =>
          rewriteHostingCaddySites(
            layout,
            hostingPayload("env-n", "n.example.com"),
            undefined,
            noGrant,
          ),
        Error,
        "validation is not working",
      );
      await assertRejects(
        () => guardHostingCaddySites(layout, noGrant),
        Error,
        "validation is not working",
      );
      assertEquals(
        [...Deno.readDirSync(sitesDir)].map((e) => e.name).sort(),
        ["env-a.caddy", "env-b.caddy"],
      );
    } finally {
      restore();
      await cleanup();
    }
  }
});

test("of two environments serving one hostname the newer file is set aside", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest(fakeHostRun(layout));
  try {
    const sitesDir = join(layout.configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    // `env-a` sorts first by name but is the newer file.
    await Deno.writeTextFile(
      join(sitesDir, "env-a.caddy"),
      "dup.example.com {\n}\n",
    );
    await Deno.writeTextFile(
      join(sitesDir, "env-b.caddy"),
      "dup.example.com {\n}\n",
    );
    await Deno.utime(
      join(sitesDir, "env-a.caddy"),
      new Date(2_000_000),
      new Date(2_000_000),
    );
    await Deno.utime(
      join(sitesDir, "env-b.caddy"),
      new Date(1_000_000),
      new Date(1_000_000),
    );
    assertEquals(await guardHostingCaddySites(layout, noGrant), [
      "env-a.caddy",
    ]);
  } finally {
    restore();
    await cleanup();
  }
});

test("a host without the sudoers entry gets a plain error and no snippet is set aside", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest((_command, args) =>
    Promise.resolve(
      args.includes("validate")
        ? {
          success: false,
          stderr: "sudo: a password is required",
        }
        : { success: true, stderr: "" },
    )
  );
  try {
    const sitesDir = join(layout.configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    await Deno.writeTextFile(
      join(sitesDir, "env-a.caddy"),
      "a.example.com {\n}\n",
    );
    await assertRejects(
      () =>
        rewriteHostingCaddySites(
          layout,
          hostingPayload("env-n", "n.example.com"),
          undefined,
          noGrant,
        ),
      Error,
      "Finish the update on this host",
    );
    await assertRejects(
      () => guardHostingCaddySites(layout, noGrant),
      Error,
      "sudoers entry",
    );
    assertEquals(
      [...Deno.readDirSync(sitesDir)].map((e) => e.name),
      ["env-a.caddy"],
    );
  } finally {
    restore();
    await cleanup();
  }
});

test("rewriteHostingCaddySites keeps a validated snippet when the hosting Caddy is not running", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest((_command, args) =>
    Promise.resolve({
      // reload and is-active both fail: the unit is not installed or stopped.
      success: !(args.includes("reload") || args.includes("is-active")),
      stderr: "unit not installed",
    })
  );
  try {
    await rewriteHostingCaddySites(
      layout,
      hostingPayload("env-off", "app.example.com"),
      undefined,
      noGrant,
    );
    assertStringIncludes(
      await Deno.readTextFile(
        join(layout.configDir, "hosting", "sites", "env-off.caddy"),
      ),
      "app.example.com",
    );
  } finally {
    restore();
    await cleanup();
  }
});

test("rewriteHostingCaddySites grants the hosting Caddy read access, and fails when it cannot", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest(() =>
    Promise.resolve({ success: true, stderr: "" })
  );
  const payload = {
    environmentId: "env-grant-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services: {}",
    }],
    hostings: [{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: ["app.example.com"],
      bindAddress: "203.0.113.10",
    }],
  };
  try {
    const granted: string[] = [];
    await rewriteHostingCaddySites(layout, payload, undefined, (dir) => {
      granted.push(dir);
      return Promise.resolve();
    });
    assertEquals(granted, [join(layout.configDir, "hosting")]);
    await assertRejects(
      () =>
        rewriteHostingCaddySites(
          layout,
          payload,
          undefined,
          () =>
            Promise.reject(
              new Error("the web server user cannot read its config"),
            ),
        ),
      Error,
      "cannot read its config",
    );
  } finally {
    restore();
    await cleanup();
  }
});

test("rewriteHostingCaddySites enables hosting Caddy before reloading when it wrote a tenant site", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[] = [];
  const restore = setIngressHostCommandForTest((_command, args) => {
    calls.push(args.join(" "));
    return Promise.resolve({ success: true, stderr: "" });
  });
  const base = {
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services: {}",
    }],
  };
  try {
    // An instance ACME window close may have just disabled Caddy: a reload of
    // a stopped unit would leave this site offline.
    await rewriteHostingCaddySites(layout, {
      ...base,
      environmentId: "env-caddy-2",
      hostings: [{
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
      }],
    });
    const enableAt = calls.findIndex((c) => c.includes("enable --now"));
    const reloadAt = calls.findIndex((c) => c.includes("reload"));
    assertEquals(
      enableAt >= 0 && reloadAt > enableAt,
      true,
      JSON.stringify(calls),
    );

    // No hostnames → nothing to serve, so Caddy is not started for it.
    calls.length = 0;
    await rewriteHostingCaddySites(layout, {
      ...base,
      environmentId: "env-caddy-3",
      hostings: [],
    });
    assertEquals(calls.some((c) => c.includes("enable")), false);
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
          composeFiles: [{
            filename: "compose.yaml",
            role: "runtime",
            content: "services: {}",
          }],
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

test("removeHostingCaddySite leaves the reserved public-edge site in place", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const sitesDir = join(layout.configDir, "hosting", "sites");
  await Deno.mkdir(sitesDir, { recursive: true });
  const sitePath = join(sitesDir, INSTANCE_ACME_HTTP01_SITE);
  const body = "http://panel.example.com {\n}\n";
  await Deno.writeTextFile(sitePath, body);
  let reloadCount = 0;
  const restore = setIngressHostCommandForTest(() => {
    reloadCount += 1;
    return Promise.resolve({ success: true, stderr: "" });
  });
  try {
    await removeHostingCaddySite(layout, "00-instance-acme-http01");
    assertEquals(await Deno.readTextFile(sitePath), body);
    assertEquals(reloadCount, 0);
  } finally {
    restore();
    await cleanup();
  }
});

test("rewriteHostingCaddySites writes an acme-hostnames manifest alongside the site snippet", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest(() =>
    Promise.resolve({ success: true, stderr: "" })
  );
  try {
    await rewriteHostingCaddySites(layout, {
      environmentId: "env-acme-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "demo",
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        content: "services: {}",
      }],
      hostings: [
        {
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: ["acme.example.com"],
          tlsMode: "acme",
        },
        {
          hostingId: "h2",
          serviceId: "s2",
          composeServiceName: "internal",
          hostnames: ["internal.example.com"],
        },
      ],
    });
    const manifestPath = join(
      layout.configDir,
      "hosting",
      "sites",
      "env-acme-1.acme-hostnames.json",
    );
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    assertEquals(manifest, ["acme.example.com"]);
    assertEquals(await readAcmeModeHostnames(layout), ["acme.example.com"]);
  } finally {
    restore();
    await cleanup();
  }
});

test("rewriteHostingCaddySites writes an empty acme-hostnames manifest when nothing is acme-mode", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest(() =>
    Promise.resolve({ success: true, stderr: "" })
  );
  try {
    await rewriteHostingCaddySites(layout, {
      environmentId: "env-no-acme",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "demo",
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        content: "services: {}",
      }],
      hostings: [
        {
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: ["internal.example.com"],
        },
      ],
    });
    assertEquals(await readAcmeModeHostnames(layout), []);
  } finally {
    restore();
    await cleanup();
  }
});

test("removeHostingCaddySite deletes the acme-hostnames manifest too, tolerating a missing one", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest(() =>
    Promise.resolve({ success: true, stderr: "" })
  );
  try {
    await rewriteHostingCaddySites(layout, {
      environmentId: "env-acme-rm",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "demo",
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        content: "services: {}",
      }],
      hostings: [
        {
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: ["acme.example.com"],
          tlsMode: "acme",
        },
      ],
    });
    assertEquals(await readAcmeModeHostnames(layout), ["acme.example.com"]);

    await removeHostingCaddySite(layout, "env-acme-rm");
    assertEquals(await readAcmeModeHostnames(layout), []);
    // Second removal must not throw even though the manifest is already gone.
    await removeHostingCaddySite(layout, "env-acme-rm");
  } finally {
    restore();
    await cleanup();
  }
});

test("readAcmeModeHostnames unions manifests across environments, sorted, deduped, and tolerates a missing sites dir", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(await readAcmeModeHostnames(layout), []);

    const sitesDir = join(layout.configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    await Deno.writeTextFile(
      join(sitesDir, "env-a.acme-hostnames.json"),
      JSON.stringify(["b.example.com", "a.example.com"]),
    );
    await Deno.writeTextFile(
      join(sitesDir, "env-b.acme-hostnames.json"),
      JSON.stringify(["a.example.com", "c.example.com"]),
    );
    // A malformed manifest must be skipped, not crash the union.
    await Deno.writeTextFile(
      join(sitesDir, "env-c.acme-hostnames.json"),
      "not json",
    );
    // A non-manifest file in the same directory must be ignored.
    await Deno.writeTextFile(join(sitesDir, "env-a.caddy"), "# irrelevant");

    assertEquals(await readAcmeModeHostnames(layout), [
      "a.example.com",
      "b.example.com",
      "c.example.com",
    ]);
  } finally {
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
  const grants: string[] = [];
  const restore = setIngressHostCommandForTest((command, args) => {
    hostCalls.push({ command, args: [...args] });
    if (args.includes("install") && args.includes("0640")) {
      return Promise.resolve({ success: true, stderr: "" });
    }
    if (args.includes("daemon-reload") || args.includes("restart")) {
      return Promise.resolve({ success: true, stderr: "" });
    }
    if (args.includes("enable")) {
      return Promise.resolve({ success: false, stderr: "start blocked" });
    }
    return Promise.resolve({ success: false, stderr: "unexpected" });
  });
  try {
    await assertRejects(
      () =>
        ensureHostingCaddyRuntime(layout, {
          ...CADDY_READY,
          grantHostingRead: (dir) => {
            grants.push(dir);
            return Promise.resolve();
          },
        }),
      Error,
      "hosting Caddy could not be installed or started",
    );
    const caddyfilePath = join(layout.configDir, "hosting", "Caddyfile");
    assertStringIncludes(
      await Deno.readTextFile(caddyfilePath),
      "auto_https disable_redirects",
    );
    assertEquals(hostCalls.some((c) => c.args.includes("install")), true);
    assertEquals(hostCalls.some((c) => c.args.includes("enable")), true);
    // Before the config writes and again before Caddy starts.
    assertEquals(grants, Array(2).fill(join(layout.configDir, "hosting")));
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
        ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
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
      await assertRejects(
        () => ensureHostingCaddyRuntime(layout, CADDY_READY),
        Error,
        "hosting Caddy could not be installed or started",
      );
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
      await assertRejects(
        () => ensureHostingCaddyRuntime(layout, CADDY_READY),
        Error,
        "hosting Caddy could not be installed or started",
      );
    } finally {
      restore();
    }
  });
});

test("installAndStartCaddy succeeds when enable --now works", async () => {
  await withCaddyRuntimeLayout(async (layout) => {
    const stages: string[] = [];
    const restore = recordHostingUnitStages(stages);
    try {
      await ensureHostingCaddyRuntime(layout, CADDY_READY);
      // A new unit restarts Caddy: enable --now keeps a running process.
      assertEquals(stages, ["install", "daemon-reload", "restart", "enable"]);
      stages.length = 0;
      await ensureHostingCaddyRuntime(layout, CADDY_READY);
      // The same unit again leaves the running Caddy alone.
      assertEquals(stages, ["install", "daemon-reload", "enable"]);
    } finally {
      restore();
    }
  });
});

test("a failed hosting Caddy restart is retried on the next deploy", async () => {
  await withCaddyRuntimeLayout(async (layout) => {
    let restartOk = false;
    const stages: string[] = [];
    const restore = setIngressHostCommandForTest((_command, args) => {
      const stage = args.find((arg) => STAGES.has(arg)) ?? args.join(" ");
      stages.push(stage);
      const success = stage !== "restart" || restartOk;
      return Promise.resolve({ success, stderr: success ? "" : "203/EXEC" });
    });
    try {
      await assertRejects(
        () => ensureHostingCaddyRuntime(layout, CADDY_READY),
        Error,
        "hosting Caddy could not be installed or started",
      );
      restartOk = true;
      stages.length = 0;
      await ensureHostingCaddyRuntime(layout, CADDY_READY);
      assertEquals(stages, ["install", "daemon-reload", "restart", "enable"]);
    } finally {
      restore();
    }
  });
});

const STAGES = new Set(["install", "daemon-reload", "restart", "enable"]);

/** The hosting Caddy account exists and the ingress guard is current and active. */
const CADDY_READY = {
  accountExists: () => Promise.resolve(true),
  ingressGuardCurrent: () => Promise.resolve(true),
  ingressGuardActive: () => Promise.resolve(true),
};

function recordHostingUnitStages(stages: string[]): () => void {
  return setIngressHostCommandForTest((_command, args) => {
    if (args.includes("restart")) {
      stages.push("restart");
      return Promise.resolve({ success: true, stderr: "" });
    }
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
}

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
    await ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
      runDocker: (args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          return Promise.resolve(dockerOkFor(args));
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
      traefikCompose(
        HOSTING_INGRESS_NETWORK,
        INGRESS_GATEWAYS,
        SYSTEM_INGRESS_IDENTITY,
      ),
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
          Promise.resolve(
            fakeDockerOk(JSON.stringify([wrongName, unlabelled])),
          ),
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
        runDocker: (args) => Promise.resolve(dockerOkFor(args)),
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
          HOSTING_INGRESS_NETWORK,
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
          runDocker: (args) => Promise.resolve(dockerOkFor(args)),
        }),
      Error,
      "serviceId contains unsupported characters",
    );
  } finally {
    await cleanup();
  }
});

test("siteSnippet stripPrefix and forceHttps=false paths", () => {
  const multi = siteSnippet({
    hostname: "app.example.com",
    tlsId: "tls-1",
    tlsDir: TLS_DIR,
    routes: [
      {
        pathPrefix: "/api",
        stripPrefix: "/api",
        upstream: { kind: "http", host: "127.0.0.1", port: 18080 },
      },
      { upstream: { kind: "traefik" } },
    ],
  });
  assertStringIncludes(multi, "uri strip_prefix /api");
  assertStringIncludes(multi, "tls ");

  const plainHttp = siteSnippet({
    hostname: "plain.example.com",
    tlsDir: TLS_DIR,
    forceHttps: false,
  });
  assertStringIncludes(plainHttp, "http://plain.example.com");
  assertEquals(plainHttp.includes("redir https://"), false);

  const multiNoForce = siteSnippet({
    hostname: "multi.example.com",
    tlsDir: TLS_DIR,
    forceHttps: false,
    routes: [
      {
        pathPrefix: "/v1",
        upstream: { kind: "http", host: "127.0.0.1", port: 18081 },
      },
      { upstream: { kind: "traefik" } },
    ],
  });
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
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime",
      content: "services: {}",
    }],
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
    nativeAppServices: [{
      composeServiceName: "web",
      serviceId: "s-http",
      listenPort: 3000,
      framework: "next",
    }],
  });
  assertEquals([...routes.keys()], ["app.example.com"]);
  assertEquals(routes.get("app.example.com")?.forceHttps, false);
});

test("buildCaddyHostnameRoutes keeps HTTPS for a single ACME hosting with forceHttps:false", () => {
  const routes = buildCaddyHostnameRoutes({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime",
      content: "services: {}",
    }],
    hostings: [
      {
        hostingId: "acme",
        serviceId: "s-web",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
        tlsMode: "acme",
        proxy: { forceHttps: false },
      },
    ],
  });
  assertEquals(routes.get("app.example.com")?.forceHttps, true);
  assertEquals(routes.get("app.example.com")?.tlsMode, "acme");
});

test("buildCaddyHostnameRoutes keeps HTTPS when a sibling route disables it on an ACME hostname", () => {
  const routes = buildCaddyHostnameRoutes({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime",
      content: "services: {}",
    }],
    hostings: [
      {
        hostingId: "http",
        serviceId: "s-api",
        composeServiceName: "api",
        hostnames: ["app.example.com"],
        proxy: { forceHttps: false },
      },
      {
        hostingId: "acme",
        serviceId: "s-web",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
        pathPrefix: "/app",
        tlsMode: "acme",
      },
    ],
  });
  assertEquals(routes.get("app.example.com")?.forceHttps, true);
  assertEquals(routes.get("app.example.com")?.tlsMode, "acme");
  assertEquals(routes.get("app.example.com")?.routes.length, 2);
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
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime",
      content: "services: {}",
    }],
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
      JSON.stringify([null, {
        hostingId: "h1",
        protocol: "tcp",
        publishedPort: 0,
      }]),
    );
    await assertRejects(
      () => collectTcpUdpIngressEntries(layout),
      Error,
      "expected an array of tcp/udp ingress entries",
    );

    await Deno.writeTextFile(
      join(dir, "00000000-0000-4000-8000-0000000000de.json"),
      JSON.stringify([{
        hostingId: "h1",
        protocol: "tcp",
        publishedPort: 0,
      }]),
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
      traefikCompose(
        HOSTING_INGRESS_NETWORK,
        INGRESS_GATEWAYS,
        SYSTEM_INGRESS_IDENTITY,
      ),
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

test("inspectHostingIngressContainer returns undefined when compose stat is denied", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const originalStat = Deno.stat.bind(Deno);
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    const composePath = hostingIngressComposePath(layout);
    Deno.stat = ((path: string | URL) => {
      if (String(path) === composePath) {
        return Promise.reject(new Deno.errors.PermissionDenied("compose"));
      }
      return originalStat(path);
    }) as typeof Deno.stat;
    assertEquals(
      await inspectHostingIngressContainer(layout, {
        runDocker: (args) => Promise.resolve(dockerOkFor(args)),
      }),
      undefined,
    );
  } finally {
    Deno.stat = originalStat;
    await cleanup();
  }
});

test("removeServiceIngress rethrows when compose cannot be statted", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000f1";
  const originalStat = Deno.stat.bind(Deno);
  try {
    await Deno.mkdir(serviceIngressDir(layout, serviceId), {
      recursive: true,
      mode: 0o750,
    });
    const composePath = serviceIngressComposePath(layout, serviceId);
    Deno.stat = ((path: string | URL) => {
      if (String(path) === composePath) {
        return Promise.reject(new Deno.errors.PermissionDenied("compose"));
      }
      return originalStat(path);
    }) as typeof Deno.stat;
    await assertRejects(
      () =>
        removeServiceIngress(layout, serviceId, {
          runDocker: (args) => Promise.resolve(dockerOkFor(args)),
        }),
      Deno.errors.PermissionDenied,
      "compose",
    );
  } finally {
    Deno.stat = originalStat;
    await cleanup();
  }
});

test("removeHostingCaddySite rethrows when the snippet cannot be unlinked", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const sitesDir = join(layout.configDir, "hosting", "sites");
  await Deno.mkdir(sitesDir, { recursive: true });
  const sitePath = join(sitesDir, "env-denied.caddy");
  await Deno.writeTextFile(sitePath, "# stale\n");
  const originalRemove = Deno.remove.bind(Deno);
  Deno.remove = ((path: string | URL, opts?: Deno.RemoveOptions) => {
    if (String(path) === sitePath) {
      return Promise.reject(new Deno.errors.PermissionDenied("caddy site"));
    }
    return originalRemove(path, opts);
  }) as typeof Deno.remove;
  try {
    await assertRejects(
      () => removeHostingCaddySite(layout, "env-denied"),
      Deno.errors.PermissionDenied,
      "caddy site",
    );
  } finally {
    Deno.remove = originalRemove;
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries rejects a tmp file that fails validation before commit", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000f2";
  const originalRead = Deno.readTextFile.bind(Deno);
  Deno.readTextFile = ((path: string | URL, opts?: Deno.ReadFileOptions) => {
    if (String(path).includes(".tmp")) {
      return Promise.resolve(JSON.stringify([{ hostingId: "h1" }]));
    }
    return originalRead(path, opts);
  }) as typeof Deno.readTextFile;
  try {
    await assertRejects(
      () =>
        syncTcpUdpIngressEntries(layout, serviceId, [{
          hostingId: "h1",
          protocol: "tcp",
          publishedPort: 9100,
        }]),
      Error,
      "failed validation before commit",
    );
  } finally {
    Deno.readTextFile = originalRead;
    await cleanup();
  }
});

test("collectTcpUdpIngressEntries skips non-claim files in the state dir", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000f3";
  try {
    const dir = join(layout.stateDir, "ingress", "tcp-udp");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "notes.txt"), "ignore");
    await Deno.writeTextFile(join(dir, `.${serviceId}.tmp`), "[]");
    await Deno.writeTextFile(
      join(dir, `${serviceId}.json`),
      JSON.stringify([{
        hostingId: "h1",
        protocol: "tcp",
        publishedPort: 9300,
      }]),
    );
    assertEquals(await collectTcpUdpIngressEntries(layout), [{
      hostingId: "h1",
      protocol: "tcp",
      publishedPort: 9300,
    }]);
  } finally {
    await cleanup();
  }
});

test("listPersistedTcpUdpServiceIds skips non-directory service entries", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const goodId = "00000000-0000-4000-8000-0000000000f4";
  try {
    const servicesDir = join(layout.stateDir, "ingress", "services");
    await Deno.mkdir(join(servicesDir, goodId), { recursive: true });
    await Deno.writeTextFile(join(servicesDir, "not-a-dir"), "file\n");
    assertEquals(await listPersistedTcpUdpServiceIds(layout), [goodId]);
  } finally {
    await cleanup();
  }
});

test("syncTcpUdpIngressEntries rethrows when an empty claim cannot be unlinked", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000f5";
  const originalRemove = Deno.remove.bind(Deno);
  try {
    await syncTcpUdpIngressEntries(layout, serviceId, [{
      hostingId: "h1",
      protocol: "tcp",
      publishedPort: 9400,
    }]);
    const claimPath = join(
      layout.stateDir,
      "ingress",
      "tcp-udp",
      `${serviceId}.json`,
    );
    Deno.remove = ((path: string | URL, opts?: Deno.RemoveOptions) => {
      if (String(path) === claimPath) {
        return Promise.reject(new Deno.errors.PermissionDenied("claim"));
      }
      return originalRemove(path, opts);
    }) as typeof Deno.remove;
    await assertRejects(
      () => syncTcpUdpIngressEntries(layout, serviceId, []),
      Deno.errors.PermissionDenied,
      "claim",
    );
  } finally {
    Deno.remove = originalRemove;
    await cleanup();
  }
});

test("removeTcpUdpIngressEntries rethrows when the claim cannot be statted", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = "00000000-0000-4000-8000-0000000000f6";
  const originalStat = Deno.stat.bind(Deno);
  try {
    await syncTcpUdpIngressEntries(layout, serviceId, [{
      hostingId: "h1",
      protocol: "udp",
      publishedPort: 9500,
    }]);
    const claimPath = join(
      layout.stateDir,
      "ingress",
      "tcp-udp",
      `${serviceId}.json`,
    );
    Deno.stat = ((path: string | URL) => {
      if (String(path) === claimPath) {
        return Promise.reject(new Deno.errors.PermissionDenied("stat"));
      }
      return originalStat(path);
    }) as typeof Deno.stat;
    await assertRejects(
      () => removeTcpUdpIngressEntries(layout, serviceId),
      Deno.errors.PermissionDenied,
      "stat",
    );
  } finally {
    Deno.stat = originalStat;
    await cleanup();
  }
});

test("removeEnvironmentTcpUdpServiceIngress rethrows when the empty index cannot be unlinked", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const environmentId = "env-idx-rm";
  const serviceId = "00000000-0000-4000-8000-0000000000f7";
  const originalRemove = Deno.remove.bind(Deno);
  try {
    await cleanupStaleTcpUdpServiceIngress(
      layout,
      environmentId,
      new Set([serviceId]),
      new Set([serviceId]),
      { runDocker: () => Promise.resolve(fakeDockerOk()) },
    );
    const indexPath = join(
      layout.stateDir,
      "ingress",
      "by-environment",
      `${environmentId}.json`,
    );
    Deno.remove = ((path: string | URL, opts?: Deno.RemoveOptions) => {
      if (String(path) === indexPath) {
        return Promise.reject(new Deno.errors.PermissionDenied("index"));
      }
      return originalRemove(path, opts);
    }) as typeof Deno.remove;
    await assertRejects(
      () =>
        removeEnvironmentTcpUdpServiceIngress(layout, environmentId, [], {
          runDocker: (args) => Promise.resolve(dockerOkFor(args)),
        }),
      Deno.errors.PermissionDenied,
      "index",
    );
  } finally {
    Deno.remove = originalRemove;
    await cleanup();
  }
});

test("collectTcpUdpIngressEntries rethrows when the state dir cannot be listed", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const dir = join(layout.stateDir, "ingress", "tcp-udp");
  await Deno.mkdir(dir, { recursive: true });
  const originalReadDir = Deno.readDir.bind(Deno);
  Deno.readDir = ((path: string | URL) => {
    if (String(path) === dir) {
      // deno-lint-ignore require-yield
      return (async function* () {
        throw new Deno.errors.PermissionDenied("tcp-udp dir");
      })();
    }
    return originalReadDir(path);
  }) as typeof Deno.readDir;
  try {
    await assertRejects(
      () => collectTcpUdpIngressEntries(layout),
      Deno.errors.PermissionDenied,
      "tcp-udp dir",
    );
  } finally {
    Deno.readDir = originalReadDir;
    await cleanup();
  }
});

test("no Traefik sees the Docker socket; only the host's socket proxy does", () => {
  // `:ro` blocks writes to the socket *file*, not Engine API calls, so a
  // remote-code bug in a Traefik that proxies live tenant traffic used to
  // mean full Docker control and every co-hosted tenant with it.
  const shared = traefikCompose(HOSTING_INGRESS_NETWORK, INGRESS_GATEWAYS);
  const perService = serviceTraefikCompose(
    [{
      hostingId: "00000000-0000-4000-8000-0000000000cd",
      protocol: "tcp",
      publishedPort: 15432,
    }],
    SERVICE_INGRESS_IDENTITY,
    HOSTING_INGRESS_NETWORK,
  );

  for (
    const [label, yaml] of [["shared", shared], ["per-service", perService]]
  ) {
    const mounts = yaml
      .split("\n")
      .filter((line) => line.includes("/var/run/docker.sock"));
    // Exactly one mount in the shared file — the proxy's — and none at all in
    // the per-service file, which reaches the host's proxy over the network.
    assertEquals(mounts.length, label === "shared" ? 1 : 0, `${label} mounts`);
    assertEquals(
      yaml.includes(
        "--providers.docker.endpoint=tcp://docker-socket-proxy:2375",
      ),
      true,
      `${label} endpoint`,
    );
  }

  // The proxy answers the two reads a Docker provider needs and nothing else.
  assertEquals(shared.includes('CONTAINERS: "1"'), true);
  assertEquals(shared.includes('EVENTS: "1"'), true);
  assertEquals(shared.includes('POST: "0"'), true);
});

// Docker gate stage 3: Traefik on the gate's read-only socket (opt-in).

const GATE_MOUNT = "/run/turbopanel-gate/ro:/var/run/turbopanel-gate:ro";
const GATE_ENDPOINT =
  "--providers.docker.endpoint=unix:///var/run/turbopanel-gate/docker.sock";
const TCP_ENTRY = [{
  hostingId: "00000000-0000-4000-8000-0000000000cd",
  protocol: "tcp" as const,
  publishedPort: 15432,
}];

test("by default both Traefiks keep today's socket-proxy shape, byte for byte", () => {
  assertEquals(
    traefikCompose(
      HOSTING_INGRESS_NETWORK,
      INGRESS_GATEWAYS,
      SYSTEM_INGRESS_IDENTITY,
      {
        source: "socket-proxy",
      },
    ),
    traefikCompose(
      HOSTING_INGRESS_NETWORK,
      INGRESS_GATEWAYS,
      SYSTEM_INGRESS_IDENTITY,
    ),
  );
  assertEquals(
    serviceTraefikCompose(
      TCP_ENTRY,
      SERVICE_INGRESS_IDENTITY,
      HOSTING_INGRESS_NETWORK,
      "socket-proxy",
    ),
    serviceTraefikCompose(
      TCP_ENTRY,
      SERVICE_INGRESS_IDENTITY,
      HOSTING_INGRESS_NETWORK,
    ),
  );
});

test("gate mode: the shared Traefik mounts only the read-only socket directory and the socket proxy is gone", () => {
  const yaml = traefikCompose(
    HOSTING_INGRESS_NETWORK,
    INGRESS_GATEWAYS,
    SYSTEM_INGRESS_IDENTITY,
    { source: "gate", keepSocketProxy: false },
  );
  assertStringIncludes(yaml, GATE_ENDPOINT);
  assertStringIncludes(yaml, `      - ${GATE_MOUNT}`);
  assertEquals(yaml.includes("docker.sock:/"), false, "no engine socket");
  assertEquals(yaml.includes("docker-socket-proxy"), false);
  assertEquals(yaml.includes("tecnativa"), false);
  assertEquals(yaml.includes("depends_on"), false);
  // The mount is the directory of its own, never the gate's main socket dir.
  assertEquals(
    yaml.split("\n").some((line) =>
      line.trim().startsWith("- /run/turbopanel-gate:")
    ),
    false,
  );
  assertEquals(INGRESS_GATE_SOCKET_DIR, "/run/turbopanel-gate/ro");
});

test("gate mode keeps the socket proxy (without Traefik depending on it) while an older service Traefik still uses it", () => {
  const yaml = traefikCompose(
    HOSTING_INGRESS_NETWORK,
    INGRESS_GATEWAYS,
    SYSTEM_INGRESS_IDENTITY,
    { source: "gate", keepSocketProxy: true },
  );
  assertStringIncludes(yaml, GATE_ENDPOINT);
  assertStringIncludes(yaml, "  docker-socket-proxy:");
  assertEquals(yaml.includes("depends_on"), false);
});

test("gate mode: a service Traefik mounts the read-only socket directory and keeps its constraint", () => {
  const yaml = serviceTraefikCompose(
    TCP_ENTRY,
    SERVICE_INGRESS_IDENTITY,
    HOSTING_INGRESS_NETWORK,
    "gate",
  );
  assertStringIncludes(yaml, GATE_ENDPOINT);
  assertStringIncludes(yaml, `      - ${GATE_MOUNT}`);
  assertStringIncludes(yaml, "--providers.docker.constraints=");
  assertEquals(yaml.includes("docker-socket-proxy"), false);
});

test("ingressDockerGateEnabled needs the root-owned switch file AND the gate's read-only directory", async () => {
  assertEquals(
    INGRESS_GATE_SWITCH_FILE,
    "/opt/turbopanel/lib/docker-gate/ingress-socket.on",
  );
  const dir = { isDirectory: true, isFile: false } as Deno.FileInfo;
  const file = { isDirectory: false, isFile: true } as Deno.FileInfo;
  const host = (present: Record<string, Deno.FileInfo>) => (path: string) =>
    path in present
      ? Promise.resolve(present[path])
      : Promise.reject(new Deno.errors.NotFound(path));
  const cases: Array<[Record<string, Deno.FileInfo>, boolean]> = [
    [{}, false],
    [{ [INGRESS_GATE_SOCKET_DIR]: dir }, false],
    [{ [INGRESS_GATE_SWITCH_FILE]: file }, false],
    [
      { [INGRESS_GATE_SWITCH_FILE]: dir, [INGRESS_GATE_SOCKET_DIR]: dir },
      false,
    ],
    [
      { [INGRESS_GATE_SWITCH_FILE]: file, [INGRESS_GATE_SOCKET_DIR]: file },
      false,
    ],
    [
      { [INGRESS_GATE_SWITCH_FILE]: file, [INGRESS_GATE_SOCKET_DIR]: dir },
      true,
    ],
  ];
  for (const [present, want] of cases) {
    assertEquals(
      await ingressDockerGateEnabled(host(present)),
      want,
      Object.keys(present).join(" + ") || "nothing",
    );
  }
});

test("serviceIngressUsesSocketProxy reads the per-service compose files on disk", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(await serviceIngressUsesSocketProxy(layout), false);
    const write = async (serviceId: string, yaml: string) => {
      await Deno.mkdir(serviceIngressDir(layout, serviceId), {
        recursive: true,
      });
      await Deno.writeTextFile(
        serviceIngressComposePath(layout, serviceId),
        yaml,
      );
    };
    const gated = { ...SERVICE_INGRESS_IDENTITY };
    await write(
      gated.serviceId,
      serviceTraefikCompose(TCP_ENTRY, gated, HOSTING_INGRESS_NETWORK, "gate"),
    );
    assertEquals(await serviceIngressUsesSocketProxy(layout), false);
    const legacyId = "00000000-0000-4000-8000-0000000000ab";
    await write(
      legacyId,
      serviceTraefikCompose(TCP_ENTRY, {
        serviceId: legacyId,
        composeServiceName: "traefik",
        containerName: `${legacyId}-in`,
      }, HOSTING_INGRESS_NETWORK),
    );
    assertEquals(await serviceIngressUsesSocketProxy(layout), true);
    // A directory without a compose file is not a user of the proxy.
    await Deno.mkdir(
      serviceIngressDir(layout, "00000000-0000-4000-8000-0000000000ac"),
      { recursive: true },
    );
    await Deno.remove(serviceIngressDir(layout, legacyId), { recursive: true });
    assertEquals(await serviceIngressUsesSocketProxy(layout), false);
  } finally {
    await cleanup();
  }
});

test("ensureHostingIngress in gate mode writes the gate shape and compose removes the orphaned proxy", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
      runDocker: (args) => {
        calls.push([...args]);
        return Promise.resolve(dockerOkFor(args));
      },
      ensureHostingCaddyRuntime: () => Promise.resolve(),
      ingressDockerGate: () => Promise.resolve(true),
    });
    const compose = await Deno.readTextFile(hostingIngressComposePath(layout));
    assertStringIncludes(compose, GATE_ENDPOINT);
    assertEquals(compose.includes("docker-socket-proxy"), false);
    const up = calls.find((a) => a[0] === "compose" && a.includes("up"));
    assert(up?.includes("--remove-orphans"), "the old proxy is removed");
  } finally {
    await cleanup();
  }
});

test("ensureHostingIngress keeps the socket proxy for the anonymous Traefik (no ingress label) even with the switch on", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
      runDocker: (args) => Promise.resolve(dockerOkFor(args)),
      ensureHostingCaddyRuntime: () => Promise.resolve(),
      ingressDockerGate: () => Promise.resolve(true),
    });
    assertEquals(
      await Deno.readTextFile(hostingIngressComposePath(layout)),
      traefikCompose(HOSTING_INGRESS_NETWORK, INGRESS_GATEWAYS),
    );
  } finally {
    await cleanup();
  }
});

test("ensureHostingIngress without the flag keeps the socket proxy", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
      runDocker: (args) => Promise.resolve(dockerOkFor(args)),
      ensureHostingCaddyRuntime: () => Promise.resolve(),
      ingressDockerGate: () => Promise.resolve(false),
    });
    const compose = await Deno.readTextFile(hostingIngressComposePath(layout));
    assertStringIncludes(
      compose,
      "--providers.docker.endpoint=tcp://docker-socket-proxy:2375",
    );
    assertStringIncludes(
      compose,
      "/var/run/docker.sock:/var/run/docker.sock:ro",
    );
  } finally {
    await cleanup();
  }
});

test("ensureServiceIngress follows the same switch", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = SERVICE_INGRESS_IDENTITY.serviceId;
  try {
    for (const gate of [false, true]) {
      await ensureServiceIngress(
        layout,
        serviceId,
        TCP_ENTRY,
        SERVICE_INGRESS_IDENTITY,
        HOSTING_INGRESS_NETWORK,
        {
          runDocker: (args) => Promise.resolve(dockerOkFor(args)),
          ingressDockerGate: () => Promise.resolve(gate),
        },
      );
      const yaml = await Deno.readTextFile(
        serviceIngressComposePath(layout, serviceId),
      );
      assertEquals(yaml.includes(GATE_ENDPOINT), gate, `gate=${gate}`);
      assertEquals(yaml.includes("docker-socket-proxy"), !gate, `gate=${gate}`);
    }
  } finally {
    await cleanup();
  }
});

// Review fixes F1 / F2: the proxy stays until no Traefik really uses it.

const PROXY_SERVICE_KEY = "\n  docker-socket-proxy:\n";

/** Records every docker call; `up` on a path matching `failUp` fails. */
function recordingDocker(calls: string[][], failUp?: RegExp) {
  return (args: readonly string[]) => {
    calls.push([...args]);
    // The shared proxy container is running unless a test says otherwise.
    if (args[0] === "ps") return Promise.resolve(fakeDockerOk("abc123\n"));
    const isUp = args.includes("up");
    const failing = isUp && failUp !== undefined &&
      args.some((arg) => failUp.test(arg));
    return Promise.resolve(
      failing ? fakeDockerFail("up failed") : dockerOkFor(args),
    );
  };
}

function deployTcpService(
  layout: Parameters<typeof ensureServiceIngress>[0],
  gate: boolean,
  runDocker: (args: readonly string[]) => Promise<DockerCliResult>,
) {
  return ensureServiceIngress(
    layout,
    SERVICE_INGRESS_IDENTITY.serviceId,
    TCP_ENTRY,
    SERVICE_INGRESS_IDENTITY,
    HOSTING_INGRESS_NETWORK,
    { runDocker, ingressDockerGate: () => Promise.resolve(gate) },
  );
}

function deployShared(
  layout: Parameters<typeof ensureHostingIngress>[0],
  gate: boolean,
  runDocker: (args: readonly string[]) => Promise<DockerCliResult>,
) {
  return ensureHostingIngress(layout, HOSTING_INGRESS_NETWORK, {
    runDocker,
    ensureHostingCaddyRuntime: () => Promise.resolve(),
    ingressDockerGate: () => Promise.resolve(gate),
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

test("F2: a failed service up keeps the applied compose file, so the proxy stays in use", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const serviceId = SERVICE_INGRESS_IDENTITY.serviceId;
  const applied = serviceIngressComposePath(layout, serviceId);
  try {
    await deployTcpService(layout, false, recordingDocker([]));
    const before = await Deno.readTextFile(applied);
    assertStringIncludes(before, "tcp://docker-socket-proxy:2375");

    await assertRejects(() =>
      deployTcpService(layout, true, recordingDocker([], /pending/))
    );
    assertEquals(await Deno.readTextFile(applied), before);
    assertEquals(await serviceIngressUsesSocketProxy(layout), true);

    await deployTcpService(layout, true, recordingDocker([]));
    assertStringIncludes(await Deno.readTextFile(applied), GATE_ENDPOINT);
    assertEquals(await serviceIngressUsesSocketProxy(layout), false);
    const leftovers = await Array.fromAsync(
      Deno.readDir(serviceIngressDir(layout, serviceId)),
    );
    assertEquals(leftovers.map((e) => e.name), ["docker-compose.yml"]);
  } finally {
    await cleanup();
  }
});

test("F2: a first service deploy whose up fails still counts as a proxy user", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await assertRejects(() =>
      deployTcpService(layout, false, recordingDocker([], /pending/))
    );
    assertEquals(
      await exists(
        serviceIngressComposePath(layout, SERVICE_INGRESS_IDENTITY.serviceId),
      ),
      false,
    );
    assertEquals(await serviceIngressUsesSocketProxy(layout), true);
  } finally {
    await cleanup();
  }
});

test("F2: compose up runs on the pending file and the shared file is replaced only after it succeeds", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await deployShared(layout, false, recordingDocker([]));
    const before = await Deno.readTextFile(hostingIngressComposePath(layout));
    assertStringIncludes(before, PROXY_SERVICE_KEY);

    await assertRejects(() =>
      deployShared(layout, true, recordingDocker([], /pending/))
    );
    assertEquals(
      await Deno.readTextFile(hostingIngressComposePath(layout)),
      before,
    );

    const calls: string[][] = [];
    await deployShared(layout, true, recordingDocker(calls));
    const up = calls.find((a) => a.includes("up"));
    assert(up?.some((arg) => arg.endsWith(".pending.yml")), "up on pending");
    const after = await Deno.readTextFile(hostingIngressComposePath(layout));
    assertStringIncludes(after, GATE_ENDPOINT);
    assertEquals(after.includes(PROXY_SERVICE_KEY), false);
  } finally {
    await cleanup();
  }
});

test("F1: a service Traefik on the proxy puts the proxy back into a gate-mode shared project first", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await deployShared(layout, true, recordingDocker([]));
    const gated = await Deno.readTextFile(hostingIngressComposePath(layout));
    assertEquals(gated.includes(PROXY_SERVICE_KEY), false);

    // Switch removed: a TCP/UDP-only deploy (no shared HTTP render).
    const calls: string[][] = [];
    await deployTcpService(layout, false, recordingDocker(calls));
    const ups = calls.filter((a) => a.includes("up"));
    assertEquals(ups.length, 2, "shared up, then the service up");
    assert(
      ups[0].some((arg) => arg.includes(join("ingress", "traefik"))),
      "the shared project comes up first",
    );
    assert(ups[1].includes(SERVICE_INGRESS_IDENTITY.serviceId));

    const shared = await Deno.readTextFile(hostingIngressComposePath(layout));
    assertStringIncludes(shared, PROXY_SERVICE_KEY);
    // The shared Traefik itself is untouched (still the gate): no recreate.
    assertStringIncludes(shared, GATE_ENDPOINT);
    assertEquals(
      shared,
      traefikCompose(
        HOSTING_INGRESS_NETWORK,
        INGRESS_GATEWAYS,
        SYSTEM_INGRESS_IDENTITY,
        {
          source: "gate",
          keepSocketProxy: true,
        },
      ),
    );
  } finally {
    await cleanup();
  }
});

test("F1: no extra shared up when the shared project already has the proxy or does not exist", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const none: string[][] = [];
    await deployTcpService(layout, false, recordingDocker(none));
    assertEquals(none.filter((a) => a.includes("up")).length, 1);

    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await deployShared(layout, false, recordingDocker([]));
    const withProxy: string[][] = [];
    await deployTcpService(layout, false, recordingDocker(withProxy));
    assertEquals(withProxy.filter((a) => a.includes("up")).length, 1);

    // Gate mode never touches the shared project.
    await deployShared(layout, true, recordingDocker([]));
    const gate: string[][] = [];
    await deployTcpService(layout, true, recordingDocker(gate));
    assertEquals(gate.filter((a) => a.includes("up")).length, 1);
  } finally {
    await cleanup();
  }
});

test("F1: with the descriptor gone, the proxy comes back as the anonymous proxy-mode shared Traefik", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await deployShared(layout, true, recordingDocker([]));
    await Deno.remove(join(layout.stateDir, "system", "hosting-ingress.json"));
    await deployTcpService(layout, false, recordingDocker([]));
    assertEquals(
      await Deno.readTextFile(hostingIngressComposePath(layout)),
      traefikCompose(HOSTING_INGRESS_NETWORK, INGRESS_GATEWAYS),
    );
  } finally {
    await cleanup();
  }
});

test("a legacy proxy-less shared file (docker.sock mounted directly) is left untouched by a TCP/UDP deploy with the switch off", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    const sharedPath = hostingIngressComposePath(layout);
    await Deno.mkdir(dirname(sharedPath), { recursive: true });
    const legacy = [
      "name: hosting-ingress",
      "services:",
      "  traefik:",
      "    image: traefik:v3",
      "    volumes:",
      "      - /var/run/docker.sock:/var/run/docker.sock:ro",
      "",
    ].join("\n");
    await Deno.writeTextFile(sharedPath, legacy);

    const calls: string[][] = [];
    await deployTcpService(layout, false, recordingDocker(calls));
    assertEquals(await Deno.readTextFile(sharedPath), legacy);
    const ups = calls.filter((a) => a.includes("up"));
    assertEquals(ups.length, 1, "only the service up; shared not recreated");
    assert(ups[0].includes(SERVICE_INGRESS_IDENTITY.serviceId));
  } finally {
    await cleanup();
  }
});

test("a leftover shared pending file or a missing proxy container counts as proxy not declared", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await writeSystemComponentDescriptor(layout, SYSTEM_INGRESS_IDENTITY);
    await deployShared(layout, false, recordingDocker([]));
    const sharedPath = hostingIngressComposePath(layout);
    const applied = await Deno.readTextFile(sharedPath);
    assertStringIncludes(applied, PROXY_SERVICE_KEY);

    // Missing proxy container: the applied file is brought up again.
    const missing: string[][] = [];
    const noProxy = (args: readonly string[]) => {
      missing.push([...args]);
      return Promise.resolve(fakeDockerOk());
    };
    await deployTcpService(layout, false, noProxy);
    const sharedUps = missing.filter((a) =>
      a.includes("up") &&
      a.some((arg) => arg.includes(join("ingress", "traefik")))
    );
    assertEquals(sharedUps.length, 1);
    assertEquals(await Deno.readTextFile(sharedPath), applied);

    // Leftover pending file from a failed shared up, container reported up.
    await Deno.writeTextFile(sharedPath.replace(/\.yml$/, ".pending.yml"), "x");
    const leftover: string[][] = [];
    await deployTcpService(layout, false, recordingDocker(leftover));
    assertEquals(
      leftover.filter((a) =>
        a.includes("up") &&
        a.some((arg) => arg.includes(join("ingress", "traefik")))
      ).length,
      1,
    );
    assertEquals(await Deno.readTextFile(sharedPath), applied);
  } finally {
    await cleanup();
  }
});

Deno.test("the hosting Caddyfile exposes totals-only metrics on loopback, with no per_host and no admin TCP", () => {
  const text = caddyfile("/etc/turbopanel");
  assertStringIncludes(
    text,
    "http://127.0.0.1:18110 {\n  bind 127.0.0.1\n  metrics\n}",
  );
  assertStringIncludes(text, "  metrics\n  servers {");
  assertEquals(text.includes("per_host"), false);
});

const WWW_BASE_PAYLOAD = {
  environmentId: "env-www-1",
  projectId: "proj-1",
  organizationId: "org-1",
  projectName: "demo",
  composeFiles: [{
    filename: "compose.yaml",
    role: "runtime" as const,
    content: "services: {}",
  }],
};

function wwwHosting(
  hostnames: string[],
  www?: EnvironmentDeployHosting["www"],
  extra: Partial<EnvironmentDeployHosting> = {},
): EnvironmentDeployHosting {
  return {
    hostingId: `h-${hostnames.join("-")}`,
    serviceId: "s1",
    composeServiceName: "web",
    hostnames,
    ...(www ? { www } : {}),
    ...extra,
  };
}

test("buildCaddyHostnameRoutes www-to-root serves the bare name and redirects www", () => {
  const routes = buildCaddyHostnameRoutes({
    ...WWW_BASE_PAYLOAD,
    hostings: [
      wwwHosting(["example.com", "www.shop.example.com"], "www-to-root", {
        tlsMode: "acme",
        bindAddress: "203.0.113.10",
      }),
    ],
  });
  assertEquals(
    [...routes.keys()].sort(),
    [
      "example.com",
      "shop.example.com",
      "www.example.com",
      "www.shop.example.com",
    ],
  );
  const redirect = routes.get("www.example.com")!;
  assertEquals(redirect.redirectTo, "example.com");
  assertEquals(redirect.routes, []);
  assertEquals(redirect.tlsMode, "acme");
  assertEquals(redirect.bindAddress, "203.0.113.10");
  // Typed as www, still served on the bare name: the mode names the direction.
  assertEquals(
    routes.get("www.shop.example.com")!.redirectTo,
    "shop.example.com",
  );
  assertEquals(routes.get("shop.example.com")!.routes.length, 1);
  assertEquals(routes.get("example.com")!.redirectTo, undefined);
});

test("buildCaddyHostnameRoutes root-to-www serves www and redirects the bare name", () => {
  const routes = buildCaddyHostnameRoutes({
    ...WWW_BASE_PAYLOAD,
    hostings: [wwwHosting(["example.com"], "root-to-www")],
  });
  assertEquals([...routes.keys()].sort(), ["example.com", "www.example.com"]);
  assertEquals(routes.get("example.com")!.redirectTo, "www.example.com");
  assertEquals(routes.get("example.com")!.routes, []);
  assertEquals(routes.get("www.example.com")!.redirectTo, undefined);
  assertEquals(routes.get("www.example.com")!.routes.length, 1);
});

test("buildCaddyHostnameRoutes redirect names follow the target's HTTPS setting", () => {
  const plain = buildCaddyHostnameRoutes({
    ...WWW_BASE_PAYLOAD,
    hostings: [
      wwwHosting(["example.com"], "www-to-root", {
        proxy: { forceHttps: false },
      }),
    ],
  });
  assertEquals(plain.get("example.com")!.forceHttps, false);
  assertEquals(plain.get("www.example.com")!.forceHttps, false);
  // Let's Encrypt always keeps HTTPS, on the site and on its redirect name.
  const acme = buildCaddyHostnameRoutes({
    ...WWW_BASE_PAYLOAD,
    hostings: [
      wwwHosting(["example.com"], "root-to-www", {
        tlsMode: "acme",
        proxy: { forceHttps: false },
      }),
    ],
  });
  assertEquals(acme.get("example.com")!.forceHttps, true);
  assertEquals(acme.get("example.com")!.tlsMode, "acme");
});

test("buildCaddyHostnameRoutes both serves the site on both names", () => {
  const routes = buildCaddyHostnameRoutes({
    ...WWW_BASE_PAYLOAD,
    hostings: [wwwHosting(["www.example.com"], "both")],
  });
  assertEquals([...routes.keys()].sort(), ["example.com", "www.example.com"]);
  for (const name of ["example.com", "www.example.com"]) {
    assertEquals(routes.get(name)!.redirectTo, undefined);
    assertEquals(routes.get(name)!.routes.length, 1);
  }
});

test("buildCaddyHostnameRoutes merges path routes of one name onto its www spelling", () => {
  const routes = buildCaddyHostnameRoutes({
    ...WWW_BASE_PAYLOAD,
    hostings: [
      wwwHosting(["example.com"], "root-to-www"),
      wwwHosting(["example.com"], "root-to-www", {
        hostingId: "h-api",
        composeServiceName: "api",
        pathPrefix: "/api",
      }),
    ],
  });
  assertEquals(routes.get("www.example.com")!.routes.length, 2);
  assertEquals(routes.get("example.com")!.redirectTo, "www.example.com");
});

test("siteSnippet www redirect sends plain HTTP straight to the HTTPS target, path and query kept", () => {
  const snippet = siteSnippet({
    hostname: "www.example.com",
    tlsDir: "/etc/turbopanel/tls",
    tlsMode: "acme",
    redirectTo: "example.com",
  });
  // One hop from http://www to https://root; Caddy's {uri} is path plus query.
  assertStringIncludes(
    snippet,
    "http://www.example.com {\n  redir https://example.com{uri} permanent\n}",
  );
  assertStringIncludes(
    snippet,
    "www.example.com {\n  redir https://example.com{uri} permanent\n}",
  );
  assertEquals(snippet.includes("reverse_proxy"), false);
});

test("siteSnippet www redirect without forced HTTPS lands on the target's plain HTTP site", () => {
  const snippet = siteSnippet({
    hostname: "example.com",
    tlsDir: "/etc/turbopanel/tls",
    forceHttps: false,
    redirectTo: "www.example.com",
  });
  assertStringIncludes(
    snippet,
    "http://example.com {\n  redir http://www.example.com{uri} permanent\n}",
  );
  assertStringIncludes(
    snippet,
    "example.com {\n  tls internal\n  redir http://www.example.com{uri} permanent\n}",
  );
});

test("buildCaddyHostnameRoutes ignores www off, on tcp, and on a name already served", () => {
  const routes = buildCaddyHostnameRoutes({
    ...WWW_BASE_PAYLOAD,
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "web",
        hostnames: ["example.com"],
        www: "www-to-root",
      },
      {
        hostingId: "h2",
        serviceId: "s2",
        composeServiceName: "blog",
        hostnames: ["www.example.com"],
      },
      {
        hostingId: "h3",
        serviceId: "s3",
        composeServiceName: "db",
        hostnames: [],
        protocol: "tcp",
        ports: [{ published: 5432, target: 5432 }],
        www: "www-to-root",
      },
      {
        hostingId: "h4",
        serviceId: "s4",
        composeServiceName: "plain",
        hostnames: ["plain.example.com"],
      },
    ],
  });
  assertEquals(routes.get("www.example.com")!.redirectTo, undefined);
  assertEquals(routes.has("www.plain.example.com"), false);
});

test("rewriteHostingCaddySites serves the www name and lists it in the acme manifest", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const restore = setIngressHostCommandForTest(() =>
    Promise.resolve({ success: true, stderr: "" })
  );
  try {
    await rewriteHostingCaddySites(layout, {
      ...WWW_BASE_PAYLOAD,
      hostings: [
        {
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: ["example.com"],
          tlsMode: "acme",
          www: "www-to-root",
        },
      ],
    });
    const sitesDir = join(layout.configDir, "hosting", "sites");
    const site = await Deno.readTextFile(join(sitesDir, "env-www-1.caddy"));
    assertStringIncludes(
      site,
      `www.example.com {\n  redir https://example.com{uri} permanent\n}`,
    );
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(
          join(sitesDir, "env-www-1.acme-hostnames.json"),
        ),
      ),
      ["example.com", "www.example.com"],
    );
    assertEquals(await readAcmeModeHostnames(layout), [
      "example.com",
      "www.example.com",
    ]);
  } finally {
    restore();
    await cleanup();
  }
});

test("snippetSiteAddresses reads back the names a snippet answers on", () => {
  const snippet = siteSnippet({
    hostname: "www.example.com",
    tlsDir: "/etc/turbopanel/tls",
    redirectTo: "example.com",
  }) + siteSnippet({ hostname: "example.com", tlsDir: "/etc/turbopanel/tls" });
  assertEquals(
    [...new Set(snippetSiteAddresses(snippet))].sort(),
    ["example.com", "www.example.com"],
  );
});

test("assertHostingNamesFree refuses a www name another environment serves, before any container starts", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const payload = {
      ...WWW_BASE_PAYLOAD,
      hostings: [wwwHosting(["example.com"], "both")],
    };
    // Nothing deployed yet on this server: free.
    await assertHostingNamesFree(layout, payload);
    const sitesDir = join(layout.configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    await Deno.writeTextFile(
      join(sitesDir, "env-other.caddy"),
      siteSnippet({ hostname: "www.example.com", tlsDir: layout.tlsDir }),
    );
    // This environment's own earlier file never counts against it.
    await Deno.writeTextFile(
      join(sitesDir, "env-www-1.caddy"),
      siteSnippet({ hostname: "example.com", tlsDir: layout.tlsDir }),
    );
    await assertRejects(
      () => assertHostingNamesFree(layout, payload),
      Error,
      "www.example.com is already served by another environment on this server",
    );
    await assertHostingNamesFree(layout, {
      ...payload,
      hostings: [wwwHosting(["example.com"])],
    });
  } finally {
    await cleanup();
  }
});
