/**
 * Watch the local Orchestrator for DeadPrimary and emit `managed-ha-event`.
 *
 * Local HTTP poll only — never a control-plane poll loop. Cluster alias is
 * the managed UUID registered on reconcile.
 */

import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  loadOrchestratorApiCredentials,
  type OrchestratorReviveOutcome,
  orchestratorStackPresent,
  reviveStoppedOrchestratorContainer,
} from "../managed/orchestrator.ts";
import {
  isDeadPrimaryProblem,
  listOrchestratorProblems,
  type OrchestratorApiDeps,
} from "../managed/orchestrator-api.ts";

const HA_OBSERVE_MS = 15_000;
const HA_REVIVE_COOLDOWN_MS = 60_000;
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
};

export class ManagedHaObserver {
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #send: (message: ManagedHaEventMessage) => void;
  readonly #api: OrchestratorApiDeps | undefined;
  readonly #isStackPresent: () => Promise<boolean>;
  readonly #reviveStack: () => Promise<OrchestratorReviveOutcome>;
  readonly #nowMs: () => number;
  readonly #layout: LayoutPaths | undefined;
  readonly #emitted = new Set<string>();
  #lastReviveAttemptMs: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ManagedHaObserverOptions) {
    this.#intervalMs = options.intervalMs ?? HA_OBSERVE_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nowMs = options.nowMs ?? Date.now;
    this.#send = options.send;
    this.#api = options.api;
    this.#layout = options.layout;
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

  async poll(): Promise<void> {
    try {
      if (!(await this.#isStackPresent())) return;
      await this.#maybeReviveStack();
      const credentials = this.#api?.credentials ??
        await loadOrchestratorApiCredentials(this.#resolveLayout());
      const problems = await listOrchestratorProblems({
        ...this.#api,
        credentials,
      });
      for (const problem of problems) {
        const alias = problem.clusterAlias;
        if (!alias || !MANAGED_ID_RE.test(alias)) continue;
        const names = problem.problems ?? [];
        if (!names.some((name) => isDeadPrimaryProblem(name))) continue;
        const key = `${alias}:${problem.key?.hostname ?? ""}:${
          problem.key?.port ?? ""
        }`;
        if (this.#emitted.has(key)) continue;
        this.#emitted.add(key);
        const { hostname, port } = problem.key ?? {};
        const instance = hostname && port !== undefined
          ? { instanceHost: hostname, instancePort: port }
          : {};
        this.#send({
          type: "managed-ha-event",
          managedId: alias,
          ...instance,
          at: this.#now(),
        });
        logInfo(
          "managed",
          `managed-ha-event emitted managedId=${alias} instance=${
            hostname ?? "?"
          }:${port ?? "?"}`,
        );
      }
    } catch (err) {
      logWarn("managed", "managed-ha observe failed:", sanitizeForLog(err));
    }
  }
}
