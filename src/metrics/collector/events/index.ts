/**
 * `EventCollectorSet` — composes every per-catalog-area detector in this
 * directory into the one `events[]` producer `linux-collector.ts` calls.
 * Each sub-collector is wrapped in `safeAsync` so one throwing never drops
 * another's events, and the physical-machine classification (`isPhysical`,
 * from `topology/physical-classifier.ts`) is resolved once and memoized —
 * DMI vendor strings don't change while the daemon process is running.
 *
 * The combined result is truncated to {@link MAX_EVENTS_PER_DETECT_TICK}
 * (mirroring `contract-v4.ts`'s private `MAX_METRIC_EVENTS_PER_SAMPLE`) —
 * `buildMetricsSampleV4` throws the *entire* sample away over that cap, so
 * this set must never hand it more than the wire contract accepts.
 */
import { isPhysicalMachine } from "../../topology/physical-classifier.ts";
import { ClockSyncEventCollector } from "./clock-sync.ts";
import type { ClockSyncReader } from "./clock-sync.ts";
import { ConntrackEventCollector } from "./conntrack.ts";
import { EdacEventCollector } from "./edac.ts";
import { FabricStateEventCollector } from "./fabric-state.ts";
import type { FabricStateReader } from "./fabric-state.ts";
import { FilesystemStateEventCollector } from "./filesystem-state.ts";
import { GenerationEventCollector } from "./generation-events.ts";
import { GpuHealthEventCollector } from "./gpu-health.ts";
import type { GpuHealthReader } from "./gpu-health.ts";
import { HungTaskEventCollector } from "./hung-task.ts";
import type { KernelLogReader } from "./hung-task.ts";
import { MdstatEventCollector } from "./mdstat.ts";
import { NicLinkEventCollector } from "./nic-link.ts";
import { OomKillEventCollector } from "./oom-kill.ts";
import { PhysicalHealthEventCollector } from "./physical-health.ts";
import { SmartEventCollector } from "./smart.ts";
import type { SmartRunner } from "./smart.ts";
import { MAX_EVENTS_PER_DETECT_TICK } from "./types.ts";
import type { EventDetectContext } from "./types.ts";
import type { MetricEventV4 } from "../../contract-v4.ts";

export { MAX_EVENTS_PER_DETECT_TICK } from "./types.ts";
export type { EventCollector, EventDetectContext } from "./types.ts";

/**
 * What `linux-collector.ts` actually has to hand: everything in
 * `EventDetectContext` except `isPhysical`, which `EventCollectorSet` alone
 * resolves and memoizes (`linux-collector.ts` never runs `isPhysicalMachine`
 * itself). This is the type `CollectorDepsV4.eventCollectors` is declared
 * against.
 */
export type TopLevelEventCollector = {
  detect(
    ctx: Omit<EventDetectContext, "isPhysical">,
  ): Promise<MetricEventV4[]>;
};

export type EventCollectorSetDeps = {
  gpuHealthReader: GpuHealthReader;
  smartRunner?: SmartRunner;
  fabricStateReader?: FabricStateReader;
  clockSyncReader?: ClockSyncReader;
  kernelLogReader?: KernelLogReader;
};

async function safeAsync(
  fn: () => MetricEventV4[] | Promise<MetricEventV4[]>,
): Promise<MetricEventV4[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

export class EventCollectorSet implements TopLevelEventCollector {
  readonly #oomKill = new OomKillEventCollector();
  readonly #conntrack = new ConntrackEventCollector();
  readonly #filesystemState = new FilesystemStateEventCollector();
  readonly #mdstat = new MdstatEventCollector();
  readonly #edac = new EdacEventCollector();
  readonly #smart: SmartEventCollector;
  readonly #nicLink = new NicLinkEventCollector();
  readonly #fabricState: FabricStateEventCollector;
  readonly #physicalHealth = new PhysicalHealthEventCollector();
  readonly #gpuHealth: GpuHealthEventCollector;
  readonly #clockSync: ClockSyncEventCollector;
  readonly #hungTask: HungTaskEventCollector;
  readonly #generation = new GenerationEventCollector();
  #isPhysicalCache: boolean | undefined;

  constructor(deps: EventCollectorSetDeps) {
    this.#smart = new SmartEventCollector({ runner: deps.smartRunner });
    this.#fabricState = new FabricStateEventCollector({
      reader: deps.fabricStateReader,
    });
    this.#gpuHealth = new GpuHealthEventCollector({
      reader: deps.gpuHealthReader,
    });
    this.#clockSync = new ClockSyncEventCollector({
      reader: deps.clockSyncReader,
    });
    this.#hungTask = new HungTaskEventCollector({
      reader: deps.kernelLogReader,
    });
  }

  async #resolveIsPhysical(ctx: {
    io: EventDetectContext["io"];
    sysRoot?: string;
  }): Promise<boolean> {
    if (this.#isPhysicalCache === undefined) {
      this.#isPhysicalCache = await isPhysicalMachine({
        readFile: ctx.io.readFile,
        sysRoot: ctx.sysRoot ?? "/sys",
      });
    }
    return this.#isPhysicalCache;
  }

  async detect(
    ctxWithoutPhysical: Omit<EventDetectContext, "isPhysical">,
  ): Promise<MetricEventV4[]> {
    const isPhysical = await this.#resolveIsPhysical(ctxWithoutPhysical);
    const ctx: EventDetectContext = { ...ctxWithoutPhysical, isPhysical };

    const results = await Promise.all([
      safeAsync(() => this.#oomKill.detect(ctx)),
      safeAsync(() => this.#conntrack.detect(ctx)),
      safeAsync(() => this.#filesystemState.detect(ctx)),
      safeAsync(() => this.#mdstat.detect(ctx)),
      safeAsync(() => this.#edac.detect(ctx)),
      safeAsync(() => this.#smart.detect(ctx)),
      safeAsync(() => this.#nicLink.detect(ctx)),
      safeAsync(() => this.#fabricState.detect(ctx)),
      safeAsync(() => this.#physicalHealth.detect(ctx)),
      safeAsync(() => this.#gpuHealth.detect(ctx)),
      safeAsync(() => this.#clockSync.detect(ctx)),
      safeAsync(() => this.#hungTask.detect(ctx)),
      safeAsync(() => this.#generation.detect(ctx)),
    ]);

    const events = results.flat();
    return events.length > MAX_EVENTS_PER_DETECT_TICK
      ? events.slice(0, MAX_EVENTS_PER_DETECT_TICK)
      : events;
  }
}
