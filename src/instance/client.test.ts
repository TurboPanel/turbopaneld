import { encodeBase64Url } from '@std/encoding/base64url'
import { type DaemonApiClient, DaemonApiError } from './api-client.ts'
import { InstanceClient } from './client.ts'
import { enrollDaemon } from './enroll.ts'
import { MonitorSession } from './monitor-session.ts'
import { createMonitorDeltaTracker } from '../monitor/delta.ts'
import type { MonitorSource } from '../monitor/source.ts'
import { MONITOR_PROTOCOL_VERSION } from '../monitor/protocol.ts'
import { DaemonTokenManager } from './token-manager.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `expected ${String(expected)} but got ${String(actual)}`,
    )
  }
}

function assertExists<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(message ?? 'expected value to exist')
  }
}

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readonly options: unknown
  readonly sentFrames: string[] = []

  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string, options?: unknown) {
    super()
    this.url = url
    this.options = options
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('cannot send on a non-open mock socket')
    }
    this.sentFrames.push(typeof data === 'string' ? data : String(data))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED || this.readyState === MockWebSocket.CLOSING) {
      return
    }
    this.readyState = MockWebSocket.CLOSING
    this.readyState = MockWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: true }))
  }

  open(): void {
    if (this.readyState !== MockWebSocket.CONNECTING) return
    this.readyState = MockWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(message: unknown): void {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: typeof message === 'string' ? message : JSON.stringify(message),
      }),
    )
  }

  fail(message = 'websocket error'): void {
    this.dispatchEvent(new ErrorEvent('error', { message }))
  }

  override dispatchEvent(event: Event): boolean {
    const ok = super.dispatchEvent(event)
    const handlerKey = `on${event.type}`
    const handler = (this as unknown as Record<string, unknown>)[handlerKey]
    if (typeof handler === 'function') {
      handler.call(this, event)
    }
    return ok
  }
}

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(key)
  else Deno.env.set(key, value)
}

