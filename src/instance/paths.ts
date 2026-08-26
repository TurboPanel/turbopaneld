import { readEnv, resolveLayout } from "../paths/layout.ts";

const layout = resolveLayout({
  TURBOPANEL_RUN_DIR: readEnv("TURBOPANEL_RUN_DIR"),
  TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
  TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
});

/** Canonical runtime socket directory ( /var/run symlinks to /run on Linux ). */
export const DEFAULT_SOCKET_DIR = layout.runDir;

/** Unix socket filename for the TurboPanel instance. */
export const INSTANCE_SOCKET = "instance.sock";

/**
 * How the daemon reaches the instance.
 *
 * - `socket`: co-located dev / same-host, dial the instance Unix socket.
 * - `url`: remote managed server, dial the instance over the network (https/wss),
 *   typically through Caddy and a Cloudflare tunnel.
 */
export type InstanceConfig =
  | { kind: "socket"; socketPath: string }
  | { kind: "url"; baseUrl: string; wsBaseUrl: string };

/**
 * Absolute path to the instance Unix socket.
 *
 * Override with `TURBOPANEL_SOCKET`, or set `TURBOPANEL_SOCKET_DIR` to change
 * the directory while keeping the default filename.
 */
export function resolveInstanceSocket(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_SOCKET?.trim();
  if (override) return override;

  const layout = resolveLayout(env);
  const dir = env.TURBOPANEL_SOCKET_DIR?.trim() || layout.runDir;
  return `${dir.replace(/\/$/, "")}/${INSTANCE_SOCKET}`;
}

function httpToWs(url: string): string {
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  throw new Error(
    `TURBOPANEL_INSTANCE_URL must start with http:// or https:// (got "${url}")`,
  );
}

/**
 * Decide how to reach the instance.
 *
 * When `TURBOPANEL_INSTANCE_URL` is set the daemon connects over the network to
 * that base URL (the full URL including scheme and port, e.g.
 * `https://<instance-host>:<port>`). Otherwise it falls back to the
 * local Unix socket used by the co-located dev setup.
 */
/**
 * Plaintext `http://` to the control plane is a development-only path gated by
 * `TURBOPANEL_DEV_HTTP_CONTROL_PLANE`. On managed/production hosts the flag is
 * never set, so a plaintext control-plane URL is rejected rather than silently
 * dialed without TLS.
 */
function isDevHttpControlPlaneEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return isTruthyFlag(env.TURBOPANEL_DEV_HTTP_CONTROL_PLANE);
}

export function resolveInstanceConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): InstanceConfig {
  const url = env.TURBOPANEL_INSTANCE_URL?.trim();
  if (url) {
    const baseUrl = stripTrailingSlashes(url);
    if (baseUrl.startsWith("http://") && !isDevHttpControlPlaneEnabled(env)) {
      throw new Error(
        `TURBOPANEL_INSTANCE_URL must use https:// (got "${baseUrl}"); ` +
          "set TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1 to allow plaintext http in development only",
      );
    }
    return { kind: "url", baseUrl, wsBaseUrl: httpToWs(baseUrl) };
  }
  return { kind: "socket", socketPath: resolveInstanceSocket(env) };
}

/** Base URL used with the Unix-socket HTTP client (host is ignored). */
export const INSTANCE_HTTP_ORIGIN = "http://instance"; // NOSONAR typescript:S5332 — Unix-socket origin only; host ignored, never a network cleartext endpoint

/** Base URL used with the Unix-socket WebSocket (host is ignored). */
export const INSTANCE_WS_ORIGIN = "ws://instance"; // NOSONAR typescript:S5332 — Unix-socket origin only; host ignored, never a network cleartext endpoint

