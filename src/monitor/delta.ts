import { MONITOR_PROTOCOL_VERSION } from "./protocol.ts";
import type {
  MonitorEvent,
  MonitorHeartbeatMessage,
  MonitorInstanceSummary,
  MonitorResourceState,
  MonitorSyncMessage,
  MonitorTransitionMessage,
} from "./protocol.ts";

export type MonitorSyncPayload = Omit<MonitorSyncMessage, "from" | "serverId">;
export type MonitorHeartbeatPayload = Omit<
  MonitorHeartbeatMessage,
  "from" | "serverId"
>;
export type MonitorTransitionPayload = Omit<
  MonitorTransitionMessage,
  "from" | "serverId"
>;

export type ResourceDiff = {
  changed: MonitorResourceState[];
  events: MonitorEvent[];
};

export type MonitorDeliveryBundle<T> = {
  payload: T;
  sequence: number;
  resourcesAfter: MonitorResourceState[];
};

/** meaningful resource fields used for heartbeat delta detection (excludes updatedAt). */
export function resourceSnapshotForDiff(
  resource: MonitorResourceState,
): Omit<MonitorResourceState, "updatedAt"> {
  const { updatedAt: _updatedAt, ...snapshot } = resource;
  return snapshot;
}

function resourceMeaningfulFieldsChanged(
  previous: MonitorResourceState,
  next: MonitorResourceState,
): boolean {
  return JSON.stringify(resourceSnapshotForDiff(previous)) !==
    JSON.stringify(resourceSnapshotForDiff(next));
}

function snapshotResources(
  resources: MonitorResourceState[],
): Map<string, MonitorResourceState> {
  const map = new Map<string, MonitorResourceState>();
  for (const resource of resources) {
    map.set(resource.resourceKey, resource);
  }
  return map;
}

export function diffResources(
  prev: Map<string, MonitorResourceState>,
  next: MonitorResourceState[],
  sequence: number,
  at: string,
): ResourceDiff {
  const changed: MonitorResourceState[] = [];
  const events: MonitorEvent[] = [];

  for (const resource of next) {
    const previous = prev.get(resource.resourceKey);
    if (!previous) {
      changed.push(resource);
      events.push({
        resourceKey: resource.resourceKey,
        kind: resource.kind,
        toStatus: resource.status,
        at,
        reason: "discovered",
        sequence,
      });
      continue;
    }

    const statusChanged = previous.status !== resource.status;
    const snapshotChanged = resourceMeaningfulFieldsChanged(previous, resource);

    if (statusChanged) {
      events.push({
        resourceKey: resource.resourceKey,
        kind: resource.kind,
        fromStatus: previous.status,
        toStatus: resource.status,
        at,
        reason: "status_change",
        sequence,
      });
    }

    if (statusChanged || snapshotChanged) {
      changed.push(resource);
    }
  }

  for (const [resourceKey, previous] of prev) {
    if (!next.some((resource) => resource.resourceKey === resourceKey)) {
      const offlineResource: MonitorResourceState = {
        ...previous,
        status: "offline",
        updatedAt: at,
      };
      changed.push(offlineResource);
      events.push({
        resourceKey,
        kind: previous.kind,
        fromStatus: previous.status,
        toStatus: "offline",
        at,
        reason: "removed",
        sequence,
      });
    }
  }

  return { changed, events };
}

export type MonitorDeltaTracker = ReturnType<typeof createMonitorDeltaTracker>;