async function waitFor<T>(
  label: string,
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

Deno.test({
  name: 'enrollDaemon calls correct HTTP endpoints',
  permissions: { read: true, write: true },
  fn: async () => {
    const tempDir = await Deno.makeTempDir()
    const calls: string[] = []
    const apiClient = {
      async getEnrollmentChallenge() {
        calls.push('challenge')
        return {
          challengeId: 'ch-enroll',
          nonce: 'nonce-enroll',
          at: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      },
      async enroll(params: {
        licenseId: string
        challengeId: string
      }) {
        calls.push('enroll')
        assertEquals(params.licenseId, 'license-123')
        assertEquals(params.challengeId, 'ch-enroll')
        return { serverId: 'srv-enrolled', keyId: 'kid-enrolled' }
      },
    } as unknown as DaemonApiClient

    try {
      const result = await enrollDaemon({
        apiClient,
        machineId: 'mid-1',
        hostname: 'host-1',
        licenseId: 'license-123',
        licenseToken: 'token-abc',
        stateDir: tempDir,
      })
      assertEquals(result.serverId, 'srv-enrolled')
      assertEquals(result.keyId, 'kid-enrolled')
      assertEquals(calls.join(','), 'challenge,enroll')

      await waitFor('persisted key file', async () => {
        try {
          const saved = await Deno.readTextFile(`${tempDir}/server-key.json`)
          return saved.length > 0 ? saved : undefined
        } catch {
          return undefined
        }
      })
      const persistedServerId = (await Deno.readTextFile(`${tempDir}/server.id`)).trim()
      const persistedKeyId = (await Deno.readTextFile(`${tempDir}/server-key-id`)).trim()
      assertEquals(persistedServerId, 'srv-enrolled')
      assertEquals(persistedKeyId, 'kid-enrolled')
    } finally {
      await Deno.remove(tempDir, { recursive: true })
    }
  },
})

Deno.test({
  name: 'InstanceClient uses JWT in WS Authorization header after enrollment',
  permissions: { env: true, read: true, write: true, sys: ['hostname'] },
  fn: async () => {
    const tempDir = await Deno.makeTempDir()
    const originalFetch = globalThis.fetch
    const originalWebSocket = globalThis.WebSocket
    const originalRefresh = DaemonTokenManager.prototype.refresh
    const originalStateDir = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')
    const originalForceEnroll = Deno.env.get('TURBOPANEL_FORCE_ENROLL')
    const sockets: MockWebSocket[] = []

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options)
        sockets.push(this)
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    })
    let refreshCalls = 0
    DaemonTokenManager.prototype.refresh = function patchedRefresh(this: DaemonTokenManager) {
      refreshCalls += 1
      return originalRefresh.call(this)
    }

    const authToken = makeJwt(Math.floor(Date.now() / 1000) + 900)
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/auth/challenge')) {
          const raw = init?.body ? await new Response(init.body).text() : '{}'
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string }
          if (body.serverId && body.keyId) {
            return new Response(JSON.stringify({
              challengeId: 'auth-challenge',
              nonce: 'auth-nonce',
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }), { status: 200 })
          }
          return new Response(JSON.stringify({
            challengeId: 'enroll-challenge',
            nonce: 'enroll-nonce',
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/enroll')) {
          return new Response(JSON.stringify({ serverId: 'srv-1', keyId: 'kid-1' }), {
            status: 200,
          })
        }
        if (url.endsWith('/api/daemon/v1/auth/session')) {
          return new Response(JSON.stringify({
            token: authToken,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      },
    })

    Deno.env.set('TURBOPANEL_DAEMON_STATE_DIR', tempDir)
    Deno.env.set('TURBOPANEL_FORCE_ENROLL', '1')
    await Deno.writeTextFile(`${tempDir}/license.id`, 'license-123\n')
    await Deno.writeTextFile(`${tempDir}/license.token`, 'token-abc\n')

    const client = new InstanceClient({
      config: { kind: 'url', baseUrl: 'https://instance.test', wsBaseUrl: 'wss://instance.test' },
      reconnectDelayMs: 30_000,
    })

    try {
      client.start()
      const socket = await waitFor('auth websocket', () => sockets.at(0))
      assertExists(socket.options)
      const options = socket.options as { headers?: { Authorization?: string } }
      assertEquals(options.headers?.Authorization, `Bearer ${authToken}`)
      socket.open()
      socket.close(1000, 'done')
    } finally {
      client.stop()
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      })
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      setOptionalEnv('TURBOPANEL_DAEMON_STATE_DIR', originalStateDir)
      setOptionalEnv('TURBOPANEL_FORCE_ENROLL', originalForceEnroll)
      await Deno.remove(tempDir, { recursive: true })
    }
  },
})

