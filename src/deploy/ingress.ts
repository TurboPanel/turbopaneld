import { join } from "@std/path";
import { logInfo, logWarn } from "../logger.ts";
import {
  type EnvironmentDeployContainer,
  type EnvironmentDeployHosting,
  type EnvironmentDeployPayload,
  isValidIpv4Literal,
  isValidIpv6Literal,
} from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
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
import { ensureHostingCaddy } from "./ensure-hosting-caddy.ts";
import {
  assertSafeIngressIdentity,
  type IngressIdentity,
} from "./ingress-identity.ts";
import {
  LABEL_RAW_PORT,
  LABEL_ROLE,
  LABEL_ROLE_INGRESS,
  LABEL_SERVICE_ID,
  LABEL_SYSTEM_COMPONENT,
} from "./labels.ts";
import {
  assertSafeSystemIngressIdentity,
  readSystemComponentDescriptor,
  SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  type SystemComponentDescriptor,
} from "./system-component.ts";

const INGRESS_NETWORK = "turbopanel-ingress";
const CADDY_SERVICE = "turbopanel-hosting-caddy.service";
const TRAEFIK_IMAGE = "traefik:v3.6.6";
const TRAEFIK_LOOPBACK = "127.0.0.1";
const TRAEFIK_HTTP_PORT = 7080;
const TRAEFIK_HTTPS_PORT = 7443;
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const decoder = new TextDecoder();

/**
 * Compose project name for the shared HTTP Traefik.
 * Happens to equal {@link INGRESS_NETWORK}; kept as a distinct constant.
 */
export const HOSTING_INGRESS_PROJECT = "turbopanel-ingress";

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
 * its own Traefik compose project (`turbopanel-ingress-<serviceId>`); the
 * shared `turbopanel-ingress` Traefik stays HTTP-only (loopback web/websecure).
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
 * Protocol ports reserved for the shared ProxySQL managed-ingress listeners.
 * Tenant raw `tcp`/`udp` hostings must not claim these.
 */
export const PROXYSQL_RESERVED_PUBLISHED_PORTS = new Set([15432, 16306]);