export function createMonitorDeltaTracker() {
  let sequence = 0;
  let deliveredSequence = 0;
  const deliveredBaseline = new Map<string, MonitorResourceState>();
  const pendingDeliveries = new Map<
    number,
    Map<string, MonitorResourceState>
  >();

  function replaceDeliveredBaseline(resources: MonitorResourceState[]): void {
    deliveredBaseline.clear();
    for (const resource of resources) {
      deliveredBaseline.set(resource.resourceKey, resource);
    }
  }

  function seedTracked(resources: MonitorResourceState[]): void {
    replaceDeliveredBaseline(resources);
    deliveredSequence = 0;
    sequence = 0;
    pendingDeliveries.clear();
  }

  function applyAck(acceptedSequence: number): void {
    if (acceptedSequence <= deliveredSequence) return;

    let confirmedSequence = -1;
    let snapshot: Map<string, MonitorResourceState> | undefined;
    for (const [pendingSequence, pendingSnapshot] of pendingDeliveries) {
      if (
        pendingSequence <= acceptedSequence &&
        pendingSequence > confirmedSequence
      ) {
        confirmedSequence = pendingSequence;
        snapshot = pendingSnapshot;
      }
    }
    if (confirmedSequence <= deliveredSequence) return;

    if (snapshot) {
      deliveredBaseline.clear();
      for (const [resourceKey, resource] of snapshot) {
        deliveredBaseline.set(resourceKey, resource);
      }
    }

    deliveredSequence = confirmedSequence;

    for (const pendingSequence of pendingDeliveries.keys()) {
      if (pendingSequence <= confirmedSequence) {
        pendingDeliveries.delete(pendingSequence);
      }
    }
  }

  function registerPendingDelivery(
    deliverySequence: number,
    resourcesAfter: MonitorResourceState[],
  ): void {
    pendingDeliveries.set(deliverySequence, snapshotResources(resourcesAfter));
    if (deliverySequence > sequence) {
      sequence = deliverySequence;
    }
  }

  function confirmDelivery(
    deliverySequence: number,
    resourcesAfter: MonitorResourceState[],
  ): void {
    registerPendingDelivery(deliverySequence, resourcesAfter);
    applyAck(deliverySequence);
  }

  function buildSync(
    instance: MonitorInstanceSummary,
    resources: MonitorResourceState[],
  ): MonitorDeliveryBundle<MonitorSyncPayload> {
    const nextSequence = sequence + 1;
    const at = new Date().toISOString();

    return {
      sequence: nextSequence,
      resourcesAfter: resources,
      payload: {
        type: "monitor.sync",
        at,
        sequence: nextSequence,
        instance,
        resources,
        protocolVersion: MONITOR_PROTOCOL_VERSION,
      },
    };
  }

  function previewTransitionEvents(
    resourceKey: string,
    next: MonitorResourceState,
    at: string,
    nextSequence: number,
  ): MonitorEvent[] {
    const previous = deliveredBaseline.get(resourceKey);
    if (!previous) {
      return [{
        resourceKey: next.resourceKey,
        kind: next.kind,
        toStatus: next.status,
        at,
        reason: "discovered",
        sequence: nextSequence,
      }];
    }

    if (previous.status === next.status) return [];

    return [{
      resourceKey: next.resourceKey,
      kind: next.kind,
      fromStatus: previous.status,
      toStatus: next.status,
      at,
      reason: "status_change",
      sequence: nextSequence,
    }];
  }

  function buildHeartbeat(
    instance: MonitorInstanceSummary,
    resources: MonitorResourceState[],
  ): MonitorDeliveryBundle<MonitorHeartbeatPayload> {
    const at = new Date().toISOString();
    const nextSequence = sequence + 1;
    const { changed, events } = diffResources(
      deliveredBaseline,
      resources,
      nextSequence,
      at,
    );

    const payload: MonitorHeartbeatPayload = {
      type: "monitor.heartbeat",
      at,
      sequence: nextSequence,
      instance,
    };

    if (changed.length > 0) payload.resources = changed;
    if (events.length > 0) payload.events = events;

    return {
      sequence: nextSequence,
      resourcesAfter: resources,
      payload,
    };
  }

  function buildTransition(
    resourceKey: string,
    next: MonitorResourceState,
    resourcesAfter: MonitorResourceState[],
  ): MonitorDeliveryBundle<MonitorTransitionPayload> | null {
    const at = new Date().toISOString();
    const nextSequence = sequence + 1;
    const events = previewTransitionEvents(resourceKey, next, at, nextSequence);

    if (events.length === 0) return null;

    return {
      sequence: nextSequence,
      resourcesAfter,
      payload: {
        type: "monitor.transition",
        at,
        sequence: nextSequence,
        events,
        resources: [next],
      },
    };
  }

  function buildRemovalTransition(
    resourceKey: string,
    previous: MonitorResourceState,
    resourcesAfter: MonitorResourceState[],
  ): MonitorDeliveryBundle<MonitorTransitionPayload> {
    const at = new Date().toISOString();
    const nextSequence = sequence + 1;
    const offlineResource: MonitorResourceState = {
      ...previous,
      status: "offline",
      updatedAt: at,
    };

    return {
      sequence: nextSequence,
      resourcesAfter,
      payload: {
        type: "monitor.transition",
        at,
        sequence: nextSequence,
        events: [{
          resourceKey,
          kind: previous.kind,
          fromStatus: previous.status,
          toStatus: "offline",
          at,
          reason: "removed",
          sequence: nextSequence,
        }],
        resources: [offlineResource],
      },
    };
  }

  return {
    buildSync,
    buildHeartbeat,
    buildTransition,
    buildRemovalTransition,
    seedTracked,
    applyAck,
    registerPendingDelivery,
    confirmDelivery,
    getSequence: () => sequence,
    getDeliveredSequence: () => deliveredSequence,
    getDeliveredBaseline: () => new Map(deliveredBaseline),
  };
}