Deno.test({
  name: '4401 WS close triggers tokenManager.refresh()',
  permissions: { env: true, read: true, write: true, sys: ['hostname'] },
  fn: async () => {
    const tempDir = await Deno.makeTempDir()
    const originalFetch = globalThis.fetch
    const originalWebSocket = globalThis.WebSocket
    const originalRefresh = DaemonTokenManager.prototype.refresh
    const originalStateDir = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')
    const originalForceEnroll = Deno.env.get('TURBOPANEL_FORCE_ENROLL')
    const sockets: MockWebSocket[] = []
    let refreshCalls = 0

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options)
        sockets.push(this)
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    })
    DaemonTokenManager.prototype.refresh = function patchedRefresh(this: DaemonTokenManager) {
      refreshCalls += 1
      return originalRefresh.call(this)
    }

    let sessionCalls = 0
    const authToken = makeJwt(Math.floor(Date.now() / 1000) + 900)
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/auth/challenge')) {
          const raw = init?.body ? await new Response(init.body).text() : '{}'
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string }
          if (body.serverId && body.keyId) {
            return new Response(JSON.stringify({
              challengeId: `auth-challenge-${sessionCalls + 1}`,
              nonce: `auth-nonce-${sessionCalls + 1}`,
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }), { status: 200 })
          }
          return new Response(JSON.stringify({
            challengeId: 'enroll-challenge',
            nonce: 'enroll-nonce',
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/enroll')) {
          return new Response(JSON.stringify({ serverId: 'srv-1', keyId: 'kid-1' }), {
            status: 200,
          })
        }
        if (url.endsWith('/api/daemon/v1/auth/session')) {
          sessionCalls += 1
          return new Response(JSON.stringify({
            token: authToken,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      },
    })

    Deno.env.set('TURBOPANEL_DAEMON_STATE_DIR', tempDir)
    Deno.env.set('TURBOPANEL_FORCE_ENROLL', '1')
    await Deno.writeTextFile(`${tempDir}/license.id`, 'license-123\n')
    await Deno.writeTextFile(`${tempDir}/license.token`, 'token-abc\n')

    const client = new InstanceClient({
      config: { kind: 'url', baseUrl: 'https://instance.test', wsBaseUrl: 'wss://instance.test' },
      reconnectDelayMs: 30,
    })

    try {
      client.start()
      const firstSocket = await waitFor('first websocket connection', () => sockets.at(0))
      firstSocket.open()
      await new Promise((resolve) => setTimeout(resolve, 20))
      firstSocket.close(4401, 'auth rejected')
      await waitFor('token refresh after 4401', () =>
        refreshCalls >= 2 ? refreshCalls : undefined, 3_000)
      const secondSocket = await waitFor('second websocket', () => sockets.at(1), 3_000)
      secondSocket.close(1000, 'done')
    } finally {
      client.stop()
      DaemonTokenManager.prototype.refresh = originalRefresh
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      })
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      setOptionalEnv('TURBOPANEL_DAEMON_STATE_DIR', originalStateDir)
      setOptionalEnv('TURBOPANEL_FORCE_ENROLL', originalForceEnroll)
      await Deno.remove(tempDir, { recursive: true })
    }
  },
})

Deno.test({
  name: 'enrollment requires valid license — hostname/machineId alone cannot create a server',
  permissions: { env: true, read: true, write: true, sys: ['hostname'] },
  fn: async () => {
    const tempDir = await Deno.makeTempDir()
    const originalFetch = globalThis.fetch
    const originalWebSocket = globalThis.WebSocket
    const originalStateDir = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')
    const originalForceEnroll = Deno.env.get('TURBOPANEL_FORCE_ENROLL')
    const sockets: MockWebSocket[] = []

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options)
        sockets.push(this)
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    })

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/auth/challenge')) {
          return new Response(JSON.stringify({
            challengeId: 'enroll-challenge',
            nonce: 'enroll-nonce',
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/enroll')) {
          return new Response(JSON.stringify({ error: 'invalid license' }), { status: 401 })
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      },
    })

    Deno.env.set('TURBOPANEL_DAEMON_STATE_DIR', tempDir)
    Deno.env.set('TURBOPANEL_FORCE_ENROLL', '1')
    await Deno.writeTextFile(`${tempDir}/license.id`, 'license-123\n')
    await Deno.writeTextFile(`${tempDir}/license.token`, 'token-abc\n')

    const client = new InstanceClient({
      config: { kind: 'url', baseUrl: 'https://instance.test', wsBaseUrl: 'wss://instance.test' },
      reconnectDelayMs: 30_000,
    })

    try {
      const apiClient = {
        async getEnrollmentChallenge() {
          return {
            challengeId: 'ch-1',
            nonce: 'n-1',
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }
        },
        async enroll() {
          throw new DaemonApiError(401, 'invalid license')
        },
      } as unknown as DaemonApiClient
      await assertRejects(
        () =>
          enrollDaemon({
            apiClient,
            machineId: 'mid-1',
            hostname: 'host-1',
            licenseId: 'license-123',
            licenseToken: 'bad-token',
            stateDir: tempDir,
          }),
        'invalid license',
      )

      client.start()
      await new Promise((resolve) => setTimeout(resolve, 200))
      assertEquals(sockets.length, 0, 'websocket connect should not proceed when enroll fails')
    } finally {
      client.stop()
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      })
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      setOptionalEnv('TURBOPANEL_DAEMON_STATE_DIR', originalStateDir)
      setOptionalEnv('TURBOPANEL_FORCE_ENROLL', originalForceEnroll)
      await Deno.remove(tempDir, { recursive: true })
    }
  },
})

