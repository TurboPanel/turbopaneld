import { dirname, join } from "@std/path";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { errorText, logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { removeStaleNetworkContainers } from "./ingress-stale-network.ts";
import {
  type EnvironmentDeployContainer,
  type EnvironmentDeployHosting,
  type EnvironmentDeployPayload,
  hostingServedNames,
  hostingWwwRedirects,
  isValidIpv4Literal,
  isValidIpv6Literal,
} from "../contracts/commands-contracts.ts";
import { type LayoutPaths, PROD_HOME_DEFAULT } from "../paths/layout.ts";
import { safeConfigToken, safeUrlPath } from "../contracts/config-values.ts";
import { isDaemonReservedHostingSite } from "./instance-acme-http01.ts";
import {
  parseComposePsEntries,
  readComposePsContainer,
  readComposePsLabels,
} from "./compose-ps.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "./docker-cli.ts";
import {
  ensureHostingCaddy,
  type EnsureHostingCaddyDeps,
  grantHostingCaddyRead,
  HOSTING_CADDY_USER,
} from "./ensure-hosting-caddy.ts";
import {
  assertSafeIngressIdentity,
  type IngressIdentity,
} from "./ingress-identity.ts";
import {
  LABEL_RAW_PORT,
  LABEL_ROLE,
  LABEL_ROLE_INGRESS,
  LABEL_ROUTED,
  LABEL_SERVICE_ID,
  LABEL_SYSTEM_COMPONENT,
} from "./labels.ts";
import {
  assertSafeSystemIngressIdentity,
  readSystemComponentDescriptor,
  SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
  SOCKET_PROXY_COMPOSE_SERVICE_NAME,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  type SystemComponentDescriptor,
} from "./system-component.ts";

const CADDY_SERVICE = "turbopanel-hosting-caddy.service";
const TRAEFIK_IMAGE = "traefik:v3.6.6";
/**
 * The only container on the host that sees the Docker socket.
 *
 * Both Traefiks proxy live tenant traffic, and a remote-code bug in either
 * used to hand over `/var/run/docker.sock` — `:ro` blocks writes to the
 * socket *file*, not Engine API calls, so it was full Docker control and
 * every co-hosted tenant with it. They now reach Docker through this proxy,
 * which answers only the two read endpoints a Docker provider needs.
 */
const SOCKET_PROXY_IMAGE = "tecnativa/docker-socket-proxy:0.3.0";
const SOCKET_PROXY_PORT = 2375;
const SOCKET_PROXY_ENDPOINT =
  `tcp://${SOCKET_PROXY_COMPOSE_SERVICE_NAME}:${SOCKET_PROXY_PORT}`;

/**
 * Docker gate stage 3 (opt-in): the directory holding the root-owned gate's
 * READ-ONLY listener (`orchestration/roles/docker-gate/files/readonly.ts`),
 * which answers only container list / inspect, events, version and ping. A
 * directory of its own, so mounting it never exposes the gate's main socket;
 * the directory (not the socket file) is mounted so a gate restart, which
 * recreates the socket, does not strand Traefik on a dead inode.
 */
export const INGRESS_GATE_SOCKET_DIR = "/run/turbopanel-gate/ro";
const INGRESS_GATE_MOUNT = "/var/run/turbopanel-gate";
const INGRESS_GATE_ENDPOINT = `unix://${INGRESS_GATE_MOUNT}/docker.sock`;
/**
 * The switch (off by default): a root-owned marker in the gate's own source
 * directory (`root:tp 0750`, so the daemon can read it and never create it),
 * written by the docker-gate role when `docker_gate_ingress_socket` is true.
 * It sticks across converges until the role is run with `false`. Without it,
 * both Traefiks keep the socket proxy exactly as before.
 */
export const INGRESS_GATE_SWITCH_FILE =
  `${PROD_HOME_DEFAULT}/lib/docker-gate/ingress-socket.on`;

/** Where a Traefik reaches Docker: the socket proxy, or the gate's read-only socket. */
export type TraefikDockerSource = "socket-proxy" | "gate";

/**
 * The shared Traefik's Docker access. In gate mode the socket proxy stays in
 * the project only while a service Traefik rendered before the switch still
 * points at it (`keepSocketProxy`); the next render drops it and
 * `--remove-orphans` deletes the container.
 */
export type SharedTraefikDocker =
  | { source: "socket-proxy" }
  | { source: "gate"; keepSocketProxy: boolean };

const VIA_SOCKET_PROXY: SharedTraefikDocker = { source: "socket-proxy" };

/**
 * True when Traefik should use the gate's read-only socket: the switch file
 * is there AND so is the gate's read-only directory (created by tmpfiles and
 * the gate unit, so it survives gate restarts; a host where the gate failed
 * to install keeps the socket proxy).
 */
export async function ingressDockerGateEnabled(
  stat: (path: string) => Promise<Deno.FileInfo> = Deno.stat,
): Promise<boolean> {
  const probe = (path: string) => stat(path).catch(() => undefined);
  const [flag, dir] = await Promise.all([
    probe(INGRESS_GATE_SWITCH_FILE),
    probe(INGRESS_GATE_SOCKET_DIR),
  ]);
  return flag?.isFile === true && dir?.isDirectory === true;
}

function dockerEndpoint(source: TraefikDockerSource): string {
  return source === "gate" ? INGRESS_GATE_ENDPOINT : SOCKET_PROXY_ENDPOINT;
}

function gateVolumeLines(source: TraefikDockerSource): string[] {
  if (source !== "gate") return [];
  return [
    "    volumes:",
    `      - ${INGRESS_GATE_SOCKET_DIR}:${INGRESS_GATE_MOUNT}:ro`,
  ];
}
const TRAEFIK_LOOPBACK = "127.0.0.1";
const TRAEFIK_HTTP_PORT = 7080;
const TRAEFIK_HTTPS_PORT = 7443;
/**
 * Loopback-only Prometheus metrics entrypoint for the shared hosting-ingress
 * Traefik. Scraped by the daemon's `metrics/collector/router/traefik.ts` adapter
 * the same way `CADDY_METRICS_ADDR`/`PROXYSQL_REST_ADDR` are — never
 * published beyond `TRAEFIK_LOOPBACK`. Per-service tenant Traefik
 * (`serviceTraefikCompose`) does not get one; ingress metrics are scoped to
 * the shared HTTP-only proxy only.
 */
const TRAEFIK_METRICS_PORT = 7081;
/** Loopback address `metrics/collector/router/traefik.ts` scrapes for shared Traefik metrics. */
export const TRAEFIK_METRICS_ADDR =
  `${TRAEFIK_LOOPBACK}:${TRAEFIK_METRICS_PORT}`;
/**
 * systemd `RuntimeDirectory=` of the hosting Caddy unit: `/run/<this>`, created
 * `tpedge:tpedge 0700` on every start and removed on stop.
 */
export const HOSTING_CADDY_RUNTIME_DIRECTORY = "turbopanel-hosting-caddy";
/**
 * The hosting Caddy's admin API, a unix socket only `tpedge` (and root) can
 * reach. Never a TCP listener: any local process (tenant PHP, native app, cron,
 * SSH shell) can dial loopback TCP, and the admin API loads arbitrary config
 * as `tpedge`, which reads every uploaded TLS key (audit P0-1). Nothing in the
 * daemon dials it; reloads go through `systemctl reload`, whose `ExecReload`
 * runs as `tpedge` (see {@link caddyUnit}). Caddy's default `127.0.0.1:2019`
 * would also collide with the dev panel Caddy.
 */
export const HOSTING_CADDY_ADMIN_SOCKET =
  `/run/${HOSTING_CADDY_RUNTIME_DIRECTORY}/admin.sock`;
/** Caddy's spelling of {@link HOSTING_CADDY_ADMIN_SOCKET} as an address. */
const HOSTING_CADDY_ADMIN_ADDR = `unix/${HOSTING_CADDY_ADMIN_SOCKET}`;
/**
 * Loopback port of the hosting Caddy's metrics-only listener: Prometheus text
 * from the `metrics` handler and nothing else (the admin API stays a unix
 * socket). Totals only: `metrics` is rendered without `per_host`, so no
 * per-site label ever leaves Caddy. Not 2049 (NFS: a host running an NFS server
 * would stop the whole hosting Caddy from binding), and not the 2019/2029/2039
 * Caddy admin ports; 18110 sits beside the other platform loopback ports
 * (18080, 18081, 18099, 18100, 18300).
 */
export const HOSTING_CADDY_METRICS_PORT = 18110;
/** Loopback address `metrics/collector/ingress/caddy.ts` scrapes. */
export const HOSTING_CADDY_METRICS_ADDR =
  `127.0.0.1:${HOSTING_CADDY_METRICS_PORT}`;
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Compose Spec `name:` charset — lowercase alphanumerics, `-`, and `_`. */
const COMPOSE_PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const decoder = new TextDecoder();

/**
 * Guard a value before it is interpolated as a compose document's top-level
 * `name:` key.
 *
 * That key is new interpolation surface: since the shared/system compose
 * projects moved off readable literals onto allocated UUIDs, the project name
 * is written *into* the YAML instead of being passed as `-p`. Charset and
 * length match `COMPOSE_PROJECT_RE` in `src/managed/engine-paths.ts`.
 */
export function assertSafeComposeProjectName(value: string): void {
  if (
    value.length === 0 ||
    value.length > 64 ||
    !COMPOSE_PROJECT_NAME_RE.test(value)
  ) {
    throw new Error("compose project name is invalid");
  }
}

export function hostingIngressDir(layout: LayoutPaths): string {
  return join(layout.stateDir, "ingress", "traefik");
}

export function hostingIngressComposePath(layout: LayoutPaths): string {
  return join(hostingIngressDir(layout), "docker-compose.yml");
}

/**
 * One raw TCP/UDP port a **per-service** Traefik publishes straight through
 * (no hostname/TLS routing) for a `tcp`/`udp` protocol hosting. Persisted per
 * service under `<stateDir>/ingress/tcp-udp/<serviceId>.json` for
 * cross-service conflict detection. Each service that publishes ports gets
 * its own Traefik compose project (named by its bare `<serviceId>`); the
 * shared hosting-ingress Traefik stays HTTP-only (loopback web/websecure).
 */
export type TcpUdpIngressEntry = {
  hostingId: string;
  protocol: "tcp" | "udp";
  publishedPort: number;
  bindAddress?: string;
};

/** Instance-allocated identity for a per-service tenant Traefik container. */
export type ServiceIngressIdentity = IngressIdentity;

/** Raised when two hostings (on different services) claim the same protocol+port. */
export class TcpUdpPortConflictError extends Error {
  constructor(
    readonly protocol: "tcp" | "udp",
    readonly publishedPort: number,
    readonly conflictingHostingId: string,
  ) {
    super(
      `${protocol} port ${publishedPort} is already published by hosting ${conflictingHostingId}`,
    );
    this.name = "TcpUdpPortConflictError";
  }
}

/**
 * Platform-default ProxySQL client listener ports. Always reserved even when an
 * org overrides its effective listeners — tenant raw `tcp`/`udp` hostings must
 * not claim these or the org-specific overrides carried on `environment.deploy`.
 */
export const PROXYSQL_RESERVED_PUBLISHED_PORTS = new Set([15432, 13306]);

/** Orchestrator HTTP/Raft — never claimed by tenant raw TCP/UDP hostings. */
export const MANAGED_HA_RESERVED_PUBLISHED_PORTS = new Set([33001, 33002]);

/** Effective org listener ports echoed on `environment.deploy` when known. */
export type ProxysqlListenerPortsInput = {
  postgres: number;
  mysqlFamily: number;
};

/** Platform defaults plus effective org listener ports when supplied. */
export function buildProxysqlReservedPublishedPorts(
  listenerPorts?: ProxysqlListenerPortsInput | null,
): ReadonlySet<number> {
  const reserved = new Set(PROXYSQL_RESERVED_PUBLISHED_PORTS);
  for (const port of MANAGED_HA_RESERVED_PUBLISHED_PORTS) reserved.add(port);
  if (listenerPorts) {
    reserved.add(listenerPorts.postgres);
    reserved.add(listenerPorts.mysqlFamily);
  }
  return reserved;
}

/** Raised when a tenant claim tries to take a ProxySQL listener port. */
export class TcpUdpPortReservedError extends Error {
  constructor(
    readonly protocol: "tcp" | "udp",
    readonly publishedPort: number,
  ) {
    super(
      `${protocol} port ${publishedPort} is reserved for managed database ingress`,
    );
    this.name = "TcpUdpPortReservedError";
  }
}

export function caddyTraefikUpstream(hop: "http" | "https"): string {
  if (hop === "http") {
    return `reverse_proxy ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTP_PORT} {
  transport http {
    proxy_protocol v2
    keepalive off
    versions h2c
  }
}`;
  }
  // Caddy rewrites Host to the upstream address on a TLS hop, and Traefik
  // routes on the original hostname, so pass it through explicitly.
  return `reverse_proxy ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTPS_PORT} {
  header_up Host {host}
  transport http {
    proxy_protocol v2
    keepalive off
    versions 2
    tls
    tls_insecure_skip_verify
  }
}`;
}

type CommandResult = {
  success: boolean;
  stderr: string;
};

/** Injectable host command runner (sudo/systemctl) for host-free unit tests. */
export type IngressHostCommandFn = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

let hostCommandOverride: IngressHostCommandFn | undefined;

/**
 * Test-only injection for hosting Caddy install/reload sudo paths.
 * Returns a restore function that clears the override.
 */
export function setIngressHostCommandForTest(
  fn?: IngressHostCommandFn,
): () => void {
  const previous = hostCommandOverride;
  hostCommandOverride = fn;
  return () => {
    hostCommandOverride = previous;
  };
}

async function runDefault(
  command: string,
  args: string[],
): Promise<CommandResult> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: decoder.decode(result.stderr).trim(),
  };
}

