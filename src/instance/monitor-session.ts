import type {
  DaemonApiClient,
  MonitorHeartbeatAck,
} from "./api-client.ts";
import { logWarn } from "../logger.ts";
import type {
  MonitorAckMessage,
  MonitorHeartbeatMessage,
  MonitorResourceState,
  MonitorSyncMessage,
  MonitorTransitionMessage,
} from "../monitor/protocol.ts";
import type {
  MonitorDeliveryBundle,
  MonitorHeartbeatPayload,
  MonitorSyncPayload,
  MonitorTransitionPayload,
} from "../monitor/delta.ts";
import type { MonitorSource } from "../monitor/source.ts";

const MONITOR_HEARTBEAT_MS = 60_000;
const MONITOR_FALLBACK_MS = 60_000;

function sanitizeForLog(value: unknown): string {
  if (value instanceof Error) return value.message.replaceAll("\n", "_");
  return String(value).replaceAll("\n", "_");
}

export type MonitorSessionOptions = {
  source: MonitorSource;
  serverId: string;
  hostname: string;
  apiClient?: DaemonApiClient;
};

export class MonitorSession {
  readonly #source: MonitorSource;
  readonly #serverId: string;
  readonly #hostname: string;
  readonly #apiClient: DaemonApiClient | undefined;

  #ws: WebSocket | undefined;
  #ackedSequence = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #fallbackTimer: ReturnType<typeof setInterval> | undefined;
  #unsubscribeTransition: (() => void) | undefined;

  constructor(options: MonitorSessionOptions) {
    this.#source = options.source;
    this.#serverId = options.serverId;
    this.#hostname = options.hostname;
    this.#apiClient = options.apiClient;
  }

  get ackedSequence(): number {
    return this.#ackedSequence;
  }

  attach(ws: WebSocket): void {
    this.detach();
    this.#ws = ws;
    this.stopFallback();

    void this.#sendSync();

    this.#heartbeatTimer = setInterval(() => {
      void this.#sendHeartbeatOverWs();
    }, MONITOR_HEARTBEAT_MS);

    this.#unsubscribeTransition = this.#source.onTransition((bundle) => {
      this.#sendTransitionOverWs(bundle);
    });
  }

  detach(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#unsubscribeTransition?.();
    this.#unsubscribeTransition = undefined;
    this.#ws = undefined;
  }

  startFallback(): void {
    if (!this.#apiClient || this.#fallbackTimer) return;

    this.#fallbackTimer = setInterval(() => {
      void this.#sendHeartbeatFallback();
    }, MONITOR_FALLBACK_MS);

    void this.#sendHeartbeatFallback();
  }

  stopFallback(): void {
    if (!this.#fallbackTimer) return;
    clearInterval(this.#fallbackTimer);
    this.#fallbackTimer = undefined;
  }

  handleAck(ack: MonitorAckMessage): void {
    if (ack.serverId !== this.#serverId) return;

    this.#ackedSequence = ack.acceptedSequence;
    this.#source.handleAck(ack.acceptedSequence);
    if (ack.resyncNeeded) {
      void this.#sendSync();
    }
  }

  #sendOnWs(
    message:
      | MonitorSyncMessage
      | MonitorHeartbeatMessage
      | MonitorTransitionMessage,
  ): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      logWarn(
        "instance",
        "monitor send failed:",
        sanitizeForLog(err),
      );
      return false;
    }
  }

  #wrapSync(payload: MonitorSyncPayload): MonitorSyncMessage {
    return { ...payload, from: "daemon", serverId: this.#serverId };
  }

  #wrapHeartbeat(payload: MonitorHeartbeatPayload): MonitorHeartbeatMessage {
    return { ...payload, from: "daemon", serverId: this.#serverId };
  }

  #wrapTransition(payload: MonitorTransitionPayload): MonitorTransitionMessage {
    return { ...payload, from: "daemon", serverId: this.#serverId };
  }

  #recordWsDelivery(
    sequence: number,
    resourcesAfter: MonitorResourceState[],
  ): void {
    this.#source.registerPendingDelivery(sequence, resourcesAfter);
  }

  #applyFallbackAck(
    ack: MonitorHeartbeatAck,
    bundle: MonitorDeliveryBundle<
      MonitorSyncPayload | MonitorHeartbeatPayload
    >,
  ): void {
    if (ack.resyncNeeded) {
      if (bundle.payload.type === "monitor.heartbeat") {
        void this.#sendSyncFallback();
      }
      return;
    }
    if (ack.acceptedSequence >= bundle.sequence) {
      this.#source.confirmDelivery(bundle.sequence, bundle.resourcesAfter);
      this.#ackedSequence = ack.acceptedSequence;
      this.#source.handleAck(ack.acceptedSequence);
    }
  }

  async #sendSync(): Promise<void> {
    try {
      const bundle = await this.#source.buildSync();
      if (
        !this.#sendOnWs(this.#wrapSync(bundle.payload))
      ) {
        return;
      }
      this.#recordWsDelivery(bundle.sequence, bundle.resourcesAfter);
    } catch (err) {
      logWarn("instance", "monitor.sync failed:", sanitizeForLog(err));
    }
  }

  async #sendHeartbeatOverWs(): Promise<void> {
    try {
      const bundle = await this.#source.buildHeartbeat();
      if (
        !this.#sendOnWs(this.#wrapHeartbeat(bundle.payload))
      ) {
        return;
      }
      this.#recordWsDelivery(bundle.sequence, bundle.resourcesAfter);
    } catch (err) {
      logWarn("instance", "monitor.heartbeat failed:", sanitizeForLog(err));
    }
  }

  #sendTransitionOverWs(
    bundle: MonitorDeliveryBundle<MonitorTransitionPayload>,
  ): void {
    try {
      if (
        !this.#sendOnWs(this.#wrapTransition(bundle.payload))
      ) {
        return;
      }
      this.#recordWsDelivery(bundle.sequence, bundle.resourcesAfter);
    } catch (err) {
      logWarn("instance", "monitor.transition failed:", sanitizeForLog(err));
    }
  }

  async #sendSyncFallback(): Promise<void> {
    if (!this.#apiClient || this.#ws?.readyState === WebSocket.OPEN) return;

    try {
      const bundle = await this.#source.buildSync();
      const ack = await this.#apiClient.heartbeat({
        serverId: this.#serverId,
        hostname: this.#hostname,
        monitor: this.#wrapSync(bundle.payload),
      });
      this.#applyFallbackAck(ack, bundle);
    } catch (err) {
      logWarn("instance", "monitor sync fallback failed:", sanitizeForLog(err));
    }
  }

  async #sendHeartbeatFallback(): Promise<void> {
    if (!this.#apiClient || this.#ws?.readyState === WebSocket.OPEN) return;

    try {
      const bundle = await this.#source.buildHeartbeat();
      const ack = await this.#apiClient.heartbeat({
        serverId: this.#serverId,
        hostname: this.#hostname,
        monitor: this.#wrapHeartbeat(bundle.payload),
      });
      this.#applyFallbackAck(ack, bundle);
    } catch (err) {
      logWarn("instance", "monitor fallback failed:", sanitizeForLog(err));
    }
  }
}
