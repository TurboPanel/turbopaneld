/**
 * In-process record of the last time each local standby's WAL receiver was
 * seen `streaming`.
 *
 * Postgres cannot answer this itself once the primary is gone: the WAL
 * receiver exits, `pg_stat_wal_receiver` has no row, and its
 * `last_msg_receipt_time` is reset whenever a new receiver starts. The
 * control plane's automatic-failover gate needs it to accept a standby that
 * stopped streaming only because its primary died (see the instance
 * `ha-fresh-standby.ts`), so the daemon samples its standbys
 * (`../instance/pg-standby-sampler.ts`) and remembers the last streaming read
 * here.
 *
 * Monotonic clock only for the age: a wall-clock step must not make an old
 * observation look fresh. Nothing is persisted; after a daemon restart there
 * is no record until the next streaming read, and the control plane then
 * fails closed.
 */

import type {
  ManagedLastStreamingObservation,
  ManagedReplicationObservedHealth,
} from "./engines/types.ts";

/**
 * A `streaming` read counts only when the receiver heard from the primary at
 * most this long ago. After a silent link drop the receiver keeps reporting
 * `streaming` (with zero lag) until `wal_receiver_timeout`; without this the
 * tracker would keep stamping a dead link as fresh.
 */
export const MAX_STREAMING_RECEIPT_AGE_MS = 5_000;

type StreamingRecord = {
  monoMs: number;
  at: string;
  lagBytes?: number;
  lagSeconds?: number;
  receiveLagBytes?: number;
};

export class StandbyStreamingTracker {
  readonly #records = new Map<string, StreamingRecord>();

  /**
   * Remember `health` when it reads `streaming` with a receipt no older than
   * {@link MAX_STREAMING_RECEIPT_AGE_MS}; anything else is ignored. The stamp
   * is moved back by the receipt age, so it marks the last message actually
   * received, not the moment of the read.
   */
  record(
    memberId: string,
    health: Pick<
      ManagedReplicationObservedHealth,
      | "state"
      | "lagBytes"
      | "lagSeconds"
      | "observedAt"
      | "receiveLagBytes"
      | "receiptAgeSeconds"
    >,
    monoMs: number,
  ): void {
    if (health.state !== "streaming") return;
    const receiptAgeMs = (health.receiptAgeSeconds ?? Number.NaN) * 1000;
    if (
      !Number.isFinite(receiptAgeMs) || receiptAgeMs < 0 ||
      receiptAgeMs > MAX_STREAMING_RECEIPT_AGE_MS
    ) {
      return;
    }
    const receivedMono = monoMs - receiptAgeMs;
    const previous = this.#records.get(memberId);
    if (previous && previous.monoMs > receivedMono) return;
    this.#records.set(memberId, {
      monoMs: receivedMono,
      at: health.observedAt,
      ...(health.lagBytes === undefined ? {} : { lagBytes: health.lagBytes }),
      ...(health.lagSeconds === undefined
        ? {}
        : { lagSeconds: health.lagSeconds }),
      ...(health.receiveLagBytes === undefined
        ? {}
        : { receiveLagBytes: health.receiveLagBytes }),
    });
  }

  lastStreaming(
    memberId: string,
    nowMonoMs: number,
  ): ManagedLastStreamingObservation | undefined {
    const record = this.#records.get(memberId);
    if (!record) return undefined;
    return {
      at: record.at,
      ageMs: Math.max(0, Math.round(nowMonoMs - record.monoMs)),
      ...(record.lagBytes === undefined ? {} : { lagBytes: record.lagBytes }),
      ...(record.lagSeconds === undefined
        ? {}
        : { lagSeconds: record.lagSeconds }),
      ...(record.receiveLagBytes === undefined
        ? {}
        : { receiveLagBytes: record.receiveLagBytes }),
    };
  }

  /** Drop members this host no longer runs as a standby. */
  retain(memberIds: ReadonlySet<string>): void {
    for (const id of this.#records.keys()) {
      if (!memberIds.has(id)) this.#records.delete(id);
    }
  }
}

/** The daemon-wide tracker shared by the sampler and the health probe. */
export const standbyStreamingTracker = new StandbyStreamingTracker();
