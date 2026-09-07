/**
 * OOM-kill events: `/proc/vmstat`'s cumulative `oom_kill` counter
 * (`ctx.oomKillTotal`, already parsed by `linux-collector.ts`), diffed via
 * the shared `CounterBaselineTracker` under its own key namespace — separate
 * from `vmstatRates`'s `vmstat:host:*` keys, since this is an event delta,
 * not a per-second rate. One event per tick with a positive delta (never a
 * per-kill event — the kernel counter doesn't carry that granularity).
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEventV5 } from "../../contract-v5.ts";

const OOM_KILL_BASELINE_KEY = "events:oom_kill:host";
/** Multiple kills in one interval escalate from "warning" to "critical". */
const CRITICAL_KILL_COUNT = 3;

export class OomKillEventCollector implements EventCollector {
  detect(ctx: EventDetectContext): MetricEventV5[] {
    if (ctx.oomKillTotal === null) return [];
    const delta = ctx.tracker.delta(
      OOM_KILL_BASELINE_KEY,
      ctx.oomKillTotal,
      ctx.bootGeneration,
    );
    if (delta === null || delta <= 0) return [];
    return [
      makeEvent(
        "oom_kill",
        delta >= CRITICAL_KILL_COUNT ? "critical" : "warning",
        ctx.nowMs,
        { payload: { count: delta } },
      ),
    ];
  }
}
