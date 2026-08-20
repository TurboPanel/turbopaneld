/**
 * Watch the local Orchestrator for DeadPrimary and emit `managed-ha-event`.
 *
 * Local HTTP poll only — never a control-plane poll loop. Cluster alias is
 * the managed UUID registered on reconcile.
 */

import { logInfo, logWarn, sanitizeForLog } from "../logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  loadOrchestratorApiCredentials,
  orchestratorStackPresent,
} from "../managed/orchestrator.ts";
import {
  isDeadPrimaryProblem,
  listOrchestratorProblems,
  type OrchestratorApiDeps,
} from "../managed/orchestrator-api.ts";

const HA_OBSERVE_MS = 15_000;
const MANAGED_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ManagedHaEventMessage = {
  type: "managed-ha-event";
  managedId: string;
  sourceMemberId?: string;
  at: string;
};

export type ManagedHaObserverOptions = {
  intervalMs?: number;
  now?: () => string;
  send: (message: ManagedHaEventMessage) => void;
  api?: OrchestratorApiDeps;
  /** Test seam — defaults to {@link orchestratorStackPresent}. */
  isStackPresent?: () => Promise<boolean>;
};

export class ManagedHaObserver {
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #send: (message: ManagedHaEventMessage) => void;
  readonly #api: OrchestratorApiDeps | undefined;
  readonly #isStackPresent: () => Promise<boolean>;
  readonly #emitted = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ManagedHaObserverOptions) {
    this.#intervalMs = options.intervalMs ?? HA_OBSERVE_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#send = options.send;
    this.#api = options.api;
    this.#isStackPresent = options.isStackPresent ??
      (() => orchestratorStackPresent(resolveLayout()));
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

  async poll(): Promise<void> {
    try {
      if (!(await this.#isStackPresent())) return;
      const credentials = this.#api?.credentials ??
        await loadOrchestratorApiCredentials(resolveLayout());
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
        this.#send({
          type: "managed-ha-event",
          managedId: alias,
          at: this.#now(),
        });
        logInfo("managed", `managed-ha-event emitted managedId=${alias}`);
      }
    } catch (err) {
      logWarn("managed", "managed-ha observe failed:", sanitizeForLog(err));
    }
  }
}