async function run(
  command: string,
  args: string[],
): Promise<CommandResult> {
  const impl = hostCommandOverride ?? runDefault;
  return await impl(command, args);
}

function commandError(action: string, result: CommandResult): Error {
  return new Error(result.stderr || `${action} failed`);
}

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/** Optional test seams for {@link inspectHostingIngressContainer}. */
export type InspectHostingIngressDeps = {
  runDocker?: RunDockerFn;
};

/**
 * Ensure the shared hosting-ingress Docker network exists.
 *
 * `network` is the `hosting-ingress` system component's allocated `serviceId`
 * — threaded in by the caller (from the persisted descriptor, or from the
 * deploy payload's `hostingIngressNetwork`), never a module constant.
 */
async function ensureIngressNetwork(
  network: string,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  assertSafeComposeProjectName(network);
  const inspect = await run([
    "network",
    "inspect",
    network,
  ]);
  if (inspect.success) return;

  const create = await run(["network", "create", network]);
  if (!create.success) {
    throw commandError("Creating ingress Docker network", create);
  }
}

/**
 * Bridge gateway(s) of the ingress network: the PROXY protocol peers the
 * shared Traefik trusts (see {@link traefikCompose}).
 */
async function ingressNetworkGateways(
  network: string,
  run: RunDockerFn,
): Promise<string[]> {
  const inspect = await run(["network", "inspect", network]);
  if (!inspect.success) {
    throw commandError("Inspecting ingress Docker network", inspect);
  }
  return parseIngressNetworkGateways(network, inspect.stdout);
}

/** Traefik entrypoint name for one raw TCP/UDP published port (must be a valid Traefik entrypoint name). */
function tcpUdpEntrypointName(
  protocol: "tcp" | "udp",
  publishedPort: number,
): string {
  return `${protocol}${publishedPort}`;
}

/** Dedupe by protocol+port (first entry wins — callers must resolve conflicts before this point). */
function dedupeTcpUdpEntries(
  entries: readonly TcpUdpIngressEntry[],
): TcpUdpIngressEntry[] {
  const byKey = new Map<string, TcpUdpIngressEntry>();
  for (const entry of entries) {
    const key = `${entry.protocol}:${entry.publishedPort}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) =>
    a.publishedPort - b.publishedPort || a.protocol.localeCompare(b.protocol)
  );
}

function quoteYamlScalar(value: string): string {
  return `"${
    value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)
  }"`;
}

function tcpUdpStaticArgLines(
  entries: readonly TcpUdpIngressEntry[],
): string[] {
  return dedupeTcpUdpEntries(entries).map((entry) => {
    const name = tcpUdpEntrypointName(entry.protocol, entry.publishedPort);
    const suffix = entry.protocol === "udp" ? "/udp" : "";
    return `      - ${
      quoteYamlScalar(
        `--entrypoints.${name}.address=:${entry.publishedPort}${suffix}`,
      )
    }`;
  });
}

function tcpUdpPortLines(entries: readonly TcpUdpIngressEntry[]): string[] {
  return dedupeTcpUdpEntries(entries).map((entry) => {
    const bindAddress = entry.bindAddress ?? "0.0.0.0";
    assertValidBindAddress(bindAddress);
    const host = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
    return `      - ${
      quoteYamlScalar(
        `${host}:${entry.publishedPort}:${entry.publishedPort}/${entry.protocol}`,
      )
    }`;
  });
}

/**
 * The `trustedIPs` value for the shared entrypoints: bare IPv4 / IPv6 literals
 * only (no CIDR — one gateway, not the subnet its tenant containers live in),
 * deduplicated, comma-joined. Empty is refused: without a trusted peer Caddy's
 * PROXY header would be ignored and every site would see the gateway as its
 * client, and `insecure` is never the fallback.
 */
export function proxyProtocolTrustedIps(ips: readonly string[]): string {
  const unique = [...new Set(ips)];
  if (unique.length === 0) {
    throw new Error(
      "Shared Traefik needs at least one trusted PROXY protocol peer (the ingress network gateway)",
    );
  }
  for (const ip of unique) {
    if (!isValidIpv4Literal(ip) && !isValidIpv6Literal(ip)) {
      throw new Error(`Invalid PROXY protocol trusted address: ${ip}`);
    }
  }
  return unique.join(",");
}

/**
 * Bridge gateway address(es) from `docker network inspect <network>` output
 * (a JSON array with one network object). Throws when there is none: the
 * shared Traefik cannot be rendered safely without it.
 */
export function parseIngressNetworkGateways(
  network: string,
  inspectStdout: string,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectStdout);
  } catch {
    parsed = undefined;
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const config = (first as { IPAM?: { Config?: unknown } } | undefined)?.IPAM
    ?.Config;
  const gateways = Array.isArray(config)
    ? config
      .map((entry) => (entry as { Gateway?: unknown } | null)?.Gateway)
      .filter((gw): gw is string => typeof gw === "string" && gw !== "")
    : [];
  if (gateways.length === 0) {
    throw new Error(
      `Ingress Docker network ${network} reports no IPAM gateway; cannot pin the PROXY protocol trusted peer`,
    );
  }
  return gateways;
}

/** Shared HTTP-only Traefik (loopback web/websecure). No tcp/udp entrypoints. */
/**
 * Shared HTTP-only Traefik compose document.
 *
 * `ingressNetwork` is the `hosting-ingress` component's allocated `serviceId`
 * — it names both the external Docker network the shared proxy joins and the
 * compose project, which this document declares itself through the top-level
 * `name:` key. Every `docker compose` invocation against this file therefore
 * omits `-p`.
 *
 * Without `identity`, returns the anonymous shape used in the fresh
 * pre-provision state (no `container_name`, no `x-turbopanel`, no labels)
 * before `system.reconcile` writes `<stateDir>/system/hosting-ingress.json`.
 *
 * With `identity`, emits allocated `container_name`, an `x-turbopanel` block
 * (`kind: system`), and canonical role / system-component / service labels —
 * never `traefik.enable`, HTTP router labels, or `com.turbopanel.raw-port`
 * (omitting raw-port keeps the shared container invisible to every tenant
 * Traefik provider constraint).
 *
 * `proxyTrustedIps` are the only peers whose PROXY protocol header Traefik
 * believes: the ingress network's bridge gateway(s), which is where the
 * hosting Caddy's connections arrive from (Docker's loopback publish relays
 * them from the host side of the bridge). Every other peer — a tenant
 * container on the ingress network above all — has its header read and
 * ignored, so it cannot claim another client's address. Who on the host may
 * reach the loopback publish at all is the ingress guard's job
 * (`orchestration/roles/hosting-caddy`, `turbopanel-ingress-guard.service`).
 */
export function traefikCompose(
  ingressNetwork: string,
  proxyTrustedIps: readonly string[],
  identity?: SystemComponentDescriptor,
  docker: SharedTraefikDocker = VIA_SOCKET_PROXY,
  requireRoutedLabel = true,
): string {
  assertSafeComposeProjectName(ingressNetwork);
  const trusted = proxyProtocolTrustedIps(proxyTrustedIps);
  if (identity !== undefined) {
    assertSafeSystemIngressIdentity(identity);
  }

  const identityLines = identity === undefined ? [] : [
    `    container_name: ${identity.containerName}`,
    "    x-turbopanel:",
    "      kind: system",
    `      component: ${SYSTEM_HOSTING_INGRESS_COMPONENT}`,
    `      serviceId: ${identity.serviceId}`,
    `      containerName: ${identity.containerName}`,
  ];
  const labelLines = identity === undefined ? [] : [
    "    labels:",
    `      ${LABEL_ROLE}: ${LABEL_ROLE_INGRESS}`,
    `      ${LABEL_SYSTEM_COMPONENT}: ${
      quoteYamlScalar(SYSTEM_HOSTING_INGRESS_COMPONENT)
    }`,
    `      ${LABEL_SERVICE_ID}: ${quoteYamlScalar(identity.serviceId)}`,
  ];
  const viaProxy = docker.source === "socket-proxy";
  const dependsLines = viaProxy
    ? ["    depends_on:", `      - ${SOCKET_PROXY_COMPOSE_SERVICE_NAME}`]
    : [];
  const keepProxy = viaProxy || docker.keepSocketProxy;
  const proxyLines = keepProxy ? socketProxyServiceLines(ingressNetwork) : [];

  const lines = [
    `name: ${ingressNetwork}`,
    "",
    "services:",
    `  ${SHARED_TRAEFIK_COMPOSE_SERVICE_NAME}:`,
    `    image: ${TRAEFIK_IMAGE}`,
    ...identityLines,
    "    restart: unless-stopped",
    "    command:",
    "      - --providers.docker=true",
    `      - --providers.docker.endpoint=${dockerEndpoint(docker.source)}`,
    "      - --providers.docker.exposedbydefault=false",
    `      - --providers.docker.network=${ingressNetwork}`,
    // Only containers the daemon stamped as routed (a reserved label) are read.
    // Left off while a running HTTP container still predates the label (see
    // `legacyHttpContainersPresent`), so no site goes dark mid-transition.
    ...(requireRoutedLabel
      ? [
        `      - ${
          quoteYamlScalar(
            `--providers.docker.constraints=Label(\`${LABEL_ROUTED}\`,\`true\`)`,
          )
        }`,
      ]
      : []),
    `      - --entrypoints.web.address=:${TRAEFIK_HTTP_PORT}`,
    `      - --entrypoints.web.proxyProtocol.trustedIPs=${trusted}`,
    `      - --entrypoints.websecure.address=:${TRAEFIK_HTTPS_PORT}`,
    `      - --entrypoints.websecure.proxyProtocol.trustedIPs=${trusted}`,
    "      - --entrypoints.websecure.http.tls=true",
    `      - --entrypoints.metrics.address=:${TRAEFIK_METRICS_PORT}`,
    "      - --metrics.prometheus=true",
    "      - --metrics.prometheus.entryPoint=metrics",
    // Traefik defaults `addRoutersLabels` to false, which suppresses the
    // whole `traefik_router_*` family. The daemon's router adapter derives
    // `routersTotal` from it, so without this flag that field would be
    // permanently null. The services/entrypoints label sets are on by
    // default and need no flag.
    "      - --metrics.prometheus.addRoutersLabels=true",
    // Six bounds, not v5's four. The old set bottomed out at 100ms, which put
    // every request on a healthy site in the first bucket and made the
    // read-time p50 meaningless; 10ms/50ms are what give the low end any
    // resolution at all.
    "      - --metrics.prometheus.buckets=0.01,0.05,0.1,0.5,1.0,5.0",
    "    ports:",
    `      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTP_PORT}:${TRAEFIK_HTTP_PORT}`,
    `      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTPS_PORT}:${TRAEFIK_HTTPS_PORT}`,
    `      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_METRICS_PORT}:${TRAEFIK_METRICS_PORT}`,
    ...labelLines,
    ...gateVolumeLines(docker.source),
    "    networks:",
    `      - ${ingressNetwork}`,
    ...dependsLines,
    ...proxyLines,
    "",
    "networks:",
    `  ${ingressNetwork}:`,
    "    external: true",
    "",
  ];
  return lines.join("\n");
}

/**
 * The host's single Docker-socket proxy, scoped to what a Docker provider
 * actually reads.
 *
 * `CONTAINERS` and `EVENTS` are what Traefik needs to discover routers and
 * follow changes; everything else — `POST` above all, but also images,
 * networks, volumes, exec, and the rest — stays off, which is the proxy's
 * default. So a container that breaks out of Traefik can list containers and
 * watch events, and cannot create, start, mount or exec anything.
 */
function socketProxyServiceLines(ingressNetwork: string): string[] {
  return [
    `  ${SOCKET_PROXY_COMPOSE_SERVICE_NAME}:`,
    `    image: ${SOCKET_PROXY_IMAGE}`,
    "    restart: unless-stopped",
    "    environment:",
    '      CONTAINERS: "1"',
    '      EVENTS: "1"',
    '      POST: "0"',
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
    "    networks:",
    `      - ${ingressNetwork}`,
  ];
}

function assertSafeServiceIngressIdentity(
  identity: ServiceIngressIdentity,
): void {
  assertSafeIngressIdentity(identity);
}

/**
 * Compose project name for one service's tenant Traefik — the bare
 * `serviceId`, with no readable prefix. The container keeps its
 * `<serviceId>-in` name (see `ingressContainerName`), which is what
 * distinguishes it from the tenant workload containers in the same project
 * namespace.
 */
export function serviceIngressProject(serviceId: string): string {
  if (!SAFE_FILE_ID_RE.test(serviceId)) {
    throw new Error("serviceId contains unsupported characters");
  }
  return serviceId;
}

export function serviceIngressDir(
  layout: LayoutPaths,
  serviceId: string,
): string {
  if (!SAFE_FILE_ID_RE.test(serviceId)) {
    throw new Error("serviceId contains unsupported characters");
  }
  return join(layout.stateDir, "ingress", "services", serviceId);
}

export function serviceIngressComposePath(
  layout: LayoutPaths,
  serviceId: string,
): string {
  return join(serviceIngressDir(layout, serviceId), "docker-compose.yml");
}

/**
 * Compose document for one tenant service's Traefik project.
 *
 * Joins `ingressNetwork` (the `hosting-ingress` component's allocated
 * `serviceId`, supplied by the caller from the deploy payload's
 * `hostingIngressNetwork`), constrains the Docker provider to
 * `com.turbopanel.service=<serviceId>` **and** `com.turbopanel.raw-port=true`
 * (stamped by `buildHostingLabelsFragment` only on services that publish tcp/udp),
 * and emits only that service's tcp/udp entrypoints + published ports.
 * HTTP routers on mixed-hosting services are pinned to `web,websecure`, which
 * this Traefik does not define — so HTTP config stays on shared loopback Traefik.
 *
 * Declares its own compose project through the top-level `name:` key
 * ({@link serviceIngressProject}), so callers need no `-p`.
 */
export function serviceTraefikCompose(
  entries: readonly TcpUdpIngressEntry[],
  identity: ServiceIngressIdentity,
  ingressNetwork: string,
  docker: TraefikDockerSource = "socket-proxy",
): string {
  assertSafeServiceIngressIdentity(identity);
  assertSafeComposeProjectName(ingressNetwork);
  const project = serviceIngressProject(identity.serviceId);
  assertSafeComposeProjectName(project);
  const staticArgs = tcpUdpStaticArgLines(entries);
  const portLines = tcpUdpPortLines(entries);
  const constraint =
    `Label(\`${LABEL_SERVICE_ID}\`,\`${identity.serviceId}\`) && Label(\`${LABEL_RAW_PORT}\`,\`true\`)`;
  const lines = [
    `name: ${project}`,
    "",
    "services:",
    `  ${identity.composeServiceName}:`,
    `    image: ${TRAEFIK_IMAGE}`,
    `    container_name: ${identity.containerName}`,
    "    x-turbopanel:",
    "      kind: ingress",
    `      serviceId: ${identity.serviceId}`,
    `      containerName: ${identity.containerName}`,
    "    restart: unless-stopped",
    "    command:",
    "      - --providers.docker=true",
    // The host's socket proxy lives in the shared ingress project and is
    // reachable over the ingress network this container already joins — one
    // proxy per host, not one per service. In gate mode: the gate's
    // read-only socket, mounted below.
    `      - --providers.docker.endpoint=${dockerEndpoint(docker)}`,
    "      - --providers.docker.exposedbydefault=false",
    `      - --providers.docker.network=${ingressNetwork}`,
    `      - ${
      quoteYamlScalar(`--providers.docker.constraints=${constraint}`)
    }`,
    ...staticArgs,
    ...(portLines.length > 0 ? ["    ports:", ...portLines] : []),
    "    labels:",
    `      ${LABEL_ROLE}: ${LABEL_ROLE_INGRESS}`,
    `      ${LABEL_SERVICE_ID}: ${quoteYamlScalar(identity.serviceId)}`,
    ...gateVolumeLines(docker),
    "    networks:",
    `      - ${ingressNetwork}`,
    "",
    "networks:",
    `  ${ingressNetwork}:`,
    "    external: true",
    "",
  ];
  return lines.join("\n");
}

