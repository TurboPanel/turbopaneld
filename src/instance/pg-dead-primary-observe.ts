/**
 * Watch this host's managed Postgres PRIMARIES and emit `managed-ha-event`
 * (`detector: 'postgres-probe'`) when one is dead while the host is alive.
 *
 * Twin of {@link ManagedHaObserver} (Orchestrator, MySQL/MariaDB only): same
 * event, same fire-and-forget send, local probes only. The rules that keep a
 * false positive from triggering a real failover live in
 * `../managed/pg-dead-primary.ts`; this file decides WHICH clusters are
 * watched and WHEN an event may leave the host:
 *
 * - enabled per cluster only for a Postgres member recorded as `primary`
 *   with at least one replica peer (`ha-member.ts`); the control plane still
 *   requires a healthy same-datacenter `failover` replica before promoting;
 * - globally off with `TURBOPANEL_MANAGED_PG_PROBE=off`;
 * - never sends unless the attached control plane advertises
 *   `managed-ha-probe-v1` (an older one would fail over whatever member it
 *   currently calls primary, without checking who reported);
 * - suppressed while a platform intent marker is active (`ha-intent.ts`);
 * - never sends after `detach()` (daemon SIGTERM) or while systemd reports
 *   the host `stopping`.
 */

import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "../managed/ha-member.ts";
import {
  isManagedIntentActive,
  readManagedIntent,
} from "../managed/ha-intent.ts";
import {
  DeadPrimaryDetector,
  type DeadPrimaryEvidence,
  DEFAULT_PG_DEAD_PRIMARY_CONFIG,
  type PgDeadPrimaryConfig,
  POSTGRES_PROBE_DETECTOR,
  type ProbeSample,
  type RunDockerFn,
  sampleManagedPostgres,
} from "../managed/pg-dead-primary.ts";

export const PG_PROBE_ENV = "TURBOPANEL_MANAGED_PG_PROBE";

export type PgDeadPrimaryEventMessage = {
  type: "managed-ha-event";
  managedId: string;
  sourceMemberId: string;
  detector: typeof POSTGRES_PROBE_DETECTOR;
  evidence: DeadPrimaryEvidence;
  at: string;
};

export type PgDeadPrimaryObserverOptions = {
  /** Returns true only when the event reached an open socket. */
  send: (message: PgDeadPrimaryEventMessage) => boolean;
  /** Control plane advertised `managed-ha-probe-v1`. */
  peerSupportsProbe: () => boolean;
  config?: Partial<PgDeadPrimaryConfig>;
  nowMs?: () => number;
  /** Test seam — defaults to the `TURBOPANEL_MANAGED_PG_PROBE` env switch. */
  globallyEnabled?: () => boolean;
  /** Test seam — defaults to {@link listManagedHaMembers}. */
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  /** Test seam — defaults to {@link sampleManagedPostgres}. */
  sample?: (containerName: string) => Promise<ProbeSample>;
  /** Test seam — defaults to the on-disk/in-memory intent marker. */
  intentActive?: (managedId: string, nowMs: number) => Promise<boolean>;
  /** Test seam — defaults to `systemctl is-system-running` == `stopping`. */
  hostStopping?: () => Promise<boolean>;
  runDocker?: RunDockerFn;
  layout?: LayoutPaths;
};

/** Default ON; only an explicit off/0/false/no disables it. */
export function pgProbeGloballyEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !["off", "0", "false", "no"].includes(value.trim().toLowerCase());
}

/** The per-cluster setting: Postgres primary with at least one replica. */
export function isWatchedPrimary(record: ManagedHaMemberRecord): boolean {
  return record.engine === "postgres" && record.role === "primary" &&
    record.replicaPeerCount > 0;
}

