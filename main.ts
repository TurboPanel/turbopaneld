import { DockerClient, DockerMonitor } from './src/docker/index.ts'
import { connectInstance } from './src/instance/client.ts'
import { logInfo, logWarn } from './src/logger.ts'
import {
  initOrchestration,
  shouldConnectToInstance,
  shouldEnableDockerIntegration,
} from './src/orchestration/setup.ts'
import { startTunnels } from './src/tunnels.ts'

logInfo('daemon', 'Hello from turbopanel-daemon')

const orchestrationReady = await initOrchestration()

const abort = new AbortController()

let dockerClient: DockerClient | undefined
if (orchestrationReady && shouldEnableDockerIntegration()) {
  dockerClient = new DockerClient()
  if (!(await dockerClient.ping())) {
    logWarn('docker', 'Docker socket not reachable yet — monitor will retry on each poll')
  }
  const dockerMonitor = new DockerMonitor(dockerClient)
  dockerMonitor.start(abort.signal)
}

// Start any configured Cloudflare tunnels (downloads cloudflared on demand).
await startTunnels(abort.signal)

// The daemon never self-updates. Updates are driven explicitly by an operator
// through the developer "Upgrade System" button or the dev-sync push; all installs
// and updates run via Ansible (the daemon is the constant that owns them).
const instanceHandle = { stop() {} }
let instance: { stop(): void } = instanceHandle

if (shouldConnectToInstance()) {
  instance = await connectInstance({})
} else {
  logInfo('instance', 'connection deferred until development environment opt-in (TURBOPANEL_DEV_INSTANCE)')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => {
    instance.stop()
    dockerClient?.close()
    abort.abort()
  })
}

await new Promise<void>((resolve) => {
  abort.signal.addEventListener('abort', () => resolve())
})
