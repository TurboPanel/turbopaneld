/**
 * Dead-primary detection for managed PostgreSQL, run on the primary's OWN
 * host (Orchestrator only speaks MySQL, so it can never see Postgres).
 *
 * Scope (policy switch: `DEAD_PRIMARY_DETECTION_SCOPE`): the engine
 * container/process is dead while this host and its daemon are alive, so
 * the control plane can still reach the host to fence it. Whole-host loss
 * is deliberately NOT detected here — nothing can fence a host that is
 * gone; that stays a manual operator action with an alert. Widening it
 * later (Option A) is a control-plane policy change
 * (`turbopanel/src/features/managed/ha-policy.ts` →
 * `AUTOMATIC_FAILOVER_DETECTORS`) plus a host-loss detector there, not a
 * change to this probe.
 *
 * A false positive fails over a healthy cluster, so every rule prefers a
 * false negative:
 * - DEAD needs `failureThreshold` consecutive hard failures spanning at
 *   least `minFailureSpanMs`;
 * - anything the daemon cannot read (Docker socket errors/timeouts, exec
 *   plumbing errors, `pg_isready` exit 3) is inconclusive and resets the
 *   streak;
 * - a server that answers at all (incl. "too many connections", 53300, or
 *   any auth error) is alive — `pg_isready` / `PQping` report OK for every
 *   server-side error except 57P03;
 * - 57P03 (starting up / recovery / shutting down) is soft for
 *   `rejectingGraceMs`, extended to `crashRecoveryGraceMs` while
 *   `pg_controldata` says "in crash recovery"; "in archive recovery" means
 *   this node is a standby, so the probe never fires;
 * - "no response" right after a container (re)start is soft for
 *   `startGraceMs` (the postmaster is not listening yet); later it is hard
 *   only when `pg_ctl status` confirms the postmaster is gone, otherwise
 *   soft for `unresponsiveGraceMs` (an overloaded primary is not dead);
 * - a failed `pg_controldata` read keeps the long crash-recovery grace;
 * - while one incident lasts the event is re-sent with exponential back-off
 *   (`resendBaseMs` doubling to `resendMaxMs`, at most `maxEventsPerIncident`
 *   events) so a refusal (e.g. inside the control plane's 15 min cooldown)
 *   is retried after it; a new incident no sooner than `backoffMs` after
 *   the last event, reset when the primary answers again.
 *
 * Only read-only probes run, as the `postgres` user: `docker inspect`,
 * `pg_isready`, `pg_ctl status`, `pg_controldata`. No SQL, no credentials
 * (the image's local socket). Streaks, graces and back-off use a monotonic
 * clock; only Docker's `StartedAt` is compared with wall time.
 */

