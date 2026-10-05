import type { DockerMonitor, DockerMonitorChange } from "../docker/monitor.ts";
import { logInfo, logWarn } from "../util/logger.ts";
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
import { CrashLoopGuard, type StopContainer } from "./crash-loop-guard.ts";
import { normalizeContainer } from "./normalize.ts";
import type { MonitorResourceState } from "./protocol.ts";
import type { ServiceRunState } from "../contracts/service-run-state.ts";
import {
  deriveServiceRunStates,
  type ServiceContainerObservation,
  serviceIdForContainer,
  ServiceRunStateStamper,
  wantsLastLogLine,
} from "./service-run-state.ts";

export type SentinelOptions = {
  dockerMonitor?: DockerMonitor;
  hostSummaryCollector?: HostSummaryCollector;
  /**
   * Reads the last log line of a failing container (`docker logs --tail 5`).
   * Without it service run states carry no log line, only the exit code.
   */
  fetchLastLogLine?: (containerId: string) => Promise<string>;
  /**
   * Stops a service container that kept restarting past the limit (10
   * restarts without staying up for 60 s). Without it nothing is stopped and
   * Docker's own restart policy decides.
   */
  stopContainer?: StopContainer;
};

/** A fetched log line, valid for the restart count it was read at. */
type CachedLogLine = { restartCount: number; line: string };

export type SentinelTransitionCallback = (
  bundle: MonitorDeliveryBundle<MonitorTransitionPayload>,
) => void;

type ContainerMonitor = Pick<
  DockerMonitor,
  | "start"
  | "waitUntilReady"
  | "getContainers"
  | "getContainerInspect"
  | "subscribe"
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
  readonly #dockerMonitor: ContainerMonitor;
  readonly #dockerEnabled: boolean;
  readonly #hostSummaryCollector: HostSummaryCollector;
  readonly #delta = createMonitorDeltaTracker();
  readonly #transitionCallbacks = new Set<SentinelTransitionCallback>();
  readonly #fetchLastLogLine: SentinelOptions["fetchLastLogLine"];
  readonly #stamper = new ServiceRunStateStamper();
  readonly #crashGuard: CrashLoopGuard | undefined;
  readonly #logLines = new Map<string, CachedLogLine>();
  readonly #logFetchesInFlight = new Set<string>();
  /** True once the Docker monitor's first listing is in; before that the list is empty, not true. */
  #containersKnown = false;
  #signal: AbortSignal | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #ready: Promise<void>;
  readonly #markReady!: () => void;

  constructor(options: SentinelOptions) {
    let markReady!: () => void;
    this.#ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    this.#markReady = markReady;

    this.#dockerEnabled = options.dockerMonitor !== undefined;
    this.#dockerMonitor = options.dockerMonitor ??
      createEmptyContainerMonitor();
    this.#hostSummaryCollector = options.hostSummaryCollector ??
      createHostSummaryCollector();
    this.#fetchLastLogLine = options.fetchLastLogLine;
    if (options.stopContainer) {
      this.#crashGuard = new CrashLoopGuard(options.stopContainer);
    }
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

  /**
   * Run state of every service with a container on this host, or `undefined`
   * when Docker is not being watched. A failing container whose log line is
   * not cached yet starts a background fetch; the next call carries it.
   */
  serviceRunStates(now: Date = new Date()): ServiceRunState[] | undefined {
    if (!this.#dockerEnabled || !this.#containersKnown) return undefined;
    const observations = this.#observeServices(now);
    return this.#stamper.stamp(
      deriveServiceRunStates(observations, now.getTime()),
      now,
    );
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

  /** Collect the service containers, apply the crash-loop limit and queue log fetches. */
  #observeServices(now: Date = new Date()): ServiceContainerObservation[] {
    const collected = this.#collectServiceObservations();
    const observations = this.#crashGuard
      ? this.#crashGuard.review(collected, now.getTime())
      : collected;
    this.#scheduleLogFetches(observations);
    return observations;
  }

  #collectServiceObservations(): ServiceContainerObservation[] {
    const observations: ServiceContainerObservation[] = [];
    for (const summary of this.#dockerMonitor.getContainers()) {
      const inspect = this.#dockerMonitor.getContainerInspect(summary.Id);
      const serviceId = serviceIdForContainer(
        inspect?.Config?.Labels ?? summary.Labels,
      );
      if (!serviceId) continue;
      const cached = this.#logLines.get(summary.Id);
      observations.push({
        serviceId,
        containerId: summary.Id,
        summary,
        inspect,
        ...(cached ? { lastLogLine: cached.line } : {}),
      });
    }
    return observations;
  }

  #scheduleLogFetches(observations: ServiceContainerObservation[]): void {
    const fetchLine = this.#fetchLastLogLine;
    if (!fetchLine) return;
    const liveIds = new Set(observations.map((obs) => obs.containerId));
    for (const id of this.#logLines.keys()) {
      if (!liveIds.has(id)) this.#logLines.delete(id);
    }
    for (const obs of observations) {
      if (!wantsLastLogLine(obs)) continue;
      const restartCount = obs.inspect?.RestartCount ?? 0;
      if (this.#logLines.get(obs.containerId)?.restartCount === restartCount) {
        continue;
      }
      if (this.#logFetchesInFlight.has(obs.containerId)) continue;
      void this.#fetchAndCache(fetchLine, obs);
    }
  }

  async #fetchAndCache(
    fetchLine: (containerId: string) => Promise<string>,
    obs: ServiceContainerObservation,
  ): Promise<void> {
    this.#logFetchesInFlight.add(obs.containerId);
    try {
      const line = await fetchLine(obs.containerId);
      this.#logLines.set(obs.containerId, {
        restartCount: obs.inspect?.RestartCount ?? 0,
        line,
      });
    } catch (err) {
      logWarn(
        "sentinel",
        "last log line fetch failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.#logFetchesInFlight.delete(obs.containerId);
    }
  }

  async #bootstrap(signal: AbortSignal): Promise<void> {
    try {
      if (!this.#dockerEnabled) {
        this.#delta.seedTracked([]);
        return;
      }

      await this.#dockerMonitor.waitUntilReady();
      if (signal.aborted) return;
      this.#containersKnown = true;

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
      // Warm the log-line cache so the next presence tick already has it, and
      // stop a crash loop as soon as Docker reports the restart that crosses it.
      this.#observeServices();

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
