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
export function resolveInstanceConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): InstanceConfig {
  const url = env.TURBOPANEL_INSTANCE_URL?.trim();
  if (url) {
    const baseUrl = stripTrailingSlashes(url);
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
 * Prefers `TURBOPANEL_INSTANCE_CA` when set; otherwise falls back to the
 * canonical config path when that file exists (e.g. operator recovery via curl).
 */
export function resolveInstanceCaPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | undefined {
  const fromEnv = env.TURBOPANEL_INSTANCE_CA?.trim();
  let resolved: string | undefined;
  if (fromEnv) {
    try {
      Deno.statSync(fromEnv);
      resolved = fromEnv;
    } catch {
      // Stale env path — fall through to canonical file if present.
    }
  }
  if (!resolved) {
    try {
      Deno.statSync(CANONICAL_INSTANCE_CA_PATH);
      resolved = CANONICAL_INSTANCE_CA_PATH;
    } catch {
      resolved = undefined;
    }
  }
  return resolved;
}

export interface InstanceHttpClientOptions {
  /** Path to the platform CA PEM to trust (self-hosted instances). */
  caCertPath?: string;
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
    return undefined;
  }

  if (options.caCertPath) {
    const cert = await Deno.readTextFile(options.caCertPath);
    return Deno.createHttpClient({ caCerts: [cert] });
  }

  return undefined;
}
