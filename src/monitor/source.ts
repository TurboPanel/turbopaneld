import type {
  MonitorDeliveryBundle,
  MonitorHeartbeatPayload,
  MonitorSyncPayload,
} from "./delta.ts";
import type { MonitorResourceState } from "./protocol.ts";
import type { SentinelTransitionCallback } from "./sentinel.ts";

/** Monitoring data source injected into the instance WebSocket client. */
export interface MonitorSource {
  buildSync(): Promise<MonitorDeliveryBundle<MonitorSyncPayload>>;
  buildHeartbeat(): Promise<MonitorDeliveryBundle<MonitorHeartbeatPayload>>;
  onTransition(
    callback: SentinelTransitionCallback,
  ): () => void;
  handleAck(acceptedSequence: number): void;
  registerPendingDelivery(
    sequence: number,
    resourcesAfter: MonitorResourceState[],
  ): void;
  confirmDelivery(
    sequence: number,
    resourcesAfter: MonitorResourceState[],
  ): void;
  waitForReady?(): Promise<void>;
  resetForReconnect?(): Promise<void>;
}
