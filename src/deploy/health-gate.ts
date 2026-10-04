/**
 * Health gate: decide from `docker compose ps --format json` whether a freshly
 * started Compose project is actually up.
 *
 * Used by the sequential deploy strategy (`sequential-deploy.ts`), which calls
 * {@link waitForHealthGate} after `up -d` and rolls back when it reports a
 * failure. In-place deploys do not gate.
 *
 * Rules (per container, grouped by compose service):
 * - `Health: healthy` passes; `unhealthy` fails at once; `starting` keeps
 *   waiting.
 * - No healthcheck (`Health` empty) passes once the container has been
 *   `running` continuously for the stable window.
 * - `exited`/`dead` with a non-zero code fails; with exit code 0 it counts as a
 *   finished one-shot job and passes. `restarting` fails (a crash loop).
 * - Every service must have at least one container, or the gate fails.
 * - The gate fails on `healthTimeoutSeconds` and names what was still pending.
 */

import { composeFileArgs } from "./compose-files.ts";
import { parseComposePsEntries } from "./compose-ps.ts";
import type { RunDockerFn } from "./docker-cli.ts";

export type HealthGateMode = "wait" | "none";

export type HealthGateFailureReason =
  | "unhealthy"
  | "exited"
  | "restarting"
  | "timeout"
  | "no-containers"
  | "ps-failed";

export type HealthGateResult =
  | { ok: true; services: string[] }
  | {
    ok: false;
    reason: HealthGateFailureReason;
    /** Compose service the failure belongs to, when one is to blame. */
    service?: string;
    detail: string;
  };

export type HealthGateOptions = {
  /** Return the stdout of `compose ps -a --format json`, or null when it failed. */
  ps: () => Promise<string | null>;
  /** Total time the gate may take. */
  timeoutMs: number;
  /** How long a container without a healthcheck must stay `running`. */
  stableMs: number;
  /** Delay between polls. */
  pollMs: number;
  /** `none` trusts a running container immediately (no stable window). */
  mode?: HealthGateMode;
  /** Injectable clock and sleeper for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One line per poll that changed nothing to report. */
  onProgress?: (message: string) => void;
};

/** Defaults: the plan's 120 s gate and 30 s no-healthcheck window. */
export const HEALTH_GATE_DEFAULT_STABLE_MS = 30_000;
export const HEALTH_GATE_DEFAULT_POLL_MS = 2_000;

type ContainerView = {
  id: string;
  service: string;
  state: string;
  health: string;
  exitCode: number;
};

type Verdict =
  | { kind: "pass" }
  | { kind: "wait"; why: string }
  | { kind: "fail"; reason: HealthGateFailureReason; detail: string };

function readString(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function firstNonEmpty(values: readonly unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.length > 0);
}

function toContainerView(entry: Record<string, unknown>): ContainerView | null {
  const service = entry.Service;
  if (typeof service !== "string" || service.length === 0) return null;
  const id = firstNonEmpty([entry.ID, entry.Name]) ?? service;
  const exit = entry.ExitCode;
  return {
    id,
    service,
    state: readString(entry.State),
    health: readString(entry.Health),
    exitCode: typeof exit === "number" ? exit : 0,
  };
}

/**
 * Judge one container. `runningSinceMs` is how long it has been running without
 * a break as observed by this gate (0 when it just appeared or restarted).
 */
export function judgeContainer(
  c: ContainerView,
  runningSinceMs: number,
  stableMs: number,
): Verdict {
  const label = `${c.service} (${c.id.slice(0, 12)})`;
  if (c.state === "exited" || c.state === "dead") {
    if (c.exitCode === 0) return { kind: "pass" };
    return {
      kind: "fail",
      reason: "exited",
      detail: `${label} exited with code ${c.exitCode}`,
    };
  }
  if (c.state === "restarting") {
    return {
      kind: "fail",
      reason: "restarting",
      detail: `${label} is restarting (crash loop)`,
    };
  }
  if (c.state !== "running") {
    return { kind: "wait", why: `${label} is ${c.state || "not started"}` };
  }
  return judgeRunning(c, label, runningSinceMs, stableMs);
}

function judgeRunning(
  c: ContainerView,
  label: string,
  runningSinceMs: number,
  stableMs: number,
): Verdict {
  if (c.health === "healthy") return { kind: "pass" };
  if (c.health === "unhealthy") {
    return {
      kind: "fail",
      reason: "unhealthy",
      detail: `${label} failed its healthcheck`,
    };
  }
  if (c.health === "starting") {
    return { kind: "wait", why: `${label} healthcheck is starting` };
  }
  if (runningSinceMs >= stableMs) return { kind: "pass" };
  return { kind: "wait", why: `${label} has no healthcheck, settling` };
}

