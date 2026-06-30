/**
 * Typed command wire contracts mirrored from the instance
 * `src/lib/commands/` module. Keep in sync when instance command shapes change.
 */

export const COMMAND_TYPES = ["daemon.ping", "server.hostname.set"] as const;

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