function joinPath(base: string, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

export function instanceUrl(config: InstanceConfig, path: string): string {
  const base = config.kind === "url" ? config.baseUrl : INSTANCE_HTTP_ORIGIN;
  return joinPath(base, path);
}

export function instanceWebSocketUrl(
  config: InstanceConfig,
  path = "/ws/daemon/v1",
): string {
  const base = config.kind === "url" ? config.wsBaseUrl : INSTANCE_WS_ORIGIN;
  return joinPath(base, path);
}

/** Human-readable description of the instance target for logs. */
export function describeInstance(config: InstanceConfig): string {
  return config.kind === "url" ? config.baseUrl : `unix://${config.socketPath}`;
}

/** Default platform CA path written by run.sh / daemon-config on managed nodes. */
export const CANONICAL_INSTANCE_CA_PATH = layout.instanceCaPath;

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** Strip all trailing `/` without a backtracking regex. */
export function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.codePointAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === path.length ? path : path.slice(0, end);
}

/**
 * Directory for daemon server identity files (`server.id`, keys, license).
 *
 * Honors `TURBOPANEL_DAEMON_STATE_DIR`, then `TURBOPANEL_STATE_DIR`, then
 * mode-specific defaults via {@link resolveLayout}.
 */
export function resolveServerIdentityDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  if (isTruthyFlag(env.TURBOPANEL_SKIP_ORCHESTRATION)) {
    return stripTrailingSlashes(Deno.cwd());
  }
  return resolveLayout(env).daemonStateDir;
}

export const SERVER_KEY_FILE = "server-key.json";

/** Absolute path to the persisted daemon server key file. */
export function resolveServerKeyPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return `${resolveServerIdentityDir(env)}/${SERVER_KEY_FILE}`;
}

/**
 * Resolve the platform CA PEM path for remote (url-mode) TLS trust.
 *
 * Prefers `TURBOPANEL_INSTANCE_CA` when that file exists; otherwise falls
 * back to the env-derived layout path (`TURBOPANEL_CONFIG_DIR` /
 * {@link CANONICAL_INSTANCE_CA_PATH}) when that file exists. A stale env
 * path falls through to the layout file. Tests inject the layout via
 * `TURBOPANEL_CONFIG_DIR` so they never stat the host's real CA.
 */
export function resolveInstanceCaPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | undefined {
  const fromEnv = env.TURBOPANEL_INSTANCE_CA?.trim();
  if (fromEnv && fileExistsSync(fromEnv)) return fromEnv;
  const canonicalPath = resolveLayout(env).instanceCaPath;
  return fileExistsSync(canonicalPath) ? canonicalPath : undefined;
}

function fileExistsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface InstanceHttpClientOptions {
  /** Path to the platform CA PEM to trust (self-hosted instances). */
  caCertPath?: string;
  /** Environment used to gate the dev-only plaintext http control plane. */
  env?: Record<string, string | undefined>;
}

const PEM_CERT_BEGIN = "-----BEGIN CERTIFICATE-----";
const PEM_CERT_END = "-----END CERTIFICATE-----";

/** Split a PEM file into individual CERTIFICATE blocks (current first). */
export function splitPemBundle(pem: string): string[] {
  const normalized = pem.replaceAll("\r\n", "\n");
  const blocks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < normalized.length) {
    const begin = normalized.indexOf(PEM_CERT_BEGIN, searchFrom);
    if (begin < 0) break;
    const end = normalized.indexOf(PEM_CERT_END, begin + PEM_CERT_BEGIN.length);
    if (end < 0) break;
    const blockEnd = end + PEM_CERT_END.length;
    blocks.push(`${normalized.slice(begin, blockEnd).trim()}\n`);
    searchFrom = blockEnd;
  }
  return blocks;
}

