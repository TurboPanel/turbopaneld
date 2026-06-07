/** Base URL used with the Unix-socket HTTP client (host is ignored). */
export const DOCKER_HTTP_ORIGIN = 'http://docker'

/**
 * Absolute path to the Docker Engine Unix socket.
 *
 * Override with `TURBOPANEL_DOCKER_SOCKET`, otherwise fall back to the root
 * Docker default.
 */
export function resolveDockerSocket(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_DOCKER_SOCKET?.trim()
  if (override) return override

  // TODO(rootless): when docker_rootless is enabled, resolve /run/user/<uid>/docker.sock here
  return '/var/run/docker.sock'
}

export interface ContainerSummary {
  Id: string
  Names: string[]
  Image: string
  State: string
  Status: string
  Ports: {
    IP?: string
    PrivatePort: number
    PublicPort?: number
    Type: string
  }[]
}

export interface ContainerInspect {
  Id: string
  Name: string
  Image: string
  State: {
    Status: string
    Running: boolean
    Paused: boolean
    Restarting: boolean
    Dead: boolean
    Pid: number
    ExitCode: number
  }
}

export class DockerClient {
  #httpClient: Deno.HttpClient

  constructor(socketPath?: string) {
    const path = socketPath ?? resolveDockerSocket()
    this.#httpClient = Deno.createHttpClient({
      proxy: { transport: 'unix', path },
    })
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.#fetch('/_ping')
      return response.status === 200
    } catch {
      return false
    }
  }

  async listContainers(all = false): Promise<ContainerSummary[]> {
    const response = await this.#fetch(
      `/containers/json?all=${all ? 'true' : 'false'}`,
    )
    if (!response.ok) {
      throw new Error(`list containers failed: HTTP ${response.status}`)
    }
    return await response.json() as ContainerSummary[]
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const response = await this.#fetch(`/containers/${id}/json`)
    if (!response.ok) {
      throw new Error(`inspect container failed: HTTP ${response.status}`)
    }
    return await response.json() as ContainerInspect
  }

  async startContainer(id: string): Promise<void> {
    const response = await this.#fetch(`/containers/${id}/start`, {
      method: 'POST',
    })
    if (!response.ok && response.status !== 304) {
      throw new Error(`start container failed: HTTP ${response.status}`)
    }
  }

  async stopContainer(id: string, timeoutSecs?: number): Promise<void> {
    const query = timeoutSecs !== undefined ? `?t=${timeoutSecs}` : ''
    const response = await this.#fetch(`/containers/${id}/stop${query}`, {
      method: 'POST',
    })
    if (!response.ok && response.status !== 304) {
      throw new Error(`stop container failed: HTTP ${response.status}`)
    }
  }

  close(): void {
    this.#httpClient.close()
  }

  #fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const normalized = path.startsWith('/') ? path : `/${path}`
    return fetch(`${DOCKER_HTTP_ORIGIN}${normalized}`, {
      ...init,
      client: this.#httpClient,
    })
  }
}
