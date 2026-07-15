import type {
  ContainerInspect,
  ContainerSummary,
  DockerClient,
  DockerEvent,
} from "./client.ts";
import { logInfo, logWarn } from "../logger.ts";

export type DockerMonitorChange = {
  containerId: string;
  summary?: ContainerSummary;
  inspect?: ContainerInspect;
  event?: DockerEvent;
  removed?: boolean;
};

export type DockerMonitorOptions = {
  pollIntervalMs?: number;
  reconcileIntervalMs?: number;
};

function isContainerNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes("HTTP 404");
}

/**
 * True when the error is just "Docker isn't reachable" (socket absent or refused).
 * On managed nodes Docker is installed on demand, so an absent socket is expected
 * and must not spam the log — we report it once on transition and retry quietly.
 */
function isDockerUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message;
  return (
    message.includes("No such file or directory") ||
    message.includes("os error 2") ||
    message.includes("Connection refused") ||
    message.includes("os error 111") ||
    message.includes("client error (Connect)")
  );
}

function isContainerDestroyEvent(event: DockerEvent): boolean {
  return event.Action === "destroy" || event.Action === "remove";
}

export class DockerMonitor {
  readonly #client: DockerClient;
  readonly #pollIntervalMs: number;
  readonly #reconcileIntervalMs: number;
  #containers: ContainerSummary[] = [];
  #inspects = new Map<string, ContainerInspect>();
  readonly #listeners = new Set<(change: DockerMonitorChange) => void>();
  #eventsBackoffMs = 1_000;
  #usingPollFallback = false;
  /** Tri-state docker reachability: null = unknown, true/false after first probe. */
  #dockerReachable: boolean | null = null;
  readonly #readyPromise: Promise<void>;
  #markReady: () => void;