import type {
  DockerCliResult,
  RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";

/** Engine dead, host alive. See the module comment for widening. */
export const DEAD_PRIMARY_DETECTION_SCOPE = "engine-dead-host-alive" as const;
export const POSTGRES_PROBE_DETECTOR = "postgres-probe" as const;

export type PgDeadPrimaryConfig = {
  intervalMs: number;
  failureThreshold: number;
  minFailureSpanMs: number;
  rejectingGraceMs: number;
  crashRecoveryGraceMs: number;
  startGraceMs: number;
  /**
   * A RUNNING container whose postmaster is still there (or cannot be read)
   * but does not answer `pg_isready` (exit 2: overloaded, wedged, slow
   * accept): soft this long. Only a postmaster confirmed gone is hard fast.
   */
  unresponsiveGraceMs: number;
  backoffMs: number;
  /** First re-send of a still-dead incident; doubles each time. */
  resendBaseMs: number;
  /** Ceiling for the re-send interval. */
  resendMaxMs: number;
  /** Events per incident, including the first. */
  maxEventsPerIncident: number;
  dockerTimeoutMs: number;
  pgReadyTimeoutSeconds: number;
};

export const DEFAULT_PG_DEAD_PRIMARY_CONFIG: Readonly<PgDeadPrimaryConfig> = {
  intervalMs: 5_000,
  failureThreshold: 6,
  minFailureSpanMs: 20_000,
  rejectingGraceMs: 10 * 60_000,
  crashRecoveryGraceMs: 30 * 60_000,
  startGraceMs: 60_000,
  unresponsiveGraceMs: 5 * 60_000,
  backoffMs: 5 * 60_000,
  resendBaseMs: 5 * 60_000,
  resendMaxMs: 60 * 60_000,
  maxEventsPerIncident: 5,
  dockerTimeoutMs: 10_000,
  pgReadyTimeoutSeconds: 3,
};

export type ContainerSnapshot = {
  status: string;
  exitCode: number;
  restartCount: number;
  startedAt?: string;
  health?: string;
  oomKilled?: boolean;
};

export type ContainerRead =
  | { kind: "present"; state: ContainerSnapshot }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

/** `pg_isready` exit code: 0 accepting, 1 rejecting (57P03), 2 no response. */
export type PgReadyRead =
  | { kind: "exit"; code: number; output: string }
  | { kind: "unreadable"; reason: string };

export type ControlDataState =
  | "in production"
  | "in crash recovery"
  | "in archive recovery"
  | "shut down"
  | "shut down in recovery"
  | "shutting down"
  | "unknown"
  /** `pg_controldata` failed or timed out. */
  | "unreadable";

/** `pg_ctl status`: 0 running, 3 not running; anything else unknown. */
export type PostmasterState = "running" | "stopped" | "unknown";

export type ProbeSample = {
  container: ContainerRead;
  pgReady?: PgReadyRead;
  controlData?: ControlDataState;
  postmaster?: PostmasterState;
};

export type Observation =
  | { kind: "healthy" }
  | { kind: "inconclusive"; reason: string }
  /** Not dead yet: counts as hard only once its grace has run out. */
  | { kind: "soft"; reason: string; graceMs: number }
  | { kind: "hard"; reason: string }
  /** This node is not a primary (in archive recovery): never fire. */
  | { kind: "not-primary"; reason: string };

const DEAD_CONTAINER_STATES = new Set([
  "exited",
  "dead",
  "restarting",
  "created",
  "paused",
  "removing",
]);

function containerAgeMs(state: ContainerSnapshot, nowMs: number): number {
  const started = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
  return Number.isFinite(started) ? nowMs - started : Number.POSITIVE_INFINITY;
}

const CRASH_RECOVERY_GRACE_STATES: ReadonlySet<ControlDataState> = new Set<
  ControlDataState
>(["in crash recovery", "unknown", "unreadable"]);

function classifyNoResponse(
  sample: ProbeSample,
  state: ContainerSnapshot,
  wallMs: number,
  config: PgDeadPrimaryConfig,
): Observation {
  if (containerAgeMs(state, wallMs) < config.startGraceMs) {
    return {
      kind: "soft",
      reason: "postgres not answering yet after container start",
      graceMs: config.startGraceMs,
    };
  }
  if (sample.postmaster === "stopped") {
    return {
      kind: "hard",
      reason: "postgres not answering and postmaster gone",
    };
  }
  return {
    kind: "soft",
    reason: `postgres not answering (pg_isready 2), postmaster ${
      sample.postmaster ?? "unknown"
    }`,
    graceMs: config.unresponsiveGraceMs,
  };
}

function classifyRejecting(
  sample: ProbeSample,
  config: PgDeadPrimaryConfig,
): Observation {
  if (sample.controlData === "in archive recovery") {
    return { kind: "not-primary", reason: "engine is in archive recovery" };
  }
  // Crash recovery, or no reading at all: assume the long recovery grace.
  // A failed pg_controldata must never shorten the grace mid-recovery.
  if (CRASH_RECOVERY_GRACE_STATES.has(sample.controlData ?? "unreadable")) {
    return {
      kind: "soft",
      reason: `postgres rejecting connections (57P03), control data: ${
        sample.controlData ?? "not read"
      }`,
      graceMs: config.crashRecoveryGraceMs,
    };
  }
  return {
    kind: "soft",
    reason: "postgres rejecting connections (57P03)",
    graceMs: config.rejectingGraceMs,
  };
}

function classifyPgReady(
  sample: ProbeSample,
  state: ContainerSnapshot,
  nowMs: number,
  config: PgDeadPrimaryConfig,
): Observation {
  const ready = sample.pgReady;
  if (!ready || ready.kind === "unreadable") {
    return {
      kind: "inconclusive",
      reason: `pg_isready unreadable: ${ready?.reason ?? "not run"}`,
    };
  }
  if (ready.code === 0) return { kind: "healthy" };
  if (ready.code === 1) return classifyRejecting(sample, config);
  if (ready.code === 2) return classifyNoResponse(sample, state, nowMs, config);
  // 3 = no attempt (bad parameters); 125-127 = docker exec plumbing.
  return {
    kind: "inconclusive",
    reason: `pg_isready exit ${ready.code}`,
  };
}

/** Pure: one sample → one observation. `nowMs` is WALL time (container start). */
export function classifyProbeSample(
  sample: ProbeSample,
  nowMs: number,
  config: PgDeadPrimaryConfig = DEFAULT_PG_DEAD_PRIMARY_CONFIG,
): Observation {
  const container = sample.container;
  if (container.kind === "unreadable") {
    return {
      kind: "inconclusive",
      reason: `container state unreadable: ${container.reason}`,
    };
  }
  if (container.kind === "absent") {
    return { kind: "hard", reason: "engine container absent" };
  }
  const state = container.state;
  if (DEAD_CONTAINER_STATES.has(state.status)) {
    return {
      kind: "hard",
      reason: `container ${state.status} exit=${state.exitCode}${
        state.oomKilled ? " oom" : ""
      }`,
    };
  }
  if (state.status !== "running") {
    return {
      kind: "inconclusive",
      reason: `container status ${state.status}`,
    };
  }
  return classifyPgReady(sample, state, nowMs, config);
}

export type DeadPrimaryEvidence = {
  failures: number;
  spanMs: number;
  lastError: string;
  container?: ContainerSnapshot;
  scope: typeof DEAD_PRIMARY_DETECTION_SCOPE;
  /** 1 for the first event of an incident, 2+ for re-sends. */
  attempt: number;
};

export type DetectorStepContext = {
  /**
   * MONOTONIC ms (`performance.now()`): streaks, graces and back-off. A wall
   * clock step must never shorten or stretch them.
   */
  nowMs: number;
  /** Wall-clock ms, only for comparing with Docker's `StartedAt`. */
  wallMs?: number;
  /** A platform action holds an intent marker for this cluster. */
  intentActive: boolean;
};

export type DetectorVerdict =
  | { fire: false }
  | { fire: true; evidence: DeadPrimaryEvidence };

/**
 * Per-cluster state machine. `step` never sends anything; the caller emits
 * and then calls `markEmitted` only when the event was actually delivered.
 */
export class DeadPrimaryDetector {
  readonly #config: PgDeadPrimaryConfig;
  #streak = 0;
  #streakStartMs: number | null = null;
  #softSinceMs: number | null = null;
  #lastError = "";
  #lastContainer: ContainerSnapshot | undefined;
  #incidentEvents = 0;
  #nextResendMs: number | null = null;
  #lastEmitMs: number | null = null;

  constructor(config: PgDeadPrimaryConfig = DEFAULT_PG_DEAD_PRIMARY_CONFIG) {
    this.#config = config;
  }

  get streak(): number {
    return this.#streak;
  }

  /** Forget the current failure run (not the incident / back-off). */
  resetStreak(): void {
    this.#streak = 0;
    this.#streakStartMs = null;
    this.#softSinceMs = null;
  }

  #recordHard(reason: string, nowMs: number): void {
    this.#streak += 1;
    this.#streakStartMs ??= nowMs;
    this.#lastError = reason;
  }

  #applySoft(
    observation: Extract<Observation, { kind: "soft" }>,
    nowMs: number,
  ): void {
    this.#softSinceMs ??= nowMs;
    // Inside its grace a soft failure holds the streak (no reset, no count),
    // so a crash loop that alternates dead/starting still accumulates.
    if (nowMs - this.#softSinceMs >= observation.graceMs) {
      this.#recordHard(`${observation.reason} beyond grace`, nowMs);
    }
  }

  #apply(observation: Observation, nowMs: number): void {
    switch (observation.kind) {
      case "healthy":
        this.resetStreak();
        this.#incidentEvents = 0;
        this.#nextResendMs = null;
        return;
      case "inconclusive":
      case "not-primary":
        this.resetStreak();
        return;
      case "soft":
        this.#applySoft(observation, nowMs);
        return;
      case "hard":
        this.#softSinceMs = null;
        this.#recordHard(observation.reason, nowMs);
        return;
    }
  }

  #canFire(nowMs: number): boolean {
    if (this.#streak < this.#config.failureThreshold) return false;
    if (this.#streakStartMs === null) return false;
    if (nowMs - this.#streakStartMs < this.#config.minFailureSpanMs) {
      return false;
    }
    if (this.#incidentEvents > 0) {
      return this.#incidentEvents < this.#config.maxEventsPerIncident &&
        nowMs >= (this.#nextResendMs ?? Number.POSITIVE_INFINITY);
    }
    return this.#lastEmitMs === null ||
      nowMs - this.#lastEmitMs >= this.#config.backoffMs;
  }

  step(
    sample: ProbeSample,
    context: DetectorStepContext,
  ): DetectorVerdict {
    if (context.intentActive) {
      this.resetStreak();
      return { fire: false };
    }
    if (sample.container.kind === "present") {
      this.#lastContainer = sample.container.state;
    }
    this.#apply(
      classifyProbeSample(
        sample,
        context.wallMs ?? context.nowMs,
        this.#config,
      ),
      context.nowMs,
    );
    if (!this.#canFire(context.nowMs)) return { fire: false };
    return {
      fire: true,
      evidence: {
        failures: this.#streak,
        spanMs: context.nowMs - (this.#streakStartMs ?? context.nowMs),
        lastError: sanitizeForLog(this.#lastError).slice(0, 300),
        ...(this.#lastContainer ? { container: this.#lastContainer } : {}),
        scope: DEAD_PRIMARY_DETECTION_SCOPE,
        attempt: this.#incidentEvents + 1,
      },
    };
  }

  markEmitted(nowMs: number): void {
    this.#incidentEvents += 1;
    this.#lastEmitMs = nowMs;
    const interval = Math.min(
      this.#config.resendBaseMs * 2 ** (this.#incidentEvents - 1),
      this.#config.resendMaxMs,
    );
    this.#nextResendMs = nowMs + interval;
  }
}

// ---------------------------------------------------------------------------
// Read-only probes (Docker CLI). Every call is bounded by a timeout; a
// timeout is "unreadable", never "dead".

export type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse `docker inspect -f '{{json .State}} {{.RestartCount}}'`. */
export function parseInspectState(stdout: string): ContainerSnapshot | null {
  const trimmed = stdout.trim();
  const split = trimmed.lastIndexOf(" ");
  if (split <= 0) return null;
  try {
    const state = JSON.parse(trimmed.slice(0, split)) as Record<
      string,
      unknown
    >;
    if (typeof state.Status !== "string") return null;
    const restartCount = Number(trimmed.slice(split + 1));
    const health = state.Health as Record<string, unknown> | undefined;
    return {
      status: state.Status,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : 0,
      restartCount: Number.isFinite(restartCount) ? restartCount : 0,
      ...(typeof state.StartedAt === "string"
        ? { startedAt: state.StartedAt }
        : {}),
      ...(typeof health?.Status === "string" ? { health: health.Status } : {}),
      ...(state.OOMKilled === true ? { oomKilled: true } : {}),
    };
  } catch {
    return null;
  }
}

const NO_SUCH_CONTAINER_RE = /no such (object|container)/i;

export async function readContainerState(
  containerName: string,
  run: RunDockerFn,
  timeoutMs: number,
): Promise<ContainerRead> {
  const result = await withTimeout<DockerCliResult | null>(
    run([
      "inspect",
      "--type",
      "container",
      "-f",
      "{{json .State}} {{.RestartCount}}",
      containerName,
    ]),
    timeoutMs,
    () => null,
  );
  if (!result) return { kind: "unreadable", reason: "docker inspect timeout" };
  if (!result.success) {
    if (NO_SUCH_CONTAINER_RE.test(result.stderr)) return { kind: "absent" };
    return {
      kind: "unreadable",
      reason: sanitizeForLog(result.stderr || "docker inspect failed").slice(
        0,
        200,
      ),
    };
  }
  const state = parseInspectState(result.stdout);
  return state
    ? { kind: "present", state }
    : { kind: "unreadable", reason: "docker inspect output unparseable" };
}

export async function readPgReady(
  containerName: string,
  run: RunDockerFn,
  config: PgDeadPrimaryConfig,
): Promise<PgReadyRead> {
  const result = await withTimeout<DockerCliResult | null>(
    run([
      "exec",
      "-u",
      "postgres",
      containerName,
      "pg_isready",
      "-q",
      "-t",
      String(config.pgReadyTimeoutSeconds),
      "-U",
      "postgres",
      "-d",
      "postgres",
    ]),
    config.dockerTimeoutMs,
    () => null,
  );
  if (!result) return { kind: "unreadable", reason: "pg_isready timeout" };
  // `pg_isready -q` prints nothing itself, so any stderr is Docker talking
  // ("Error response from daemon", socket errors): never an engine verdict.
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return {
      kind: "unreadable",
      reason: sanitizeForLog(stderr).slice(0, 200),
    };
  }
  return { kind: "exit", code: result.code, output: "" };
}

const CONTROL_DATA_STATES: readonly ControlDataState[] = [
  "shut down in recovery",
  "in crash recovery",
  "in archive recovery",
  "in production",
  "shutting down",
  "shut down",
];

export function parseControlDataState(stdout: string): ControlDataState {
  const line = stdout.split("\n").find((entry) =>
    entry.startsWith("Database cluster state:")
  );
  if (!line) return "unknown";
  const value = line.slice("Database cluster state:".length).trim();
  return CONTROL_DATA_STATES.find((state) => state === value) ?? "unknown";
}

/** `pg_controldata` (read-only, PGDATA from the image env). */
export async function readControlData(
  containerName: string,
  run: RunDockerFn,
  timeoutMs: number,
): Promise<ControlDataState> {
  const result = await withTimeout<DockerCliResult | null>(
    run([
      "exec",
      "-u",
      "postgres",
      "-e",
      "LC_ALL=C",
      containerName,
      "pg_controldata",
    ]),
    timeoutMs,
    () => null,
  );
  if (!result?.success) return "unreadable";
  return parseControlDataState(result.stdout);
}

/** `pg_ctl status` (read-only; PGDATA from the image env). */
export async function readPostmaster(
  containerName: string,
  run: RunDockerFn,
  timeoutMs: number,
): Promise<PostmasterState> {
  const result = await withTimeout<DockerCliResult | null>(
    run(["exec", "-u", "postgres", containerName, "pg_ctl", "status"]),
    timeoutMs,
    () => null,
  );
  if (!result) return "unknown";
  if (result.code === 0) return "running";
  // 3 = "no server running"; only trust it when Docker itself said nothing.
  if (result.code === 3 && !/error response from daemon/i.test(result.stderr)) {
    return "stopped";
  }
  return "unknown";
}

/** One full sample: container first, Postgres only when it is running. */
export async function sampleManagedPostgres(
  containerName: string,
  run: RunDockerFn,
  config: PgDeadPrimaryConfig = DEFAULT_PG_DEAD_PRIMARY_CONFIG,
): Promise<ProbeSample> {
  const container = await readContainerState(
    containerName,
    run,
    config.dockerTimeoutMs,
  );
  if (container.kind !== "present" || container.state.status !== "running") {
    return { container };
  }
  const pgReady = await readPgReady(containerName, run, config);
  if (pgReady.kind === "exit" && pgReady.code === 2) {
    const postmaster = await readPostmaster(
      containerName,
      run,
      config.dockerTimeoutMs,
    );
    return { container, pgReady, postmaster };
  }
  if (pgReady.kind !== "exit" || pgReady.code !== 1) {
    return { container, pgReady };
  }
  const controlData = await readControlData(
    containerName,
    run,
    config.dockerTimeoutMs,
  );
  return { container, pgReady, controlData };
}
