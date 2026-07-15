/**
 * Typed command wire contracts mirrored from the instance
 * `src/lib/commands/` module. Keep in sync when instance command shapes change.
 */

export const COMMAND_TYPES = [
  "daemon.ping",
  "environment.deploy",
  "server.hostname.set",
  "server.reboot",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export type PingPayload = Record<string, never>;

export type PingResult = {
  apiAcceptedAt?: string;
  queuedAt?: string;
  consumerReceivedAt?: string;
  cellEnqueuedAt?: string;
  daemonReceivedAt?: string;
  daemonRespondedAt?: string;
  resultRecordedAt?: string;
  daemonHostname?: string;
  daemonBuild?: {
    commit?: string;
    buildId?: string;
    builtAt?: string;
    channel?: string;
  };
};

export type HostnamePayload = {
  hostname: string;
};

export type HostnameResult = {
  observedHostname: string;
  summary?: string;
};

export type RebootPayload = Record<string, never>;

export type RebootResult = {
  scheduled: boolean;
  summary?: string;
};

export type EnvironmentDeployHosting = {
  hostingId: string;
  serviceId: string;
  composeServiceName: string;
  hostnames: string[];
  pathPrefix?: string;
  targetPort?: number;
};

export type EnvironmentDeployPayload = {
  environmentId: string;
  projectId: string;
  projectName: string;
  composeYaml: string;
  hostings: EnvironmentDeployHosting[];
};

export type EnvironmentDeployContainer = {
  /** Present when the compose service appears in `payload.hostings`. */
  serviceId?: string;
  composeServiceName: string;
  containerId: string;
  containerName: string;
  status: string;
};

export type EnvironmentDeployResult = {
  projectName: string;
  summary: string;
  services?: string[];
  containers?: EnvironmentDeployContainer[];
};

/** Must stay in sync with the instance canonical version in src/lib/commands/hostname.ts */
export const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Must stay in sync with the instance canonical version in src/lib/commands/hostname.ts */
export const HOSTNAME_MAX_LENGTH = 253;

const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/;

/** Must stay in sync with the instance canonical version in src/lib/commands/hostname.ts */
export function isValidHostname(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > HOSTNAME_MAX_LENGTH) return false;
  if (/[A-Z]/.test(value)) return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return HOSTNAME_RE.test(value);
}

/** Must stay in sync with the instance canonical version in src/lib/commands/hostname.ts */
export function assertValidHostname(value: unknown): asserts value is string {
  if (!isValidHostname(value)) {
    throw new Error("Invalid hostname");
  }
}

export type CommandDispatchMessage = {
  type: "command-dispatch";
  id: string;
  commandId: string;
  commandType: string;
  payload: unknown;
  at: string;
};

export type CommandAckMessage = {
  type: "command-ack";
  id: string;
  at: string;
  daemonReceivedAt: string;
};

export type CommandOutcomeMessage = {
  type: "command-outcome";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  at: string;
  daemonReceivedAt?: string;
  daemonRespondedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePingPayload(value: unknown): PingPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid ping payload");
  }
  return {};
}

export function parseRebootPayload(value: unknown): RebootPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid reboot payload");
  }
  return {};
}

export function parseHostnamePayload(value: unknown): HostnamePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid hostname payload");
  }
  const record = value as Record<string, unknown>;
  const hostname = record.hostname;
  if (typeof hostname !== "string" || hostname.length === 0) {
    throw new Error("hostname must be a non-empty string");
  }
  assertValidHostname(hostname);
  return { hostname };
}

function parseNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return value;
}

function parseHosting(value: unknown): EnvironmentDeployHosting {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy hosting");
  }

  const hostnames = value.hostnames;
  if (!Array.isArray(hostnames)) {
    throw new TypeError("hostings[].hostnames must contain valid hostnames");
  }
  const parsedHostnames: string[] = [];
  for (const hostname of hostnames) {
    if (!isValidHostname(hostname)) {
      throw new TypeError("hostings[].hostnames must contain valid hostnames");
    }
    parsedHostnames.push(hostname);
  }

  const pathPrefix = value.pathPrefix;
  if (
    pathPrefix !== undefined &&
    (typeof pathPrefix !== "string" || !pathPrefix.startsWith("/"))
  ) {
    throw new TypeError("hostings[].pathPrefix must start with /");
  }

  const targetPort = value.targetPort;
  if (
    targetPort !== undefined &&
    (typeof targetPort !== "number" ||
      !Number.isInteger(targetPort) ||
      targetPort < 1 ||
      targetPort > 65_535)
  ) {
    throw new TypeError("hostings[].targetPort must be a valid port");
  }

  return {
    hostingId: parseNonEmptyString(value, "hostingId"),
    serviceId: parseNonEmptyString(value, "serviceId"),
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
    hostnames: parsedHostnames,
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
    ...(targetPort === undefined ? {} : { targetPort }),
  };
}

export function parseEnvironmentDeployPayload(
  value: unknown,
): EnvironmentDeployPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy payload");
  }

  const hostings = value.hostings;
  if (!Array.isArray(hostings)) {
    throw new TypeError("hostings must be an array");
  }

  return {
    environmentId: parseNonEmptyString(value, "environmentId"),
    projectId: parseNonEmptyString(value, "projectId"),
    projectName: parseNonEmptyString(value, "projectName"),
    composeYaml: parseNonEmptyString(value, "composeYaml"),
    hostings: hostings.map(parseHosting),
  };
}