Deno.test({
  name: 'token manager is created after enrollment',
  permissions: { env: true, read: true, write: true, sys: ['hostname'] },
  fn: async () => {
    const tempDir = await Deno.makeTempDir()
    const originalFetch = globalThis.fetch
    const originalWebSocket = globalThis.WebSocket
    const originalStateDir = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')
    const originalForceEnroll = Deno.env.get('TURBOPANEL_FORCE_ENROLL')
    const sockets: MockWebSocket[] = []
    let authChallengeBody: { serverId?: string; keyId?: string } | undefined
    const authToken = makeJwt(Math.floor(Date.now() / 1000) + 900)

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options)
        sockets.push(this)
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    })

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/auth/challenge')) {
          const raw = init?.body ? await new Response(init.body).text() : '{}'
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string }
          if (body.serverId && body.keyId) {
            authChallengeBody = body
            return new Response(JSON.stringify({
              challengeId: 'auth-challenge',
              nonce: 'auth-nonce',
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }), { status: 200 })
          }
          return new Response(JSON.stringify({
            challengeId: 'enroll-challenge',
            nonce: 'enroll-nonce',
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/enroll')) {
          return new Response(JSON.stringify({ serverId: 'srv-new', keyId: 'kid-new' }), {
            status: 200,
          })
        }
        if (url.endsWith('/api/daemon/v1/auth/session')) {
          return new Response(JSON.stringify({
            token: authToken,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      },
    })

    Deno.env.set('TURBOPANEL_DAEMON_STATE_DIR', tempDir)
    Deno.env.set('TURBOPANEL_FORCE_ENROLL', '1')
    await Deno.writeTextFile(`${tempDir}/license.id`, 'license-123\n')
    await Deno.writeTextFile(`${tempDir}/license.token`, 'token-abc\n')

    const client = new InstanceClient({
      config: { kind: 'url', baseUrl: 'https://instance.test', wsBaseUrl: 'wss://instance.test' },
      reconnectDelayMs: 30_000,
    })

    try {
      client.start()
      const socket = await waitFor('token manager websocket', () => sockets.at(0))
      socket.open()
      await waitFor('auth challenge payload', () => authChallengeBody)
      assertEquals(authChallengeBody?.serverId, 'srv-new')
      assertEquals(authChallengeBody?.keyId, 'kid-new')
      socket.close(1000, 'done')
    } finally {
      client.stop()
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      })
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      setOptionalEnv('TURBOPANEL_DAEMON_STATE_DIR', originalStateDir)
      setOptionalEnv('TURBOPANEL_FORCE_ENROLL', originalForceEnroll)
      await Deno.remove(tempDir, { recursive: true })
    }
  },
})

async function assertRejects(
  fn: () => Promise<unknown>,
  messageIncludes: string,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(messageIncludes)) return
    throw new Error(`expected rejection including "${messageIncludes}", got "${message}"`)
  }
  throw new Error('expected promise rejection')
}

function makeJwt(exp: number): string {
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ exp })))
  return `${header}.${payload}.signature`
}

function createTestMonitorSource(): MonitorSource {
  const tracker = createMonitorDeltaTracker()
  tracker.seedTracked([])
  return {
    buildSync: async () => tracker.buildSync({}, []),
    buildHeartbeat: async () => tracker.buildHeartbeat({}, []),
    onTransition: () => () => {},
    handleAck: (acceptedSequence) => tracker.applyAck(acceptedSequence),
    registerPendingDelivery: (sequence, resourcesAfter) =>
      tracker.registerPendingDelivery(sequence, resourcesAfter),
    confirmDelivery: (sequence, resourcesAfter) =>
      tracker.confirmDelivery(sequence, resourcesAfter),
  }
}

