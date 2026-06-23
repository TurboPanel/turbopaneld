import type {
  ContainerInspect,
  ContainerSummary,
  DockerClient,
  DockerEvent,
} from "./client.ts";
import { logWarn } from "../logger.ts";

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

function isContainerDestroyEvent(event: DockerEvent): boolean {
  return event.Action === "destroy" || event.Action === "remove";
}

export class DockerMonitor {
  #client: DockerClient;
  #pollIntervalMs: number;
  #reconcileIntervalMs: number;
  #containers: ContainerSummary[] = [];
  #inspects = new Map<string, ContainerInspect>();
  #listeners = new Set<(change: DockerMonitorChange) => void>();
  #eventsBackoffMs = 1_000;
  #usingPollFallback = false;
  #readyPromise: Promise<void>;
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

      const inspects = new Map<string, ContainerInspect>();
      for (const summary of summaries) {
        if (signal.aborted) return;
        try {
          const inspect = await this.#client.inspectContainer(summary.Id);
          inspects.set(summary.Id, inspect);
        } catch (err) {
          logWarn(
            "docker-monitor",
            "inspect failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      this.#inspects = inspects;

      for (const summary of summaries) {
        this.#notify({
          containerId: summary.Id,
          summary,
          inspect: inspects.get(summary.Id),
        });
      }
    } catch (err) {
      logWarn(
        "docker-monitor",
        "reconcile failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.#markReady();
    }
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
      try {
        this.#usingPollFallback = false;
        this.#eventsBackoffMs = 1_000;

        for await (const event of this.#client.streamEvents(signal)) {
          if (signal.aborted) return;
          await this.#handleEvent(event, signal);
        }

        if (signal.aborted) return;
      } catch (err) {
        if (signal.aborted) return;
        logWarn(
          "docker-monitor",
          "events stream failed:",
          err instanceof Error ? err.message : err,
        );
      }

      if (signal.aborted) return;

      if (!this.#usingPollFallback) {
        this.#usingPollFallback = true;
        void this.#pollLoop(signal);
      }

      await delay(this.#eventsBackoffMs, signal);
      this.#eventsBackoffMs = Math.min(this.#eventsBackoffMs * 2, 60_000);
    }
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

      const summaryIndex = this.#containers.findIndex((c) =>
        c.Id === containerId
      );
      let summary: ContainerSummary | undefined;
      if (summaryIndex >= 0) {
        summary = this.#containers[summaryIndex];
      } else {
        try {
          const summaries = await this.#client.listContainers(true);
          this.#containers = summaries;
          summary = summaries.find((c) => c.Id === containerId);
        } catch (err) {
          logWarn(
            "docker-monitor",
            "list after event failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      this.#notify({
        containerId,
        summary,
        inspect,
        event,
      });
    } catch (err) {
      if (signal.aborted) return;
      if (isContainerNotFound(err)) {
        this.#removeContainer(containerId, event);
        return;
      }
      logWarn(
        "docker-monitor",
        "event refresh failed:",
        err instanceof Error ? err.message : err,
      );
    }
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
        logWarn(
          "docker-monitor",
          "listener failed:",
          err instanceof Error ? err.message : err,
        );
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
