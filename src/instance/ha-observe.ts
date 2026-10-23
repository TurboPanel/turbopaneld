/**
 * Watch the local Orchestrator for a dead primary (any code
 * {@link isDeadPrimaryProblem} accepts) and emit `managed-ha-event`.
 *
 * Local HTTP poll only — never a control-plane poll loop. The cluster is the
 * managed UUID alias registered on reconcile, or (when that alias call failed)
 * the local primary whose published listener equals Orchestrator's key.
 */

import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  loadOrchestratorApiCredentials,
  type OrchestratorApiCredentials,
  type OrchestratorReviveOutcome,
  orchestratorStackPresent,
  reviveStoppedOrchestratorContainer,
} from "../managed/orchestrator.ts";
import {
  isDeadPrimaryProblem,
  listOrchestratorProblems,
  listOrchestratorReplicationAnalysis,
  type OrchestratorApiDeps,
  type OrchestratorReplicationAnalysis,
} from "../managed/orchestrator-api.ts";
import {
  isOrchestratorHaEmitSuppressed,
  type OrchestratorDeadPrimaryEmitContext,
  resolveHungPrimaryEmit,
  resolveOrchestratorDeadPrimaryEmit,
} from "../managed/ha-orchestrator-managed-id.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "../managed/ha-member.ts";
import {
  HungPrimaryTracker,
  type HungSample,
  sampleMysqlFamilyPrimary,
} from "../managed/mysql-hung-primary.ts";
import {
  runDocker as defaultRunDocker,
  type RunDockerFn,
} from "../deploy/docker-cli.ts";

const HA_OBSERVE_MS = 15_000;
const HA_REVIVE_COOLDOWN_MS = 60_000;
/** Wait between events once an incident has outlasted the control plane's patience. */
const HA_INCIDENT_REEMIT_MS = 15 * 60_000;
/**
 * Wait after the first delivered event of an incident; it doubles with each
 * further one up to {@link HA_INCIDENT_REEMIT_STEADY_MS}. A refusal at event
 * time (for example replicas that still look connected to a frozen primary,
 * or the control plane's 15 minute cooldown) is then retried within a minute,
 * not after a growing back-off that could skip past the cooldown's end.
 */
const HA_INCIDENT_REEMIT_FIRST_MS = 30_000;
/** The steady wait between events while the control plane may still accept one. */
const HA_INCIDENT_REEMIT_STEADY_MS = 60_000;
/**
 * Events sent at the steady pace per incident (about 24 minutes): past the
 * 15 minute cooldown, and the control plane refuses a failure older than 20
 * minutes anyway. After that the slow pace keeps the incident visible only.
 */
const HA_INCIDENT_REEMIT_STEADY_COUNT = 25;
/** Bound each Orchestrator read so one hung request cannot stall polling. */
const HA_API_TIMEOUT_MS = 10_000;
const MANAGED_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ManagedHaEventMessage = {
  type: "managed-ha-event";
  managedId: string;
  sourceMemberId?: string;
  /** Orchestrator's key for the dead instance; both or neither. */
  instanceHost?: string;
  instancePort?: number;
  /**
   * `spanMs`: how long ago the local primary's engine container stopped, so
   * the control plane can tell whether a replica was still streaming when
   * the primary died. For a frozen engine (container still running) it counts
   * from the first poll that saw the incident.
   */
  evidence?: { spanMs: number; primaryStoppedAt: string };
  at: string;
};

export type ManagedHaObserverOptions = {
  intervalMs?: number;
  now?: () => string;
  /**
   * Returns false when the message could not be handed to the control plane
   * (no open connection); the incident is then retried on the next poll.
   */
  send: (message: ManagedHaEventMessage) => boolean;
  api?: OrchestratorApiDeps;
  /** Test seam — defaults to {@link orchestratorStackPresent}. */
  isStackPresent?: () => Promise<boolean>;
  /**
   * Test seam — defaults to {@link reviveStoppedOrchestratorContainer}.
   * A first stopped observation is retried on the next poll for confirmation;
   * completed start attempts remain limited to once per 60 s.
   */
  reviveStack?: () => Promise<OrchestratorReviveOutcome>;
  /** Wall clock in ms for the revive cooldown; defaults to `Date.now`. */
  nowMs?: () => number;
  /** Test seam — defaults to {@link resolveLayout} from process env. */
  layout?: LayoutPaths;
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
  /** Test seam — defaults to {@link listManagedHaMembers}. */
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  /** Test seam — defaults to {@link sampleMysqlFamilyPrimary}. */
  sampleHung?: (record: ManagedHaMemberRecord) => Promise<HungSample>;
};