export async function systemdHostStopping(): Promise<boolean> {
  try {
    const out = await new Deno.Command("systemctl", {
      args: ["is-system-running"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(out.stdout).trim() === "stopping";
  } catch {
    return false;
  }
}

export class PgDeadPrimaryObserver {
  readonly #config: PgDeadPrimaryConfig;
  readonly #send: PgDeadPrimaryObserverOptions["send"];
  readonly #peerSupportsProbe: () => boolean;
  readonly #nowMs: () => number;
  readonly #globallyEnabled: () => boolean;
  readonly #listMembers: () => Promise<ManagedHaMemberRecord[]>;
  readonly #sample: (containerName: string) => Promise<ProbeSample>;
  readonly #intentActive: (
    managedId: string,
    nowMs: number,
  ) => Promise<boolean>;
  readonly #hostStopping: () => Promise<boolean>;
  readonly #detectors = new Map<string, DeadPrimaryDetector>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight = false;
  #stopped = true;

  constructor(options: PgDeadPrimaryObserverOptions) {
    this.#config = { ...DEFAULT_PG_DEAD_PRIMARY_CONFIG, ...options.config };
    this.#send = options.send;
    this.#peerSupportsProbe = options.peerSupportsProbe;
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#globallyEnabled = options.globallyEnabled ??
      (() => pgProbeGloballyEnabled(Deno.env.get(PG_PROBE_ENV)));
    const layout = () => options.layout ?? resolveLayout(Deno.env.toObject());
    this.#listMembers = options.listMembers ??
      (() => listManagedHaMembers(layout()));
    const run = options.runDocker ?? defaultRunDocker;
    this.#sample = options.sample ??
      ((name) => sampleManagedPostgres(name, run, this.#config));
    this.#intentActive = options.intentActive ??
      (async (managedId, nowMs) =>
        isManagedIntentActive(
          await readManagedIntent(layout().stateDir, managedId),
          nowMs,
        ));
    this.#hostStopping = options.hostStopping ?? systemdHostStopping;
  }

  attach(): void {
    this.detach();
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#config.intervalMs);
  }

  /** Stops polling AND blocks any send from a tick already in flight. */
  detach(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #detectorFor(managedId: string): DeadPrimaryDetector {
    let detector = this.#detectors.get(managedId);
    if (!detector) {
      detector = new DeadPrimaryDetector(this.#config);
      this.#detectors.set(managedId, detector);
    }
    return detector;
  }

  /** One tick. Never overlaps itself; never throws. */
  async poll(): Promise<void> {
    if (this.#inFlight || this.#stopped) return;
    this.#inFlight = true;
    try {
      await this.#pollOnce();
    } catch (err) {
      logWarn("managed", "pg dead-primary probe failed:", sanitizeForLog(err));
    } finally {
      this.#inFlight = false;
    }
  }

  async #pollOnce(): Promise<void> {
    if (!this.#globallyEnabled()) {
      this.#detectors.clear();
      return;
    }
    const watched = (await this.#listMembers()).filter(isWatchedPrimary);
    const ids = new Set(watched.map((record) => record.managedId));
    for (const id of [...this.#detectors.keys()]) {
      if (!ids.has(id)) this.#detectors.delete(id);
    }
    await Promise.all(watched.map((record) => this.#probeOne(record)));
  }

  async #probeOne(record: ManagedHaMemberRecord): Promise<void> {
    const detector = this.#detectorFor(record.managedId);
    const sample = await this.#sample(record.containerName);
    const nowMs = this.#nowMs();
    const intentActive = await this.#intentActive(record.managedId, nowMs);
    const verdict = detector.step(sample, { nowMs, intentActive });
    if (!verdict.fire) return;
    if (!(await this.#mayEmit(record, detector))) return;
    const delivered = this.#send({
      type: "managed-ha-event",
      managedId: record.managedId,
      sourceMemberId: record.memberId,
      detector: POSTGRES_PROBE_DETECTOR,
      evidence: verdict.evidence,
      at: new Date(nowMs).toISOString(),
    });
    if (!delivered) return;
    detector.markEmitted(nowMs);
    logInfo(
      "managed",
      `managed-ha-event emitted managedId=${record.managedId} detector=${POSTGRES_PROBE_DETECTOR} failures=${verdict.evidence.failures}`,
    );
  }

  async #mayEmit(
    record: ManagedHaMemberRecord,
    detector: DeadPrimaryDetector,
  ): Promise<boolean> {
    if (this.#stopped) return false;
    if (await this.#hostStopping()) {
      detector.resetStreak();
      logInfo(
        "managed",
        `pg dead-primary suppressed (host stopping) managedId=${record.managedId}`,
      );
      return false;
    }
    if (!this.#peerSupportsProbe()) {
      // Close the incident locally so this logs once, not every tick.
      detector.markEmitted(this.#nowMs());
      logWarn(
        "managed",
        `pg dead-primary detected but control plane lacks managed-ha-probe-v1; not sent managedId=${record.managedId}`,
      );
      return false;
    }
    // Re-check after the awaits above: detach() may have run meanwhile.
    return !this.#stopped;
  }
}
