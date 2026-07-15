import type {
  ContainerInspect,
  ContainerSummary,
  DockerEvent,
} from "../docker/client.ts";
import type {
  MonitorResourceState,
  MonitorResourceStatus,
} from "./protocol.ts";

/** optional turbopanel docker label keys for project/service mapping. */
export const TURBOPANEL_LABEL_KEYS = {
  project: "com.turbopanel.project",
  service: "com.turbopanel.service",
} as const;

export type NormalizeContainerInput = {
  inspect?: ContainerInspect;
  summary?: ContainerSummary;
  event?: DockerEvent;
};

function shortContainerId(id: string): string {
  return id.replace(/^\/+/, "").slice(0, 12);
}

function stripLeadingSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function resolveContainerName(
  input: NormalizeContainerInput,
): string | undefined {
  if (input.inspect?.Name) {
    return stripLeadingSlash(input.inspect.Name);
  }
  const names = input.summary?.Names;
  if (names && names.length > 0) {
    return stripLeadingSlash(names[0]);
  }
  return undefined;
}

function resolveLabels(
  input: NormalizeContainerInput,
): Record<string, string> | undefined {
  const fromInspect = input.inspect?.Config?.Labels;
  if (fromInspect && Object.keys(fromInspect).length > 0) return fromInspect;
  const fromSummary = input.summary?.Labels;
  if (fromSummary && Object.keys(fromSummary).length > 0) return fromSummary;
  return undefined;
}

function mapHealthStatus(status: string): MonitorResourceStatus | undefined {
  switch (status.toLowerCase()) {
    case "healthy":
      return "healthy";
    case "unhealthy":
      return "unhealthy";
    case "starting":
      return "starting";
    default:
      return undefined;
  }
}

function mapDockerStateStatus(
  status: string,
  exitCode?: number,
): MonitorResourceStatus {
  switch (status.toLowerCase()) {
    case "running":
      return "healthy";
    case "restarting":
    case "created":
      return "starting";
    case "paused":
      return "degraded";
    case "exited":
      return exitCode === 0 ? "stopped" : "failed";
    case "dead":
      return "failed";
    default:
      return "unknown";
  }
}

function deriveStatusFromEventAction(
  action: string,
): MonitorResourceStatus | undefined {
  const colon = action.indexOf(":");
  if (colon === -1) return undefined;
  const prefix = action.slice(0, colon).trim().toLowerCase();
  if (prefix !== "health_status") return undefined;
  return mapHealthStatus(action.slice(colon + 1).trim());
}

export function deriveContainerStatus(
  input: NormalizeContainerInput,
): MonitorResourceStatus {
  if (input.event?.Action) {
    const fromEvent = deriveStatusFromEventAction(input.event.Action);
    if (fromEvent) return fromEvent;
  }

  const healthStatus = input.inspect?.State?.Health?.Status;
  if (healthStatus) {
    const mapped = mapHealthStatus(healthStatus);
    if (mapped) return mapped;
  }

  const dockerStatus = input.inspect?.State?.Status ?? input.summary?.State;
  if (dockerStatus) {
    return mapDockerStateStatus(
      dockerStatus,
      input.inspect?.State?.ExitCode,
    );
  }

  return "unknown";
}

type PortBinding = { HostIp?: string; HostPort?: string };
type NetworkPorts = Record<string, PortBinding[] | null>;
type SummaryPort = ContainerSummary["Ports"][number];

function resolvePublishedHost(ip: string | undefined): string {
  return ip && ip !== "0.0.0.0" ? ip : "0.0.0.0";
}

function formatInspectPortBinding(
  privatePort: string,
  binding: PortBinding,
): string {
  const host = resolvePublishedHost(binding.HostIp);
  const hostPort = binding.HostPort ?? "?";
  return `${host}:${hostPort}->${privatePort}`;
}

function formatInspectPorts(networkPorts: NetworkPorts): string[] | undefined {
  const formatted: string[] = [];
  for (const [privatePort, bindings] of Object.entries(networkPorts)) {
    if (!bindings?.length) continue;
    for (const binding of bindings) {
      formatted.push(formatInspectPortBinding(privatePort, binding));
    }
  }
  if (formatted.length === 0) return undefined;
  return formatted;
}

function formatSummaryPort(port: SummaryPort): string {
  const host = resolvePublishedHost(port.IP);
  const publicPort = port.PublicPort ?? "?";
  return `${host}:${publicPort}->${port.PrivatePort}/${port.Type}`;
}

function formatPorts(input: NormalizeContainerInput): string[] | undefined {
  const networkPorts = input.inspect?.NetworkSettings?.Ports;
  if (networkPorts) {
    const fromInspect = formatInspectPorts(networkPorts);
    if (fromInspect) return fromInspect;
  }

  const summaryPorts = input.summary?.Ports;
  if (!summaryPorts?.length) return undefined;
  return summaryPorts.map(formatSummaryPort);
}

function resolveImage(input: NormalizeContainerInput): string | undefined {
  return input.inspect?.Config?.Image ??
    input.inspect?.Image ??
    input.summary?.Image;
}

const DOCKER_ZERO_TIME = "0001-01-01T00:00:00Z";

function isMeaningfulDockerTimestamp(
  value: string | undefined,
): value is string {
  return value !== undefined && value !== "" && value !== DOCKER_ZERO_TIME;
}

/** derive updatedAt from docker/event timestamps so normalization stays stable across passes. */
function resolveUpdatedAt(input: NormalizeContainerInput): string | undefined {
  if (input.event?.time !== undefined) {
    return new Date(input.event.time * 1000).toISOString();
  }

  const state = input.inspect?.State;
  if (isMeaningfulDockerTimestamp(state?.FinishedAt)) {
    return state.FinishedAt;
  }
  if (isMeaningfulDockerTimestamp(state?.StartedAt)) {
    return state.StartedAt;
  }

  return undefined;
}

export function normalizeContainer(
  input: NormalizeContainerInput,
): MonitorResourceState {
  const fullId =
    (input.inspect?.Id ?? input.summary?.Id ?? input.event?.Actor?.ID ?? "")
      .replace(/^\/+/, "");
  const labels = resolveLabels(input);
  const status = deriveContainerStatus(input);
  const healthStatus = input.inspect?.State?.Health?.Status;

  const state: MonitorResourceState = {
    resourceKey: `container:${shortContainerId(fullId)}`,
    kind: "container",
    status,
    containerId: fullId,
  };

  const updatedAt = resolveUpdatedAt(input);
  if (updatedAt) state.updatedAt = updatedAt;

  const name = resolveContainerName(input);
  if (name) state.name = name;

  const image = resolveImage(input);
  if (image) state.image = image;

  if (healthStatus) state.healthStatus = healthStatus;

  const restartCount = input.inspect?.RestartCount;
  if (restartCount !== undefined) state.restartCount = restartCount;

  const ports = formatPorts(input);
  if (ports) state.ports = ports;

  if (labels) {
    state.labels = labels;
    const projectId = labels[TURBOPANEL_LABEL_KEYS.project];
    const serviceId = labels[TURBOPANEL_LABEL_KEYS.service];
    if (projectId) state.projectId = projectId;
    if (serviceId) state.serviceId = serviceId;
  }

  return state;
}
