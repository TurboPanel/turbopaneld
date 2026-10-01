import { resolveInstanceSocket } from "./sockets.ts";

/**
 * Default health-wait budget. A 1-core, 1 GB host can take several minutes to
 * start the new instance binary and apply migrations before it answers, and a
 * rollback is far worse than waiting, so the default is generous. Override
 * with {@link UPDATE_HEALTH_TIMEOUT_ENV}.
 */
export const INSTANCE_UPDATE_HEALTH_TIMEOUT_MS = 10 * 60 * 1000;
/** First poll gap; later polls back off up to the max below. */
export const INSTANCE_UPDATE_HEALTH_INTERVAL_MS = 1_000;
export const INSTANCE_UPDATE_HEALTH_MAX_INTERVAL_MS = 10_000;

export const UPDATE_HEALTH_TIMEOUT_ENV =
  "TURBOPANEL_UPDATE_HEALTH_TIMEOUT_SECONDS";
const MIN_HEALTH_TIMEOUT_SECONDS = 30;
const MAX_HEALTH_TIMEOUT_SECONDS = 3_600;

/**
 * The health-wait budget in milliseconds: `TURBOPANEL_UPDATE_HEALTH_TIMEOUT_SECONDS`
 * when it is a whole number of seconds within 30..3600, else the default.
 */
export function resolveUpdateHealthTimeoutMs(
  env?: Record<string, string | undefined>,
): number {
  let raw: string | undefined;
  try {
    raw = (env ?? Deno.env.toObject())[UPDATE_HEALTH_TIMEOUT_ENV];
  } catch {
    raw = undefined;
  }
  const text = raw?.trim() ?? "";
  if (!/^\d+$/.test(text)) return INSTANCE_UPDATE_HEALTH_TIMEOUT_MS;
  const seconds = Number(text);
  if (
    seconds < MIN_HEALTH_TIMEOUT_SECONDS ||
    seconds > MAX_HEALTH_TIMEOUT_SECONDS
  ) {
    return INSTANCE_UPDATE_HEALTH_TIMEOUT_MS;
  }
  return seconds * 1_000;
}

export const CONTROL_PLANE_INSTANCE_UNIT = "turbopanel-instance";

export type ControlPlaneHealthSnapshot = {
  version: string;
  commit: string;
};

export class InstanceHealthError extends Error {
  readonly code: "health_timeout" | "health_mismatch";

  constructor(code: "health_timeout" | "health_mismatch", message: string) {
    super(message);
    this.name = "InstanceHealthError";
    this.code = code;
  }
}

export type InstanceHealthTarget = {
  commit: string;
  version?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function healthAccepted(
  health: ControlPlaneHealthSnapshot,
  options: {
    target: InstanceHealthTarget;
    accept?: (health: ControlPlaneHealthSnapshot) => boolean;
  },
): boolean {
  if (options.accept) return options.accept(health);
  return healthMatches(health, options.target);
}

function healthMatches(
  health: ControlPlaneHealthSnapshot,
  target: InstanceHealthTarget,
): boolean {
  if (health.commit !== target.commit) return false;
  if (target.version && health.version !== target.version) return false;
  return true;
}

/**
 * `GET /api/health` over the instance Unix socket. A down socket or a body
 * without version and commit is `null` so the poll can keep waiting.
 */
export async function readInstanceHealth(
  socketPath: string = resolveInstanceSocket(),
): Promise<ControlPlaneHealthSnapshot | null> {
  let client: Deno.HttpClient | undefined;
  try {
    client = Deno.createHttpClient({
      proxy: { transport: "unix", path: socketPath },
    });
    const response = await fetch("http://localhost/api/health", { client });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    const version = typeof body.version === "string" ? body.version : "";
    const revision = isRecord(body.revision) ? body.revision : null;
    const commit = revision && typeof revision.commit === "string"
      ? revision.commit
      : "";
    if (!version || !commit || commit === "unknown") return null;
    return { version, commit };
  } catch {
    return null;
  } finally {
    client?.close();
  }
}

export async function instanceUnitIsActive(
  unit: string = CONTROL_PLANE_INSTANCE_UNIT,
): Promise<boolean> {
  try {
    const result = await new Deno.Command("systemctl", {
      args: ["is-active", "--quiet", unit],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Poll until the instance unit is active and `/api/health` names the target
 * build. A response for a different commit is a mismatch; no response before
 * the deadline is a timeout.
 */
export async function waitForInstanceHealth(options: {
  target: InstanceHealthTarget;
  timeoutMs?: number;
  intervalMs?: number;
  /** When set, the poll gap doubles after each miss, up to this cap. */
  maxIntervalMs?: number;
  readHealth?: () => Promise<ControlPlaneHealthSnapshot | null>;
  unitActive?: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** When set, replaces commit/version equality (rollback with no prior health). */
  accept?: (health: ControlPlaneHealthSnapshot) => boolean;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? resolveUpdateHealthTimeoutMs();
  let intervalMs = options.intervalMs ?? INSTANCE_UPDATE_HEALTH_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? intervalMs;
  const readHealth = options.readHealth ?? (() => readInstanceHealth());
  const unitActive = options.unitActive ?? (() => instanceUnitIsActive());
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let sawMismatch = false;
  // One poll, then (unless accepted or out of time) a sleep and the next poll.
  const poll = async (): Promise<boolean> => {
    if (now() > deadline) return false;
    const active = await unitActive();
    const health = active ? await readHealth() : null;
    if (health && healthAccepted(health, options)) return true;
    if (health && health.commit !== options.target.commit) sawMismatch = true;
    if (now() >= deadline) return false;
    const remaining = deadline - now();
    await sleep(Math.min(intervalMs, Math.max(remaining, 0)));
    intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    return poll();
  };
  if (await poll()) return;
  const code = sawMismatch ? "health_mismatch" : "health_timeout";
  throw new InstanceHealthError(
    code,
    `${code}: control plane did not report ${options.target.commit} before the health deadline`,
  );
}
