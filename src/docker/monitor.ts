import { type ContainerSummary, DockerClient } from './client.ts'

export class DockerMonitor {
  #client: DockerClient
  #pollIntervalMs: number
  #containers: ContainerSummary[] = []

  constructor(client: DockerClient, pollIntervalMs = 10_000) {
    this.#client = client
    this.#pollIntervalMs = pollIntervalMs
  }

  getContainers(): ContainerSummary[] {
    return this.#containers
  }

  start(signal: AbortSignal): void {
    void this.#pollLoop(signal)
  }

  async #pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.#containers = await this.#client.listContainers(true)
        const summary = this.#containers
          .map((c) => {
            const name = c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12)
            return `${name}=${c.State}`
          })
          .join(', ')
        console.log(
          `[docker-monitor] ${this.#containers.length} containers: ${summary}`,
        )
      } catch (err) {
        console.warn(
          '[docker-monitor] poll failed:',
          err instanceof Error ? err.message : err,
        )
      }

      await delay(this.#pollIntervalMs, signal)
      if (signal.aborted) break
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve()
    }

    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      finish()
    }

    signal.addEventListener('abort', onAbort)
  })
}
