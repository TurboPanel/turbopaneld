/** versioned monitoring wire protocol; bump when breaking monitor message shapes. */
export const MONITOR_PROTOCOL_VERSION = 1;

export const MONITOR_RESOURCE_STATUSES = [
  "unknown",
  "starting",
  "healthy",
  "degraded",
  "unhealthy",
  "stopped",
  "failed",
  "offline",
] as const;

export type MonitorResourceStatus = (typeof MONITOR_RESOURCE_STATUSES)[number];

const MONITOR_RESOURCE_STATUS_SET = new Set<string>(MONITOR_RESOURCE_STATUSES);

export function isMonitorResourceStatus(
  value: unknown,
): value is MonitorResourceStatus {
  return typeof value === "string" && MONITOR_RESOURCE_STATUS_SET.has(value);
}

export type MonitorResourceKind =
  | "instance"
  | "project"
  | "service"
  | "container";

const MONITOR_RESOURCE_KINDS = new Set<string>([
  "instance",
  "project",
  "service",
  "container",
]);

function isMonitorResourceKind(value: unknown): value is MonitorResourceKind {
  return typeof value === "string" && MONITOR_RESOURCE_KINDS.has(value);
}

/** host/system summary reported by the daemon monitor loop. */
export type MonitorInstanceSummary = {
  cpu?: { usagePercent?: number; cores?: number };
  memory?: { usedBytes?: number; totalBytes?: number; usagePercent?: number };
  disk?: { usedBytes?: number; totalBytes?: number; usagePercent?: number };
  load?: { one?: number; five?: number; fifteen?: number };
  uptimeSeconds?: number;
  bootId?: string;
};

/** normalized resource state for a monitored entity. */
export type MonitorResourceState = {
  resourceKey: string;
  kind: MonitorResourceKind;
  status: MonitorResourceStatus;
  name?: string;
  image?: string;
  healthStatus?: string;
  restartCount?: number;
  ports?: string[];
  labels?: Record<string, string>;
  projectId?: string;
  serviceId?: string;
  containerId?: string;
  updatedAt?: string;
};

/** status transition event emitted when a resource changes health. */
export type MonitorEvent = {
  resourceKey?: string;
  kind?: MonitorResourceKind;
  fromStatus?: MonitorResourceStatus;
  toStatus: MonitorResourceStatus;
  at: string;
  reason?: string;
  sequence?: number;
};

/** minute-bucket lightweight metric sample. */
export type MonitorMetricSample = {
  at: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  load?: number;
};

export type MonitorSyncMessage = {
  type: "monitor.sync";
  from: "daemon";
  serverId: string;
  at: string;
  sequence: number;
  instance: MonitorInstanceSummary;
  resources: MonitorResourceState[];
  events?: MonitorEvent[];
  protocolVersion: typeof MONITOR_PROTOCOL_VERSION;
};

export type MonitorHeartbeatMessage = {
  type: "monitor.heartbeat";
  from: "daemon";
  serverId: string;
  at: string;
  sequence: number;
  instance: MonitorInstanceSummary;
  resources?: MonitorResourceState[];
  events?: MonitorEvent[];
};

export type MonitorTransitionMessage = {
  type: "monitor.transition";
  from: "daemon";
  serverId: string;
  at: string;
  sequence: number;
  events: MonitorEvent[];
  resources?: MonitorResourceState[];
};

export type MonitorAckMessage = {
  type: "monitor.ack";
  from: "instance";
  serverId: string;
  at: string;
  acceptedSequence: number;
  resyncNeeded?: boolean;
};

export type MonitorMessage =
  | MonitorSyncMessage
  | MonitorHeartbeatMessage
  | MonitorTransitionMessage
  | MonitorAckMessage;