/** A local MySQL or MariaDB primary with at least one replica to fail over to. */
export function isHungProbeWatched(record: ManagedHaMemberRecord): boolean {
  return (record.engine === "mysql" || record.engine === "mariadb") &&
    record.role === "primary" && record.replicaPeerCount > 0;
}

function isReplicationAnalysisMasterRow(
  entry: OrchestratorReplicationAnalysis,
): boolean {
  if (entry.isMaster === false) return false;
  const analysis = entry.analysis;
  return analysis !== undefined && isDeadPrimaryProblem(analysis);
}

/**
 * Evidence for the event: time since the primary's engine container stopped.
 * Anchored on Docker's own stop time, not on when this poll first saw the
 * row: Orchestrator and the 15 s poll add up to ~20 s of delay, and a later
 * anchor would make a replica that streamed until the kill look stale.
 */
export function deadPrimaryEvidence(
  primaryStoppedAtMs: number | undefined,
  nowMs: number,
): ManagedHaEventMessage["evidence"] {
  if (primaryStoppedAtMs === undefined) return undefined;
  const spanMs = nowMs - primaryStoppedAtMs;
  if (!Number.isFinite(spanMs) || spanMs < 0) return undefined;
  return {
    spanMs: Math.round(spanMs),
    primaryStoppedAt: new Date(primaryStoppedAtMs).toISOString(),
  };
}

type ObserverApi = OrchestratorApiDeps & {
  credentials: OrchestratorApiCredentials;
};

/** What one poll learned; never shared between polls that overlap. */
type HaPollState = {
  generation: number;
  /** One candidate per incident, so rows from both sources send one event. */
  pending: Map<string, OrchestratorDeadPrimaryEmitContext>;
  /** False when a source failed: a missing row then proves no recovery. */
  complete: boolean;
};

/** Wait before the next event of an incident that already delivered `deliveredCount`. */
export function haIncidentReemitGapMs(deliveredCount: number): number {
  if (deliveredCount >= HA_INCIDENT_REEMIT_STEADY_COUNT) {
    return HA_INCIDENT_REEMIT_MS;
  }
  const doublings = Math.max(0, deliveredCount - 1);
  return Math.min(
    HA_INCIDENT_REEMIT_FIRST_MS * 2 ** Math.min(doublings, 30),
    HA_INCIDENT_REEMIT_STEADY_MS,
  );
}

/**
 * True while the last event for this incident reached the control plane less
 * than the current gap ago. Only a delivered event (which always carries the
 * full instance key) starts the wait. Without `deliveredCount` the longest
 * gap applies.
 */
export function shouldSuppressHaIncidentReemit(
  lastDeliveredMs: number | undefined,
  nowMs: number,
  deliveredCount: number = Number.MAX_SAFE_INTEGER,
): boolean {
  if (lastDeliveredMs === undefined) return false;
  return nowMs - lastDeliveredMs < haIncidentReemitGapMs(deliveredCount);
}