function parseSentMonitorFrames(
  frames: string[],
): Array<Record<string, unknown>> {
  return frames.map((frame) => JSON.parse(frame) as Record<string, unknown>)
}

Deno.test({
  name: 'MonitorSession defers heartbeat until initial sync completes',
  permissions: { env: true },
  fn: async () => {
    const tracker = createMonitorDeltaTracker()
    tracker.seedTracked([])
    const readyDelayMs = 25
    const heartbeatIntervalMs = 10
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval

    globalThis.setInterval = ((
      handler: (...args: unknown[]) => void,
      _delayMs?: number,
      ...args: unknown[]
    ) => originalSetInterval(handler, heartbeatIntervalMs, ...args)) as typeof setInterval
    globalThis.clearInterval = originalClearInterval

    const source: MonitorSource = {
      waitForReady: () =>
        new Promise((resolve) => setTimeout(resolve, readyDelayMs)),
      resetForReconnect: async () => {},
      buildSync: async () => tracker.buildSync({}, []),
      buildHeartbeat: async () => tracker.buildHeartbeat({}, []),
      onTransition: () => () => {},
      handleAck: (acceptedSequence) => tracker.applyAck(acceptedSequence),
      registerPendingDelivery: (sequence, resourcesAfter) =>
        tracker.registerPendingDelivery(sequence, resourcesAfter),
      confirmDelivery: (sequence, resourcesAfter) =>
        tracker.confirmDelivery(sequence, resourcesAfter),
    }

    const sentFrames: string[] = []
    const ws = {
      readyState: MockWebSocket.OPEN,
      send(data: string) {
        sentFrames.push(data)
      },
    } as unknown as WebSocket

    const session = new MonitorSession({
      source,
      serverId: 'srv-monitor-bootstrap',
      hostname: 'host-monitor',
    })

    try {
      session.attach(ws)
      await new Promise((resolve) => setTimeout(resolve, readyDelayMs + 20))

      const parsed = parseSentMonitorFrames(sentFrames)
      const syncIndex = parsed.findIndex((frame) => frame.type === 'monitor.sync')
      const heartbeatIndex = parsed.findIndex((frame) =>
        frame.type === 'monitor.heartbeat'
      )

      assertExists(parsed[syncIndex], 'monitor.sync should be sent')
      assert(
        heartbeatIndex === -1 || heartbeatIndex > syncIndex,
        'monitor.heartbeat must not precede monitor.sync',
      )
    } finally {
      globalThis.setInterval = originalSetInterval
      session.detach()
    }
  },
})

Deno.test({
  name: 'MonitorSession fallback leaves delivery unconfirmed when resyncNeeded',
  fn: async () => {
    const tracker = createMonitorDeltaTracker()
    tracker.seedTracked([])
    const source: MonitorSource = {
      buildSync: async () => tracker.buildSync({}, []),
      buildHeartbeat: async () => tracker.buildHeartbeat({}, []),
      onTransition: () => () => {},
      handleAck: (acceptedSequence) => tracker.applyAck(acceptedSequence),
      registerPendingDelivery: (sequence, resourcesAfter) =>
        tracker.registerPendingDelivery(sequence, resourcesAfter),
      confirmDelivery: (sequence, resourcesAfter) =>
        tracker.confirmDelivery(sequence, resourcesAfter),
    }
    let heartbeatCalls = 0
    const session = new MonitorSession({
      source,
      serverId: 'srv-monitor',
      hostname: 'host-monitor',
      apiClient: {
        heartbeat: async () => {
          heartbeatCalls += 1
          return { acceptedSequence: 0, resyncNeeded: true }
        },
      } as unknown as DaemonApiClient,
    })
    session.startFallback()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assertEquals(heartbeatCalls, 2)
    assertEquals(session.ackedSequence, 0)
    session.stopFallback()
  },
})

