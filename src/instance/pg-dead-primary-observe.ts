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
 * - never sends after `detach()` (daemon SIGTERM) or unless systemd positively
 *   reports the host `running`/`degraded` (2 s timeout, fails closed);
 * - streaks/graces/back-off run on a monotonic clock; a tick gap over 3
 *   intervals, attach and detach all reset the streaks;
 * - a held stop/destroy marker is released (and logged) after the engine has
 *   been healthy for 10 minutes; a transient marker's expiry is logged.
 */

import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "../managed/ha-member.ts";
import {
  clearManagedIntent,
  HOST_WIDE_INTENT_ID,
  isHeldIntent,
  isIntentLookupActive,
  lookupManagedIntent,
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

/** A previous tick's Docker call is still running: inconclusive, never dead. */
const DOCKER_STILL_BUSY: ProbeSample = {
  container: {
    kind: "unreadable",
    reason: "previous docker call still running",
  },
};

/** A held stop/destroy is released after the engine is healthy this long. */
export const HELD_INTENT_HEALTHY_RELEASE_MS = 10 * 60_000;
/** A tick gap above this many intervals (suspend, stall) resets streaks. */
const GAP_RESET_INTERVALS = 3;
const SYSTEMCTL_TIMEOUT_MS = 2_000;

export type PgDeadPrimaryEventMessage = {
  type: "managed-ha-event";
  managedId: string;
  sourceMemberId: string;
  detector: typeof POSTGRES_PROBE_DETECTOR;
  evidence: DeadPrimaryEvidence;
  at: string;
};

export type IntentState = {
  /** A marker (cluster or host-wide) suppresses the probe. */
  active: boolean;
  /** The CLUSTER marker is a held stop/destroy (eligible for auto-release). */
  heldClusterMarker: boolean;
};

export type PgDeadPrimaryObserverOptions = {
  /** Returns true only when the event reached an open socket. */
  send: (message: PgDeadPrimaryEventMessage) => boolean;
  /** Control plane advertised `managed-ha-probe-v1`. */
  peerSupportsProbe: () => boolean;
  config?: Partial<PgDeadPrimaryConfig>;
  /** Monotonic ms for streaks/graces/back-off. Defaults to `performance.now`. */
  monoMs?: () => number;
  /** Wall ms for marker expiry, Docker `StartedAt` and the event `at`. */
  wallMs?: () => number;
  /** Test seam — defaults to the `TURBOPANEL_MANAGED_PG_PROBE` env switch. */
  globallyEnabled?: () => boolean;
  /** Test seam — defaults to {@link listManagedHaMembers}. */
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  /** Test seam — defaults to {@link sampleManagedPostgres}. */
  sample?: (containerName: string) => Promise<ProbeSample>;
  /** Test seam — defaults to the cluster + host-wide intent markers. */
  intentState?: (managedId: string, wallMs: number) => Promise<IntentState>;
  /** Test seam — defaults to {@link clearManagedIntent}. */
  releaseHeld?: (managedId: string, reason: string) => Promise<void>;
  /** Test seam — defaults to {@link systemdHostBlocksEmit} (fails closed). */
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

/**
 * True unless systemd positively reports `running` or `degraded`. Fails
 * closed: a timeout, a missing `systemctl`, `starting`, `stopping` or any
 * other state blocks sending.
 */
export async function systemdHostBlocksEmit(
  timeoutMs: number = SYSTEMCTL_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const out = await new Deno.Command("systemctl", {
      args: ["is-system-running"],
      stdout: "piped",
      stderr: "null",
      signal: controller.signal,
    }).output();
    const state = new TextDecoder().decode(out.stdout).trim();
    return state !== "running" && state !== "degraded";
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

type ClusterWatch = {
  detector: DeadPrimaryDetector;
  intentWasActive: boolean;
  healthySinceMono: number | null;
};

function isHealthySample(sample: ProbeSample): boolean {
  return sample.container.kind === "present" &&
    sample.container.state.status === "running" &&
    sample.pgReady?.kind === "exit" && sample.pgReady.code === 0;
}

export class PgDeadPrimaryObserver {
  readonly #config: PgDeadPrimaryConfig;
  readonly #send: PgDeadPrimaryObserverOptions["send"];
  readonly #peerSupportsProbe: () => boolean;
  readonly #monoMs: () => number;
  readonly #wallMs: () => number;
  readonly #globallyEnabled: () => boolean;
  readonly #listMembers: () => Promise<ManagedHaMemberRecord[]>;
  readonly #sample: (containerName: string) => Promise<ProbeSample>;
  readonly #intentState: (
    managedId: string,
    wallMs: number,
  ) => Promise<IntentState>;
  readonly #releaseHeld: (managedId: string, reason: string) => Promise<void>;
  readonly #hostStopping: () => Promise<boolean>;
  readonly #watches = new Map<string, ClusterWatch>();
  /** Docker CLI calls still running per container (a timeout does not kill them). */
  readonly #dockerInFlight = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight = false;
  #stopped = true;
  #lastPollMono: number | null = null;

  constructor(options: PgDeadPrimaryObserverOptions) {
    this.#config = { ...DEFAULT_PG_DEAD_PRIMARY_CONFIG, ...options.config };
    this.#send = options.send;
    this.#peerSupportsProbe = options.peerSupportsProbe;
    this.#monoMs = options.monoMs ?? (() => performance.now());
    this.#wallMs = options.wallMs ?? (() => Date.now());
    this.#globallyEnabled = options.globallyEnabled ??
      (() =>
        pgProbeGloballyEnabled(Deno.env.get("TURBOPANEL_MANAGED_PG_PROBE")));
    const layout = () => options.layout ?? resolveLayout(Deno.env.toObject());
    this.#listMembers = options.listMembers ??
      (() => listManagedHaMembers(layout()));
    const run = options.runDocker ?? defaultRunDocker;
    this.#sample = options.sample ??
      ((name) =>
        sampleManagedPostgres(name, this.#trackedRun(name, run), this.#config));
    this.#intentState = options.intentState ??
      (async (managedId, wallMs) => {
        const stateDir = layout().stateDir;
        const [cluster, host] = await Promise.all([
          lookupManagedIntent(stateDir, managedId),
          lookupManagedIntent(stateDir, HOST_WIDE_INTENT_ID),
        ]);
        return {
          active: isIntentLookupActive(cluster, wallMs) ||
            isIntentLookupActive(host, wallMs),
          heldClusterMarker: isHeldIntent(cluster),
        };
      });
    this.#releaseHeld = options.releaseHeld ??
      ((managedId, reason) =>
        clearManagedIntent(layout().stateDir, managedId, reason));
    this.#hostStopping = options.hostStopping ??
      (() => systemdHostBlocksEmit());
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
    this.#resetStreaks();
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Forget every failure run (keeps incident/back-off so nothing re-fires). */
  #resetStreaks(): void {
    for (const watch of this.#watches.values()) {
      watch.detector.resetStreak();
      watch.healthySinceMono = null;
    }
    this.#lastPollMono = null;
  }

  /**
   * Count each Docker call until its process really ends. A probe timeout
   * only stops waiting; with dockerd wedged, starting another call every tick
   * would pile up hung CLI processes.
   */
  #trackedRun(containerName: string, run: RunDockerFn): RunDockerFn {
    return (args, options) => {
      const count = (delta: number) => {
        const next = (this.#dockerInFlight.get(containerName) ?? 0) + delta;
        if (next > 0) this.#dockerInFlight.set(containerName, next);
        else this.#dockerInFlight.delete(containerName);
      };
      count(1);
      const pending = run(args, options);
      pending.then(() => count(-1), () => count(-1));
      return pending;
    };
  }

  #watchFor(managedId: string): ClusterWatch {
    let watch = this.#watches.get(managedId);
    if (!watch) {
      watch = {
        detector: new DeadPrimaryDetector(this.#config),
        intentWasActive: false,
        healthySinceMono: null,
      };
      this.#watches.set(managedId, watch);
    }
    return watch;
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

  /** A stalled loop (suspend, starved event loop) must not stitch a streak. */
  #noteTickGap(): void {
    const mono = this.#monoMs();
    const last = this.#lastPollMono;
    if (
      last !== null &&
      mono - last > GAP_RESET_INTERVALS * this.#config.intervalMs
    ) {
      this.#resetStreaks();
      logInfo(
        "managed",
        `pg dead-primary probe: ${
          Math.round(mono - last)
        } ms tick gap, streaks reset`,
      );
    }
    this.#lastPollMono = mono;
  }

  async #pollOnce(): Promise<void> {
    if (!this.#globallyEnabled()) {
      this.#watches.clear();
      return;
    }
    this.#noteTickGap();
    const watched = (await this.#listMembers()).filter(isWatchedPrimary);
    const ids = new Set(watched.map((record) => record.managedId));
    for (const id of this.#watches.keys()) {
      if (!ids.has(id)) this.#watches.delete(id);
    }
    await Promise.all(watched.map((record) => this.#probeOne(record)));
  }

  async #trackIntent(
    record: ManagedHaMemberRecord,
    watch: ClusterWatch,
    sample: ProbeSample,
    intent: IntentState,
  ): Promise<void> {
    const mono = this.#monoMs();
    if (watch.intentWasActive && !intent.active) {
      logInfo(
        "managed",
        `intent marker expired managedId=${record.managedId}; probe re-armed`,
      );
    }
    watch.intentWasActive = intent.active;
    if (!intent.heldClusterMarker || !isHealthySample(sample)) {
      watch.healthySinceMono = null;
      return;
    }
    watch.healthySinceMono ??= mono;
    if (mono - watch.healthySinceMono < HELD_INTENT_HEALTHY_RELEASE_MS) return;
    watch.healthySinceMono = null;
    await this.#releaseHeld(
      record.managedId,
      `engine healthy for ${HELD_INTENT_HEALTHY_RELEASE_MS / 60_000} min`,
    );
  }

  async #probeOne(record: ManagedHaMemberRecord): Promise<void> {
    const watch = this.#watchFor(record.managedId);
    const sample = this.#dockerInFlight.has(record.containerName)
      ? DOCKER_STILL_BUSY
      : await this.#sample(record.containerName);
    const wallMs = this.#wallMs();
    const intent = await this.#intentState(record.managedId, wallMs);
    await this.#trackIntent(record, watch, sample, intent);
    const monoMs = this.#monoMs();
    const verdict = watch.detector.step(sample, {
      nowMs: monoMs,
      wallMs,
      intentActive: intent.active,
    });
    if (!verdict.fire) return;
    if (!(await this.#mayEmit(record, watch.detector))) return;
    const delivered = this.#send({
      type: "managed-ha-event",
      managedId: record.managedId,
      sourceMemberId: record.memberId,
      detector: POSTGRES_PROBE_DETECTOR,
      evidence: verdict.evidence,
      at: new Date(this.#wallMs()).toISOString(),
    });
    if (!delivered) return;
    watch.detector.markEmitted(monoMs);
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
        `pg dead-primary suppressed (host not confirmed running) managedId=${record.managedId}`,
      );
      return false;
    }
    if (!this.#peerSupportsProbe()) {
      // Close the incident locally so this logs once, not every tick.
      detector.markEmitted(this.#monoMs());
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