/**
 * The hosting unit's systemd `StateDirectory=`: `/var/lib/<name>`, created
 * and owned by {@link HOSTING_CADDY_USER}. It holds the ACME account, the
 * internal CA and every leaf certificate. Top level on purpose: never inside
 * the `tp`-owned state tree, so `tp` cannot swap it out from under Caddy.
 */
export const HOSTING_CADDY_STATE_DIRECTORY = "turbopanel-hosting-caddy";

/**
 * Bounded shutdown for the hosting Caddy. Without it Caddy waits forever for
 * open connections after SIGTERM and systemd has to kill it. The unit's
 * `TimeoutStopSec` must stay above this.
 */
export const HOSTING_CADDY_GRACE_PERIOD = "5s";

/**
 * The Caddyfile the deploy path validates a candidate site set with: the real
 * one, except it imports the staged copy of the sites and keeps its throwaway
 * certificate authority in its own folder (`caddy validate` provisions the
 * internal CA, and the validating account has no home to put it in).
 */
type HostingCaddyfileCandidate = Readonly<{
  sitesDir: string;
  storageDir: string;
}>;

export function caddyfile(
  configDir: string,
  candidate?: HostingCaddyfileCandidate,
): string {
  // `disable_redirects`, not `off`: every site snippet writes its own
  // `http://<host>` redirect block, but `off` also disables certificate
  // management — `tls internal` sites then fail the handshake with no leaf
  // cert ever issued. Site snippets emit a materialized cert pair,
  // `tls internal`, or omit the `tls` line (`tlsMode: 'acme'`) so Caddy's
  // ACME client can issue on :80/:443.
  // Future: optional `email {acmeEmail}` in this global block when the
  // deploy payload carries an ACME contact address.
  // `skip_install_trust`: Caddy runs as an unprivileged account, so it must
  // never try to add its internal CA to the host's trust store (it would
  // shell out to sudo, and as root it used to succeed).
  const storage = candidate
    ? `\n  storage file_system ${candidate.storageDir}`
    : "";
  const sitesGlob = candidate?.sitesDir ?? join(configDir, "hosting", "sites");
  return `{
  admin ${HOSTING_CADDY_ADMIN_ADDR}|0600${storage}
  auto_https disable_redirects
  skip_install_trust
  grace_period ${HOSTING_CADDY_GRACE_PERIOD}
  metrics
  servers {
    protocols h1 h2 h3
    metrics
  }
}
# Metrics only, with no per-host option: totals across every site, no site
# name in a label. \`bind\` keeps the listener on loopback.
http://${HOSTING_CADDY_METRICS_ADDR} {
  bind 127.0.0.1
  metrics
}
import ${join(sitesGlob, "*.caddy")}
`;
}

export function caddyUnit(layout: LayoutPaths): string {
  const caddy = join(layout.runtimesDir, "caddy", "current", "caddy");
  const configDir = join(layout.configDir, "hosting");
  // Without HOME and the XDG paths Caddy falls back to `./caddy` under
  // WorkingDirectory, i.e. certificates and autosave written into the config
  // tree. `%S` is systemd's state root (/var/lib), so all of it lands in the
  // unit's own StateDirectory. XDG_DATA_HOME is this process's ACME account
  // and certificate storage. It must stay distinct from control-plane Caddy
  // (`<state>/caddy/.local/share`) and from site Caddy (`<state>/site-caddy`).
  // The processes must never share an account, contact, or on-disk storage.
  const state = `%S/${HOSTING_CADDY_STATE_DIRECTORY}`;
  return `[Unit]
Description=TurboPanel hosting Caddy ingress
After=network-online.target docker.service
Wants=network-online.target

[Service]
# Type=simple is active as soon as ExecStart is forked. ExecReload POSTs to
# the admin socket, which does not exist yet. Instance ACME writes the
# HTTP-01 site before the first start and does not reload that window; an
# already-running unit still reloads.
Type=simple
# Not root: ${HOSTING_CADDY_USER} (not in group tp) with one capability, binding
# :80/:443. tp-host refuses this unit in any other shape.
User=${HOSTING_CADDY_USER}
Group=${HOSTING_CADDY_USER}
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
StateDirectory=${HOSTING_CADDY_STATE_DIRECTORY}
# The admin socket's directory: ${HOSTING_CADDY_USER} only. tp-host pins both.
RuntimeDirectory=${HOSTING_CADDY_RUNTIME_DIRECTORY}
RuntimeDirectoryMode=0700
Environment=HOME=${state}
Environment=XDG_DATA_HOME=${state}/data
Environment=XDG_CONFIG_HOME=${state}/config
WorkingDirectory=${configDir}
ExecStart=${caddy} run --config ${
    join(configDir, "Caddyfile")
  } --adapter caddyfile
ExecReload=${caddy} reload --config ${
    join(configDir, "Caddyfile")
  } --adapter caddyfile --address ${HOSTING_CADDY_ADMIN_ADDR}
TimeoutStopSec=30
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

async function installAndStartCaddy(
  unitSource: string,
  unitChanged: boolean,
): Promise<boolean> {
  const install = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "install",
      "-m",
      "0640",
      unitSource,
      join("/etc/systemd/system", CADDY_SERVICE),
    ]),
  );
  if (!install.success) {
    logWarn("deploy", `hosting Caddy unit not installed: ${install.stderr}`);
    return false;
  }

  const daemonReload = await run(
    "sudo",
    hostSudoArgs(["-n", "systemctl", "daemon-reload"]),
  );
  if (!daemonReload.success) {
    logWarn(
      "deploy",
      `hosting Caddy daemon-reload failed: ${daemonReload.stderr}`,
    );
    return false;
  }
  // `enable --now` leaves a running Caddy alone, so a changed unit (a new
  // account, capability or store) would only apply on the next reboot.
  // Restart it now; on a host where it is stopped this starts it.
  if (unitChanged) {
    const restart = await run(
      "sudo",
      hostSudoArgs(["-n", "systemctl", "restart", CADDY_SERVICE]),
    );
    if (!restart.success) {
      logWarn("deploy", `hosting Caddy restart failed: ${restart.stderr}`);
      return false;
    }
  }
  const enable = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "systemctl",
      "enable",
      "--now",
      CADDY_SERVICE,
    ]),
  );
  if (!enable.success) {
    logWarn("deploy", `hosting Caddy start failed: ${enable.stderr}`);
    return false;
  }
  return true;
}

/** Ensure hosting Caddy binary, Caddyfile, sites dir, and systemd unit. */
export async function ensureHostingCaddyRuntime(
  layout: LayoutPaths,
  deps?: EnsureHostingCaddyDeps,
): Promise<void> {
  await ensureHostingCaddy(layout, deps);
  const hostingDir = join(layout.configDir, "hosting");
  const sitesDir = join(hostingDir, "sites");
  await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });
  const grantRead = deps?.grantHostingRead ?? grantHostingCaddyRead;
  // Before the writes, so a folder made before the role ran hands its default
  // entry to the files below; after them (further down), so whatever was
  // already there (an updated host's Caddyfile) gets its entry too.
  await grantRead(hostingDir);
  await Deno.writeTextFile(
    join(sitesDir, "00-empty.caddy"),
    "# Hosting routes are written per environment.\n",
    { mode: 0o640 },
  );
  await Deno.writeTextFile(
    join(hostingDir, "Caddyfile"),
    caddyfile(layout.configDir),
    {
      mode: 0o640,
    },
  );
  const unitSource = join(hostingDir, CADDY_SERVICE);
  const unit = caddyUnit(layout);
  // The staged copy is the last unit that was installed and started.
  const unitChanged = (await readTextIfPresent(unitSource)) !== unit;
  await Deno.writeTextFile(unitSource, unit, { mode: 0o640 });
  await grantRead(hostingDir);

  const started = await installAndStartCaddy(unitSource, unitChanged);
  if (!started) {
    // Drop the staged copy so the next attempt still sees a changed unit and
    // restarts Caddy once it installs.
    await Deno.remove(unitSource).catch(() => {});
    throw new Error("hosting Caddy could not be installed or started");
  }
}

/** Optional test seams for {@link ensureHostingIngress}. */
export type EnsureHostingIngressDeps = {
  runDocker?: RunDockerFn;
  /** When set, skips binary/unit install (host-free tests). */
  ensureHostingCaddyRuntime?: (layout: LayoutPaths) => Promise<void>;
  /** Docker gate stage 3 switch; defaults to {@link ingressDockerGateEnabled}. */
  ingressDockerGate?: () => Promise<boolean>;
};

/**
 * Where a compose document waits while `compose up` runs on it. It replaces
 * the applied `docker-compose.yml` only after `up` succeeds, so the applied
 * file always describes what last came up (never mere intent). A failed `up`
 * leaves it behind: it may describe containers that did get (re)created.
 */
function pendingComposePath(composePath: string): string {
  return composePath.replace(/\.yml$/, ".pending.yml");
}

/** Write `yaml` pending, run `up` on it, then make it the applied file. */
async function applyCompose(
  composePath: string,
  yaml: string,
  up: (file: string) => Promise<DockerCliResult>,
  what: string,
): Promise<void> {
  const pending = pendingComposePath(composePath);
  await Deno.writeTextFile(pending, yaml, { mode: 0o640 });
  const result = await up(pending);
  if (!result.success) throw commandError(what, result);
  await Deno.rename(pending, composePath);
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/**
 * True while a service Traefik may still reach Docker through the shared
 * socket proxy: its applied compose file names the proxy, or a pending one
 * does (an `up` that failed part-way may have left a container on it). The
 * shared project keeps the proxy until none does.
 */
export async function serviceIngressUsesSocketProxy(
  layout: LayoutPaths,
): Promise<boolean> {
  const root = join(layout.stateDir, "ingress", "services");
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(root));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
  const files = entries.filter((entry) => entry.isDirectory).flatMap(
    (entry) => {
      const applied = join(root, entry.name, "docker-compose.yml");
      return [applied, pendingComposePath(applied)];
    },
  );
  const uses = await Promise.all(files.map(composeNamesSocketProxy));
  return uses.includes(true);
}

async function composeNamesSocketProxy(path: string): Promise<boolean> {
  const yaml = await readTextIfPresent(path);
  return yaml?.includes(SOCKET_PROXY_ENDPOINT) === true;
}

/** True when a shared compose document runs the socket-proxy service. */
function declaresSocketProxy(yaml: string): boolean {
  return yaml.includes(`\n  ${SOCKET_PROXY_COMPOSE_SERVICE_NAME}:\n`);
}

async function loadHostingIngressDescriptor(
  layout: LayoutPaths,
): Promise<SystemComponentDescriptor | undefined> {
  try {
    const loaded = await readSystemComponentDescriptor(
      layout,
      SYSTEM_HOSTING_INGRESS_COMPONENT,
    );
    return loaded ?? undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(
      "deploy",
      `hosting ingress descriptor unreadable; using anonymous Traefik: ${message}`,
    );
    return undefined;
  }
}

/**
 * True when a running container still routes HTTP through the shared Traefik
 * without the daemon's routed label (it was deployed before the label existed).
 * Such a container only gets the label when its environment is redeployed, so
 * the shared Traefik keeps reading every labelled container (no provider
 * constraint) until none is left; the next render after that turns the
 * constraint on. Authored `traefik.*` labels are refused at deploy either way.
 * A Docker error counts as "present": availability wins over the constraint.
 */
export async function legacyHttpContainersPresent(
  run: RunDockerFn,
): Promise<boolean> {
  // `-a`: a stopped container comes back unrouted when its site is started.
  const ps = await run([
    "ps",
    "-a",
    "-q",
    "--filter",
    "label=traefik.enable=true",
  ]);
  if (!ps.success) return true;
  const ids = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length === 0) return false;
  const inspect = await run([
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    ...ids,
  ]);
  if (!inspect.success) return true;
  return inspect.stdout.split("\n").some((line) => {
    const labels = parseLabelsLine(line);
    if (labels === undefined || labels[LABEL_ROUTED] === "true") return false;
    return Object.keys(labels).some((k) => k.startsWith("traefik.http."));
  });
}

function parseLabelsLine(line: string): Record<string, string> | undefined {
  const text = line.trim();
  if (text === "" || text === "null") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, string>
      : undefined;
  } catch {
    return undefined;
  }
}

/** `compose up` the shared project from `yaml` (applied only on success). */
function upSharedTraefik(
  layout: LayoutPaths,
  yaml: string,
  run: RunDockerFn,
): Promise<void> {
  // No `-p`: the compose file declares its own project through `name:`.
  return applyCompose(
    hostingIngressComposePath(layout),
    yaml,
    (file) => run(["compose", "-f", file, "up", "-d", "--remove-orphans"]),
    "Starting Traefik ingress",
  );
}

/**
 * A service Traefik about to use the socket proxy needs it running. After the
 * switch is turned off, a TCP/UDP-only deploy re-renders its Traefik onto the
 * proxy without rendering the shared project, which may still be in gate mode
 * (no proxy). Add the proxy back to it: same gate-mode Traefik plus the proxy
 * service, so compose only starts the proxy and the shared Traefik (every
 * HTTP route) is not recreated. No shared project: nothing to add it to (a
 * TCP/UDP-only host has never had a proxy; unchanged).
 */
async function ensureSharedSocketProxy(
  layout: LayoutPaths,
  ingressNetwork: string,
  run: RunDockerFn,
): Promise<void> {
  const composePath = hostingIngressComposePath(layout);
  const applied = await readTextIfPresent(composePath);
  if (applied === undefined) return;
  if (declaresSocketProxy(applied)) {
    // Declared is not running: a leftover pending file (a failed `up` may have
    // removed the proxy as an orphan) or a missing container means the proxy
    // is gone. Re-up the applied file as it is; compose only starts the proxy.
    const trusted = !(await exists(pendingComposePath(composePath))) &&
      await socketProxyRunning(ingressNetwork, run);
    if (!trusted) await upSharedTraefik(layout, applied, run);
    return;
  }
  // A legacy shared file (Traefik on docker.sock directly, no proxy service)
  // is not ours to recreate from a TCP/UDP deploy: only a file that already
  // uses the gate endpoint may be re-rendered in gate mode.
  if (!applied.includes(INGRESS_GATE_ENDPOINT)) return;
  const descriptor = await loadHostingIngressDescriptor(layout);
  // No descriptor: the anonymous shape, which is always on the proxy (it has
  // no ingress label for the gate's allowance), as ensureHostingIngress does.
  const docker: SharedTraefikDocker = descriptor === undefined
    ? VIA_SOCKET_PROXY
    : { source: "gate", keepSocketProxy: true };
  await upSharedTraefik(
    layout,
    traefikCompose(
      ingressNetwork,
      await ingressNetworkGateways(ingressNetwork, run),
      descriptor,
      docker,
      !(await legacyHttpContainersPresent(run)),
    ),
    run,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** True when the shared project's socket-proxy container is running. */
async function socketProxyRunning(
  ingressNetwork: string,
  run: RunDockerFn,
): Promise<boolean> {
  const result = await run([
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${ingressNetwork}`,
    "--filter",
    `label=com.docker.compose.service=${SOCKET_PROXY_COMPOSE_SERVICE_NAME}`,
  ]);
  return result.success && result.stdout.trim() !== "";
}

