/**
 * Sample this host's managed Postgres STANDBYS every few seconds and record
 * each `streaming` read in the daemon-wide {@link standbyStreamingTracker}.
 *
 * The control plane's automatic-failover gate accepts a standby that is no
 * longer streaming only when it was seen streaming within a small margin of
 * the primary's failure (default 10 s). A replica's health is otherwise read
 * only on `managed.apply` / `managed.lifecycle` / the on-demand probe, far
 * too rarely for that, so this loop keeps the record fresh. It sends nothing
 * and decides nothing; local reads only.
 *
 * Off with the same switch as the dead-primary probe
 * (`TURBOPANEL_MANAGED_PG_PROBE=off`): without samples the control plane
 * simply keeps refusing a non-streaming standby, as before.
 */

import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "../managed/ha-member.ts";
import { getManagedEngineRuntime } from "../managed/engines/index.ts";
import type { ManagedReplicationObservedHealth } from "../managed/engines/types.ts";
import {
  type StandbyStreamingTracker,
  standbyStreamingTracker,
} from "../managed/standby-streaming.ts";
import { pgProbeGloballyEnabled } from "./pg-dead-primary-observe.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/** Sample cadence. Must stay well under the control plane's receipt margin. */
export const STANDBY_SAMPLE_INTERVAL_MS = 2_000;
const WARN_EVERY_MS = 10 * 60_000;

export type PgStandbySamplerOptions = {
  intervalMs?: number;
  tracker?: StandbyStreamingTracker;
  /** Monotonic ms. Defaults to `performance.now`. */
  monoMs?: () => number;
  /** Test seam — defaults to the `TURBOPANEL_MANAGED_PG_PROBE` env switch. */
  globallyEnabled?: () => boolean;
  /** Test seam — defaults to {@link listManagedHaMembers}. */
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  /** Test seam — defaults to the Postgres runtime's standby `readHealth`. */
  readStandby?: (
    containerName: string,
  ) => Promise<ManagedReplicationObservedHealth>;
  runDocker?: RunDockerFn;
  layout?: LayoutPaths;
};

export function isSampledStandby(record: ManagedHaMemberRecord): boolean {
  return record.engine === "postgres" && record.role === "replica";
}

function readPostgresStandby(
  containerName: string,
  run: RunDockerFn,
): Promise<ManagedReplicationObservedHealth> {
  const engine = getManagedEngineRuntime("postgres");
  const replication = engine.replication;
  if (!replication) {
    return Promise.reject(new Error("postgres has no replication runtime"));
  }
  return replication.readHealth({
    containerId: containerName,
    // Unused by `readHealth`; exec goes straight to the container name.
    composeServiceName: "postgres",
    rootUsername: engine.rootUsername,
    defaultDatabase: engine.defaultDatabase,
    exec: async (argv, input) => {
      const result = await run(
        ["exec", "-i", containerName, ...argv],
        input === undefined ? undefined : { input },
      );
      return {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  }, "standby");
}

export class PgStandbySampler {
  readonly #intervalMs: number;
  readonly #tracker: StandbyStreamingTracker;
  readonly #monoMs: () => number;
  readonly #globallyEnabled: () => boolean;
  readonly #listMembers: () => Promise<ManagedHaMemberRecord[]>;
  readonly #readStandby: (
    containerName: string,
  ) => Promise<ManagedReplicationObservedHealth>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight = false;
  #lastWarnMono: number | null = null;

  constructor(options: PgStandbySamplerOptions = {}) {
    this.#intervalMs = options.intervalMs ?? STANDBY_SAMPLE_INTERVAL_MS;
    this.#tracker = options.tracker ?? standbyStreamingTracker;
    this.#monoMs = options.monoMs ?? (() => performance.now());
    this.#globallyEnabled = options.globallyEnabled ??
      (() =>
        pgProbeGloballyEnabled(Deno.env.get("TURBOPANEL_MANAGED_PG_PROBE")));
    const layout = () => options.layout ?? resolveLayout(Deno.env.toObject());
    this.#listMembers = options.listMembers ??
      (() => listManagedHaMembers(layout()));
    const run = options.runDocker ?? defaultRunDocker;
    this.#readStandby = options.readStandby ??
      ((name) => readPostgresStandby(name, run));
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
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      await this.#pollOnce();
    } catch (err) {
      this.#warn(`pg standby sampler failed: ${sanitizeForLog(err)}`);
    } finally {
      this.#inFlight = false;
    }
  }

  async #pollOnce(): Promise<void> {
    if (!this.#globallyEnabled()) return;
    const standbys = (await this.#listMembers()).filter(isSampledStandby);
    this.#tracker.retain(new Set(standbys.map((record) => record.memberId)));
    await Promise.all(standbys.map((record) => this.#sampleOne(record)));
  }

  async #sampleOne(record: ManagedHaMemberRecord): Promise<void> {
    // Stamp BEFORE the read: the receiver was streaming no earlier than
    // this, so the reported age only ever errs on the old (refusing) side. A
    // hung read holds the next poll back, which only makes the record older.
    const startedMono = this.#monoMs();
    try {
      const health = await this.#readStandby(record.containerName);
      this.#tracker.record(record.memberId, health, startedMono);
    } catch (err) {
      this.#warn(
        `pg standby sample for ${record.managedId} failed: ${
          sanitizeForLog(err)
        }`,
      );
    }
  }

  #warn(message: string): void {
    const mono = this.#monoMs();
    if (
      this.#lastWarnMono !== null && mono - this.#lastWarnMono < WARN_EVERY_MS
    ) {
      return;
    }
    this.#lastWarnMono = mono;
    logWarn("managed", message);
  }
}
