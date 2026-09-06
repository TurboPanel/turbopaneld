/**
 * Host clock-sync state: `src/host/time-sync.ts`'s `readTimeSync()` spawns
 * `timedatectl` synchronously, so this collector never calls it directly —
 * that would both be a per-interval subprocess and block the event loop.
 * Instead it reads `getLastObservedTimeSync()`, a cache stashed as a side
 * effect whenever some other real caller (e.g. `instance/idle-presence.ts`'s
 * hello/heartbeat snapshot) already invokes `readTimeSync()`. This collector
 * still gates its own detection behind a low-cadence timer (documented
 * exception, same shape as `smart.ts`) so a quiet connection doesn't get
 * re-evaluated every ~60 s metrics tick; an empty cache (no real read has
 * happened yet this process) yields `undefined`, matching every other
 * "no telemetry wired" default in `collector/`.
 */
import { getLastObservedTimeSync } from "../../../host/time-sync.ts";
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEventV4 } from "../../contract-v4.ts";

export const DEFAULT_CLOCK_SYNC_INTERVAL_MS = 5 * 60_000;

export type ClockSyncReader = () => boolean | undefined;

function defaultReadNtpSynced(): boolean | undefined {
  try {
    return getLastObservedTimeSync()?.ntpSynced;
  } catch {
    return undefined;
  }
}

export class ClockSyncEventCollector implements EventCollector {
  readonly #reader: ClockSyncReader;
  readonly #intervalMs: number;
  #lastRunMs: number | null = null;
  #lastSynced: boolean | undefined;

  constructor(deps?: { reader?: ClockSyncReader; intervalMs?: number }) {
    this.#reader = deps?.reader ?? defaultReadNtpSynced;
    this.#intervalMs = deps?.intervalMs ?? DEFAULT_CLOCK_SYNC_INTERVAL_MS;
  }

  detect(ctx: EventDetectContext): MetricEventV4[] {
    if (
      this.#lastRunMs !== null &&
      ctx.nowMs - this.#lastRunMs < this.#intervalMs
    ) {
      return [];
    }
    this.#lastRunMs = ctx.nowMs;

    const synced = this.#reader();
    const events: MetricEventV4[] = [];
    if (
      synced !== undefined && this.#lastSynced !== undefined &&
      synced !== this.#lastSynced
    ) {
      events.push(
        synced
          ? makeEvent("clock_sync_restored", "info", ctx.nowMs)
          : makeEvent("clock_sync_lost", "warning", ctx.nowMs),
      );
    }
    this.#lastSynced = synced;
    return events;
  }
}
