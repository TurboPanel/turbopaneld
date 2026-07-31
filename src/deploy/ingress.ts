import { join } from "@std/path";
import { logWarn } from "../logger.ts";
import {
  type EnvironmentDeployHosting,
  type EnvironmentDeployPayload,
  isValidIpv4Literal,
  isValidIpv6Literal,
} from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { runDocker } from "./docker-cli.ts";
import { ensureHostingCaddy } from "./ensure-hosting-caddy.ts";

const INGRESS_NETWORK = "turbopanel-ingress";
const CADDY_SERVICE = "turbopanel-hosting-caddy.service";
const TRAEFIK_IMAGE = "traefik:v3.6.6";
const TRAEFIK_LOOPBACK = "127.0.0.1";
const TRAEFIK_HTTP_PORT = 7080;
const TRAEFIK_HTTPS_PORT = 7443;
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const decoder = new TextDecoder();

/**
 * One raw TCP/UDP port Traefik publishes straight through (no hostname/TLS
 * routing) for a `tcp`/`udp` protocol hosting. Persisted per environment
 * under `<stateDir>/ingress/tcp-udp/<environmentId>.json` and merged across
 * every environment's file to build one consistent Traefik static config —
 * Traefik entrypoints cannot be added dynamically, so the ingress container
 * is recreated whenever the merged entrypoint set changes.
 */
export type TcpUdpIngressEntry = {
  hostingId: string;
  protocol: "tcp" | "udp";
  publishedPort: number;
  bindAddress?: string;
};

/** Raised when two hostings (in different environments) claim the same protocol+port. */
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

async function run(
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

function commandError(action: string, result: CommandResult): Error {
  return new Error(result.stderr || `${action} failed`);
}

async function ensureIngressNetwork(): Promise<void> {
  const inspect = await runDocker(["network", "inspect", INGRESS_NETWORK]);
  if (inspect.success) return;

  const create = await runDocker(["network", "create", INGRESS_NETWORK]);
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

function tcpUdpStaticArgLines(
  entries: readonly TcpUdpIngressEntry[],
): string[] {
  return dedupeTcpUdpEntries(entries).map((entry) => {
    const name = tcpUdpEntrypointName(entry.protocol, entry.publishedPort);
    const suffix = entry.protocol === "udp" ? "/udp" : "";
    return `      - --entrypoints.${name}.address=:${entry.publishedPort}${suffix}`;
  });
}

function tcpUdpPortLines(entries: readonly TcpUdpIngressEntry[]): string[] {
  return dedupeTcpUdpEntries(entries).map((entry) => {
    const bindAddress = entry.bindAddress ?? "0.0.0.0";
    assertValidBindAddress(bindAddress);
    const host = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
    return `      - ${host}:${entry.publishedPort}:${entry.publishedPort}/${entry.protocol}`;
  });
}

export function traefikCompose(
  entries: readonly TcpUdpIngressEntry[] = [],
): string {
  const staticArgs = tcpUdpStaticArgLines(entries);
  const portLines = tcpUdpPortLines(entries);
  const lines = [
    "services:",
    "  traefik:",
    `    image: ${TRAEFIK_IMAGE}`,
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
    ...staticArgs,
    "    ports:",
    `      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTP_PORT}:${TRAEFIK_HTTP_PORT}`,
    `      - ${TRAEFIK_LOOPBACK}:${TRAEFIK_HTTPS_PORT}:${TRAEFIK_HTTPS_PORT}`,
    ...portLines,
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
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

export async function ensureHostingIngress(
  layout: LayoutPaths,
  tcpUdpEntries: readonly TcpUdpIngressEntry[] = [],
): Promise<void> {
  await ensureIngressNetwork();

  const ingressDir = join(layout.stateDir, "ingress", "traefik");
  await Deno.mkdir(ingressDir, { recursive: true, mode: 0o750 });
  const composePath = join(ingressDir, "docker-compose.yml");
  await Deno.writeTextFile(composePath, traefikCompose(tcpUdpEntries), {
    mode: 0o640,
  });
  const composeUp = await runDocker([
    "compose",
    "-p",
    "turbopanel-ingress",
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!composeUp.success) {
    throw commandError("Starting Traefik ingress", composeUp);
  }

  await ensureHostingCaddyRuntime(layout);
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

function tcpUdpStateFile(layout: LayoutPaths, environmentId: string): string {
  if (!SAFE_FILE_ID_RE.test(environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }
  return join(tcpUdpStateDir(layout), `${environmentId}.json`);
}

/** Read every persisted per-environment TCP/UDP entry list, optionally excluding one environment. */
export async function collectTcpUdpIngressEntries(
  layout: LayoutPaths,
  excludeEnvironmentId?: string,
): Promise<TcpUdpIngressEntry[]> {
  const dir = tcpUdpStateDir(layout);
  let dirEntries: Deno.DirEntry[];
  try {
    dirEntries = [];
    for await (const entry of Deno.readDir(dir)) dirEntries.push(entry);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }

  const excludeFile = excludeEnvironmentId
    ? `${excludeEnvironmentId}.json`
    : undefined;
  const merged: TcpUdpIngressEntry[] = [];
  for (const entry of dirEntries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    if (entry.name === excludeFile) continue;
    const contents = await Deno.readTextFile(join(dir, entry.name));
    const parsed: unknown = JSON.parse(contents);
    if (Array.isArray(parsed)) merged.push(...(parsed as TcpUdpIngressEntry[]));
  }
  return merged;
}

/**
 * Persist this environment's TCP/UDP entries (deleting the file when empty),
 * check for protocol+port conflicts against every other environment's
 * entries, and return the full merged set for `ensureHostingIngress`.
 * Throws {@link TcpUdpPortConflictError} on conflict — no partial write.
 */
export async function syncTcpUdpIngressEntries(
  layout: LayoutPaths,
  environmentId: string,
  entries: readonly TcpUdpIngressEntry[],
): Promise<TcpUdpIngressEntry[]> {
  const dir = tcpUdpStateDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

  const others = await collectTcpUdpIngressEntries(layout, environmentId);
  for (const entry of entries) {
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

  const filePath = tcpUdpStateFile(layout, environmentId);
  if (entries.length === 0) {
    try {
      await Deno.remove(filePath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    return others;
  }

  await Deno.writeTextFile(filePath, JSON.stringify(entries), { mode: 0o640 });
  return [...others, ...entries];
}

/**
 * Remove this environment's persisted TCP/UDP entries. Returns `null` when
 * the environment had none (caller can skip re-syncing Traefik); otherwise
 * returns the remaining merged set from every other environment.
 */
export async function removeTcpUdpIngressEntries(
  layout: LayoutPaths,
  environmentId: string,
): Promise<TcpUdpIngressEntry[] | null> {
  const filePath = tcpUdpStateFile(layout, environmentId);
  try {
    await Deno.stat(filePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }

  await Deno.remove(filePath);
  return await collectTcpUdpIngressEntries(layout, environmentId);
}