type Observation = {
  verdicts: { service: string; verdict: Verdict }[];
  services: string[];
};

function observe(
  containers: readonly ContainerView[],
  runningSince: Map<string, number>,
  nowMs: number,
  stableMs: number,
): Observation {
  const live = new Set<string>();
  const verdicts: Observation["verdicts"] = [];
  for (const c of containers) {
    if (c.state === "running") {
      live.add(c.id);
      if (!runningSince.has(c.id)) runningSince.set(c.id, nowMs);
    }
    const since = runningSince.get(c.id);
    const elapsed = c.state === "running" && since !== undefined
      ? nowMs - since
      : 0;
    verdicts.push({
      service: c.service,
      verdict: judgeContainer(c, elapsed, stableMs),
    });
  }
  // A container that stopped running starts its window over if it comes back.
  for (const id of runningSince.keys()) {
    if (!live.has(id)) runningSince.delete(id);
  }
  return {
    verdicts,
    services: [...new Set(containers.map((c) => c.service))].toSorted((a, b) =>
      a.localeCompare(b)
    ),
  };
}

function firstFailure(obs: Observation): HealthGateResult | null {
  for (const { service, verdict } of obs.verdicts) {
    if (verdict.kind === "fail") {
      return {
        ok: false,
        reason: verdict.reason,
        service,
        detail: verdict.detail,
      };
    }
  }
  return null;
}

function pendingReasons(obs: Observation): string[] {
  const out: string[] = [];
  for (const { verdict } of obs.verdicts) {
    if (verdict.kind === "wait") out.push(verdict.why);
  }
  return out;
}

/**
 * Poll until every container passes, one fails, or the timeout elapses.
 * Never throws for an unhealthy project; a `ps` that errors counts as a failed
 * poll and is retried until the timeout.
 */
export function waitForHealthGate(
  options: HealthGateOptions,
): Promise<HealthGateResult> {
  const clock = {
    now: options.now ?? Date.now,
    sleep: options.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  return pollGate(options, clock, {
    startedAt: clock.now(),
    stableMs: options.mode === "none" ? 0 : options.stableMs,
    runningSince: new Map<string, number>(),
  });
}

type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

type GateState = {
  startedAt: number;
  stableMs: number;
  runningSince: Map<string, number>;
};

/**
 * One poll, then either a verdict or a sleep and the next poll. Recursion
 * rather than a loop because every step awaits the previous one.
 */
async function pollGate(
  options: HealthGateOptions,
  clock: Clock,
  state: GateState,
): Promise<HealthGateResult> {
  const stdout = await options.ps();
  const nowMs = clock.now();
  const poll: PollOutcome = stdout === null
    ? {
      done: false,
      pending: ["docker compose ps failed"],
      reason: "ps-failed",
    }
    : evaluatePoll(stdout, state.runningSince, nowMs, state.stableMs);
  if (poll.done) return poll.result;
  const first = poll.pending[0];
  if (first !== undefined) options.onProgress?.(first);
  if (nowMs - state.startedAt + options.pollMs > options.timeoutMs) {
    return {
      ok: false,
      reason: poll.reason,
      detail: `health gate timed out after ${
        Math.round(options.timeoutMs / 1000)
      }s: ${poll.pending.join("; ")}`,
    };
  }
  await clock.sleep(options.pollMs);
  return pollGate(options, clock, state);
}

type PollOutcome =
  | { done: true; result: HealthGateResult }
  | { done: false; pending: string[]; reason: HealthGateFailureReason };

function evaluatePoll(
  stdout: string,
  runningSince: Map<string, number>,
  nowMs: number,
  stableMs: number,
): PollOutcome {
  const containers = parseComposePsEntries(stdout)
    .map(toContainerView)
    .filter((c): c is ContainerView => c !== null);
  if (containers.length === 0) {
    return {
      done: false,
      pending: ["no containers reported yet"],
      reason: "no-containers",
    };
  }
  const obs = observe(containers, runningSince, nowMs, stableMs);
  const failure = firstFailure(obs);
  if (failure) return { done: true, result: failure };
  const pending = pendingReasons(obs);
  if (pending.length === 0) {
    return { done: true, result: { ok: true, services: obs.services } };
  }
  return { done: false, pending, reason: "timeout" };
}

/**
 * Build the `ps` callback for {@link waitForHealthGate}: `compose ps -a` so a
 * container that already exited is still seen.
 */
export function composePsForGate(
  run: RunDockerFn,
  projectName: string,
  composePaths: readonly string[],
): () => Promise<string | null> {
  return async () => {
    const result = await run([
      ...composeFileArgs(projectName, composePaths),
      "ps",
      "-a",
      "--format",
      "json",
    ]);
    return result.success ? result.stdout : null;
  };
}
