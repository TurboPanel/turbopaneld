import { connectInstance, type DaemonMessage } from './src/instance/client.ts'
import { initOrchestration } from './src/orchestration/setup.ts'
import { startTunnels } from './src/tunnels.ts'
import { maybeUpdate } from './src/updater.ts'
import {
  agentDebugLog,
  probeLogDirectory,
  readParentComm,
} from './src/debug-log.ts'

console.log('Hello from turbopanel-daemon')

// #region agent log
const logDir = '/var/log/turbopanel/daemon'
const parentComm = await readParentComm()
const logProbe = await probeLogDirectory(logDir)
await agentDebugLog('main.ts:startup', 'daemon startup logging probe', {
  hostname: Deno.hostname(),
  pid: Deno.pid,
  parentComm,
  systemdUnitEnv: Deno.env.get('INVOCATION_ID') ?? null,
  logProbe,
}, 'H1')
// #endregion

await initOrchestration()

// #region agent log
const logProbeAfter = await probeLogDirectory(logDir)
await agentDebugLog('main.ts:post-orchestration', 'post-orchestration logging probe', {
  parentComm: await readParentComm(),
  logProbe: logProbeAfter,
}, 'H3')
// #endregion

const abort = new AbortController()

// Start any configured Cloudflare tunnels (downloads cloudflared on demand).
await startTunnels(abort.signal)

const instance = await connectInstance({
  onMessage: (message: DaemonMessage) => {
    if (message.type === 'version') {
      void maybeUpdate(message.commit)
    }
  },
})

// Fallback poll in case a pushed `version` message is missed (e.g. a reconnect
// gap). The WS push above is the primary, near-instant path.
const versionPoll = setInterval(async () => {
  try {
    const { commit } = await instance.fetchVersion()
    await maybeUpdate(commit)
  } catch {
    // Instance unreachable / endpoint missing: ignore and retry next tick.
  }
}, 60_000)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => {
    clearInterval(versionPoll)
    instance.stop()
    abort.abort()
  })
}

await new Promise<void>((resolve) => {
  abort.signal.addEventListener('abort', () => resolve())
})