const MONITOR_MESSAGE_TYPES = new Set<string>([
  "monitor.sync",
  "monitor.heartbeat",
  "monitor.transition",
  "monitor.ack",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMonitorResourceState(value: unknown): value is MonitorResourceState {
  if (!isRecord(value)) return false;
  if (!isString(value.resourceKey)) return false;
  if (!isMonitorResourceKind(value.kind)) return false;
  if (!isMonitorResourceStatus(value.status)) return false;
  return true;
}

function isMonitorResourceStateArray(
  value: unknown,
): value is MonitorResourceState[] {
  return Array.isArray(value) && value.every(isMonitorResourceState);
}

function isMonitorEvent(value: unknown): value is MonitorEvent {
  if (!isRecord(value)) return false;
  if (!isMonitorResourceStatus(value.toStatus)) return false;
  if (!isString(value.at)) return false;
  if (value.resourceKey !== undefined && !isString(value.resourceKey)) {
    return false;
  }
  if (value.kind !== undefined && !isMonitorResourceKind(value.kind)) {
    return false;
  }
  if (
    value.fromStatus !== undefined && !isMonitorResourceStatus(value.fromStatus)
  ) return false;
  if (value.reason !== undefined && !isString(value.reason)) return false;
  if (value.sequence !== undefined && !isNumber(value.sequence)) return false;
  return true;
}

function isMonitorEventArray(value: unknown): value is MonitorEvent[] {
  return Array.isArray(value) && value.every(isMonitorEvent);
}

function isMonitorInstanceSummary(
  value: unknown,
): value is MonitorInstanceSummary {
  return isRecord(value);
}

function parseMonitorMessageObject(
  value: Record<string, unknown>,
): MonitorMessage | null {
  const type = value.type;
  if (!isString(type) || !MONITOR_MESSAGE_TYPES.has(type)) return null;
  if (!isString(value.serverId)) return null;
  if (!isString(value.at)) return null;

  switch (type) {
    case "monitor.sync": {
      if (value.from !== "daemon") return null;
      if (!isNumber(value.sequence)) return null;
      if (!isMonitorInstanceSummary(value.instance)) return null;
      if (!isMonitorResourceStateArray(value.resources)) return null;
      if (value.events !== undefined && !isMonitorEventArray(value.events)) {
        return null;
      }
      if (value.protocolVersion !== MONITOR_PROTOCOL_VERSION) return null;
      return {
        type: "monitor.sync",
        from: "daemon",
        serverId: value.serverId,
        at: value.at,
        sequence: value.sequence,
        instance: value.instance,
        resources: value.resources,
        events: value.events,
        protocolVersion: MONITOR_PROTOCOL_VERSION,
      };
    }
    case "monitor.heartbeat": {
      if (value.from !== "daemon") return null;
      if (!isNumber(value.sequence)) return null;
      if (!isMonitorInstanceSummary(value.instance)) return null;
      if (
        value.resources !== undefined &&
        !isMonitorResourceStateArray(value.resources)
      ) {
        return null;
      }
      if (value.events !== undefined && !isMonitorEventArray(value.events)) {
        return null;
      }
      return {
        type: "monitor.heartbeat",
        from: "daemon",
        serverId: value.serverId,
        at: value.at,
        sequence: value.sequence,
        instance: value.instance,
        resources: value.resources,
        events: value.events,
      };
    }
    case "monitor.transition": {
      if (value.from !== "daemon") return null;
      if (!isNumber(value.sequence)) return null;
      if (!isMonitorEventArray(value.events)) return null;
      if (
        value.resources !== undefined &&
        !isMonitorResourceStateArray(value.resources)
      ) {
        return null;
      }
      return {
        type: "monitor.transition",
        from: "daemon",
        serverId: value.serverId,
        at: value.at,
        sequence: value.sequence,
        events: value.events,
        resources: value.resources,
      };
    }
    case "monitor.ack": {
      if (value.from !== "instance") return null;
      if (!isNumber(value.acceptedSequence)) return null;
      if (
        value.resyncNeeded !== undefined &&
        typeof value.resyncNeeded !== "boolean"
      ) {
        return null;
      }
      return {
        type: "monitor.ack",
        from: "instance",
        serverId: value.serverId,
        at: value.at,
        acceptedSequence: value.acceptedSequence,
        resyncNeeded: value.resyncNeeded,
      };
    }
    default:
      return null;
  }
}

/** validate and parse a monitor wire message from json or an already-parsed value. */
export function parseMonitorMessage(
  raw: string | unknown,
): MonitorMessage | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  return parseMonitorMessageObject(value);
}