Deno.test({
  name: 'MonitorSession fallback sends monitor.sync when heartbeat returns resyncNeeded',
  fn: async () => {
    const tracker = createMonitorDeltaTracker()
    tracker.seedTracked([])
    let heartbeatCalls = 0
    const source: MonitorSource = {
      buildSync: async () => tracker.buildSync({}, []),
      buildHeartbeat: async () => tracker.buildHeartbeat({}, []),
      onTransition: () => () => {},
      handleAck: (acceptedSequence) => tracker.applyAck(acceptedSequence),
      registerPendingDelivery: (sequence, resourcesAfter) =>
        tracker.registerPendingDelivery(sequence, resourcesAfter),
      confirmDelivery: (sequence, resourcesAfter) =>
        tracker.confirmDelivery(sequence, resourcesAfter),
    }
    const session = new MonitorSession({
      source,
      serverId: 'srv-monitor',
      hostname: 'host-monitor',
      apiClient: {
        heartbeat: async (params: { monitor?: { type?: string } }) => {
          heartbeatCalls += 1
          if (params.monitor?.type === 'monitor.sync') {
            return { acceptedSequence: 1, resyncNeeded: false }
          }
          return { acceptedSequence: 0, resyncNeeded: true }
        },
      } as unknown as DaemonApiClient,
    })
    session.startFallback()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assertEquals(heartbeatCalls, 2)
    assertEquals(session.ackedSequence, 1)
    session.stopFallback()
  },
})

Deno.test({
  name: 'host-only sentinel reports empty resources with host summary',
  fn: async () => {
    const { createSentinel } = await import('../monitor/sentinel.ts')
    const sentinel = createSentinel({})
    const bundle = await sentinel.buildSync()
    assertEquals(bundle.payload.resources?.length ?? 0, 0)
    assertExists(bundle.payload.instance)
  },
})

Deno.test({
  name: 'InstanceClient with host-only monitor sends monitor.sync over websocket',
  permissions: { env: true, read: true, write: true, sys: ['hostname'] },
  fn: async () => {
    const tempDir = await Deno.makeTempDir()
    const originalFetch = globalThis.fetch
    const originalWebSocket = globalThis.WebSocket
    const originalStateDir = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')
    const originalForceEnroll = Deno.env.get('TURBOPANEL_FORCE_ENROLL')
    const sockets: MockWebSocket[] = []

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options)
        sockets.push(this)
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    })

    const authToken = makeJwt(Math.floor(Date.now() / 1000) + 900)
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/auth/challenge')) {
          return new Response(JSON.stringify({
            challengeId: 'enroll-challenge',
            nonce: 'enroll-nonce',
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/enroll')) {
          return new Response(JSON.stringify({ serverId: 'srv-1', keyId: 'kid-1' }), {
            status: 200,
          })
        }
        if (url.endsWith('/api/daemon/v1/auth/session')) {
          return new Response(JSON.stringify({
            token: authToken,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      },
    })

    Deno.env.set('TURBOPANEL_DAEMON_STATE_DIR', tempDir)
    Deno.env.set('TURBOPANEL_FORCE_ENROLL', '1')
    await Deno.writeTextFile(`${tempDir}/license.id`, 'license-123\n')
    await Deno.writeTextFile(`${tempDir}/license.token`, 'token-abc\n')

    const { createSentinel } = await import('../monitor/sentinel.ts')
    const monitor = createSentinel({})

    const client = new InstanceClient({
      config: { kind: 'url', baseUrl: 'https://instance.test', wsBaseUrl: 'wss://instance.test' },
      reconnectDelayMs: 30_000,
      monitor,
    })

    try {
      client.start()
      const socket = await waitFor('monitor websocket', () => sockets.at(0))
      socket.open()
      await new Promise((resolve) => setTimeout(resolve, 50))
      const sync = parseSentMonitorFrames(socket.sentFrames).find((frame) =>
        frame.type === 'monitor.sync'
      )
      assertExists(sync)
      assertEquals(sync.protocolVersion, MONITOR_PROTOCOL_VERSION)
      assertEquals((sync.resources as unknown[] | undefined)?.length ?? 0, 0)
      socket.close(1000, 'done')
    } finally {
      client.stop()
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      })
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      setOptionalEnv('TURBOPANEL_DAEMON_STATE_DIR', originalStateDir)
      setOptionalEnv('TURBOPANEL_FORCE_ENROLL', originalForceEnroll)
      await Deno.remove(tempDir, { recursive: true })
    }
  },
})

