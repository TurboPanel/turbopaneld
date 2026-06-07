import { connectInstance } from './src/instance/client.ts'
import { initOrchestration } from './src/orchestration/setup.ts'
import { startTunnels } from './src/tunnels.ts'
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

// The daemon never self-updates. Updates are driven explicitly by an operator
// through the admin "Upgrade System" button or the dev-sync push; all installs
// and updates run via Ansible (the daemon is the constant that owns them).
const instance = await connectInstance({})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => {
    instance.stop()
    abort.abort()
  })
}

await new Promise<void>((resolve) => {
  abort.signal.addEventListener('abort', () => resolve())
})
