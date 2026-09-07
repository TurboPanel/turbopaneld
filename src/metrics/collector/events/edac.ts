/**
 * EDAC (memory ECC) events: sums `ce_count`/`ue_count` (corrected/
 * uncorrected error counters) under `/sys/devices/system/edac/mc/mcN/` for
 * every memory controller, diffed via the shared `CounterBaselineTracker`.
 * Physical-machine gated — a VM's vDIMM/vCPU has no real EDAC hardware
 * behind it, so `isPhysical: false` short-circuits before any sysfs read.
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEventV5 } from "../../contract-v5.ts";
import type { SensorIo } from "../sensors/discovery.ts";

const MC_DIR_RE = /^mc\d+$/;
const CE_BASELINE_KEY = "events:edac:ce";
const UE_BASELINE_KEY = "events:edac:ue";

async function sumMcCounters(
  io: SensorIo,
  mcRoot: string,
): Promise<{ ce: number; ue: number; any: boolean } | null> {
  const entries = await io.listDir(mcRoot);
  let ce = 0;
  let ue = 0;
  let any = false;

  for (const name of entries) {
    if (!MC_DIR_RE.test(name)) continue;
    const [ceRaw, ueRaw] = await Promise.all([
      io.readFile(`${mcRoot}/${name}/ce_count`),
      io.readFile(`${mcRoot}/${name}/ue_count`),
    ]);
    const ceValue = Number(ceRaw?.trim());
    const ueValue = Number(ueRaw?.trim());
    if (Number.isFinite(ceValue)) {
      ce += ceValue;
      any = true;
    }
    if (Number.isFinite(ueValue)) {
      ue += ueValue;
      any = true;
    }
  }

  return any ? { ce, ue, any } : null;
}

export class EdacEventCollector implements EventCollector {
  async detect(ctx: EventDetectContext): Promise<MetricEventV5[]> {
    if (!ctx.isPhysical) return [];

    const root = ctx.sysRoot ?? "/sys";
    const totals = await sumMcCounters(
      ctx.io,
      `${root}/devices/system/edac/mc`,
    );
    if (!totals) return [];

    const events: MetricEventV5[] = [];
    const ceDelta = ctx.tracker.delta(
      CE_BASELINE_KEY,
      totals.ce,
      ctx.bootGeneration,
    );
    const ueDelta = ctx.tracker.delta(
      UE_BASELINE_KEY,
      totals.ue,
      ctx.bootGeneration,
    );

    if (ceDelta !== null && ceDelta > 0) {
      events.push(
        makeEvent("edac_corrected", "warning", ctx.nowMs, {
          payload: { count: ceDelta },
        }),
      );
    }
    if (ueDelta !== null && ueDelta > 0) {
      events.push(
        makeEvent("edac_uncorrected", "critical", ctx.nowMs, {
          payload: { count: ueDelta },
        }),
      );
    }
    return events;
  }
}