/**
 * The anonymous (pre-`system.reconcile`) shared Traefik carries no
 * `turbopanel.role=ingress` label, so the gate would not grant it the
 * read-only socket bind: it keeps the socket proxy until it has an identity.
 */
async function sharedTraefikDocker(
  layout: LayoutPaths,
  hasIdentity: boolean,
  gateEnabled: () => Promise<boolean>,
): Promise<SharedTraefikDocker> {
  if (!hasIdentity || !(await gateEnabled())) return VIA_SOCKET_PROXY;
  return {
    source: "gate",
    keepSocketProxy: await serviceIngressUsesSocketProxy(layout),
  };
}

/**
 * Ensure the shared HTTP-only Traefik + hosting Caddy runtime.
 *
 * `ingressNetwork` is the `hosting-ingress` component's allocated `serviceId`
 * — the Docker network name **and** the compose project name. Callers supply
 * it from the persisted descriptor (`system.reconcile`) or from the deploy
 * payload's `hostingIngressNetwork` (`environment.deploy`).
 */
export async function ensureHostingIngress(
  layout: LayoutPaths,
  ingressNetwork: string,
  deps?: EnsureHostingIngressDeps,
): Promise<void> {
  const run = deps?.runDocker ?? defaultRunDocker;
  await ensureIngressNetwork(ingressNetwork, run);
  await removeStaleNetworkContainers(ingressNetwork, ingressNetwork, run);
  const gateways = await ingressNetworkGateways(ingressNetwork, run);

  const ingressDir = hostingIngressDir(layout);
  await Deno.mkdir(ingressDir, { recursive: true, mode: 0o750 });

  const descriptor = await loadHostingIngressDescriptor(layout);
  const docker = await sharedTraefikDocker(
    layout,
    descriptor !== undefined,
    deps?.ingressDockerGate ?? (() => ingressDockerGateEnabled()),
  );
  await upSharedTraefik(
    layout,
    traefikCompose(
      ingressNetwork,
      gateways,
      descriptor,
      docker,
      !(await legacyHttpContainersPresent(run)),
    ),
    run,
  );

  const ensureCaddy = deps?.ensureHostingCaddyRuntime ??
    ensureHostingCaddyRuntime;
  await ensureCaddy(layout);
}

/**
 * True when the compose-ps row carries the allowlisted platform labels for
 * the shared hosting-ingress Traefik (`turbopanel.role=ingress`,
 * `com.turbopanel.system.component=hosting-ingress`, and
 * `com.turbopanel.service=<serviceId>`). Unlabelled / legacy rows fail.
 */
function hasHostingIngressLabels(
  entry: Record<string, unknown>,
  serviceId: string,
): boolean {
  const labels = readComposePsLabels(entry);
  return (
    labels[LABEL_ROLE] === LABEL_ROLE_INGRESS &&
    labels[LABEL_SYSTEM_COMPONENT] === SYSTEM_HOSTING_INGRESS_COMPONENT &&
    labels[LABEL_SERVICE_ID] === serviceId
  );
}

