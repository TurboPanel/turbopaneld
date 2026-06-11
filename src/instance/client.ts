import {
  createInstanceHttpClient,
  describeInstance,
  type InstanceConfig,
  instanceUrl,
  instanceWebSocketUrl,
  resolveInstanceConfig,
} from './paths.ts'
import { collectServerAddresses } from '../server-addresses.ts'
import { applyDevSyncTarball, type DevSyncState, newDevSyncState } from '../dev-sync-apply.ts'
import { writeInstanceTunnelToken } from '../tunnels.ts'
import { decodeBase64 } from '@std/encoding/base64'

/** Chained replace pattern Sonar S5145 recognizes for log-injection sanitization. */
function stripLogInjection(text: string): string {
  return text.replaceAll('\n', '_').replaceAll('\r', '_').replaceAll('\t', '_')
}

function sanitizeForLog(value: unknown): string {
  if (value instanceof Error) return stripLogInjection(value.message)
  if (typeof value === 'string') return stripLogInjection(value)
  try {
    return stripLogInjection(JSON.stringify(value) ?? String(value))
  } catch {
    return stripLogInjection(String(value))
  }
}

type DaemonMessage =
  | {
    type: 'hello'
    from: 'instance' | 'daemon'
    at: string
    hostname?: string
    serverId?: string
    machineId?: string
  }
  | { type: 'ping'; id: string; at: string }
  | { type: 'pong'; id: string; at: string }
  | { type: 'echo'; payload: unknown; at: string }
  | { type: 'version'; commit: string; branch: string; at: string }
  | { type: 'command'; id: string; command: string; at: string }
  | {
    type: 'command-result'
    id: string
    exitCode: number
    stdout: string
    stderr: string
    at: string
  }
  | { type: 'addresses-request'; id: string; at: string }
  | {
    type: 'addresses-result'
    id: string
    addresses: {
      privateIpv4: string[]
      privateIpv6: string[]
      publicIpv4: string[]
      publicIpv6: string[]
    }
    at: string
  }
  | {
    type: 'dev-sync-begin'
    id: string
    totalChunks: number
    totalBytes: number
    at: string
  }
  | { type: 'dev-sync-chunk'; id: string; index: number; data: string; at: string }
  | { type: 'dev-sync-end'; id: string; at: string }
  | { type: 'dev-sync-result'; id: string; ok: boolean; error?: string; at: string }
  | { type: 'tunnel-token'; id: string; token: string; at: string }
  | { type: 'tunnel-token-result'; id: string; ok: boolean; error?: string; at: string }

export interface InstanceClientOptions {
  config?: InstanceConfig
  httpClient?: Deno.HttpClient
  reconnectDelayMs?: number
  onMessage?: (message: DaemonMessage) => void
}

const SERVER_ID_PATH = '/etc/turbopanel/daemon/server.id'

