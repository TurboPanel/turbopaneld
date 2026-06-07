/** Canonical runtime socket directory ( /var/run symlinks to /run on Linux ). */
export const DEFAULT_SOCKET_DIR = '/run/turbopanel'

/** Unix socket filename for the TurboPanel instance. */
export const INSTANCE_SOCKET = 'turbopanel.sock'

/**
 * How the daemon reaches the instance.
 *
 * - `socket`: co-located dev / same-host, dial the instance Unix socket.
 * - `url`: remote agent node, dial the instance over the network (https/wss),
 *   typically through Caddy and a Cloudflare tunnel.
 */
export type InstanceConfig =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'url'; baseUrl: string; wsBaseUrl: string }

/**
 * Absolute path to the instance Unix socket.
 *
 * Override with `TURBOPANEL_SOCKET`, or set `TURBOPANEL_SOCKET_DIR` to change
 * the directory while keeping the default filename.
 */
export function resolveInstanceSocket(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_SOCKET?.trim()
  if (override) return override

  const dir = env.TURBOPANEL_SOCKET_DIR?.trim() || DEFAULT_SOCKET_DIR
  return `${dir.replace(/\/$/, '')}/${INSTANCE_SOCKET}`
}

function httpToWs(url: string): string {
  if (url.startsWith('https://')) {
    return `wss://${url.slice('https://'.length)}`
  }
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`
  throw new Error(
    `TURBOPANEL_INSTANCE_URL must start with http:// or https:// (got "${url}")`,
  )
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
  const url = env.TURBOPANEL_INSTANCE_URL?.trim()
  if (url) {
    const baseUrl = url.replace(/\/+$/, '')
    return { kind: 'url', baseUrl, wsBaseUrl: httpToWs(baseUrl) }
  }
  return { kind: 'socket', socketPath: resolveInstanceSocket(env) }
}

/** Base URL used with the Unix-socket HTTP client (host is ignored). */
export const INSTANCE_HTTP_ORIGIN = 'http://instance'

/** Base URL used with the Unix-socket WebSocket (host is ignored). */
export const INSTANCE_WS_ORIGIN = 'ws://instance'

function joinPath(base: string, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalized}`
}

export function instanceUrl(config: InstanceConfig, path: string): string {
  const base = config.kind === 'url' ? config.baseUrl : INSTANCE_HTTP_ORIGIN
  return joinPath(base, path)
}

export function instanceWebSocketUrl(
  config: InstanceConfig,
  path = '/ws/daemon/v1',
): string {
  const base = config.kind === 'url' ? config.wsBaseUrl : INSTANCE_WS_ORIGIN
  return joinPath(base, path)
}

/** Human-readable description of the instance target for logs. */
export function describeInstance(config: InstanceConfig): string {
  return config.kind === 'url' ? config.baseUrl : `unix://${config.socketPath}`
}

export interface InstanceHttpClientOptions {
  /** Path to the platform CA PEM to trust (self-hosted instances). */
  caCertPath?: string
}

/**
 * Build the HTTP client used for both REST and the WebSocket upgrade.
 *
 * - socket mode: a Unix-transport client (host in the URL is ignored).
 * - url mode with a CA: a client trusting the platform CA PEM (self-hosted).
 * - url mode without a CA: `undefined`, so the platform default fetch/WebSocket
 *   is used (valid public certs).
 *
 * To skip certificate validation entirely (not recommended), run Deno with
 * `--unsafely-ignore-certificate-errors` (the daemon systemd unit can add that
 * flag when `TURBOPANEL_TLS_INSECURE=1`).
 */
export async function createInstanceHttpClient(
  config: InstanceConfig,
  options: InstanceHttpClientOptions = {},
): Promise<Deno.HttpClient | undefined> {
  if (config.kind === 'socket') {
    return Deno.createHttpClient({
      proxy: { transport: 'unix', path: config.socketPath },
    })
  }

  if (options.caCertPath) {
    const cert = await Deno.readTextFile(options.caCertPath)
    return Deno.createHttpClient({ caCerts: [cert] })
  }

  return undefined
}