export class ManagedHaObserver {
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #send: ManagedHaObserverOptions["send"];
  readonly #api: OrchestratorApiDeps | undefined;
  readonly #isStackPresent: () => Promise<boolean>;
  readonly #reviveStack: () => Promise<OrchestratorReviveOutcome>;
  readonly #nowMs: () => number;
  readonly #layout: LayoutPaths | undefined;
  readonly #runDocker: RunDockerFn;
  readonly #listMembers: () => Promise<ManagedHaMemberRecord[]>;
  readonly #sampleHung: (record: ManagedHaMemberRecord) => Promise<HungSample>;
  readonly #hungTracker = new HungPrimaryTracker();
  /** Incident key -> when its event last reached the control plane, and how many did. */
  readonly #incidentLastDelivered = new Map<
    string,
    { atMs: number; count: number }
  >();
  /** Incident key -> when a poll first saw it (failure start for a frozen engine). */
  readonly #incidentFirstSeen = new Map<string, number>();
  #pollGeneration = 0;
  /** Newest poll that finished after reading every source. */
  #newestCompleteGeneration = 0;
  #lastReviveAttemptMs: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ManagedHaObserverOptions) {
    this.#intervalMs = options.intervalMs ?? HA_OBSERVE_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nowMs = options.nowMs ?? Date.now;
    this.#send = options.send;
    this.#api = options.api;
    this.#layout = options.layout;
    this.#runDocker = options.runDocker ?? defaultRunDocker;
    this.#listMembers = options.listMembers ??
      (() => listManagedHaMembers(this.#resolveLayout()));
    this.#sampleHung = options.sampleHung ??
      ((record) => sampleMysqlFamilyPrimary(record, this.#runDocker));
    this.#isStackPresent = options.isStackPresent ??
      (() => orchestratorStackPresent(this.#resolveLayout()));
    this.#reviveStack = options.reviveStack ??
      (() => reviveStoppedOrchestratorContainer(this.#resolveLayout()));
  }

  #resolveLayout(): LayoutPaths {
    return this.#layout ?? resolveLayout(Deno.env.toObject());
  }

  attach(): void {
    this.detach();
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#intervalMs);
  }

  detach(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #maybeReviveStack(): Promise<void> {
    const now = this.#nowMs();
    if (
      this.#lastReviveAttemptMs !== undefined &&
      now - this.#lastReviveAttemptMs < HA_REVIVE_COOLDOWN_MS
    ) {
      return;
    }
    try {
      const outcome = await this.#reviveStack();
      if (outcome === "stopped" || outcome === "busy") return;
      this.#lastReviveAttemptMs = now;
      if (outcome === "started") {
        logInfo(
          "managed",
          "orchestrator self-heal started a stopped container",
        );
      }
    } catch (err) {
      this.#lastReviveAttemptMs = now;
      logWarn(
        "managed",
        "orchestrator self-heal failed:",
        sanitizeForLog(err),
      );
    }
  }

  #emitDeadPrimary(candidate: OrchestratorDeadPrimaryEmitContext): void {
    const { managedId, incidentKey, emitKey } = candidate;
    const now = this.#nowMs();
    const last = this.#incidentLastDelivered.get(incidentKey);
    if (shouldSuppressHaIncidentReemit(last?.atMs, now, last?.count)) {
      return;
    }
    const instance = `${emitKey.hostname}:${emitKey.port}`;
    // A frozen engine container still runs, so Docker has no stop time. The
    // first poll that saw the incident stands in as the failure start.
    if (!this.#incidentFirstSeen.has(incidentKey)) {
      this.#incidentFirstSeen.set(incidentKey, now);
    }
    const evidence = deadPrimaryEvidence(
      candidate.primaryStoppedAtMs ?? this.#incidentFirstSeen.get(incidentKey),
      now,
    );
    const delivered = this.#send({
      type: "managed-ha-event",
      managedId,
      instanceHost: emitKey.hostname,
      instancePort: emitKey.port,
      ...(evidence ? { evidence } : {}),
      at: this.#now(),
    });
    if (!delivered) {
      logWarn(
        "managed",
        `managed-ha-event not sent (no control-plane connection); retrying next poll managedId=${managedId} instance=${instance}`,
      );
      return;
    }
    this.#incidentLastDelivered.set(incidentKey, {
      atMs: now,
      count: (last?.count ?? 0) + 1,
    });
    logInfo(
      "managed",
      `managed-ha-event emitted managedId=${managedId} instance=${instance} spanMs=${
        evidence?.spanMs ?? "unknown"
      }`,
    );
  }

  /**
   * Forget incidents no longer reported dead, so a new failure of the same
   * primary is sent at once. Only the newest poll, and only one that read
   * every source, may decide that.
   */
  #clearRecoveredIncidents(state: HaPollState): void {
    if (!state.complete || state.generation !== this.#pollGeneration) return;
    for (const key of this.#incidentLastDelivered.keys()) {
      if (!state.pending.has(key)) this.#incidentLastDelivered.delete(key);
    }
    for (const key of this.#incidentFirstSeen.keys()) {
      if (!state.pending.has(key)) this.#incidentFirstSeen.delete(key);
    }
  }

  async #recordOrchestratorDeadPrimary(
    state: HaPollState,
    layout: LayoutPaths,
    analyzedKey: { hostname?: string; port?: number },
    clusterAlias?: string,
  ): Promise<void> {
    const ctx = await resolveOrchestratorDeadPrimaryEmit(
      layout,
      analyzedKey,
      clusterAlias,
      this.#runDocker,
      this.#nowMs(),
    );
    if (ctx) state.pending.set(ctx.incidentKey, ctx);
  }

