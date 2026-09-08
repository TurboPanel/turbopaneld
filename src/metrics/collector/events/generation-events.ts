/**
 * Topology/boot generation bump edge-detectors — both trivial diffs over
 * fields `linux-collector.ts` already has every tick
 * (`snapshot.generation`/`snapshot.bootGeneration`). First tick establishes
 * the baseline (no fabricated "changed" event just because there was no
 * prior value to compare against).
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEvent } from "../../contract.ts";

export class GenerationEventCollector implements EventCollector {
  #lastTopologyGeneration: number | undefined;
  #lastBootGeneration: number | undefined;

  detect(ctx: EventDetectContext): MetricEvent[] {
    const events: MetricEvent[] = [];
    const { generation, bootGeneration } = ctx.snapshot;

    if (
      this.#lastTopologyGeneration !== undefined &&
      this.#lastTopologyGeneration !== generation
    ) {
      events.push(
        makeEvent("topology_generation_changed", "info", ctx.nowMs, {
          payload: { from: this.#lastTopologyGeneration, to: generation },
        }),
      );
    }
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

    this.#lastTopologyGeneration = generation;
    this.#lastBootGeneration = bootGeneration;
    return events;
  }
}