async function readMachineId(): Promise<string | undefined> {
  try {
    const id = await Deno.readTextFile('/etc/machine-id')
    const trimmed = id.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

async function readServerId(): Promise<string | undefined> {
  try {
    const id = await Deno.readTextFile(SERVER_ID_PATH)
    const trimmed = id.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

async function writeServerId(serverId: string): Promise<void> {
  const trimmed = serverId.trim()
  if (!trimmed) return
  try {
    await Deno.mkdir('/etc/turbopanel/daemon', { recursive: true })
    await Deno.writeTextFile(SERVER_ID_PATH, `${trimmed}\n`)
  } catch (err) {
    console.warn('[instance] failed to persist server id:', sanitizeForLog(err))
  }
}

function parseMessage(raw: string): DaemonMessage | null {
  try {
    return JSON.parse(raw) as DaemonMessage
  } catch {
    return null
  }
}

export class InstanceClient {
  readonly #config: InstanceConfig
  readonly #httpClient: Deno.HttpClient | undefined
  readonly #reconnectDelayMs: number
  readonly #onMessage?: (message: DaemonMessage) => void

  #ws: WebSocket | undefined
  #stopped = false
  #connectLoopStarted = false
  readonly #devSync = new Map<string, DevSyncState>()

  constructor(options: InstanceClientOptions = {}) {
    this.#config = options.config ?? resolveInstanceConfig()
    this.#httpClient = options.httpClient
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 2_000
    this.#onMessage = options.onMessage
  }

  get config(): InstanceConfig {
    return this.#config
  }

  get target(): string {
    return describeInstance(this.#config)
  }

  #fetchInit(
    init: RequestInit = {},
  ): RequestInit & { client?: Deno.HttpClient } {
    return this.#httpClient ? { ...init, client: this.#httpClient } : init
  }

  async fetchHealth(): Promise<{ ok: boolean }> {
    const response = await fetch(
      instanceUrl(this.#config, '/api/health'),
      this.#fetchInit(),
    )
    if (!response.ok) {
      throw new Error(`health check failed: HTTP ${response.status}`)
    }
    return await response.json()
  }

  async fetchVersion(): Promise<{ commit: string; branch: string }> {
    const response = await fetch(
      instanceUrl(this.#config, '/api/daemon/v1/version'),
      this.#fetchInit(),
    )
    if (!response.ok) {
      throw new Error(`version fetch failed: HTTP ${response.status}`)
    }
    return await response.json()
  }

  async fetchConnections(): Promise<
    { connections: { id: string; connectedAt: string }[] }
  > {
    const response = await fetch(
      instanceUrl(this.#config, '/api/developer/v1/daemon/connections'),
      this.#fetchInit(),
    )
    if (!response.ok) {
      throw new Error(`connections fetch failed: HTTP ${response.status}`)
    }
    return await response.json()
  }

  start(): void {
    if (this.#connectLoopStarted) return
    this.#connectLoopStarted = true
    this.#stopped = false
    this.#runConnectLoop().catch((err) => {
      console.warn(
        '[instance] connect loop exited unexpectedly:',
        sanitizeForLog(err),
      )
    })
  }

  stop(): void {
    this.#stopped = true
    this.#ws?.close()
    this.#ws = undefined
  }

  send(message: DaemonMessage): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('instance websocket is not connected')
    }
    this.#ws.send(JSON.stringify(message))
  }

  async #runConnectLoop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#connectOnce()
      } catch (err) {
        console.warn(
          '[instance] websocket connect failed:',
          sanitizeForLog(err),
        )
        this.#closeActiveSocket()
      }

      if (this.#stopped) break
      await delay(this.#reconnectDelayMs)
    }
  }

  #newWebSocket(): WebSocket {
    const url = instanceWebSocketUrl(this.#config, '/ws/daemon/v1')
    return this.#httpClient
      ? new WebSocket(url, { client: this.#httpClient })
      : new WebSocket(url)
  }

  #closeActiveSocket(): void {
    const ws = this.#ws
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return
    }
    try {
      ws.close()
    } catch {
      // Socket may already be gone.
    }
    if (this.#ws === ws) this.#ws = undefined
  }

  async #connectOnce(): Promise<void> {
    await this.fetchHealth()

    // Do not close the active socket here: by the time #connectOnce() is called
    // from #runConnectLoop(), the previous socket has already closed naturally
    // (the loop awaits #connectOnce() which blocks until the 'close' event).
    // Calling #closeActiveSocket() here would kill a healthy connection on every
    // reconnect cycle, producing a perpetual ~2-second disconnect/reconnect storm.

    const ws = this.#newWebSocket()
    this.#ws = ws

    await new Promise<void>((resolve, reject) => {
      const fail = (err: unknown) => {
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }

      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onClose)
      }

      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (event: Event) => {
        fail((event as ErrorEvent).message ?? 'websocket error')
      }
      const onClose = () => {
        fail('websocket closed before open')
      }

      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onClose)
    })

    console.log('[instance] websocket connected via', sanitizeForLog(this.target))

    const hello: DaemonMessage = {
      type: 'hello',
      from: 'daemon',
      hostname: Deno.hostname(),
      serverId: await readServerId(),
      machineId: await readMachineId(),
      at: new Date().toISOString(),
    }
    ws.send(JSON.stringify(hello))

    ws.onmessage = (event) => {
      const raw = typeof event.data === 'string'
        ? event.data
        : String(event.data)
      const message = parseMessage(raw)
      if (!message) {
        console.warn('[instance] ignored non-JSON websocket message')
        return
      }

      this.#onMessage?.(message)
      this.#handleMessage(message, ws)
    }

    ws.onclose = () => {
      console.log('[instance] websocket closed')
      if (this.#ws === ws) this.#ws = undefined
    }

    await new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve(), { once: true })
    })
  }

  #handleMessage(message: DaemonMessage, ws: WebSocket): void {
    switch (message.type) {
      case 'hello':
        if (message.from === 'instance' && message.serverId) {
          void writeServerId(message.serverId)
        }
        console.log(
          '[instance] hello from',
          sanitizeForLog(message.from),
          sanitizeForLog(message.hostname ?? message.serverId ?? '(no identity)'),
          'at',
          sanitizeForLog(message.at),
        )
        break
      case 'ping':
        ws.send(JSON.stringify(
          {
            type: 'pong',
            id: message.id,
            at: new Date().toISOString(),
          } satisfies DaemonMessage,
        ))
        break
      case 'pong':
        console.log('[instance] pong', sanitizeForLog(message.id))
        break
      case 'version':
        // Informational only. The daemon never self-updates; updates are
        // operator-driven via the developer upgrade button / dev-sync push.
        break
      case 'echo':
        console.log('[instance] echo from instance:', sanitizeForLog(message.payload))
        ws.send(JSON.stringify(
          {
            type: 'echo',
            payload: { received: message.payload, from: 'daemon' },
            at: new Date().toISOString(),
          } satisfies DaemonMessage,
        ))
        break
      case 'command':
        this.#runCommand(message, ws).catch((err) => {
          console.warn(
            '[instance] command handler failed:',
            sanitizeForLog(err),
          )
        })
        break
      case 'addresses-request':
        this.#collectAddresses(message, ws)
        break
      case 'dev-sync-begin':
        this.#devSync.set(message.id, newDevSyncState(message.totalChunks))
        break
      case 'dev-sync-chunk': {
        const state = this.#devSync.get(message.id)
        if (state) state.chunks[message.index] = message.data
        break
      }
      case 'dev-sync-end':
        this.#applyDevSync(message.id, ws).catch((err) => {
          console.warn(
            '[instance] dev-sync handler failed:',
            sanitizeForLog(err),
          )
        })
        break
      case 'tunnel-token':
        this.#applyTunnelToken(message, ws).catch((err) => {
          console.warn(
            '[instance] tunnel-token handler failed:',
            sanitizeForLog(err),
          )
        })
        break
    }
  }

  async #applyDevSync(id: string, ws: WebSocket): Promise<void> {
    const state = this.#devSync.get(id)
    this.#devSync.delete(id)
    let ok = false
    let error: string | undefined
    try {
      if (!state) throw new Error('no dev-sync in progress for this id')
      const base64 = state.chunks.join('')
      const bytes = decodeBase64(base64)
      await applyDevSyncTarball(bytes)
      ok = true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      console.error('[dev-sync] failed:', sanitizeForLog(error))
    }

    const result: DaemonMessage = {
      type: 'dev-sync-result',
      id,
      ok,
      error,
      at: new Date().toISOString(),
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result))

    // Restart only after acking success, so the instance sees the result before
    // this process is replaced by the freshly-synced build.
    if (ok) await restartDaemonService()
  }

  async #applyTunnelToken(
    message: Extract<DaemonMessage, { type: 'tunnel-token' }>,
    ws: WebSocket,
  ): Promise<void> {
    let ok = false
    let error: string | undefined
    try {
      await writeInstanceTunnelToken(message.token)
      ok = true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      console.error('[tunnel-token] failed:', sanitizeForLog(error))
    }

    const result: DaemonMessage = {
      type: 'tunnel-token-result',
      id: message.id,
      ok,
      error,
      at: new Date().toISOString(),
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result))
  }

  #collectAddresses(
    message: Extract<DaemonMessage, { type: 'addresses-request' }>,
    ws: WebSocket,
  ): void {
    let addresses: Extract<DaemonMessage, { type: 'addresses-result' }>['addresses']
    try {
      addresses = collectServerAddresses()
    } catch (err) {
      console.warn(
        '[instance] collect addresses failed:',
        sanitizeForLog(err),
      )
      addresses = {
        privateIpv4: [],
        privateIpv6: [],
        publicIpv4: [],
        publicIpv6: [],
      }
    }

    const result: DaemonMessage = {
      type: 'addresses-result',
      id: message.id,
      addresses,
      at: new Date().toISOString(),
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result))
    }
  }

  /**
   * Run a shell command requested by the instance and stream the result back.
   *
   * TEMPORARY: this executes arbitrary shell commands with the daemon's full
   * privileges and has no auth. It exists only for the dev-only developer panel.
   */
  async #runCommand(
    message: Extract<DaemonMessage, { type: 'command' }>,
    ws: WebSocket,
  ): Promise<void> {
    console.log('[instance] run command:', stripLogInjection(message.command))
    let result: Extract<DaemonMessage, { type: 'command-result' }>
    try {
      const command = new Deno.Command('sh', {
        args: ['-c', message.command],
        stdout: 'piped',
        stderr: 'piped',
      })
      const { code, stdout, stderr } = await command.output()
      result = {
        type: 'command-result',
        id: message.id,
        exitCode: code,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
        at: new Date().toISOString(),
      }
    } catch (err) {
      result = {
        type: 'command-result',
        id: message.id,
        exitCode: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      }
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result))
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Ask systemd to restart this daemon (used after a dev-sync swap). */
async function restartDaemonService(): Promise<void> {
  const unit = Deno.env.get('TURBOPANEL_SERVICE_NAME')?.trim() ||
    'turbopanel-daemon'
  try {
    const result = await new Deno.Command('systemctl', {
      args: ['restart', unit],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!result.success) {
      const safeUnit = stripLogInjection(unit)
      const safeStderr = stripLogInjection(
        new TextDecoder().decode(result.stderr).trim() || 'unknown error',
      )
      console.warn('[dev-sync] systemctl restart', safeUnit, 'failed:', safeStderr)
    }
  } catch (err) {
    console.warn('[dev-sync] restart failed:', sanitizeForLog(err))
  }
}

export async function connectInstance(
  options: InstanceClientOptions = {},
): Promise<InstanceClient> {
  const reconnectDelayMs = options.reconnectDelayMs ?? 2_000
  const config = options.config ?? resolveInstanceConfig()
  const httpClient = options.httpClient ??
    await createInstanceHttpClient(config, {
      caCertPath: Deno.env.get('TURBOPANEL_INSTANCE_CA')?.trim() || undefined,
    })

  const client = new InstanceClient({
    ...options,
    config,
    httpClient,
    reconnectDelayMs,
  })

  while (true) {
    try {
      const health = await client.fetchHealth()
      console.log(
        '[instance] REST health:',
        sanitizeForLog(health),
        'via',
        sanitizeForLog(client.target),
      )
      break
    } catch (err) {
      console.warn(
        '[instance] waiting for instance:',
        sanitizeForLog(err),
      )
      await delay(reconnectDelayMs)
    }
  }

  client.start()
  return client
}

export type { DaemonMessage }
