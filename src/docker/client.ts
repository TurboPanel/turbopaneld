import { logWarn } from "../logger.ts";

/** Base URL used with the Unix-socket HTTP client (host is ignored). */
// Docker Engine speaks plain HTTP over the Unix socket; there is no TLS hop.
export const DOCKER_HTTP_ORIGIN = "http://docker"; // NOSONAR typescript:S5332 — Unix-socket Docker API, not a cleartext network endpoint

/**
 * Absolute path to the Docker Engine Unix socket.
 *
 * Override with `TURBOPANEL_DOCKER_SOCKET`, otherwise fall back to the root
 * Docker default.
 */
export function resolveDockerSocket(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_DOCKER_SOCKET?.trim();
  if (override) return override;

  // Future: when docker_rootless is enabled, resolve /run/user/<uid>/docker.sock here
  return "/var/run/docker.sock";
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels?: Record<string, string>;
  Ports: {
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type: string;
  }[];
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  RestartCount?: number;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    Dead: boolean;
    Pid: number;
    ExitCode: number;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: { Status: string; FailingStreak?: number };
  };
  Config?: { Image?: string; Labels?: Record<string, string> };
  NetworkSettings?: {
    Ports?: Record<
      string,
      { HostIp?: string; HostPort?: string }[] | null
    >;
  };
}

export type DockerEvent = {
  Type: string;
  Action: string;
  Actor: { ID: string; Attributes?: Record<string, string> };
  time?: number;
  timeNano?: number;
  status?: string;
  id?: string;
  from?: string;
};

export function isStreamAbortError(
  error: unknown,
  signal: AbortSignal,
): boolean {
  if (signal.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Deno.errors.BadResource;
}

export function* parseEventLines(lines: string[]): Generator<DockerEvent> {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as DockerEvent;
    } catch {
      logWarn("docker-client", "events stream: invalid json line");
    }
  }
}

/** Host-free fetch seam so tests never need a live Docker socket. */
export type DockerFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type DockerClientOptions = {
  fetchImpl?: DockerFetch;
  createHttpClient?: (socketPath: string) => Deno.HttpClient;
};

export class DockerClient {
  readonly #httpClient: Deno.HttpClient | undefined;
  readonly #fetchImpl: DockerFetch | undefined;
  #closed = false;

  constructor(socketPath?: string, options: DockerClientOptions = {}) {
    this.#fetchImpl = options.fetchImpl;
    if (this.#fetchImpl && !options.createHttpClient) {
      return;
    }
    const path = socketPath ?? resolveDockerSocket();
    const create = options.createHttpClient ?? ((unixPath: string) =>
      Deno.createHttpClient({
        proxy: { transport: "unix", path: unixPath },
      }));
    this.#httpClient = create(path);
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.#fetch("/_ping");
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async listContainers(all = false): Promise<ContainerSummary[]> {
    const response = await this.#fetch(
      `/containers/json?all=${all ? "true" : "false"}`,
    );
    if (!response.ok) {
      throw new Error(`list containers failed: HTTP ${response.status}`);
    }
    return await response.json() as ContainerSummary[];
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const response = await this.#fetch(`/containers/${id}/json`);
    if (!response.ok) {
      throw new Error(`inspect container failed: HTTP ${response.status}`);
    }
    return await response.json() as ContainerInspect;
  }

  async startContainer(id: string): Promise<void> {
    const response = await this.#fetch(`/containers/${id}/start`, {
      method: "POST",
    });
    if (!response.ok && response.status !== 304) {
      throw new Error(`start container failed: HTTP ${response.status}`);
    }
  }

  async stopContainer(id: string, timeoutSecs?: number): Promise<void> {
    const query = timeoutSecs !== undefined ? `?t=${timeoutSecs}` : "";
    const response = await this.#fetch(`/containers/${id}/stop${query}`, {
      method: "POST",
    });
    if (!response.ok && response.status !== 304) {
      throw new Error(`stop container failed: HTTP ${response.status}`);
    }
  }

  async *streamEvents(signal: AbortSignal): AsyncGenerator<DockerEvent> {
    const filters = {
      type: ["container"],
      event: [
        "start",
        "stop",
        "die",
        "destroy",
        "remove",
        "restart",
        "oom",
        "health_status",
        "kill",
        "pause",
        "unpause",
      ],
    };
    const query = `?filters=${encodeURIComponent(JSON.stringify(filters))}`;
    const response = await this.#openEventsResponse(query, signal);
    if (!response) return;

    if (!response.ok || !response.body) {
      throw new Error(`stream events failed: HTTP ${response.status}`);
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    try {
      yield* this.#readEventLines(reader, signal);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // stream already closed
      }
    }
  }

  async #openEventsResponse(
    query: string,
    signal: AbortSignal,
  ): Promise<Response | null> {
    try {
      return await this.#fetch(`/events${query}`, { signal });
    } catch (error) {
      if (isStreamAbortError(error, signal)) return null;
      throw error;
    }
  }

  async *#readEventLines(
    reader: ReadableStreamDefaultReader<string>,
    signal: AbortSignal,
  ): AsyncGenerator<DockerEvent> {
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        yield* parseEventLines(lines);
      }
    } catch (error) {
      if (isStreamAbortError(error, signal)) return;
      throw error;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (!this.#httpClient) {
      return;
    }
    try {
      this.#httpClient.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) {
        throw error;
      }
    }
  }

  #fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const url = `${DOCKER_HTTP_ORIGIN}${normalized}`;
    if (this.#fetchImpl) {
      return this.#fetchImpl(url, init);
    }
    return fetch(url, {
      ...init,
      client: this.#httpClient,
    });
  }
}
