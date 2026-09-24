import { resolveInstanceSocket } from "./sockets.ts";

/** Long enough for the instance binary to apply migrations before it answers. */
export const INSTANCE_UPDATE_HEALTH_TIMEOUT_MS = 5 * 60 * 1000;
export const INSTANCE_UPDATE_HEALTH_INTERVAL_MS = 2_000;

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
  readHealth?: () => Promise<ControlPlaneHealthSnapshot | null>;
  unitActive?: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** When set, replaces commit/version equality (rollback with no prior health). */
  accept?: (health: ControlPlaneHealthSnapshot) => boolean;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? INSTANCE_UPDATE_HEALTH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? INSTANCE_UPDATE_HEALTH_INTERVAL_MS;
  const readHealth = options.readHealth ?? (() => readInstanceHealth());
  const unitActive = options.unitActive ?? (() => instanceUnitIsActive());
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let sawMismatch = false;
  while (now() <= deadline) {
    const active = await unitActive();
    const health = active ? await readHealth() : null;
    if (health && healthAccepted(health, options)) return;
    if (health && health.commit !== options.target.commit) sawMismatch = true;
    if (now() >= deadline) break;
    const remaining = deadline - now();
    await sleep(Math.min(intervalMs, Math.max(remaining, 0)));
  }
  const code = sawMismatch ? "health_mismatch" : "health_timeout";
  throw new InstanceHealthError(
    code,
    `${code}: control plane did not report ${options.target.commit} before the health deadline`,
  );
}