async function hostingIngressComposeFileExists(
  composePath: string,
): Promise<boolean> {
  try {
    await Deno.stat(composePath);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Best-effort observe the shared hosting-ingress Traefik container.
 *
 * Returns `undefined` when Docker/`ps` fails (caller should omit
 * `containers` from the command result). Returns `null` when no descriptor
 * is allocated, the compose file is missing, or the expected labelled
 * identity is absent (authoritative empty). Never throws; never scans
 * Docker broadly — only the canonical compose project and allocated
 * identity with allowlisted platform labels are accepted.
 */
export async function inspectHostingIngressContainer(
  layout: LayoutPaths,
  deps?: InspectHostingIngressDeps,
): Promise<EnvironmentDeployContainer | null | undefined> {
  const run = deps?.runDocker ?? defaultRunDocker;
  try {
    const descriptor = await readSystemComponentDescriptor(
      layout,
      SYSTEM_HOSTING_INGRESS_COMPONENT,
    );
    if (descriptor === null) return null;

    const composePath = hostingIngressComposePath(layout);
    // Missing compose file = authoritative absence (never written / removed
    // with the project). Do not invoke `docker compose -f <missing>` —
    // that fails and would look like a collection error.
    if (!(await hostingIngressComposeFileExists(composePath))) {
      return null;
    }

    const result = await run([
      "compose",
      "-f",
      composePath,
      "ps",
      "-a",
      "--format",
      "json",
    ]);
    if (!result.success) {
      logInfo(
        "deploy",
        `hosting ingress inspect failed: ${
          result.stderr || "docker compose ps failed"
        }`,
      );
      return undefined;
    }
    const entries = parseComposePsEntries(result.stdout);
    for (const entry of entries) {
      const row = readComposePsContainer(entry, "ingress");
      if (row === null) continue;
      // Require the allocated container_name AND compose service — never
      // accept a legacy default name just because Service === traefik.
      if (
        row.composeServiceName !== descriptor.composeServiceName ||
        row.containerName !== descriptor.containerName
      ) {
        continue;
      }
      if (!hasHostingIngressLabels(entry, descriptor.serviceId)) continue;
      return {
        ...row,
        serviceId: descriptor.serviceId,
      };
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn("deploy", `hosting ingress inspect failed: ${message}`);
    return undefined;
  }
}

/** Optional test seams for {@link ensureServiceIngress}. */
export type EnsureServiceIngressDeps = {
  runDocker?: RunDockerFn;
  /** Docker gate stage 3 switch; defaults to {@link ingressDockerGateEnabled}. */
  ingressDockerGate?: () => Promise<boolean>;
};

/**
 * Ensure this service's Traefik is running with its own entrypoint set.
 * Writes compose under `<stateDir>/ingress/services/<serviceId>/`.
 */
export async function ensureServiceIngress(
  layout: LayoutPaths,
  serviceId: string,
  entries: readonly TcpUdpIngressEntry[],
  identity: ServiceIngressIdentity,
  ingressNetwork: string,
  deps?: EnsureServiceIngressDeps,
): Promise<void> {
  if (identity.serviceId !== serviceId) {
    throw new Error("ingress identity serviceId mismatch");
  }
  const run = deps?.runDocker ?? defaultRunDocker;
  await ensureIngressNetwork(ingressNetwork, run);
  await removeStaleNetworkContainers(
    serviceIngressProject(serviceId),
    ingressNetwork,
    run,
  );

  const ingressDir = serviceIngressDir(layout, serviceId);
  await Deno.mkdir(ingressDir, { recursive: true, mode: 0o750 });
  const composePath = serviceIngressComposePath(layout, serviceId);
  const gateEnabled = deps?.ingressDockerGate ??
    (() => ingressDockerGateEnabled());
  const docker: TraefikDockerSource = (await gateEnabled())
    ? "gate"
    : "socket-proxy";
  if (docker === "socket-proxy") {
    await ensureSharedSocketProxy(layout, ingressNetwork, run);
  }
  const project = serviceIngressProject(serviceId);
  await applyCompose(
    composePath,
    serviceTraefikCompose(entries, identity, ingressNetwork, docker),
    (file) =>
      run([
        "compose",
        "-p",
        project,
        "-f",
        file,
        "up",
        "-d",
        "--remove-orphans",
      ]),
    "Starting service Traefik ingress",
  );
}

/** Optional test seams for {@link removeServiceIngress}. */
export type RemoveServiceIngressDeps = {
  runDocker?: RunDockerFn;
};

/**
 * Best-effort `docker compose down` for this service's Traefik project, then
 * remove the per-service ingress compose directory.
 */
export async function removeServiceIngress(
  layout: LayoutPaths,
  serviceId: string,
  deps?: RemoveServiceIngressDeps,
): Promise<void> {
  if (!SAFE_FILE_ID_RE.test(serviceId)) {
    throw new Error("serviceId contains unsupported characters");
  }
  const run = deps?.runDocker ?? defaultRunDocker;
  const project = serviceIngressProject(serviceId);
  const composePath = serviceIngressComposePath(layout, serviceId);
  const ingressDir = serviceIngressDir(layout, serviceId);
  const args = ["compose", "-p", project, "down", "--remove-orphans"];
  try {
    await Deno.stat(composePath);
    args.splice(3, 0, "-f", composePath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const down = await run(args);
  if (!down.success) {
    logWarn(
      "deploy",
      `service ingress down soft-failed project=${project}: ${
        down.stderr || "compose down failed"
      }`,
    );
  }

  try {
    await Deno.remove(ingressDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn(
        "deploy",
        `service ingress dir remove soft-failed project=${project}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Strict allowlist for Caddy `bind` interpolation — IPv4/IPv6 literals only. */
export function assertValidBindAddress(value: string): void {
  if (!isValidIpv4Literal(value) && !isValidIpv6Literal(value)) {
    throw new Error(`bindAddress contains unsupported characters: ${value}`);
  }
}

function formatBindDirective(bindAddress: string): string {
  assertValidBindAddress(bindAddress);
  // Bracket IPv6 so Caddyfile does not treat `:` as a port separator.
  const rendered = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
  return `  bind ${rendered}\n`;
}

export type CaddyUpstream =
  | { kind: "traefik" }
  | { kind: "http"; host: string; port: number };

const DEFAULT_TRAEFIK_UPSTREAM: CaddyUpstream = { kind: "traefik" };

/** One path-routed upstream on a shared hostname (hosting Caddy). */
export type CaddySiteRoute = {
  pathPrefix?: string;
  upstream: CaddyUpstream;
  stripPrefix?: string;
};

type HostnameSite = {
  forceHttps: boolean;
  bindAddress?: string;
  routes: CaddySiteRoute[];
  tlsMode?: EnvironmentDeployHosting["tlsMode"];
  /** Set on a `www` redirect name: send every request to `<redirectTo>`. */
  redirectTo?: string;
};

function hostingTlsDirective(
  tlsMode: EnvironmentDeployHosting["tlsMode"],
  tlsId: string | undefined,
  tlsDir: string,
): string {
  if (tlsMode === "acme") return "";
  if (tlsId) {
    const id = safeConfigToken("hostings[].tlsId", tlsId);
    return `  tls ${join(tlsDir, id, "fullchain.pem")} ${
      join(tlsDir, id, "privkey.pem")
    }`;
  }
  return "  tls internal";
}

/**
 * ACME needs a bare-host HTTPS site so Caddy can issue and terminate TLS.
 * `forceHttps: false` is incompatible with `tlsMode: 'acme'` — emit HTTPS
 * anyway (a sibling HTTP-only route on the same hostname cannot drop it).
 */
function emitHttpsSite(
  forceHttps: boolean,
  tlsMode: EnvironmentDeployHosting["tlsMode"],
): boolean {
  return forceHttps || tlsMode === "acme";
}

export function assertSafeHostingPathPrefix(pathPrefix: string): void {
  safeUrlPath("hostings[].pathPrefix", pathPrefix);
}

export function formatCaddyPathMatcher(pathPrefix: string): string {
  assertSafeHostingPathPrefix(pathPrefix);
  const trimmed = pathPrefix.endsWith("/")
    ? pathPrefix.slice(0, -1)
    : pathPrefix;
  if (trimmed.length === 0 || trimmed === "/") {
    return "/*";
  }
  return `${trimmed}/*`;
}

/** Longest prefix first; catch-all routes last. */
export function sortCaddySiteRoutes(
  routes: readonly CaddySiteRoute[],
): CaddySiteRoute[] {
  return [...routes].sort((a, b) => {
    const aCatch = !a.pathPrefix;
    const bCatch = !b.pathPrefix;
    if (aCatch !== bCatch) return aCatch ? 1 : -1;
    const aLen = a.pathPrefix?.length ?? 0;
    const bLen = b.pathPrefix?.length ?? 0;
    if (aLen !== bLen) return bLen - aLen;
    return (a.pathPrefix ?? "").localeCompare(b.pathPrefix ?? "");
  });
}

function formatRouteHandleBlock(
  route: CaddySiteRoute,
  upstreamLine: string,
): string {
  if (!route.pathPrefix) {
    return `  handle {\n    ${upstreamLine}\n  }\n`;
  }
  const match = formatCaddyPathMatcher(route.pathPrefix);
  const raw = route.stripPrefix?.trim();
  if (raw && raw.length > 0) {
    const strip = safeUrlPath("hostings[].proxy.stripPrefix", raw);
    return `  handle ${match} {\n    uri strip_prefix ${strip}\n    ${upstreamLine}\n  }\n`;
  }
  return `  handle ${match} {\n    ${upstreamLine}\n  }\n`;
}

function formatRouteHandlers(
  routes: readonly CaddySiteRoute[],
  hop: "http" | "https",
): string {
  const sorted = sortCaddySiteRoutes(routes);
  let blocks = "";
  for (const route of sorted) {
    const { http, https } = resolveUpstreamBlocks(route.upstream);
    const upstreamLine = hop === "https" ? https : http;
    blocks += formatRouteHandleBlock(route, upstreamLine);
  }
  return blocks;
}

function usesMultiRouteRouting(routes: readonly CaddySiteRoute[]): boolean {
  return routes.length > 1 || routes.some((route) => route.pathPrefix);
}

export function caddyHttpUpstream(host: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`upstream port is invalid: ${port}`);
  }
  // Loopback-only hosts for site; reject other hosts to keep
  // Caddyfile interpolation safe.
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`upstream host is not allowed: ${host}`);
  }
  const renderedHost = host.includes(":") ? `[${host}]` : host;
  return `reverse_proxy ${renderedHost}:${port}`;
}

function resolveUpstreamBlocks(
  upstream: CaddyUpstream = DEFAULT_TRAEFIK_UPSTREAM,
): {
  http: string;
  https: string;
} {
  if (upstream.kind === "http") {
    const line = caddyHttpUpstream(upstream.host, upstream.port);
    return { http: line, https: line };
  }
  return {
    http: caddyTraefikUpstream("http"),
    https: caddyTraefikUpstream("https"),
  };
}

/** Inputs for a hosting-Caddy per-hostname site block. */
export type SiteSnippetOptions = Readonly<{
  hostname: string;
  tlsDir: string;
  tlsId?: string;
  forceHttps?: boolean;
  bindAddress?: string;
  upstream?: CaddyUpstream;
  routes?: readonly CaddySiteRoute[];
  tlsMode?: EnvironmentDeployHosting["tlsMode"];
  /**
   * Serve this name as a permanent redirect to `<redirectTo>` (path and query
   * kept) instead of proxying. With `forceHttps` (the default) both plain HTTP
   * and HTTPS land on `https://<redirectTo>` in one hop; without it both land
   * on `http://<redirectTo>`, the only site the target then has.
   */
  redirectTo?: string;
}>;

/** A name that only redirects, under its own certificate on the HTTPS side. */
function redirectSiteSnippet(options: SiteSnippetOptions): string {
  const { hostname, tlsDir, tlsId, bindAddress, tlsMode } = options;
  const target = safeConfigToken("hostings[].www", options.redirectTo!);
  const tlsDirective = hostingTlsDirective(tlsMode, tlsId, tlsDir);
  const tlsLine = tlsDirective ? `${tlsDirective}\n` : "";
  const bindLine = bindAddress ? formatBindDirective(bindAddress) : "";
  // Both schemes land on the scheme the target actually serves: HTTPS in one
  // hop normally, plain HTTP when the target has forced HTTPS off (it then has
  // no HTTPS site to land on).
  const scheme = emitHttpsSite(options.forceHttps ?? true, tlsMode)
    ? "https"
    : "http";
  const redirect = `  redir ${scheme}://${target}{uri} permanent\n`;
  return `http://${hostname} {
${bindLine}${redirect}}

${hostname} {
${bindLine}${tlsLine}${redirect}}
`;
}

export function siteSnippet(options: SiteSnippetOptions): string {
  if (options.redirectTo !== undefined) return redirectSiteSnippet(options);
  const {
    hostname,
    tlsDir,
    tlsId,
    forceHttps = true,
    bindAddress,
    upstream = DEFAULT_TRAEFIK_UPSTREAM,
    routes,
    tlsMode,
  } = options;
  const effectiveRoutes: CaddySiteRoute[] = routes?.length
    ? [...routes]
    : [{ upstream }];

  if (!usesMultiRouteRouting(effectiveRoutes)) {
    const single = effectiveRoutes[0]?.upstream ?? upstream;
    const { http: httpUpstream, https: httpsUpstream } = resolveUpstreamBlocks(
      single,
    );
    const tlsLine = hostingTlsDirective(tlsMode, tlsId, tlsDir);
    const bindLine = bindAddress ? formatBindDirective(bindAddress) : "";
    const https = emitHttpsSite(forceHttps, tlsMode);

    const httpBlock = https
      ? `http://${hostname} {
${bindLine}  redir https://{host}{uri} permanent
}

`
      : `http://${hostname} {
${bindLine}  ${httpUpstream}
}

`;

    const httpsBlock = https
      ? `${hostname} {
${bindLine}${tlsLine}
  ${httpsUpstream}
}
`
      : "";

    return httpBlock + httpsBlock;
  }

  const tlsLine = hostingTlsDirective(tlsMode, tlsId, tlsDir);
  const bindLine = bindAddress ? formatBindDirective(bindAddress) : "";
  const httpsHandlers = formatRouteHandlers(effectiveRoutes, "https");
  const httpHandlers = formatRouteHandlers(effectiveRoutes, "http");
  const https = emitHttpsSite(forceHttps, tlsMode);

  const httpBlock = https
    ? `http://${hostname} {
${bindLine}  redir https://{host}{uri} permanent
}

`
    : `http://${hostname} {
${bindLine}${httpHandlers}
}

`;

  const httpsBlock = https
    ? `${hostname} {
${bindLine}${tlsLine}
${httpsHandlers}
}
`
    : "";

  return httpBlock + httpsBlock;
}

/**
 * Where a hostname's traffic goes.
 *
 * A loopback upstream covers **both** host-native lanes: a site
 * vhost and a native `node` app are indistinguishable from Caddy's side — each
 * is a process listening on 127.0.0.1 on a port the control plane allocated out
 * of one shared ledger. Everything else goes to Traefik, which fronts the
 * Docker containers.
 */
function resolveHostingUpstream(
  hosting: EnvironmentDeployHosting,
  loopbackByService: Map<string, { listenPort: number }>,
): CaddyUpstream {
  const loopback = loopbackByService.get(hosting.composeServiceName);
  if (loopback) {
    return { kind: "http", host: "127.0.0.1", port: loopback.listenPort };
  }
  return DEFAULT_TRAEFIK_UPSTREAM;
}

function normalizePathPrefixFromHosting(
  pathPrefix: string | undefined,
): string | undefined {
  if (pathPrefix === undefined) return undefined;
  const trimmed = pathPrefix.trim();
  if (trimmed.length === 0 || trimmed === "/") return undefined;
  return trimmed;
}

function buildCaddySiteRoute(
  hosting: EnvironmentDeployHosting,
  loopbackByService: Map<string, { listenPort: number }>,
): CaddySiteRoute {
  const upstream = resolveHostingUpstream(hosting, loopbackByService);
  const pathPrefix = normalizePathPrefixFromHosting(hosting.pathPrefix);
  const stripPrefix = hosting.proxy?.stripPrefix;
  return {
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
    upstream,
    ...(stripPrefix ? { stripPrefix } : {}),
  };
}

function getOrCreateHostnameSite(
  byHostname: Map<string, HostnameSite>,
  hostname: string,
): HostnameSite {
  let site = byHostname.get(hostname);
  if (!site) {
    site = { forceHttps: true, routes: [] };
    byHostname.set(hostname, site);
  }
  return site;
}

function mergeHostingIntoHostnameSite(
  site: HostnameSite,
  hosting: EnvironmentDeployHosting,
  route: CaddySiteRoute,
): void {
  if (hosting.tlsMode === "acme") {
    site.tlsMode = "acme";
  }
  // ACME on this hostname always keeps HTTPS — a sibling `forceHttps: false`
  // must not AND the site down to HTTP-only and block issuance.
  site.forceHttps = site.tlsMode === "acme" ||
    (site.forceHttps && (hosting.proxy?.forceHttps ?? true));
  if (hosting.bindAddress) {
    assertValidBindAddress(hosting.bindAddress);
    site.bindAddress = hosting.bindAddress;
  }
  site.routes.push(route);
}

export function buildCaddyHostnameRoutes(
  payload: EnvironmentDeployPayload,
): Map<string, HostnameSite> {
  const loopbackByService = new Map<string, { listenPort: number }>([
    ...(payload.sites ?? []).map((
      site,
    ) => [site.composeServiceName, site] as const),
    ...(payload.nativeAppServices ?? []).map((
      app,
    ) => [app.composeServiceName, app] as const),
  ]);

  const byHostname = new Map<string, HostnameSite>();

  for (const hosting of payload.hostings) {
    if ((hosting.protocol ?? "http") !== "http") continue;
    if (hosting.hostnames.length === 0) continue;

    const route = buildCaddySiteRoute(hosting, loopbackByService);
    for (const hostname of hostingServedNames(hosting)) {
      const site = getOrCreateHostnameSite(byHostname, hostname);
      mergeHostingIntoHostnameSite(site, hosting, route);
    }
  }

  addWwwRedirectSites(byHostname, payload.hostings);
  return byHostname;
}

/**
 * The redirect-only names from `www` modes: one redirect site per name, under
 * the same TLS mode and bind address as the hosting. A name some hosting
 * already serves is left alone (the control plane refuses that deploy; this
 * keeps a stray payload from replacing a real site).
 */
function addWwwRedirectSites(
  byHostname: Map<string, HostnameSite>,
  hostings: readonly EnvironmentDeployHosting[],
): void {
  for (const hosting of hostings) {
    if ((hosting.protocol ?? "http") !== "http") continue;
    for (const { from, to } of hostingWwwRedirects(hosting)) {
      if (byHostname.has(from)) continue;
      byHostname.set(from, redirectSiteFor(hosting, to, byHostname.get(to)));
    }
  }
}

/**
 * The redirect-only site for one name: the hosting's TLS mode and bind
 * address, and the HTTPS setting the target site actually serves (every path
 * of it), so the redirect never lands on a scheme the target lacks.
 */
function redirectSiteFor(
  hosting: EnvironmentDeployHosting,
  to: string,
  target: HostnameSite | undefined,
): HostnameSite {
  const acme = hosting.tlsMode === "acme";
  const forceHttps = target
    ? emitHttpsSite(target.forceHttps, target.tlsMode)
    : acme || (hosting.proxy?.forceHttps ?? true);
  return {
    forceHttps,
    routes: [],
    redirectTo: to,
    ...(acme ? { tlsMode: "acme" as const } : {}),
    ...(hosting.bindAddress ? { bindAddress: hosting.bindAddress } : {}),
  };
}

/** Companion manifest naming which of an environment's hostnames run tlsMode: 'acme'. */
function acmeHostnamesManifestPath(
  layout: LayoutPaths,
  environmentId: string,
): string {
  return join(
    layout.configDir,
    "hosting",
    "sites",
    `${environmentId}.acme-hostnames.json`,
  );
}

/**
 * Every currently-deployed `tlsMode: 'acme'` hostname, across all
 * environments — unions each environment's own manifest (written/removed in
 * lockstep with its `.caddy` site file by {@link rewriteHostingCaddySites} /
 * {@link removeHostingCaddySite}, so a stale environment never leaves a
 * phantom entry here). Used by {@link AcmeIssuanceObserver} to know what to
 * poll without re-parsing Caddyfile syntax.
 */
export async function readAcmeModeHostnames(
  layout: LayoutPaths,
): Promise<string[]> {
  const sitesDir = join(layout.configDir, "hosting", "sites");
  const hostnames = new Set<string>();
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(sitesDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  try {
    for await (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(".acme-hostnames.json")) {
        continue;
      }
      for (const hostname of await readAcmeHostnamesManifest(sitesDir, entry)) {
        hostnames.add(hostname);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return [...hostnames].sort((a, b) => a.localeCompare(b));
}

/**
 * One environment's `.acme-hostnames.json`: the string entries of its array.
 * Unreadable or malformed is logged and skipped — one stale manifest must not
 * hide every other environment's hostnames from the observer.
 */
async function readAcmeHostnamesManifest(
  sitesDir: string,
  entry: Deno.DirEntry,
): Promise<string[]> {
  try {
    const raw = await Deno.readTextFile(join(sitesDir, entry.name));
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch (err) {
    logWarn(
      "deploy",
      `acme-hostnames manifest unreadable, skipping: ${entry.name}: ${
        errorText(err)
      }`,
    );
    return [];
  }
}

/**
 * One hosting-site change at a time. The candidate set is staged at fixed paths
 * (sudoers pins one argv), and commands run concurrently, so two environments
 * deploying together would validate each other's half-built set.
 */
let hostingSitesTail: Promise<unknown> = Promise.resolve();

function withHostingSitesLock<T>(work: () => Promise<T>): Promise<T> {
  const result = hostingSitesTail.then(work, work);
  hostingSitesTail = result.catch(() => {});
  return result;
}

const HOSTING_CANDIDATE_SITES_DIR = "sites.next";
const HOSTING_CANDIDATE_CADDYFILE = "Caddyfile.next";

/** `/var/lib/turbopanel-hosting-caddy`: the unit's `StateDirectory=`. */
function hostingCaddyStateRoot(layout: LayoutPaths): string {
  return join(dirname(layout.stateDir), HOSTING_CADDY_STATE_DIRECTORY);
}

/**
 * The validating account keeps its throwaway certificate authority under the
 * unit's state folder, which systemd creates when the unit starts. A host whose
 * unit has never started gets it started once (the deploy path normally did
 * that already), so the folder exists before Caddy is asked to use it.
 */
async function ensureValidationStorage(layout: LayoutPaths): Promise<string> {
  const state = hostingCaddyStateRoot(layout);
  const exists = await Deno.stat(state).then(() => true, (err) => {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn(
        "deploy",
        `hosting Caddy state folder not checked: ${errorText(err)}`,
      );
      return true;
    }
    return false;
  });
  if (!exists) {
    const start = await run(
      "sudo",
      hostSudoArgs(["-n", "systemctl", "start", CADDY_SERVICE]),
    );
    if (!start.success) {
      logWarn("deploy", `hosting Caddy start skipped: ${start.stderr}`);
    }
  }
  return join(state, "validate");
}

/** The staged copy of the site set, outside the live include glob. */
type HostingCandidate = Readonly<{
  sitesDir: string;
  caddyfile: string;
  validateStorage: string;
}>;

async function openHostingCandidate(
  layout: LayoutPaths,
  hostingDir: string,
): Promise<HostingCandidate> {
  const candidate = {
    sitesDir: join(hostingDir, HOSTING_CANDIDATE_SITES_DIR),
    caddyfile: join(hostingDir, HOSTING_CANDIDATE_CADDYFILE),
    validateStorage: await ensureValidationStorage(layout),
  };
  await Deno.remove(candidate.sitesDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(candidate.sitesDir, { mode: 0o750 });
  // A glob that matches nothing is an error in Caddy; the staged set may be empty.
  await Deno.writeTextFile(
    join(candidate.sitesDir, "00-candidate.caddy"),
    "# staged candidate\n",
    { mode: 0o640 },
  );
  await Deno.writeTextFile(
    candidate.caddyfile,
    caddyfile(layout.configDir, {
      sitesDir: candidate.sitesDir,
      storageDir: candidate.validateStorage,
    }),
    { mode: 0o640 },
  );
  return candidate;
}

async function closeHostingCandidate(
  candidate: HostingCandidate,
): Promise<void> {
  await Deno.remove(candidate.sitesDir, { recursive: true }).catch(() => {});
  await Deno.remove(candidate.caddyfile).catch(() => {});
}

/** Caddy's complaint about the staged set, or `null` when it loads. */
async function hostingCandidateRefusal(
  layout: LayoutPaths,
  candidate: HostingCandidate,
): Promise<string | null> {
  const test = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "-u",
      HOSTING_CADDY_USER,
      "--",
      join(layout.runtimesDir, "caddy", "current", "caddy"),
      "validate",
      "--adapter",
      "caddyfile",
      "--config",
      candidate.caddyfile,
    ]),
  );
  if (test.success) return null;
  // sudo itself refusing is a host that was not finished updating, not a bad
  // snippet: say so, and never let it read as "every snippet is bad".
  if (
    /password is required|not allowed to execute|may not run sudo/i.test(
      test.stderr,
    )
  ) {
    throw new Error(
      "the hosting Caddy check is not allowed on this host: the sudoers entry that lets the daemon run it is missing, so the host update did not finish. Finish the update on this host, then deploy again.",
    );
  }
  return test.stderr || "caddy validate failed";
}

/**
 * The site addresses one snippet answers on: every top-level `name {` /
 * `http://name {` line the daemon itself wrote (`siteSnippet`).
 */
export function snippetSiteAddresses(contents: string): string[] {
  const names: string[] = [];
  for (const line of contents.split("\n")) {
    if (line.length === 0 || line.startsWith(" ") || !line.endsWith(" {")) {
      continue;
    }
    const address = line.slice(0, -2).trim();
    names.push(
      address.startsWith("http://") ? address.slice("http://".length) : address,
    );
  }
  return names;
}

/**
 * Before any container starts: refuse a deploy that would answer on a name
 * another environment's live site already answers on on this server. A www
 * choice adds names the panel's uniqueness check may not have seen, and the
 * shared Traefik would otherwise route that name to this environment's
 * containers even though Caddy later refuses the duplicate site.
 */
export async function assertHostingNamesFree(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
): Promise<void> {
  const wanted = new Set(
    payload.hostings
      .filter((hosting) => (hosting.protocol ?? "http") === "http")
      .flatMap((hosting) => [
        ...hostingServedNames(hosting),
        ...hostingWwwRedirects(hosting).map((redirect) => redirect.from),
      ]),
  );
  if (wanted.size === 0) return;
  const sitesDir = join(layout.configDir, "hosting", "sites");
  let names: string[];
  try {
    names = await liveSnippetNames(sitesDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  const own = `${payload.environmentId}.caddy`;
  const others = names.filter((name) =>
    name !== own && !isDaemonReservedHostingSite(name)
  );
  const contents = await Promise.all(
    others.map((name) => Deno.readTextFile(join(sitesDir, name))),
  );
  const taken = contents.flatMap(snippetSiteAddresses).find((name) =>
    wanted.has(name)
  );
  if (taken !== undefined) {
    throw new Error(
      `${taken} is already served by another environment on this server; remove it there (or change this hosting's www choice) before deploying`,
    );
  }
}

async function liveSnippetNames(sitesDir: string): Promise<string[]> {
  const entries: Array<{ name: string; modified: number }> = [];
  for await (const entry of Deno.readDir(sitesDir)) {
    if (entry.isFile && entry.name.endsWith(".caddy")) {
      const info = await Deno.stat(join(sitesDir, entry.name));
      entries.push({ name: entry.name, modified: info.mtime?.getTime() ?? 0 });
    }
  }
  // The daemon's own reserved sites first (they are kept in preference), then
  // oldest first: of two files serving one hostname the newer is set aside.
  const ordered = entries.toSorted((a, b) =>
    Number(isDaemonReservedHostingSite(b.name)) -
      Number(isDaemonReservedHostingSite(a.name)) ||
    a.modified - b.modified || a.name.localeCompare(b.name)
  );
  return ordered.map((entry) => entry.name);
}

/**
 * The snippets already on disk that Caddy will not load, found by adding them
 * to an empty set one at a time (the reserved sites first, then by name). One
 * that refuses to join a set the earlier ones load fine is the one to set
 * aside; a hostname served by two environments leaves the later file out.
 */
async function findUnloadableSnippets(
  layout: LayoutPaths,
  candidate: HostingCandidate,
  sitesDir: string,
  names: readonly string[],
): Promise<Array<{ name: string; reason: string }>> {
  // An empty set must load. When it does not, the validator itself is not
  // working (no sudoers entry, no binary, an unreadable candidate) and nothing
  // says anything about the snippets: set none aside.
  const empty = await hostingCandidateRefusal(layout, candidate);
  if (empty !== null) {
    throw new Error(
      `the hosting Caddy validation is not working on this host, so no snippet was judged or set aside: ${empty}`,
    );
  }
  const bad: Array<{ name: string; reason: string }> = [];
  await forEachSequential(names, async (name) => {
    const staged = join(candidate.sitesDir, name);
    await Deno.copyFile(join(sitesDir, name), staged);
    const refusal = await hostingCandidateRefusal(layout, candidate);
    if (refusal !== null) {
      await Deno.remove(staged);
      bad.push({ name, reason: refusal });
    }
  });
  return bad;
}

/**
 * Move snippets the hosting Caddy cannot load out of the live glob, so one
 * environment's stale file never fails every other environment's deploy or
 * crash-loops the unit at its next start. The file is kept beside its old
 * name as `<name>.quarantined`, which no `*.caddy` glob matches.
 */
async function quarantineHostingSnippets(
  sitesDir: string,
  bad: ReadonlyArray<{ name: string; reason: string }>,
): Promise<void> {
  await forEachSequential(bad, async ({ name, reason }) => {
    await Deno.rename(
      join(sitesDir, name),
      join(sitesDir, `${name}.quarantined`),
    );
    logWarn(
      "deploy",
      `hosting Caddy cannot load ${name}; set aside as ${name}.quarantined: ${reason}`,
    );
  });
}

/**
 * Stage the whole site set with this environment's new snippet in place of its
 * old one, outside the live include glob, and let the web server's own account
 * validate it with the pinned `caddy validate` (sudoers allows exactly this
 * argv). A snippet the hosting Caddy cannot load (a hostname another
 * environment already serves, a malformed line, a certificate it cannot read)
 * is refused here, before it can sit in the glob where the next restart or boot
 * would crash-loop ingress for every site on the host.
 *
 * When the set is refused only because of a stale snippet already on disk (the
 * other environments' files fail on their own, without the new one), that file
 * is set aside and the new snippet is judged again.
 */
async function validateHostingCaddyCandidate(
  layout: LayoutPaths,
  hostingDir: string,
  sitesDir: string,
  siteFile: string,
  contents: string,
  grantRead: (hostingDir: string) => Promise<void>,
): Promise<void> {
  const candidate = await openHostingCandidate(layout, hostingDir);
  try {
    const others = (await liveSnippetNames(sitesDir)).filter((name) =>
      name !== siteFile
    );
    await Promise.all(
      others.map((name) =>
        Deno.copyFile(join(sitesDir, name), join(candidate.sitesDir, name))
      ),
    );
    await Deno.writeTextFile(join(candidate.sitesDir, siteFile), contents, {
      mode: 0o640,
    });
    // After staging, so the account can read everything staged (the grant also
    // sets the folder defaults the live snippets inherit).
    await grantRead(hostingDir);
    let refusal = await hostingCandidateRefusal(layout, candidate);
    if (refusal === null) return;

    // Is it the new snippet, or one already on disk?
    await Deno.remove(join(candidate.sitesDir, siteFile));
    if (await hostingCandidateRefusal(layout, candidate) === null) {
      throw new Error(
        `hosting Caddy refused the site config for ${siteFile}: ${refusal}`,
      );
    }
    await Promise.all(
      others.map((name) =>
        Deno.remove(join(candidate.sitesDir, name)).catch(() => {})
      ),
    );
    const bad = await findUnloadableSnippets(
      layout,
      candidate,
      sitesDir,
      others,
    );
    await quarantineHostingSnippets(sitesDir, bad);
    await Deno.writeTextFile(join(candidate.sitesDir, siteFile), contents, {
      mode: 0o640,
    });
    refusal = await hostingCandidateRefusal(layout, candidate);
    if (refusal !== null) {
      throw new Error(
        `hosting Caddy refused the site config for ${siteFile}: ${refusal}`,
      );
    }
  } finally {
    await closeHostingCandidate(candidate);
  }
}

/**
 * At daemon start: set aside any snippet already on disk that the hosting
 * Caddy cannot load, so a stale one does not keep the unit from starting. A
 * unit already running keeps its loaded config; it picks up the change on the
 * reload sent here.
 */
export function guardHostingCaddySites(
  layout: LayoutPaths,
  grantRead: (hostingDir: string) => Promise<void> = grantHostingCaddyRead,
): Promise<string[]> {
  return withHostingSitesLock(() =>
    guardHostingCaddySitesLocked(layout, grantRead)
  );
}

async function guardHostingCaddySitesLocked(
  layout: LayoutPaths,
  grantRead: (hostingDir: string) => Promise<void>,
): Promise<string[]> {
  const hostingDir = join(layout.configDir, "hosting");
  const sitesDir = join(hostingDir, "sites");
  let names: string[];
  try {
    names = await liveSnippetNames(sitesDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  if (names.length === 0) return [];
  const candidate = await openHostingCandidate(layout, hostingDir);
  try {
    await Promise.all(
      names.map((name) =>
        Deno.copyFile(join(sitesDir, name), join(candidate.sitesDir, name))
      ),
    );
    await grantRead(hostingDir);
    if (await hostingCandidateRefusal(layout, candidate) === null) return [];
    await Promise.all(
      names.map((name) =>
        Deno.remove(join(candidate.sitesDir, name)).catch(() => {})
      ),
    );
    const bad = await findUnloadableSnippets(
      layout,
      candidate,
      sitesDir,
      names,
    );
    await quarantineHostingSnippets(sitesDir, bad);
    if (bad.length > 0) {
      const reload = await run(
        "sudo",
        hostSudoArgs(["-n", "systemctl", "reload", CADDY_SERVICE]),
      );
      if (!reload.success) {
        logWarn("deploy", `hosting Caddy reload skipped: ${reload.stderr}`);
      }
    }
    return bad.map((b) => b.name);
  } finally {
    await closeHostingCandidate(candidate);
  }
}

/** Put the previous snippet back after a failed reload. */
async function restorePreviousHostingSite(
  live: string,
  previous: string,
): Promise<void> {
  await Deno.rename(previous, live);
}

/** Drop a brand-new snippet after a failed reload. */
async function dropNewHostingSite(live: string): Promise<void> {
  await Deno.remove(live).catch(() => {});
}

/**
 * Swap the validated snippet in (`.tpnew` is outside the `*.caddy` glob, and
 * the rename is atomic), reload, and put the old one back when a running Caddy
 * refuses the reload. A unit that is not running keeps the validated file: it
 * loads it on its next start.
 */
async function activateHostingSite(
  live: string,
  contents: string,
): Promise<void> {
  const next = `${live}.tpnew`;
  const previous = `${live}.tpprev`;
  await Deno.writeTextFile(next, contents, { mode: 0o640 });
  const hadPrevious = await Deno.copyFile(live, previous).then(
    () => true,
    (err) => {
      if (err instanceof Deno.errors.NotFound) return false;
      throw err;
    },
  );
  await Deno.rename(next, live);
  // A new snippet supersedes one set aside earlier for this environment.
  await Deno.remove(`${live}.quarantined`).catch(() => {});

  const reloadArgs = hostSudoArgs(["-n", "systemctl", "reload", CADDY_SERVICE]);
  const reload = await run("sudo", reloadArgs);
  if (reload.success) {
    await Deno.remove(previous).catch(() => {});
    return;
  }
  const active = await run(
    "sudo",
    hostSudoArgs(["-n", "systemctl", "is-active", "--quiet", CADDY_SERVICE]),
  );
  if (!active.success) {
    logWarn("deploy", `hosting Caddy reload skipped: ${reload.stderr}`);
    await Deno.remove(previous).catch(() => {});
    return;
  }
  await (hadPrevious
    ? restorePreviousHostingSite(live, previous)
    : dropNewHostingSite(live));
  const again = await run("sudo", reloadArgs);
  if (!again.success) {
    logWarn(
      "deploy",
      `hosting Caddy reload after restoring ${live} failed: ${again.stderr}`,
    );
  }
  throw new Error(
    `hosting Caddy did not reload the new site config: ${
      reload.stderr || "reload failed"
    }`,
  );
}

/**
 * Write one environment's hosting snippet. The new snippet is validated as part
 * of the whole set before it touches the live include glob; when a running
 * Caddy then refuses the reload the previous snippet is restored and the deploy
 * fails, so the host never keeps a config its next start cannot load.
 */
/** Optional test seams for {@link rewriteHostingCaddySites}. */
export type RewriteHostingCaddySitesDeps = {
  ensureHostingCaddyRuntime?: (layout: LayoutPaths) => Promise<void>;
};

export function rewriteHostingCaddySites(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  hostnameTls?: Map<string, string>,
  grantRead: (hostingDir: string) => Promise<void> = grantHostingCaddyRead,
  deps?: RewriteHostingCaddySitesDeps,
): Promise<void> {
  if (!SAFE_FILE_ID_RE.test(payload.environmentId)) {
    return Promise.reject(
      new Error("environmentId contains unsupported characters"),
    );
  }
  return withHostingSitesLock(() =>
    rewriteHostingCaddySitesLocked(
      layout,
      payload,
      hostnameTls,
      grantRead,
      deps,
    )
  );
}

async function rewriteHostingCaddySitesLocked(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  hostnameTls: Map<string, string> | undefined,
  grantRead: (hostingDir: string) => Promise<void>,
  deps?: RewriteHostingCaddySitesDeps,
): Promise<void> {
  if (deps?.ensureHostingCaddyRuntime) {
    await deps.ensureHostingCaddyRuntime(layout);
  } else if (!hostCommandOverride) {
    await ensureHostingCaddyRuntime(layout);
  }

  const hostingDir = join(layout.configDir, "hosting");
  const sitesDir = join(hostingDir, "sites");
  await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });

  const hostnameSites = buildCaddyHostnameRoutes(payload);

  const hostnames = [...hostnameSites.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  const siteContent = hostnames
    .map((hostname) => {
      const site = hostnameSites.get(hostname)!;
      return siteSnippet({
        hostname,
        tlsId: hostnameTls?.get(hostname),
        tlsDir: layout.tlsDir,
        forceHttps: site.forceHttps,
        bindAddress: site.bindAddress,
        routes: site.routes,
        tlsMode: site.tlsMode,
        redirectTo: site.redirectTo,
      });
    })
    .join("\n");
  const siteFile = `${payload.environmentId}.caddy`;
  await validateHostingCaddyCandidate(
    layout,
    hostingDir,
    sitesDir,
    siteFile,
    siteContent,
    grantRead,
  );

  if (hostnames.length > 0) {
    // The instance ACME window may have just disabled hosting Caddy after
    // seeing only its own reserved site (it does not wait for deploys): a
    // tenant site must end with Caddy running and enabled at boot, not rely
    // on a reload of a stopped unit.
    const enable = await run(
      "sudo",
      hostSudoArgs(["-n", "systemctl", "enable", "--now", CADDY_SERVICE]),
    );
    if (!enable.success) {
      logWarn("deploy", `hosting Caddy enable skipped: ${enable.stderr}`);
    }
  }

  await activateHostingSite(join(sitesDir, siteFile), siteContent);

  // Rewritten unconditionally, same lifecycle as the .caddy file above, so an
  // environment that moves off acme-mode entirely never leaves a stale entry
  // for readAcmeModeHostnames() to keep polling. Only after the snippet is
  // live: a refused deploy must not change what the observer polls.
  const acmeHostnames = hostnames.filter((hostname) =>
    hostnameSites.get(hostname)!.tlsMode === "acme"
  );
  await Deno.writeTextFile(
    acmeHostnamesManifestPath(layout, payload.environmentId),
    JSON.stringify(acmeHostnames),
    { mode: 0o640 },
  );
}

/** Remove the per-environment hosting site snippet and best-effort reload Caddy. */
export function removeHostingCaddySite(
  layout: LayoutPaths,
  environmentId: string,
): Promise<void> {
  if (!SAFE_FILE_ID_RE.test(environmentId)) {
    return Promise.reject(
      new Error("environmentId contains unsupported characters"),
    );
  }
  return withHostingSitesLock(() =>
    removeHostingCaddySiteLocked(layout, environmentId)
  );
}

async function removeHostingCaddySiteLocked(
  layout: LayoutPaths,
  environmentId: string,
): Promise<void> {
  const siteName = `${environmentId}.caddy`;
  if (isDaemonReservedHostingSite(siteName)) return;

  const sitePath = join(
    layout.configDir,
    "hosting",
    "sites",
    siteName,
  );
  try {
    await Deno.remove(sitePath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  await Deno.remove(`${sitePath}.quarantined`).catch(() => {});

  try {
    await Deno.remove(acmeHostnamesManifestPath(layout, environmentId));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  const reload = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "systemctl",
      "reload",
      CADDY_SERVICE,
    ]),
  );
  if (!reload.success) {
    logWarn("deploy", `hosting Caddy reload skipped: ${reload.stderr}`);
  }
}

/** Extract one `TcpUdpIngressEntry` per port mapping for `tcp`/`udp` protocol hostings. */
export function buildTcpUdpIngressEntries(
  hostings: readonly EnvironmentDeployHosting[],
): TcpUdpIngressEntry[] {
  const entries: TcpUdpIngressEntry[] = [];
  for (const hosting of hostings) {
    if (hosting.protocol !== "tcp" && hosting.protocol !== "udp") continue;
    for (const port of hosting.ports ?? []) {
      entries.push({
        hostingId: hosting.hostingId,
        protocol: hosting.protocol,
        publishedPort: port.published,
        ...(hosting.bindAddress ? { bindAddress: hosting.bindAddress } : {}),
      });
    }
  }
  return entries;
}

function tcpUdpStateDir(layout: LayoutPaths): string {
  return join(layout.stateDir, "ingress", "tcp-udp");
}

function tcpUdpStateFile(layout: LayoutPaths, serviceId: string): string {
  if (!SAFE_FILE_ID_RE.test(serviceId)) {
    throw new Error("serviceId contains unsupported characters");
  }
  return join(tcpUdpStateDir(layout), `${serviceId}.json`);
}

function isValidPortNumberLike(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

/** Shape-validate one persisted entry — mirrors {@link TcpUdpIngressEntry}. */
function isValidTcpUdpIngressEntry(
  value: unknown,
): value is TcpUdpIngressEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.hostingId !== "string" || record.hostingId.length === 0) {
    return false;
  }
  if (record.protocol !== "tcp" && record.protocol !== "udp") return false;
  if (!isValidPortNumberLike(record.publishedPort)) return false;
  if (
    record.bindAddress !== undefined && typeof record.bindAddress !== "string"
  ) {
    return false;
  }
  return true;
}

function isValidTcpUdpIngressEntryArray(
  value: unknown,
): value is TcpUdpIngressEntry[] {
  return Array.isArray(value) && value.every(isValidTcpUdpIngressEntry);
}

/**
 * Serializes every {@link syncTcpUdpIngressEntries} /
 * {@link removeTcpUdpIngressEntries} call across **every** serviceId.
 *
 * The published-port conflict check in `syncTcpUdpIngressEntries` reads
 * every *other* service's persisted file before writing its own. A lock
 * keyed by `serviceId` would not help — the race is *between two different*
 * services contending for the same port, so serialization must cover the
 * whole `ingress/tcp-udp` state directory.
 */
let tcpUdpIngressLockTail: Promise<unknown> = Promise.resolve();

function withTcpUdpIngressLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = tcpUdpIngressLockTail.then(fn, fn);
  // Chain the next caller off this call's settlement, but swallow rejection
  // here so a failed call doesn't turn every later call into a rejection too
  // (each caller already observes its own failure via the returned promise).
  tcpUdpIngressLockTail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Write `entries` to `filePath` via a temp file in the same directory,
 * validate the bytes actually landed on disk round-trip to the expected
 * shape, then atomically rename over `filePath`.
 */
async function writeTcpUdpIngressEntriesAtomic(
  dir: string,
  filePath: string,
  entries: readonly TcpUdpIngressEntry[],
): Promise<void> {
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);
  await Deno.writeTextFile(tmpPath, JSON.stringify(entries), { mode: 0o640 });
  try {
    const written = JSON.parse(await Deno.readTextFile(tmpPath));
    if (!isValidTcpUdpIngressEntryArray(written)) {
      throw new Error(
        `tcp/udp ingress entries for ${filePath} failed validation before commit`,
      );
    }
    await Deno.rename(tmpPath, filePath);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    throw err;
  }
}

/** List directory entries; missing directory → empty array. */
async function listDirEntriesOrEmpty(dir: string): Promise<Deno.DirEntry[]> {
  try {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
    return entries;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

/**
 * Committed per-service claim filenames only — skip dirs, non-`.json`, and
 * in-progress atomic writes (`.*.tmp`).
 */
function isCommittedTcpUdpClaimFile(entry: Deno.DirEntry): boolean {
  return (
    entry.isFile &&
    entry.name.endsWith(".json") &&
    !entry.name.startsWith(".")
  );
}

/**
 * Parse + shape-validate one claim file. Corrupt JSON or unexpected shapes
 * fail loudly so conflict detection never sees garbage.
 */
async function readTcpUdpIngressEntriesFile(
  dir: string,
  fileName: string,
): Promise<TcpUdpIngressEntry[]> {
  const contents = await Deno.readTextFile(join(dir, fileName));
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    throw new Error(
      `corrupt tcp/udp ingress state file ${fileName}: invalid JSON`,
      { cause: err },
    );
  }
  if (!isValidTcpUdpIngressEntryArray(parsed)) {
    throw new Error(
      `corrupt tcp/udp ingress state file ${fileName}: expected an array of tcp/udp ingress entries`,
    );
  }
  return parsed;
}

/**
 * Read every persisted per-service TCP/UDP entry list, optionally excluding one
 * service.
 *
 * Throws a clear error when a state file contains invalid JSON or an entry
 * that doesn't match {@link TcpUdpIngressEntry} — corrupt state must fail
 * loudly rather than silently feeding garbage into conflict detection.
 */
export async function collectTcpUdpIngressEntries(
  layout: LayoutPaths,
  excludeServiceId?: string,
): Promise<TcpUdpIngressEntry[]> {
  const dir = tcpUdpStateDir(layout);
  const dirEntries = await listDirEntriesOrEmpty(dir);
  const excludeFile = excludeServiceId ? `${excludeServiceId}.json` : undefined;
  // Independent read-only file reads; `Promise.all` keeps directory order.
  const perFile = await Promise.all(
    dirEntries
      .filter((entry) =>
        isCommittedTcpUdpClaimFile(entry) && entry.name !== excludeFile
      )
      .map((entry) => readTcpUdpIngressEntriesFile(dir, entry.name)),
  );
  return perFile.flat();
}

function addClaimFileServiceIds(
  entries: readonly Deno.DirEntry[],
  ids: Set<string>,
): void {
  for (const entry of entries) {
    if (!isCommittedTcpUdpClaimFile(entry)) continue;
    const serviceId = entry.name.slice(0, -".json".length);
    if (SAFE_FILE_ID_RE.test(serviceId)) ids.add(serviceId);
  }
}

function addServiceDirIds(
  entries: readonly Deno.DirEntry[],
  ids: Set<string>,
): void {
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (!SAFE_FILE_ID_RE.test(entry.name)) continue;
    ids.add(entry.name);
  }
}

/**
 * ServiceIds that currently have a claim file and/or a per-service Traefik
 * project directory on disk.
 */
export async function listPersistedTcpUdpServiceIds(
  layout: LayoutPaths,
): Promise<string[]> {
  const ids = new Set<string>();
  addClaimFileServiceIds(
    await listDirEntriesOrEmpty(tcpUdpStateDir(layout)),
    ids,
  );
  addServiceDirIds(
    await listDirEntriesOrEmpty(join(layout.stateDir, "ingress", "services")),
    ids,
  );
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function environmentIngressIndexPath(
  layout: LayoutPaths,
  environmentId: string,
): string {
  if (!SAFE_FILE_ID_RE.test(environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }
  return join(
    layout.stateDir,
    "ingress",
    "by-environment",
    `${environmentId}.json`,
  );
}

/** Previously active raw-port serviceIds for one environment (may be empty). */
export async function readEnvironmentTcpUdpServiceIds(
  layout: LayoutPaths,
  environmentId: string,
): Promise<string[]> {
  const path = environmentIngressIndexPath(layout, environmentId);
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
    if (
      !Array.isArray(parsed) ||
      !parsed.every((id) => typeof id === "string" && SAFE_FILE_ID_RE.test(id))
    ) {
      throw new Error(
        `corrupt environment tcp/udp ingress index for ${environmentId}`,
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

async function writeEnvironmentTcpUdpServiceIds(
  layout: LayoutPaths,
  environmentId: string,
  serviceIds: readonly string[],
): Promise<void> {
  const path = environmentIngressIndexPath(layout, environmentId);
  const dir = join(layout.stateDir, "ingress", "by-environment");
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  const sorted = [...serviceIds].sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    return;
  }
  await Deno.writeTextFile(path, JSON.stringify(sorted), { mode: 0o640 });
}

/**
 * Tear down every per-service Traefik project + claim file for an environment
 * stop.
 *
 * Unions the daemon-persisted environment index with `payloadServiceIds` from
 * `environment.stop` so ingress is removed even when the instance payload
 * omits `ingressServices` (hosting deleted or flipped to HTTP before stop).
 * Clears the environment index afterward.
 */
export async function removeEnvironmentTcpUdpServiceIngress(
  layout: LayoutPaths,
  environmentId: string,
  payloadServiceIds: readonly string[] = [],
  deps?: RemoveServiceIngressDeps,
): Promise<string[]> {
  const fromIndex = await readEnvironmentTcpUdpServiceIds(
    layout,
    environmentId,
  );
  const serviceIds = new Set<string>([...fromIndex, ...payloadServiceIds]);
  const removed: string[] = [];
  // Docker teardown + claim-file removal stay ordered per service.
  await forEachSequential(
    [...serviceIds].sort((a, b) => a.localeCompare(b)),
    async (serviceId) => {
      await removeServiceIngress(layout, serviceId, deps);
      await removeTcpUdpIngressEntries(layout, serviceId);
      removed.push(serviceId);
    },
  );
  await writeEnvironmentTcpUdpServiceIds(layout, environmentId, []);
  return removed;
}

/**
 * Tear down per-service Traefik projects + claim files for services that
 * previously published raw ports for this environment but are absent from
 * the new `ingressServices[]` set (e.g. tcp/udp → HTTP-only redeploy).
 *
 * Discovery unions (1) the environment index written on the last deploy and
 * (2) on-disk claim/project state for serviceIds still present in this
 * environment's hostings — so a tcp→HTTP flip is cleaned even before an
 * index exists, and a later `environment.stop` need not rediscover them.
 */
export async function cleanupStaleTcpUdpServiceIngress(
  layout: LayoutPaths,
  environmentId: string,
  environmentServiceIds: ReadonlySet<string>,
  activeIngressServiceIds: ReadonlySet<string>,
  deps?: RemoveServiceIngressDeps,
): Promise<string[]> {
  const previousFromIndex = await readEnvironmentTcpUdpServiceIds(
    layout,
    environmentId,
  );
  const persisted = await listPersistedTcpUdpServiceIds(layout);
  const candidates = new Set<string>(previousFromIndex);
  for (const serviceId of persisted) {
    if (environmentServiceIds.has(serviceId)) candidates.add(serviceId);
  }

  const removed: string[] = [];
  await forEachSequential(
    [...candidates].sort((a, b) => a.localeCompare(b)),
    async (serviceId) => {
      if (activeIngressServiceIds.has(serviceId)) return;
      if (persisted.includes(serviceId)) {
        await removeServiceIngress(layout, serviceId, deps);
        await removeTcpUdpIngressEntries(layout, serviceId);
      }
      removed.push(serviceId);
    },
  );

  await writeEnvironmentTcpUdpServiceIds(
    layout,
    environmentId,
    [...activeIngressServiceIds],
  );
  return removed;
}

async function syncTcpUdpIngressEntriesLocked(
  layout: LayoutPaths,
  serviceId: string,
  entries: readonly TcpUdpIngressEntry[],
  reservedPublishedPorts: ReadonlySet<number>,
): Promise<TcpUdpIngressEntry[]> {
  const dir = tcpUdpStateDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

  const others = await collectTcpUdpIngressEntries(layout, serviceId);
  for (const entry of entries) {
    if (
      entry.protocol === "tcp" &&
      reservedPublishedPorts.has(entry.publishedPort)
    ) {
      throw new TcpUdpPortReservedError(entry.protocol, entry.publishedPort);
    }
    const conflict = others.find(
      (o) =>
        o.protocol === entry.protocol &&
        o.publishedPort === entry.publishedPort,
    );
    if (conflict) {
      throw new TcpUdpPortConflictError(
        entry.protocol,
        entry.publishedPort,
        conflict.hostingId,
      );
    }
  }

  const filePath = tcpUdpStateFile(layout, serviceId);
  if (entries.length === 0) {
    try {
      await Deno.remove(filePath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    return [];
  }

  await writeTcpUdpIngressEntriesAtomic(dir, filePath, entries);
  return [...entries];
}

/**
 * Persist this service's TCP/UDP entries (deleting the file when empty),
 * check for protocol+port conflicts against every other service's entries,
 * and return **this service's own entries** for `ensureServiceIngress`.
 * Throws {@link TcpUdpPortConflictError} on conflict — **no partial write**.
 */
export function syncTcpUdpIngressEntries(
  layout: LayoutPaths,
  serviceId: string,
  entries: readonly TcpUdpIngressEntry[],
  listenerPorts?: ProxysqlListenerPortsInput | null,
): Promise<TcpUdpIngressEntry[]> {
  const reservedPublishedPorts = buildProxysqlReservedPublishedPorts(
    listenerPorts,
  );
  return withTcpUdpIngressLock(() =>
    syncTcpUdpIngressEntriesLocked(
      layout,
      serviceId,
      entries,
      reservedPublishedPorts,
    )
  );
}

async function removeTcpUdpIngressEntriesLocked(
  layout: LayoutPaths,
  serviceId: string,
): Promise<TcpUdpIngressEntry[] | null> {
  const filePath = tcpUdpStateFile(layout, serviceId);
  try {
    await Deno.stat(filePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }

  await Deno.remove(filePath);
  return await collectTcpUdpIngressEntries(layout, serviceId);
}

/**
 * Remove this service's persisted TCP/UDP claim file. Returns `null` when
 * the service had none; otherwise the remaining claims from every other
 * service (callers no longer restart a shared Traefik for tcp/udp).
 */
export function removeTcpUdpIngressEntries(
  layout: LayoutPaths,
  serviceId: string,
): Promise<TcpUdpIngressEntry[] | null> {
  return withTcpUdpIngressLock(() =>
    removeTcpUdpIngressEntriesLocked(layout, serviceId)
  );
}
