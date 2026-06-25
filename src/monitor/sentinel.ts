import type {
  ContainerInspect,
  ContainerSummary,
  DockerEvent,
} from "../docker/client.ts";
import type { DockerMonitor, DockerMonitorChange } from "../docker/monitor.ts";
import { logInfo, logWarn } from "../logger.ts";
import { createMonitorDeltaTracker } from "./delta.ts";
import type {
  MonitorDeliveryBundle,
  MonitorHeartbeatPayload,
  MonitorSyncPayload,
  MonitorTransitionPayload,
} from "./delta.ts";
import {
  createHostSummaryCollector,
  type HostSummaryCollector,
} from "./host-summary.ts";
import { normalizeContainer } from "./normalize.ts";
import type { MonitorResourceState } from "./protocol.ts";

export type SentinelOptions = {
  dockerMonitor?: DockerMonitor;
  hostSummaryCollector?: HostSummaryCollector;
};

export type SentinelTransitionCallback = (
  bundle: MonitorDeliveryBundle<MonitorTransitionPayload>,
) => void;

type ContainerMonitor = Pick<
  DockerMonitor,
  "start" | "waitUntilReady" | "getContainers" | "getContainerInspect" | "subscribe"
>;

function createEmptyContainerMonitor(): ContainerMonitor {
  return {
    start() {},
    waitUntilReady: async () => {},
    getContainers: () => [],
    getContainerInspect: () => undefined,
    subscribe: () => () => {},
  };
}

export class Sentinel {
  #dockerMonitor: ContainerMonitor;
  #dockerEnabled: boolean;
  #hostSummaryCollector: HostSummaryCollector;
  #delta = createMonitorDeltaTracker();
  #transitionCallbacks = new Set<SentinelTransitionCallback>();
  #signal: AbortSignal | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #ready: Promise<void>;
  #markReady!: () => void;

  constructor(options: SentinelOptions) {
    let markReady!: () => void;
    this.#ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    this.#markReady = markReady;

    this.#dockerEnabled = options.dockerMonitor !== undefined;
    this.#dockerMonitor = options.dockerMonitor ?? createEmptyContainerMonitor();
    this.#hostSummaryCollector = options.hostSummaryCollector ??
      createHostSummaryCollector();
  }

  onTransition(callback: SentinelTransitionCallback): () => void {
    this.#transitionCallbacks.add(callback);
    return () => {
      this.#transitionCallbacks.delete(callback);
    };
  }

  start(signal: AbortSignal): void {
    this.#signal = signal;
    logInfo("sentinel", "starting");

    if (this.#dockerEnabled) {
      this.#dockerMonitor.start(signal);
    }
    void this.#bootstrap(signal);
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    logInfo("sentinel", "stopped");
  }

  async buildSync(): Promise<MonitorDeliveryBundle<MonitorSyncPayload>> {
    const instance = await this.#hostSummaryCollector.collect();
    const resources = this.#collectNormalizedResources();
    return this.#delta.buildSync(instance, resources);
  }

  async buildHeartbeat(): Promise<
    MonitorDeliveryBundle<MonitorHeartbeatPayload>
  > {
    const instance = await this.#hostSummaryCollector.collect();
    const resources = this.#collectNormalizedResources();
    return this.#delta.buildHeartbeat(instance, resources);
  }

  handleAck(acceptedSequence: number): void {
    this.#delta.applyAck(acceptedSequence);
  }

  registerPendingDelivery(
    sequence: number,
    resourcesAfter: MonitorResourceState[],
  ): void {
    this.#delta.registerPendingDelivery(sequence, resourcesAfter);
  }

  confirmDelivery(
    sequence: number,
    resourcesAfter: MonitorResourceState[],
  ): void {
    this.#delta.confirmDelivery(sequence, resourcesAfter);
  }

  async waitForReady(): Promise<void> {
    await this.#ready;
  }

  async resetForReconnect(): Promise<void> {
    await this.#ready;
    this.#delta.seedTracked(this.#collectNormalizedResources());
  }

  #collectNormalizedResources(): MonitorResourceState[] {
    if (!this.#dockerEnabled) return [];

    const resources: MonitorResourceState[] = [];

    for (const summary of this.#dockerMonitor.getContainers()) {
      const inspect = this.#dockerMonitor.getContainerInspect(summary.Id);
      resources.push(normalizeContainer({ summary, inspect }));
    }

    return resources;
  }

  async #bootstrap(signal: AbortSignal): Promise<void> {
    try {
      if (!this.#dockerEnabled) {
        this.#delta.seedTracked([]);
        return;
      }

      await this.#dockerMonitor.waitUntilReady();
      if (signal.aborted) return;

      this.#delta.seedTracked(this.#collectNormalizedResources());

      this.#unsubscribe = this.#dockerMonitor.subscribe((change) => {
        this.#handleChange(change);
      });
    } catch (err) {
      logWarn(
        "sentinel",
        "bootstrap failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.#markReady();
    }
  }

  #handleChange(change: DockerMonitorChange): void {
    if (this.#signal?.aborted || !this.#dockerEnabled) return;

    try {
      const resourcesAfter = this.#collectNormalizedResources();

      if (change.removed) {
        const resourceKey = this.#resourceKeyForChange(change);
        let previous = this.#delta.getDeliveredBaseline().get(resourceKey);

        if (!previous && (change.summary || change.inspect)) {
          previous = normalizeContainer({
            summary: change.summary,
            inspect: change.inspect,
            event: change.event,
          });
        }

        if (!previous) return;

        const bundle = this.#delta.buildRemovalTransition(
          previous.resourceKey,
          previous,
          resourcesAfter,
        );
        this.#emitTransition(bundle);
        return;
      }

      const normalized = normalizeContainer({
        summary: change.summary,
        inspect: change.inspect,
        event: change.event,
      });
      const bundle = this.#delta.buildTransition(
        normalized.resourceKey,
        normalized,
        resourcesAfter,
      );

      if (!bundle) return;

      this.#emitTransition(bundle);
    } catch (err) {
      logWarn(
        "sentinel",
        "change handling failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  #resourceKeyForChange(change: DockerMonitorChange): string {
    const fullId = (
      change.inspect?.Id ??
        change.summary?.Id ??
        change.containerId
    ).replace(/^\/+/, "");
    return `container:${fullId.slice(0, 12)}`;
  }

  #emitTransition(
    bundle: MonitorDeliveryBundle<MonitorTransitionPayload>,
  ): void {
    for (const callback of this.#transitionCallbacks) {
      try {
        callback(bundle);
      } catch (err) {
        logWarn(
          "sentinel",
          "transition callback failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

export function createSentinel(options: SentinelOptions = {}): Sentinel {
  return new Sentinel(options);
}
