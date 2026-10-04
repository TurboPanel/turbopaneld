/**
 * Per-service run state from Docker container state.
 *
 * Pure derivation lives here; the {@link Sentinel} feeds it observations and
 * the presence channel carries the result (`src/host/service-run-state.ts`).
 *
 * Rules:
 * - A container is `running` only after it has stayed up for
 *   {@link SERVICE_SETTLE_MS}. A deploy that dies at second 10 therefore never
 *   shows as running, however briefly Docker reports it up.
 * - `restarting` is `crashing`.
 * - Down with a non-zero exit at or past {@link SERVICE_CRASH_LIMIT} restarts is
 *   `stopped_after_crashes`.
 * - A service with several containers reports its worst one.
 */
import type { ContainerInspect, ContainerSummary } from "../docker/client.ts";
import {
  MAX_SERVICE_LAST_ERROR_CHARS,
  MAX_SERVICE_RUN_STATES,
  SERVICE_CRASH_LIMIT,
  SERVICE_SETTLE_MS,
  type ServiceRunState,
  type ServiceRunStateName,
} from "../contracts/service-run-state.ts";
import {
  LABEL_ROLE,
  LABEL_ROLE_INGRESS,
  LABEL_ROLE_SYSTEM,
  LABEL_SERVICE_ID,
} from "../deploy/labels.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { lastLogReason } from "../managed/container-stability.ts";

/** One container of a service, as the sentinel saw it. */
export type ServiceContainerObservation = {
  serviceId: string;
  containerId: string;
  summary?: ContainerSummary;
  inspect?: ContainerInspect;
  /** Last log line fetched for a failing container, when known. */
  lastLogLine?: string;
};

type DerivedServiceRunState = Omit<ServiceRunState, "asOf">;

/** Worst first; the service reports the highest-ranked container state. */
const STATE_SEVERITY: Record<ServiceRunStateName, number> = {
  stopped_after_crashes: 6,
  crashing: 5,
  unhealthy: 4,
  stopped: 3,
  unknown: 2,
  starting: 1,
  running: 0,
};

function dockerStatusOf(obs: ServiceContainerObservation): string {
  return (obs.inspect?.State?.Status ?? obs.summary?.State ?? "")
    .toLowerCase();
}

function upForMs(inspect: ContainerInspect | undefined, nowMs: number) {
  const startedAt = inspect?.State?.StartedAt;
  if (!startedAt) return undefined;
  const startedMs = Date.parse(startedAt);
  return Number.isFinite(startedMs) ? nowMs - startedMs : undefined;
}

function runningState(
  obs: ServiceContainerObservation,
  nowMs: number,
): ServiceRunStateName {
  const health = obs.inspect?.State?.Health?.Status?.toLowerCase();
  if (health === "unhealthy") return "unhealthy";
  if (health === "starting") return "starting";
  const upMs = upForMs(obs.inspect, nowMs);
  if (upMs === undefined || upMs < SERVICE_SETTLE_MS) return "starting";
  return "running";
}

function downState(obs: ServiceContainerObservation): ServiceRunStateName {
  const exitCode = obs.inspect?.State?.ExitCode ?? 0;
  const failed = exitCode !== 0 || dockerStatusOf(obs) === "dead";
  if (failed && (obs.inspect?.RestartCount ?? 0) >= SERVICE_CRASH_LIMIT) {
    return "stopped_after_crashes";
  }
  return "stopped";
}

/** Run state of one container. */
export function containerRunState(
  obs: ServiceContainerObservation,
  nowMs: number,
): ServiceRunStateName {
  switch (dockerStatusOf(obs)) {
    case "running":
      return runningState(obs, nowMs);
    case "restarting":
      return "crashing";
    case "created":
      return "starting";
    case "exited":
    case "dead":
    case "paused":
      return downState(obs);
    default:
      return "unknown";
  }
}