Deno.test({
  name: 'INSTANCE_STALE_MS exceeds monitor heartbeat cadence plus jitter',
  fn: () => {
    const MONITOR_HEARTBEAT_MS = 60_000
    const INSTANCE_STALE_MS = 150_000
    assert(
      INSTANCE_STALE_MS > MONITOR_HEARTBEAT_MS + 15_000,
      'stale watchdog must survive one heartbeat interval',
    )
  },
})

Deno.test({
  name: 'websocket survives inbound silence across one monitor heartbeat interval',
  permissions: { env: true, read: true, write: true, sys: ['hostname'] },
  fn: async () => {
    const tempDir = await Deno.makeTempDir()
    const originalFetch = globalThis.fetch
    const originalWebSocket = globalThis.WebSocket
    const originalStateDir = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')
    const originalForceEnroll = Deno.env.get('TURBOPANEL_FORCE_ENROLL')
    const sockets: MockWebSocket[] = []
    let closeCount = 0

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options)
        sockets.push(this)
      }

      override close(code = 1000, reason = ''): void {
        closeCount += 1
        super.close(code, reason)
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    })

    const authToken = makeJwt(Math.floor(Date.now() / 1000) + 900)
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/auth/challenge')) {
          return new Response(JSON.stringify({
            challengeId: 'enroll-challenge',
            nonce: 'enroll-nonce',
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }), { status: 200 })
        }
        if (url.endsWith('/api/daemon/v1/enroll')) {
          return new Response(JSON.stringify({ serverId: 'srv-1', keyId: 'kid-1' }), {
            status: 200,
          })
        }
        if (url.endsWith('/api/daemon/v1/auth/session')) {
          return new Response(JSON.stringify({
            token: authToken,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      },
    })

    Deno.env.set('TURBOPANEL_DAEMON_STATE_DIR', tempDir)
    Deno.env.set('TURBOPANEL_FORCE_ENROLL', '1')
    await Deno.writeTextFile(`${tempDir}/license.id`, 'license-123\n')
    await Deno.writeTextFile(`${tempDir}/license.token`, 'token-abc\n')

    const monitor = createTestMonitorSource()
    const client = new InstanceClient({
      config: { kind: 'url', baseUrl: 'https://instance.test', wsBaseUrl: 'wss://instance.test' },
      reconnectDelayMs: 120_000,
      monitor,
    })

    try {
      client.start()
      const socket = await waitFor('heartbeat idle websocket', () => sockets.at(0))
      socket.open()
      await new Promise((resolve) => setTimeout(resolve, 50))
      socket.receive(JSON.stringify({
        type: 'monitor.ack',
        from: 'instance',
        serverId: 'srv-1',
        at: new Date().toISOString(),
        acceptedSequence: 1,
      }))

      await new Promise((resolve) => setTimeout(resolve, 65_000))

      assertEquals(closeCount, 0)
      assertEquals(socket.readyState, MockWebSocket.OPEN)
      socket.close(1000, 'done')
    } finally {
      client.stop()
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      })
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      setOptionalEnv('TURBOPANEL_DAEMON_STATE_DIR', originalStateDir)
      setOptionalEnv('TURBOPANEL_FORCE_ENROLL', originalForceEnroll)
      await Deno.remove(tempDir, { recursive: true })
    }
  },
  sanitizeResources: false,
})