  async #pollProblems(
    state: HaPollState,
    layout: LayoutPaths,
    api: ObserverApi,
  ): Promise<void> {
    const problems = await listOrchestratorProblems(api);
    await forEachSequential(problems, async (problem) => {
      const alias = problem.clusterAlias;
      if (!alias || !MANAGED_ID_RE.test(alias)) return;
      const names = problem.problems ?? [];
      if (!names.some((name) => isDeadPrimaryProblem(name))) return;
      await this.#recordOrchestratorDeadPrimary(
        state,
        layout,
        problem.key ?? {},
        alias,
      );
    });
  }

  async #pollReplicationAnalysis(
    state: HaPollState,
    layout: LayoutPaths,
    api: ObserverApi,
  ): Promise<void> {
    const entries = await listOrchestratorReplicationAnalysis(api);
    await forEachSequential(entries, async (entry) => {
      if (!isReplicationAnalysisMasterRow(entry)) return;
      await this.#recordOrchestratorDeadPrimary(
        state,
        layout,
        { hostname: entry.key?.hostname, port: entry.key?.port },
        entry.clusterAlias,
      );
    });
  }

  /**
   * A primary that is hung (paused, or its server never answers a timed
   * ping) is not something Orchestrator reports as dead: its replicas still
   * look connected. This host's own probe reports it instead, as the same
   * event, once it has been silent long enough (see `mysql-hung-primary.ts`).
   */
  async #pollHungPrimaries(
    state: HaPollState,
    layout: LayoutPaths,
  ): Promise<void> {
    const watched = (await this.#listMembers()).filter(isHungProbeWatched);
    this.#hungTracker.retainOnly(new Set(watched.map((row) => row.managedId)));
    await forEachSequential(watched, async (record) => {
      const nowMs = this.#nowMs();
      // A planned stop, switchover or destroy never counts toward a hang.
      if (
        await isOrchestratorHaEmitSuppressed(layout, record.managedId, nowMs)
      ) {
        this.#hungTracker.forget(record.managedId);
        return;
      }
      const verdict = this.#hungTracker.step(
        record.managedId,
        await this.#sampleHung(record),
        this.#nowMs(),
      );
      if (!verdict.hung) return;
      const ctx = await resolveHungPrimaryEmit(
        layout,
        record.managedId,
        verdict.sinceMs,
        this.#runDocker,
        this.#nowMs(),
      );
      if (!ctx) return;
      if (!state.pending.has(ctx.incidentKey)) {
        logWarn(
          "managed",
          `primary managedId=${record.managedId} is hung (${verdict.reason}; ${verdict.samples} probes over ${
            Math.round((this.#nowMs() - verdict.sinceMs) / 1000)
          } s)`,
        );
        state.pending.set(ctx.incidentKey, ctx);
      }
    });
  }

  /**
   * Send this poll's events unless a newer poll already finished with every
   * source read: that one saw a fresher state (healthy, or dead and sent).
   */
  #finishPoll(state: HaPollState): void {
    if (this.#newestCompleteGeneration > state.generation) return;
    if (state.complete) this.#newestCompleteGeneration = state.generation;
    for (const candidate of state.pending.values()) {
      this.#emitDeadPrimary(candidate);
    }
    this.#clearRecoveredIncidents(state);
  }

  /** Read one source; a failure is logged and marks the poll incomplete. */
  async #pollSource(
    state: HaPollState,
    label: string,
    read: () => Promise<void>,
  ): Promise<void> {
    try {
      await read();
    } catch (err) {
      state.complete = false;
      logWarn(
        "managed",
        `orchestrator ${label} poll failed:`,
        sanitizeForLog(err),
      );
    }
  }

  async poll(): Promise<void> {
    this.#pollGeneration += 1;
    const state: HaPollState = {
      generation: this.#pollGeneration,
      pending: new Map(),
      complete: true,
    };
    const layout = this.#resolveLayout();
    try {
      if (!(await this.#isStackPresent())) return;
      await this.#maybeReviveStack();
      const credentials = this.#api?.credentials ??
        await loadOrchestratorApiCredentials(layout);
      const api: ObserverApi = {
        timeoutMs: HA_API_TIMEOUT_MS,
        ...this.#api,
        credentials,
      };
      // Sources are read one after the other and each failure stays local:
      // a broken /api/problems must never hide a replication-analysis row.
      await this.#pollSource(
        state,
        "problems",
        () => this.#pollProblems(state, layout, api),
      );
      await this.#pollSource(
        state,
        "replication-analysis",
        () => this.#pollReplicationAnalysis(state, layout, api),
      );
      await this.#pollSource(
        state,
        "hung-primary probe",
        () => this.#pollHungPrimaries(state, layout),
      );
      this.#finishPoll(state);
    } catch (err) {
      logWarn("managed", "managed-ha observe failed:", sanitizeForLog(err));
    }
  }
}