/** True when the container is down or flapping and its last log line helps. */
export function wantsLastLogLine(obs: ServiceContainerObservation): boolean {
  const status = dockerStatusOf(obs);
  if (status === "restarting" || status === "dead") return true;
  return status === "exited" && (obs.inspect?.State?.ExitCode ?? 0) !== 0;
}

function errorLineFor(obs: ServiceContainerObservation): string | undefined {
  if (obs.lastLogLine) return obs.lastLogLine;
  const exitCode = obs.inspect?.State?.ExitCode;
  if (dockerStatusOf(obs) === "exited" && exitCode) {
    return `Exited with code ${exitCode}`;
  }
  return undefined;
}

function worseOf(
  current: DerivedServiceRunState | undefined,
  next: DerivedServiceRunState,
): DerivedServiceRunState {
  if (!current) return next;
  const worse = STATE_SEVERITY[next.state] > STATE_SEVERITY[current.state]
    ? next
    : current;
  const other = worse === next ? current : next;
  return {
    serviceId: worse.serviceId,
    state: worse.state,
    restartCount: Math.max(worse.restartCount, other.restartCount),
    ...(worse.lastError ?? other.lastError
      ? { lastError: worse.lastError ?? other.lastError }
      : {}),
  };
}

/** Collapse container observations to one derived state per service. */
export function deriveServiceRunStates(
  observations: readonly ServiceContainerObservation[],
  nowMs: number,
): DerivedServiceRunState[] {
  const byService = new Map<string, DerivedServiceRunState>();
  for (const obs of observations) {
    const state = containerRunState(obs, nowMs);
    const lastError = state === "running" || state === "starting"
      ? undefined
      : errorLineFor(obs);
    const next: DerivedServiceRunState = {
      serviceId: obs.serviceId,
      state,
      restartCount: obs.inspect?.RestartCount ?? 0,
      ...(lastError
        ? { lastError: lastError.slice(0, MAX_SERVICE_LAST_ERROR_CHARS) }
        : {}),
    };
    byService.set(obs.serviceId, worseOf(byService.get(obs.serviceId), next));
  }
  return [...byService.values()]
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId))
    .slice(0, MAX_SERVICE_RUN_STATES);
}

/** Tenant workload containers only: ingress and platform containers share the service label. */
export function serviceIdForContainer(
  labels: Record<string, string> | undefined,
): string | undefined {
  const serviceId = labels?.[LABEL_SERVICE_ID];
  if (!serviceId) return undefined;
  const role = labels?.[LABEL_ROLE];
  if (role === LABEL_ROLE_INGRESS || role === LABEL_ROLE_SYSTEM) {
    return undefined;
  }
  return serviceId;
}

function fingerprint(state: DerivedServiceRunState): string {
  return `${state.state}|${state.restartCount}|${state.lastError ?? ""}`;
}

/**
 * Stamps `asOf` on derived states: the time the daemon first saw each exact
 * state, held steady while it does not change.
 */
export class ServiceRunStateStamper {
  readonly #seen = new Map<string, { fingerprint: string; asOf: string }>();

  stamp(
    derived: readonly DerivedServiceRunState[],
    now: Date,
  ): ServiceRunState[] {
    const nowIso = now.toISOString();
    const liveIds = new Set<string>();
    const stamped = derived.map((entry) => {
      liveIds.add(entry.serviceId);
      const print = fingerprint(entry);
      const previous = this.#seen.get(entry.serviceId);
      const asOf = previous?.fingerprint === print ? previous.asOf : nowIso;
      this.#seen.set(entry.serviceId, { fingerprint: print, asOf });
      return { ...entry, asOf };
    });
    for (const id of this.#seen.keys()) {
      if (!liveIds.has(id)) this.#seen.delete(id);
    }
    return stamped;
  }
}

/** Last log line of a container through the Docker CLI (`docker logs --tail 5`). */
export async function fetchContainerLastLogLine(
  containerId: string,
  run: typeof runDocker = runDocker,
): Promise<string> {
  const logs = await run(["logs", "--tail", "5", containerId]);
  return lastLogReason(`${logs.stdout}\n${logs.stderr}`);
}
