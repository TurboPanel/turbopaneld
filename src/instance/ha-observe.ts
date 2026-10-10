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
  type OrchestratorDeadPrimaryEmitContext,
  resolveOrchestratorDeadPrimaryEmit,
} from "../managed/ha-orchestrator-managed-id.ts";
import {
  runDocker as defaultRunDocker,
  type RunDockerFn,
} from "../deploy/docker-cli.ts";

const HA_OBSERVE_MS = 15_000;
const HA_REVIVE_COOLDOWN_MS = 60_000;
/** Matches the control-plane automatic-failover cooldown for re-triggers. */
const HA_INCIDENT_REEMIT_MS = 15 * 60_000;
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
};

function isReplicationAnalysisMasterRow(
  entry: OrchestratorReplicationAnalysis,
): boolean {
  if (entry.isMaster === false) return false;
  const analysis = entry.analysis;
  return analysis !== undefined && isDeadPrimaryProblem(analysis);
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

/**
 * True while an event for this incident reached the control plane less than
 * {@link HA_INCIDENT_REEMIT_MS} ago. Only a delivered event (which always
 * carries the full instance key) starts the cooldown.
 */
export function shouldSuppressHaIncidentReemit(
  lastDeliveredMs: number | undefined,
  nowMs: number,
): boolean {
  if (lastDeliveredMs === undefined) return false;
  return nowMs - lastDeliveredMs < HA_INCIDENT_REEMIT_MS;
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
  /** Incident key -> when its event last reached the control plane. */
  readonly #incidentLastDelivered = new Map<string, number>();
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
    if (
      shouldSuppressHaIncidentReemit(
        this.#incidentLastDelivered.get(incidentKey),
        now,
      )
    ) {
      return;
    }
    const instance = `${emitKey.hostname}:${emitKey.port}`;
    const delivered = this.#send({
      type: "managed-ha-event",
      managedId,
      instanceHost: emitKey.hostname,
      instancePort: emitKey.port,
      at: this.#now(),
    });
    if (!delivered) {
      logWarn(
        "managed",
        `managed-ha-event not sent (no control-plane connection); retrying next poll managedId=${managedId} instance=${instance}`,
      );
      return;
    }
    this.#incidentLastDelivered.set(incidentKey, now);
    logInfo(
      "managed",
      `managed-ha-event emitted managedId=${managedId} instance=${instance}`,
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
      this.#finishPoll(state);
    } catch (err) {
      logWarn("managed", "managed-ha observe failed:", sanitizeForLog(err));
    }
  }
}