/** Raised when a tenant claim tries to take a ProxySQL listener port. */
export class TcpUdpPortReservedError extends Error {
  constructor(
    readonly protocol: "tcp" | "udp",
    readonly publishedPort: number,
  ) {
    super(
      `${protocol} port ${publishedPort} is reserved for managed database ingress (ProxySQL)`,
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
  return `reverse_proxy ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTPS_PORT} {
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

async function ensureIngressNetwork(run: RunDockerFn = defaultRunDocker): Promise<void> {
  const inspect = await run([
    "network",
    "inspect",
    INGRESS_NETWORK,
  ]);
  if (inspect.success) return;

  const create = await run(["network", "create", INGRESS_NETWORK]);
  if (!create.success) {
    throw commandError("Creating ingress Docker network", create);
  }
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

/** Shared HTTP-only Traefik (loopback web/websecure). No tcp/udp entrypoints. */
/**
 * Shared HTTP-only Traefik compose document (project {@link HOSTING_INGRESS_PROJECT}).
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
 * Adding `container_name` causes one compose recreation of the existing
 * `turbopanel-ingress-traefik-1` container on first identity-bearing ensure —
 * expected and self-healing, since `up -d` replaces the same compose service
 * rather than orphaning it.
 */
export function traefikCompose(
  identity?: SystemComponentDescriptor,
): string {
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

  const lines = [
    "services:",
    `  ${SHARED_TRAEFIK_COMPOSE_SERVICE_NAME}:`,
    `    image: ${TRAEFIK_IMAGE}`,
    ...identityLines,
    "    restart: unless-stopped",
    "    command:",
    "      - --providers.docker=true",
    "      - --providers.docker.exposedbydefault=false",
    `      - --providers.docker.network=${INGRESS_NETWORK}`,
    `      - --entrypoints.web.address=:${TRAEFIK_HTTP_PORT}`,
    "      - --entrypoints.web.proxyProtocol.insecure=true",
    `      - --entrypoints.websecure.address=:${TRAEFIK_HTTPS_PORT}`,
    "      - --entrypoints.websecure.proxyProtocol.insecure=true",
    "      - --entrypoints.websecure.http.tls=true",
    "    ports:",
    `      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTP_PORT}:${TRAEFIK_HTTP_PORT}`,
    `      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTPS_PORT}:${TRAEFIK_HTTPS_PORT}`,
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
    ...labelLines,
    "    networks:",
    `      - ${INGRESS_NETWORK}`,
    "",
    "networks:",
    `  ${INGRESS_NETWORK}:`,
    "    external: true",
    "",
  ];
  return lines.join("\n");
}

function assertSafeServiceIngressIdentity(
  identity: ServiceIngressIdentity,
): void {
  assertSafeIngressIdentity(identity);
}

/** Compose project name for one service's tenant Traefik. */
export function serviceIngressProject(serviceId: string): string {
  if (!SAFE_FILE_ID_RE.test(serviceId)) {
    throw new Error("serviceId contains unsupported characters");
  }
  return `turbopanel-ingress-${serviceId}`;
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
 * Joins {@link INGRESS_NETWORK}, constrains the Docker provider to
 * `com.turbopanel.service=<serviceId>` **and** `com.turbopanel.raw-port=true`
 * (stamped by `buildHostingLabelsFragment` only on services that publish tcp/udp),
 * and emits only that service's tcp/udp entrypoints + published ports.
 * HTTP routers on mixed-hosting services are pinned to `web,websecure`, which
 * this Traefik does not define — so HTTP config stays on shared loopback Traefik.
 */
export function serviceTraefikCompose(
  entries: readonly TcpUdpIngressEntry[],
  identity: ServiceIngressIdentity,
): string {
  assertSafeServiceIngressIdentity(identity);
  const staticArgs = tcpUdpStaticArgLines(entries);
  const portLines = tcpUdpPortLines(entries);
  const constraint =
    `Label(\`${LABEL_SERVICE_ID}\`,\`${identity.serviceId}\`) && Label(\`${LABEL_RAW_PORT}\`,\`true\`)`;
  const lines = [
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
    "      - --providers.docker.exposedbydefault=false",
    `      - --providers.docker.network=${INGRESS_NETWORK}`,
    `      - ${
      quoteYamlScalar(`--providers.docker.constraints=${constraint}`)
    }`,
    ...staticArgs,
    ...(portLines.length > 0 ? ["    ports:", ...portLines] : []),
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
    "    labels:",
    `      ${LABEL_ROLE}: ${LABEL_ROLE_INGRESS}`,
    `      ${LABEL_SERVICE_ID}: ${quoteYamlScalar(identity.serviceId)}`,
    "    networks:",
    `      - ${INGRESS_NETWORK}`,
    "",
    "networks:",
    `  ${INGRESS_NETWORK}:`,
    "    external: true",
    "",
  ];
  return lines.join("\n");
}

export function caddyfile(configDir: string): string {
  return `{
  auto_https off
  servers {
    protocols h1 h2 h3
  }
}
import ${join(configDir, "hosting", "sites", "*.caddy")}
`;
}

function caddyUnit(layout: LayoutPaths): string {
  const caddy = join(layout.runtimesDir, "caddy", "current", "caddy");
  const configDir = join(layout.configDir, "hosting");
  return `[Unit]
Description=TurboPanel hosting Caddy ingress
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${configDir}
ExecStart=${caddy} run --config ${
    join(configDir, "Caddyfile")
  } --adapter caddyfile
ExecReload=${caddy} reload --config ${
    join(configDir, "Caddyfile")
  } --adapter caddyfile
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

async function installAndStartCaddy(
  unitSource: string,
): Promise<boolean> {
  const install = await run("sudo", [
    "-n",
    "install",
    "-m",
    "0640",
    unitSource,
    join("/etc/systemd/system", CADDY_SERVICE),
  ]);
  if (!install.success) {
    logWarn("deploy", `hosting Caddy unit not installed: ${install.stderr}`);
    return false;
  }

  const daemonReload = await run("sudo", ["-n", "systemctl", "daemon-reload"]);
  if (!daemonReload.success) {
    logWarn(
      "deploy",
      `hosting Caddy daemon-reload failed: ${daemonReload.stderr}`,
    );
    return false;
  }
  const enable = await run("sudo", [
    "-n",
    "systemctl",
    "enable",
    "--now",
    CADDY_SERVICE,
  ]);
  if (!enable.success) {
    logWarn("deploy", `hosting Caddy start failed: ${enable.stderr}`);
    return false;
  }
  return true;
}

/** Ensure hosting Caddy binary, Caddyfile, sites dir, and systemd unit. */
export async function ensureHostingCaddyRuntime(
  layout: LayoutPaths,
): Promise<void> {
  await ensureHostingCaddy(layout);
  const hostingDir = join(layout.configDir, "hosting");
  const sitesDir = join(hostingDir, "sites");
  await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });
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
  await Deno.writeTextFile(unitSource, caddyUnit(layout), { mode: 0o640 });

  // A non-root daemon cannot install a system unit. Keep the generated config
  // so test and dev environments can grant sudo later without redeploying.
  await installAndStartCaddy(unitSource);
}

/** Optional test seams for {@link ensureHostingIngress}. */
export type EnsureHostingIngressDeps = {
  runDocker?: RunDockerFn;
  /** When set, skips binary/unit install (host-free tests). */
  ensureHostingCaddyRuntime?: (layout: LayoutPaths) => Promise<void>;
};

/** Ensure the shared HTTP-only Traefik + hosting Caddy runtime. */
export async function ensureHostingIngress(
  layout: LayoutPaths,
  deps?: EnsureHostingIngressDeps,
): Promise<void> {
  const run = deps?.runDocker ?? defaultRunDocker;
  await ensureIngressNetwork(run);

  const ingressDir = hostingIngressDir(layout);
  await Deno.mkdir(ingressDir, { recursive: true, mode: 0o750 });
  const composePath = hostingIngressComposePath(layout);

  let descriptor: SystemComponentDescriptor | undefined;
  try {
    const loaded = await readSystemComponentDescriptor(
      layout,
      SYSTEM_HOSTING_INGRESS_COMPONENT,
    );
    if (loaded !== null) descriptor = loaded;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(
      "deploy",
      `hosting ingress descriptor unreadable; using anonymous Traefik: ${message}`,
    );
  }

  await Deno.writeTextFile(composePath, traefikCompose(descriptor), {
    mode: 0o640,
  });
  const composeUp = await run([
    "compose",
    "-p",
    HOSTING_INGRESS_PROJECT,
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!composeUp.success) {
    throw commandError("Starting Traefik ingress", composeUp);
  }

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
      "-p",
      HOSTING_INGRESS_PROJECT,
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
  deps?: EnsureServiceIngressDeps,
): Promise<void> {
  if (identity.serviceId !== serviceId) {
    throw new Error("ingress identity serviceId mismatch");
  }
  const run = deps?.runDocker ?? defaultRunDocker;
  await ensureIngressNetwork(run);

  const ingressDir = serviceIngressDir(layout, serviceId);
  await Deno.mkdir(ingressDir, { recursive: true, mode: 0o750 });
  const composePath = serviceIngressComposePath(layout, serviceId);
  await Deno.writeTextFile(
    composePath,
    serviceTraefikCompose(entries, identity),
    { mode: 0o640 },
  );
  const project = serviceIngressProject(serviceId);
  const composeUp = await run([
    "compose",
    "-p",
    project,
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!composeUp.success) {
    throw commandError("Starting service Traefik ingress", composeUp);
  }
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
};

export function assertSafeHostingPathPrefix(pathPrefix: string): void {
  if (pathPrefix.includes("`") || /[\r\n]/.test(pathPrefix)) {
    throw new Error("hostings[].pathPrefix contains an unsupported character");
  }
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
  const strip = route.stripPrefix?.trim();
  if (strip && strip.length > 0) {
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
  // Loopback-only hosts for traditional-web; reject other hosts to keep
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

export function siteSnippet(
  hostname: string,
  tlsId: string | undefined,
  tlsDir: string,
  forceHttps = true,
  bindAddress?: string,
  upstream: CaddyUpstream = DEFAULT_TRAEFIK_UPSTREAM,
  routes?: readonly CaddySiteRoute[],
): string {
  const effectiveRoutes: CaddySiteRoute[] = routes?.length
    ? [...routes]
    : [{ upstream }];

  if (!usesMultiRouteRouting(effectiveRoutes)) {
    const single = effectiveRoutes[0]?.upstream ?? upstream;
    const { http: httpUpstream, https: httpsUpstream } = resolveUpstreamBlocks(
      single,
    );
    const tlsLine = tlsId
      ? `  tls ${join(tlsDir, tlsId, "fullchain.pem")} ${
        join(tlsDir, tlsId, "privkey.pem")
      }`
      : "  tls internal";
    const bindLine = bindAddress ? formatBindDirective(bindAddress) : "";

    const httpBlock = forceHttps
      ? `http://${hostname} {
${bindLine}  redir https://{host}{uri} permanent
}

`
      : `http://${hostname} {
${bindLine}  ${httpUpstream}
}

`;

    const httpsBlock = forceHttps
      ? `${hostname} {
${bindLine}${tlsLine}
  ${httpsUpstream}
}
`
      : "";

    return httpBlock + httpsBlock;
  }

  const tlsLine = tlsId
    ? `  tls ${join(tlsDir, tlsId, "fullchain.pem")} ${
      join(tlsDir, tlsId, "privkey.pem")
    }`
    : "  tls internal";
  const bindLine = bindAddress ? formatBindDirective(bindAddress) : "";
  const httpsHandlers = formatRouteHandlers(effectiveRoutes, "https");
  const httpHandlers = formatRouteHandlers(effectiveRoutes, "http");

  const httpBlock = forceHttps
    ? `http://${hostname} {
${bindLine}  redir https://{host}{uri} permanent
}

`
    : `http://${hostname} {
${bindLine}${httpHandlers}
}

`;

  const httpsBlock = forceHttps
    ? `${hostname} {
${bindLine}${tlsLine}
${httpsHandlers}
}
`
    : "";

  return httpBlock + httpsBlock;
}

function resolveHostingUpstream(
  hosting: EnvironmentDeployHosting,
  traditionalByService: Map<string, { listenPort: number }>,
): CaddyUpstream {
  const traditional = traditionalByService.get(hosting.composeServiceName);
  if (traditional) {
    return { kind: "http", host: "127.0.0.1", port: traditional.listenPort };
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
  traditionalByService: Map<string, { listenPort: number }>,
): CaddySiteRoute {
  const upstream = resolveHostingUpstream(hosting, traditionalByService);
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
  site.forceHttps = site.forceHttps && (hosting.proxy?.forceHttps ?? true);
  if (hosting.bindAddress) {
    assertValidBindAddress(hosting.bindAddress);
    site.bindAddress = hosting.bindAddress;
  }
  site.routes.push(route);
}

export function buildCaddyHostnameRoutes(
  payload: EnvironmentDeployPayload,
): Map<string, HostnameSite> {
  const traditionalByService = new Map(
    (payload.traditionalWebSites ?? []).map((site) => [
      site.composeServiceName,
      site,
    ]),
  );

  const byHostname = new Map<string, HostnameSite>();

  for (const hosting of payload.hostings) {
    if ((hosting.protocol ?? "http") !== "http") continue;
    if (hosting.hostnames.length === 0) continue;

    const route = buildCaddySiteRoute(hosting, traditionalByService);
    for (const hostname of hosting.hostnames) {
      const site = getOrCreateHostnameSite(byHostname, hostname);
      mergeHostingIntoHostnameSite(site, hosting, route);
    }
  }

  return byHostname;
}

export async function rewriteHostingCaddySites(
  layout: LayoutPaths,
  payload: EnvironmentDeployPayload,
  hostnameTls?: Map<string, string>,
): Promise<void> {
  if (!SAFE_FILE_ID_RE.test(payload.environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }

  const sitesDir = join(layout.configDir, "hosting", "sites");
  await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });

  const hostnameSites = buildCaddyHostnameRoutes(payload);

  const hostnames = [...hostnameSites.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  const siteContent = hostnames
    .map((hostname) => {
      const site = hostnameSites.get(hostname)!;
      return siteSnippet(
        hostname,
        hostnameTls?.get(hostname),
        layout.tlsDir,
        site.forceHttps,
        site.bindAddress,
        DEFAULT_TRAEFIK_UPSTREAM,
        site.routes,
      );
    })
    .join("\n");
  await Deno.writeTextFile(
    join(sitesDir, `${payload.environmentId}.caddy`),
    siteContent,
    { mode: 0o640 },
  );

  const reload = await run("sudo", [
    "-n",
    "systemctl",
    "reload",
    CADDY_SERVICE,
  ]);
  if (!reload.success) {
    logWarn("deploy", `hosting Caddy reload skipped: ${reload.stderr}`);
  }
}

/** Remove the per-environment hosting site snippet and best-effort reload Caddy. */
export async function removeHostingCaddySite(
  layout: LayoutPaths,
  environmentId: string,
): Promise<void> {
  if (!SAFE_FILE_ID_RE.test(environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }

  const sitePath = join(
    layout.configDir,
    "hosting",
    "sites",
    `${environmentId}.caddy`,
  );
  try {
    await Deno.remove(sitePath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  const reload = await run("sudo", [
    "-n",
    "systemctl",
    "reload",
    CADDY_SERVICE,
  ]);
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
  const merged: TcpUdpIngressEntry[] = [];
  for (const entry of dirEntries) {
    if (!isCommittedTcpUdpClaimFile(entry)) continue;
    if (entry.name === excludeFile) continue;
    merged.push(...await readTcpUdpIngressEntriesFile(dir, entry.name));
  }
  return merged;
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
): Promise<string[]> {
  const fromIndex = await readEnvironmentTcpUdpServiceIds(
    layout,
    environmentId,
  );
  const serviceIds = new Set<string>([...fromIndex, ...payloadServiceIds]);
  const removed: string[] = [];
  for (const serviceId of [...serviceIds].sort((a, b) => a.localeCompare(b))) {
    await removeServiceIngress(layout, serviceId);
    await removeTcpUdpIngressEntries(layout, serviceId);
    removed.push(serviceId);
  }
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
  for (const serviceId of [...candidates].sort((a, b) => a.localeCompare(b))) {
    if (activeIngressServiceIds.has(serviceId)) continue;
    if (persisted.includes(serviceId)) {
      await removeServiceIngress(layout, serviceId);
      await removeTcpUdpIngressEntries(layout, serviceId);
    }
    removed.push(serviceId);
  }

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
): Promise<TcpUdpIngressEntry[]> {
  const dir = tcpUdpStateDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

  const others = await collectTcpUdpIngressEntries(layout, serviceId);
  for (const entry of entries) {
    if (
      entry.protocol === "tcp" &&
      PROXYSQL_RESERVED_PUBLISHED_PORTS.has(entry.publishedPort)
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
): Promise<TcpUdpIngressEntry[]> {
  return withTcpUdpIngressLock(() =>
    syncTcpUdpIngressEntriesLocked(layout, serviceId, entries)
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
