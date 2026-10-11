/**
 * Push this host's managed replica health to the control plane every 30 s.
 *
 * A replica's health is otherwise read only when something asks (an apply, a
 * lifecycle result, the panel's Refresh, a failover probe), so a quiet
 * cluster's reading ages out and a replica that stopped answering keeps its
 * last `streaming` line. This reporter reads every replica recorded in
 * `ha-member.json` (all engines) and sends one `managed-health-report` frame
 * listing them. A replica whose engine is down goes out as `down: true`.
 *
 * Fire-and-forget and read-only: nothing here decides anything. Sent only to a
 * control plane advertising `managed-health-report-v1`; an older one keeps
 * today's behaviour. If this daemon stops reporting, the control plane shows
 * the replica's reading as unknown once it passes the freshness window.
 */

import type {
  DaemonMessage,
  ManagedHealthReportMember,
} from "../contracts/cell-messages.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "../managed/ha-member.ts";
import {
  type ManagedHealthProbeResult,
  probeManagedMemberHealth,
} from "../managed/health.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";

/** Report cadence. Well under the control plane's 120 s freshness window. */
export const MANAGED_HEALTH_REPORT_INTERVAL_MS = 30_000;
/** The control plane accepts at most this many members per frame. */
export const MANAGED_HEALTH_REPORT_MAX_MEMBERS = 32;
const WARN_EVERY_MS = 10 * 60_000;

/** The daemon's text when a member's engine is not running or not answering. */
const ENGINE_DOWN_TEXT = "engine not running";

export type ManagedHealthReporterOptions = {
  /** Send one frame; false when the socket is not open. */
  send: (message: DaemonMessage) => boolean;
  /** True while the control plane advertises `managed-health-report-v1`. */
  peerSupportsReport: () => boolean;
  intervalMs?: number;
  now?: () => string;
  /** Test seam: defaults to {@link listManagedHaMembers}. */
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  /** Test seam: defaults to the on-demand probe (`managed/health.ts`). */
  probe?: (record: ManagedHaMemberRecord) => Promise<ManagedHealthProbeResult>;
  layout?: LayoutPaths;
};

export class ManagedHealthReporter {
  readonly #send: (message: DaemonMessage) => boolean;
  readonly #peerSupportsReport: () => boolean;
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #listMembers: () => Promise<ManagedHaMemberRecord[]>;
  readonly #probe: (
    record: ManagedHaMemberRecord,
  ) => Promise<ManagedHealthProbeResult>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight = false;
  #lastWarnMs: number | null = null;

  constructor(options: ManagedHealthReporterOptions) {
    this.#send = options.send;
    this.#peerSupportsReport = options.peerSupportsReport;
    this.#intervalMs = options.intervalMs ?? MANAGED_HEALTH_REPORT_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#listMembers = options.listMembers ??
      (() =>
        listManagedHaMembers(
          options.layout ?? resolveLayout(Deno.env.toObject()),
        ));
    this.#probe = options.probe ??
      ((record) =>
        probeManagedMemberHealth({
          managedId: record.managedId,
          memberId: record.memberId,
          role: "replica",
          engine: record.engine,
        }));
  }

  attach(): void {
    this.detach();
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#intervalMs);
    // First report right away so a fresh connection does not wait 30 s.
    void this.poll();
  }

  detach(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async poll(): Promise<void> {
    if (this.#inFlight || !this.#peerSupportsReport()) return;
    this.#inFlight = true;
    try {
      const replicas = (await this.#listMembers())
        .filter((record) => record.role === "replica")
        .slice(0, MANAGED_HEALTH_REPORT_MAX_MEMBERS);
      if (replicas.length === 0) return;
      const entries = await Promise.all(
        replicas.map((record) => this.#read(record)),
      );
      const members = entries.filter(
        (entry): entry is ManagedHealthReportMember => entry !== null,
      );
      if (members.length === 0) return;
      this.#send({ type: "managed-health-report", members, at: this.#now() });
    } catch (err) {
      this.#warn(`managed health report failed: ${sanitizeForLog(err)}`);
    } finally {
      this.#inFlight = false;
    }
  }

  async #read(
    record: ManagedHaMemberRecord,
  ): Promise<ManagedHealthReportMember | null> {
    const { managedId, memberId } = record;
    const probe = await this.#probe(record);
    if (probe.ok) {
      const replication = probe.member.replication;
      return replication ? { managedId, memberId, replication } : null;
    }
    // Only an engine-down answer is a reading. Anything else (a bad request,
    // a missing runtime) says nothing about the replica, so it sends nothing
    // and the control plane lets the old reading age out.
    return probe.error.includes(ENGINE_DOWN_TEXT)
      ? { managedId, memberId, down: true }
      : null;
  }

  #warn(message: string): void {
    const now = Date.now();
    if (this.#lastWarnMs !== null && now - this.#lastWarnMs < WARN_EVERY_MS) {
      return;
    }
    this.#lastWarnMs = now;
    logWarn("managed", message);
  }
}
