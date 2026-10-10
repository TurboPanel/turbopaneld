/**
 * Watch the local Orchestrator for DeadPrimary and emit `managed-ha-event`.
 *
 * Local HTTP poll only — never a control-plane poll loop. Cluster alias is
 * the managed UUID registered on reconcile.
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
import { resolveOrchestratorDeadPrimaryEmit } from "../managed/ha-orchestrator-managed-id.ts";
import {
  runDocker as defaultRunDocker,
  type RunDockerFn,
} from "../deploy/docker-cli.ts";

const HA_OBSERVE_MS = 15_000;
const HA_REVIVE_COOLDOWN_MS = 60_000;
/** Matches the control-plane automatic-failover cooldown for re-triggers. */
const HA_INCIDENT_REEMIT_MS = 15 * 60_000;
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
  send: (message: ManagedHaEventMessage) => void;
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

export class ManagedHaObserver {
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #send: (message: ManagedHaEventMessage) => void;
  readonly #api: OrchestratorApiDeps | undefined;
  readonly #isStackPresent: () => Promise<boolean>;
  readonly #reviveStack: () => Promise<OrchestratorReviveOutcome>;
  readonly #nowMs: () => number;
  readonly #layout: LayoutPaths | undefined;
  readonly #runDocker: RunDockerFn;
  readonly #incidentLastEmit = new Map<string, number>();
  readonly #emittedThisPoll = new Set<string>();
  #deadIncidentsThisPoll = new Set<string>();
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

  #emitDeadPrimary(
    managedId: string,
    incidentKey: string,
    key: { hostname?: string; port?: number },
  ): void {
    if (this.#emittedThisPoll.has(incidentKey)) return;
    const now = this.#nowMs();
    const lastEmit = this.#incidentLastEmit.get(incidentKey);
    if (lastEmit !== undefined && now - lastEmit < HA_INCIDENT_REEMIT_MS) {
      return;
    }
    this.#emittedThisPoll.add(incidentKey);
    this.#incidentLastEmit.set(incidentKey, now);
    const { hostname, port } = key;
    const instance = hostname !== undefined && port !== undefined
      ? { instanceHost: hostname, instancePort: port }
      : {};
    this.#send({
      type: "managed-ha-event",
      managedId,
      ...instance,
      at: this.#now(),
    });
    logInfo(
      "managed",
      `managed-ha-event emitted managedId=${managedId} instance=${
        hostname ?? "?"
      }:${port ?? "?"}`,
    );
  }

  #clearRecoveredIncidents(): void {
    for (const key of this.#incidentLastEmit.keys()) {
      if (!this.#deadIncidentsThisPoll.has(key)) {
        this.#incidentLastEmit.delete(key);
      }
    }
  }

  async #tryEmitOrchestratorDeadPrimary(
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
    if (!ctx) return;
    this.#deadIncidentsThisPoll.add(ctx.incidentKey);
    this.#emitDeadPrimary(ctx.managedId, ctx.incidentKey, ctx.emitKey);
  }

  async #pollProblems(
    layout: LayoutPaths,
    api: OrchestratorApiDeps & { credentials: OrchestratorApiCredentials },
  ): Promise<void> {
    const problems = await listOrchestratorProblems(api);
    await forEachSequential(problems, async (problem) => {
      const alias = problem.clusterAlias;
      if (!alias || !MANAGED_ID_RE.test(alias)) return;
      const names = problem.problems ?? [];
      if (!names.some((name) => isDeadPrimaryProblem(name))) return;
      await this.#tryEmitOrchestratorDeadPrimary(
        layout,
        problem.key ?? {},
        alias,
      );
    });
  }

  async #pollReplicationAnalysis(
    layout: LayoutPaths,
    api: OrchestratorApiDeps & { credentials: OrchestratorApiCredentials },
  ): Promise<void> {
    const entries = await listOrchestratorReplicationAnalysis(api);
    await forEachSequential(entries, async (entry) => {
      if (!isReplicationAnalysisMasterRow(entry)) return;
      const hostname = entry.key?.hostname;
      const port = entry.key?.port;
      await this.#tryEmitOrchestratorDeadPrimary(
        layout,
        { hostname, port },
        entry.clusterAlias,
      );
    });
  }

  async poll(): Promise<void> {
    this.#emittedThisPoll.clear();
    this.#deadIncidentsThisPoll = new Set();
    const layout = this.#resolveLayout();
    try {
      if (!(await this.#isStackPresent())) return;
      await this.#maybeReviveStack();
      const credentials = this.#api?.credentials ??
        await loadOrchestratorApiCredentials(layout);
      const api = { ...this.#api, credentials };
      await this.#pollProblems(layout, api);
      try {
        await this.#pollReplicationAnalysis(layout, api);
      } catch (err) {
        logWarn(
          "managed",
          "orchestrator replication-analysis poll failed:",
          sanitizeForLog(err),
        );
      }
      this.#clearRecoveredIncidents();
    } catch (err) {
      logWarn("managed", "managed-ha observe failed:", sanitizeForLog(err));
    }
  }
}
