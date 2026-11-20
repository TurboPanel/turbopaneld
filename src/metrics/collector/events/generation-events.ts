/**
 * Boot generation bump edge-detector — a trivial diff over the field
 * `linux-collector.ts` already has every tick (`snapshot.bootGeneration`).
 * First tick establishes the baseline (no fabricated "changed" event just
 * because there was no prior value to compare against).
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEvent } from "../../../contracts/metrics-contract.ts";

export class GenerationEventCollector implements EventCollector {
  #lastBootGeneration: number | undefined;

  detect(ctx: EventDetectContext): MetricEvent[] {
    const events: MetricEvent[] = [];
    const { bootGeneration } = ctx.snapshot;

    if (
      this.#lastBootGeneration !== undefined &&
      this.#lastBootGeneration !== bootGeneration
    ) {
      events.push(
        makeEvent("boot_generation_changed", "warning", ctx.nowMs, {
          payload: { from: this.#lastBootGeneration, to: bootGeneration },
        }),
      );
    }

    this.#lastBootGeneration = bootGeneration;
    return events;
  }
}