  constructor(
    client: DockerClient,
    pollIntervalMs = 10_000,
    reconcileIntervalMs = 30_000,
  ) {
    this.#client = client;
    this.#pollIntervalMs = pollIntervalMs;
    this.#reconcileIntervalMs = reconcileIntervalMs;

    let markReady!: () => void;
    this.#readyPromise = new Promise((resolve) => {
      markReady = resolve;
    });
    this.#markReady = () => {
      markReady();
      this.#markReady = () => {};
    };
  }

  waitUntilReady(): Promise<void> {
    return this.#readyPromise;
  }

  /** Mark Docker reachable; log only when transitioning from unavailable. */
  #markDockerReachable(): void {
    if (this.#dockerReachable === false) {
      logInfo("docker-monitor", "Docker socket is now reachable");
    }
    this.#dockerReachable = true;
  }

  /**
   * Record that Docker is unavailable. Logs once on transition (info, not warn)
   * so an intentionally Docker-less managed node doesn't flood the error log.
   * Returns true if this was a state transition.
   */
  #markDockerUnavailable(reason: string): boolean {
    const transitioned = this.#dockerReachable !== false;
    if (transitioned) {
      logInfo(
        "docker-monitor",
        `Docker socket unavailable (${reason}); will retry quietly until Docker is installed`,
      );
    }
    this.#dockerReachable = false;
    return transitioned;
  }

  getContainers(): ContainerSummary[] {
    return this.#containers;
  }

  getContainerInspect(id: string): ContainerInspect | undefined {
    return this.#inspects.get(id);
  }

  subscribe(listener: (change: DockerMonitorChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(signal: AbortSignal): void {
    void this.#reconcileAll(signal);
    void this.#eventsLoop(signal);
    void this.#reconcileLoop(signal);
  }

  async #reconcileAll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;

    try {
      const summaries = await this.#client.listContainers(true);
      this.#containers = summaries;
      this.#inspects = await this.#inspectAll(summaries, signal);
      if (signal.aborted) return;

      for (const summary of summaries) {
        this.#notify({
          containerId: summary.Id,
          summary,
          inspect: this.#inspects.get(summary.Id),
        });
      }
      this.#markDockerReachable();
    } catch (err) {
      this.#handleReconcileError(err);
    } finally {
      this.#markReady();
    }
  }

  async #inspectAll(
    summaries: ContainerSummary[],
    signal: AbortSignal,
  ): Promise<Map<string, ContainerInspect>> {
    const inspects = new Map<string, ContainerInspect>();
    for (const summary of summaries) {
      if (signal.aborted) break;
      await this.#inspectOne(summary.Id, inspects);
    }
    return inspects;
  }

  async #inspectOne(
    containerId: string,
    inspects: Map<string, ContainerInspect>,
  ): Promise<void> {
    try {
      const inspect = await this.#client.inspectContainer(containerId);
      inspects.set(containerId, inspect);
    } catch (err) {
      logWarn("docker-monitor", "inspect failed:", err);
    }
  }

  #handleReconcileError(err: unknown): void {
    if (isDockerUnavailable(err)) {
      this.#markDockerUnavailable("reconcile");
      return;
    }
    logWarn("docker-monitor", "reconcile failed:", err);
  }

  async #reconcileLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await delay(this.#reconcileIntervalMs, signal);
      if (signal.aborted) break;
      await this.#reconcileAll(signal);
    }
  }

  async #eventsLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const streamedAny = await this.#runEventsStream(signal);
      if (signal.aborted) return;

      this.#ensurePollFallback(signal);
      await this.#backoffAfterStream(streamedAny, signal);
    }
  }

  async #runEventsStream(signal: AbortSignal): Promise<boolean> {
    let streamedAny = false;
    try {
      this.#usingPollFallback = false;

      for await (const event of this.#client.streamEvents(signal)) {
        if (signal.aborted) return streamedAny;
        streamedAny = true;
        // A live event means the socket is reachable.
        this.#markDockerReachable();
        this.#eventsBackoffMs = 1_000;
        await this.#handleEvent(event, signal);
      }
    } catch (err) {
      if (!signal.aborted) this.#handleEventsStreamError(err);
    }
    return streamedAny;
  }

  #handleEventsStreamError(err: unknown): void {
    if (isDockerUnavailable(err)) {
      // Expected on Docker-less managed nodes — log once on transition.
      this.#markDockerUnavailable("events stream");
      return;
    }
    logWarn("docker-monitor", "events stream failed:", err);
  }

  #ensurePollFallback(signal: AbortSignal): void {
    if (this.#usingPollFallback) return;
    this.#usingPollFallback = true;
    void this.#pollLoop(signal);
  }

  async #backoffAfterStream(
    streamedAny: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    // Only reset the backoff after a genuinely healthy stream; otherwise grow it
    // so a missing socket doesn't drive a 1s retry/log loop.
    if (streamedAny) {
      this.#eventsBackoffMs = 1_000;
    }
    await delay(this.#eventsBackoffMs, signal);
    this.#eventsBackoffMs = Math.min(this.#eventsBackoffMs * 2, 60_000);
  }

  async #handleEvent(event: DockerEvent, signal: AbortSignal): Promise<void> {
    const containerId = event.Actor?.ID;
    if (!containerId) return;

    if (isContainerDestroyEvent(event)) {
      this.#removeContainer(containerId, event);
      return;
    }

    try {
      const inspect = await this.#client.inspectContainer(containerId);
      this.#inspects.set(containerId, inspect);
      const summary = await this.#resolveSummary(containerId);
      this.#notify({ containerId, summary, inspect, event });
    } catch (err) {
      this.#handleEventRefreshError(err, containerId, event, signal);
    }
  }

  async #resolveSummary(
    containerId: string,
  ): Promise<ContainerSummary | undefined> {
    const existing = this.#containers.find((c) => c.Id === containerId);
    if (existing) return existing;
    return await this.#refreshSummaryFromList(containerId);
  }

  async #refreshSummaryFromList(
    containerId: string,
  ): Promise<ContainerSummary | undefined> {
    try {
      const summaries = await this.#client.listContainers(true);
      this.#containers = summaries;
      return summaries.find((c) => c.Id === containerId);
    } catch (err) {
      logWarn("docker-monitor", "list after event failed:", err);
      return undefined;
    }
  }

  #handleEventRefreshError(
    err: unknown,
    containerId: string,
    event: DockerEvent,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) return;
    if (isContainerNotFound(err)) {
      this.#removeContainer(containerId, event);
      return;
    }
    logWarn("docker-monitor", "event refresh failed:", err);
  }

  #removeContainer(containerId: string, event?: DockerEvent): void {
    const summary = this.#containers.find((container) =>
      container.Id === containerId
    );
    const inspect = this.#inspects.get(containerId);
    const wasTracked = summary !== undefined || inspect !== undefined;

    this.#containers = this.#containers.filter((container) =>
      container.Id !== containerId
    );
    this.#inspects.delete(containerId);

    if (!wasTracked) return;

    this.#notify({
      containerId,
      summary,
      inspect,
      event,
      removed: true,
    });
  }

  async #pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.#usingPollFallback) {
      await delay(this.#pollIntervalMs, signal);
      if (signal.aborted || !this.#usingPollFallback) break;

      await this.#reconcileAll(signal);
    }
  }

  #notify(change: DockerMonitorChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (err) {
        logWarn("docker-monitor", "listener failed:", err);
      }
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };

    signal.addEventListener("abort", onAbort);
  });
}
