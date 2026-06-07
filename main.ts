import { connectInstance } from './src/instance/client.ts'
import { initOrchestration } from './src/orchestration/setup.ts'
import { startTunnels } from './src/tunnels.ts'

console.log('Hello from turbopanel-daemon')

await initOrchestration()

const abort = new AbortController()

// Start any configured Cloudflare tunnels (downloads cloudflared on demand).
await startTunnels(abort.signal)

// The daemon never self-updates. Updates are driven explicitly by an operator
// through the developer "Upgrade System" button or the dev-sync push; all installs
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
