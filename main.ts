import { initOrchestration } from './src/orchestration/setup.ts'

console.log('Hello from turbopanel-daemon')

await initOrchestration()

const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => abort.abort())
}

await new Promise<void>((resolve) => {
  abort.signal.addEventListener('abort', () => resolve())
})
