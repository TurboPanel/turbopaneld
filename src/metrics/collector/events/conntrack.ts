/**
 * Conntrack-table exhaustion: a high/low-water state machine over
 * `ctx.conntrackUsedPercent` (already computed by `linux-collector.ts` via
 * `parse-kernel-limits.ts`'s `conntrackUsedPercent`). Hysteresis between
 * {@link HIGH_WATER_PERCENT}/{@link LOW_WATER_PERCENT} avoids flapping one
 * event per tick while the table hovers around a single threshold. There is
 * no `conntrack_recovered` kind in the catalog (`contract-v4.ts`'s
 * `METRIC_EVENT_KINDS_V4`) — recovery is a silent state reset, not an event.
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEventV4 } from "../../contract-v4.ts";

const HIGH_WATER_PERCENT = 90;
const LOW_WATER_PERCENT = 80;

export class ConntrackEventCollector implements EventCollector {
  #exhausted = false;

  detect(ctx: EventDetectContext): MetricEventV4[] {
    const pct = ctx.conntrackUsedPercent;
    if (pct === null) return [];

    if (!this.#exhausted && pct >= HIGH_WATER_PERCENT) {
      this.#exhausted = true;
      return [
        makeEvent("conntrack_exhaustion", "critical", ctx.nowMs, {
          payload: { usedPercent: pct },
        }),
      ];
    }
    if (this.#exhausted && pct < LOW_WATER_PERCENT) {
      this.#exhausted = false;
    }
    return [];
  }
}
