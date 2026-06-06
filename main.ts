console.log('Hello from turbopanel-daemon')

const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => abort.abort())
}

await new Promise<void>((resolve) => {
  abort.signal.addEventListener('abort', () => resolve())
})
