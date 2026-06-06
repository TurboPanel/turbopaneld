import {
  createInstanceHttpClient,
  describeInstance,
  type InstanceConfig,
  instanceUrl,
  instanceWebSocketUrl,
  resolveInstanceConfig,
} from './paths.ts'
import { collectServerAddresses } from '../server-addresses.ts'

type DaemonMessage =
  | {
    type: 'hello'
    from: 'instance' | 'daemon'
    at: string
    hostname?: string
    nodeId?: string
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

export interface InstanceClientOptions {
  config?: InstanceConfig
  httpClient?: Deno.HttpClient
  reconnectDelayMs?: number
  onMessage?: (message: DaemonMessage) => void
}

async function readNodeId(): Promise<string | undefined> {
  try {
    const id = await Deno.readTextFile('/etc/machine-id')
    const trimmed = id.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
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
  #connectLoop: Promise<void> | undefined

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
      instanceUrl(this.#config, '/api/daemon/version'),
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
      instanceUrl(this.#config, '/api/daemon/connections'),
      this.#fetchInit(),
    )
    if (!response.ok) {
      throw new Error(`connections fetch failed: HTTP ${response.status}`)
    }
    return await response.json()
  }

  start(): void {
    if (this.#connectLoop) return
    this.#stopped = false
    this.#connectLoop = this.#runConnectLoop()
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
          err instanceof Error ? err.message : err,
        )
      }

      if (this.#stopped) break
      await delay(this.#reconnectDelayMs)
    }
  }

  #newWebSocket(): WebSocket {
    const url = instanceWebSocketUrl(this.#config, '/ws')
    return this.#httpClient
      ? new WebSocket(url, { client: this.#httpClient })
      : new WebSocket(url)
  }

  async #connectOnce(): Promise<void> {
    await this.fetchHealth()

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

    console.log('[instance] websocket connected via', this.target)

    const hello: DaemonMessage = {
      type: 'hello',
      from: 'daemon',
      hostname: Deno.hostname(),
      nodeId: await readNodeId(),
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
        console.log(
          '[instance] hello from',
          message.from,
          message.hostname ?? '(no hostname)',
          'at',
          message.at,
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
        console.log('[instance] pong', message.id)
        break
      case 'version':
        // Handled by the updater via the onMessage hook.
        break
      case 'echo':
        console.log('[instance] echo from instance:', message.payload)
        ws.send(JSON.stringify(
          {
            type: 'echo',
            payload: { received: message.payload, from: 'daemon' },
            at: new Date().toISOString(),
          } satisfies DaemonMessage,
        ))
        break
      case 'command':
        void this.#runCommand(message, ws)
        break
      case 'addresses-request':
        void this.#collectAddresses(message, ws)
        break
    }
  }

  async #collectAddresses(
    message: Extract<DaemonMessage, { type: 'addresses-request' }>,
    ws: WebSocket,
  ): Promise<void> {
    let addresses: Extract<DaemonMessage, { type: 'addresses-result' }>['addresses']
    try {
      addresses = collectServerAddresses()
    } catch (err) {
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
   * privileges and has no auth. It exists only for the dev/test admin panel.
   */
  async #runCommand(
    message: Extract<DaemonMessage, { type: 'command' }>,
    ws: WebSocket,
  ): Promise<void> {
    console.log('[instance] run command:', message.command)
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
      console.log('[instance] REST health:', health, 'via', client.target)
      break
    } catch (err) {
      console.warn(
        '[instance] waiting for instance:',
        err instanceof Error ? err.message : err,
      )
      await delay(reconnectDelayMs)
    }
  }

  client.start()
  return client
}

export type { DaemonMessage }