function pemBodyToDer(block: string): Uint8Array {
  const begin = block.indexOf(PEM_CERT_BEGIN);
  const end = block.indexOf(PEM_CERT_END, begin + PEM_CERT_BEGIN.length);
  const b64 = block
    .slice(begin + PEM_CERT_BEGIN.length, end)
    .replaceAll(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** SHA-256 fingerprint (lowercase hex, no colons) of the first CERTIFICATE in a PEM bundle. */
export async function fingerprintPemCertificate(pem: string): Promise<string> {
  const blocks = splitPemBundle(pem);
  const first = blocks[0];
  if (!first) {
    throw new Error("PEM bundle contains no certificates");
  }
  const der = pemBodyToDer(first);
  const copy = new Uint8Array(der.length);
  copy.set(der);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return bytesToHex(new Uint8Array(digest));
}

export function normalizeCaFingerprint(value: string): string {
  return value.trim().toLowerCase().replaceAll(":", "").replaceAll(" ", "");
}

type PlatformCaHttpClientCache = {
  path: string;
  mtimeMs: number;
  size: number;
  client: Deno.HttpClient;
};

let platformCaHttpClientCache: PlatformCaHttpClientCache | undefined;

/** Drop the cached HTTP client so the next connect re-reads the CA bundle. */
export function invalidatePlatformCaHttpClient(): void {
  platformCaHttpClientCache = undefined;
}

/** Build an HTTP client that trusts every certificate in the platform CA PEM bundle. */
export async function createHttpClientFromCaPath(
  caCertPath: string | undefined,
): Promise<Deno.HttpClient | undefined> {
  const trimmed = caCertPath?.trim();
  if (!trimmed) return undefined;
  const stat = await Deno.stat(trimmed);
  const mtimeMs = stat.mtime?.getTime() ?? 0;
  const size = stat.size;
  const cached = platformCaHttpClientCache;
  if (
    cached?.path === trimmed &&
    cached.mtimeMs === mtimeMs &&
    cached.size === size
  ) {
    return cached.client;
  }
  const pem = await Deno.readTextFile(trimmed);
  const certs = splitPemBundle(pem);
  if (certs.length === 0) {
    throw new Error(`platform CA PEM at ${trimmed} contains no certificates`);
  }
  const client = Deno.createHttpClient({ caCerts: certs });
  platformCaHttpClientCache = { path: trimmed, mtimeMs, size, client };
  return client;
}

/**
 * `fetch` that trusts the platform CA when `resolveInstanceCaPath` finds one.
 *
 * Overlay catalogs (`TURBOPANEL_DL_BASE`) are served over the same TLS trust
 * model as the instance API — self-hosted daemons must not use bare `fetch`.
 */
export async function fetchWithPlatformCa(
  url: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
  init?: RequestInit,
): Promise<Response> {
  const client = await createHttpClientFromCaPath(resolveInstanceCaPath(env));
  if (client) {
    return fetch(url, { ...init, client });
  }
  return fetch(url, init);
}

/**
 * Build the HTTP client used for both REST and the WebSocket upgrade.
 *
 * - socket mode: a Unix-transport client (host in the URL is ignored).
 * - url mode with a CA: a client trusting the platform CA PEM (self-hosted).
 * - url mode without a CA: `undefined`, so the platform default fetch/WebSocket
 *   is used (valid public certs: Let's Encrypt, Cloudflare, etc.).
 *
 * There is no "insecure"/skip-verification mode: the daemon either trusts a
 * publicly-valid cert via the system store, or trusts the platform CA PEM. In
 * both cases the instance server cert MUST be valid for the hostname the daemon
 * dials (its SAN must include the configured public URL host) — otherwise the
 * TLS handshake fails. Manage the instance cert SANs from the admin surface /
 * `TURBOPANEL_PUBLIC_URL`, not by disabling verification.
 */
export async function createInstanceHttpClient(
  config: InstanceConfig,
  options: InstanceHttpClientOptions = {},
): Promise<Deno.HttpClient | undefined> {
  if (config.kind === "socket") {
    return Deno.createHttpClient({
      proxy: { transport: "unix", path: config.socketPath },
    });
  }

  if (config.baseUrl.startsWith("http://")) {
    const env = options.env ??
      (typeof Deno !== "undefined" ? Deno.env.toObject() : {});
    if (!isDevHttpControlPlaneEnabled(env)) {
      throw new Error(
        `instance base URL must use https:// (got "${config.baseUrl}"); ` +
          "set TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1 to allow plaintext http in development only",
      );
    }
    return undefined;
  }

  return await createHttpClientFromCaPath(options.caCertPath);
}
