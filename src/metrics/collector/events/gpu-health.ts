/**
 * GPU hardware-health faults, sourced from an injected `readHealthSignals`
 * reader (production wiring: `gpu/index.ts`'s cached `NvmlGpuAdapter`
 * instance's own `readHealthSignals` — never a second adapter/`dlopen`).
 *
 * `gpu_xid` fires whenever the last-observed Xid error code changes from the
 * prior tick (NVML only exposes the latest code, not a queue, so this is a
 * change-detector, not a count); Xid 79 ("GPU has fallen off the bus") also
 * fires `gpu_fallen_off_bus`. `gpu_ecc` diffs the aggregate double-bit ECC
 * counter via the shared tracker. `gpu_row_remap`/`gpu_retirement` fire on a
 * pending-flag rising edge. `gpu_disappeared` fires when a GPU this
 * collector was tracking drops out of topology; `gpu_fallen_off_bus` also
 * fires when a GPU stays in topology but every health field goes `null`
 * right after a tick that had a real reading (adapter lost the device
 * without topology re-discovering yet). `gpu_thermal_critical` cross-checks
 * this tick's already-built `GpuSampleV4.temperatureCelsius` against a fixed
 * conservative threshold — no per-GPU thermal threshold exists in topology
 * today.
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEventV4 } from "../../contract-v4.ts";
import type { GpuTopology } from "../../topology/types.ts";

/** No topology-level GPU thermal threshold exists yet — this is a conservative fixed default until one is added. */
const GPU_THERMAL_CRITICAL_CELSIUS = 105;
/** NVML Xid 79 — "GPU has fallen off the bus". */
const XID_FALLEN_OFF_BUS = 79;

export type GpuHealthSignals = {
  eccDoubleBitAggregateTotal: number | null;
  lastXidErrorCode: number | null;
  remappedRows: {
    correctable: number;
    uncorrectable: number;
    pending: boolean;
    failureOccurred: boolean;
  } | null;
  retiredPagesPending: boolean | null;
};

export type GpuHealthReader = (gpu: GpuTopology) => Promise<GpuHealthSignals>;

type GpuHealthState = {
  lastXid: number | null;
  remapPending: boolean;
  remapFailed: boolean;
  retirementPending: boolean;
  thermalCritical: boolean;
  hadHealthyRead: boolean;
};

const EMPTY_STATE: GpuHealthState = {
  lastXid: null,
  remapPending: false,
  remapFailed: false,
  retirementPending: false,
  thermalCritical: false,
  hadHealthyRead: false,
};

function isAllNull(health: GpuHealthSignals): boolean {
  return health.eccDoubleBitAggregateTotal === null &&
    health.lastXidErrorCode === null &&
    health.remappedRows === null &&
    health.retiredPagesPending === null;
}

export class GpuHealthEventCollector implements EventCollector {
  readonly #reader: GpuHealthReader;
  readonly #state = new Map<string, GpuHealthState>();
  readonly #seenGpuIds = new Set<string>();

  constructor(deps: { reader: GpuHealthReader }) {
    this.#reader = deps.reader;
  }

  async detect(ctx: EventDetectContext): Promise<MetricEventV4[]> {
    const events: MetricEventV4[] = [];
    const currentIds = new Set(ctx.snapshot.gpus.map((g) => g.gpuId));
    this.#forgetMissingGpus(ctx, events, currentIds);

    for (const gpu of ctx.snapshot.gpus) {
      this.#seenGpuIds.add(gpu.gpuId);
      const prior = this.#state.get(gpu.gpuId) ?? EMPTY_STATE;
      const health = await this.#reader(gpu);
      this.#detectGpu(ctx, events, gpu.gpuId, prior, health);
    }

    return events;
  }

  #forgetMissingGpus(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    currentIds: Set<string>,
  ): void {
    const missing: string[] = [];
    for (const gpuId of this.#seenGpuIds) {
      if (!currentIds.has(gpuId)) missing.push(gpuId);
    }
    for (const gpuId of missing) {
      events.push(
        makeEvent("gpu_disappeared", "critical", ctx.nowMs, {
          entityId: gpuId,
        }),
      );
      this.#seenGpuIds.delete(gpuId);
      this.#state.delete(gpuId);
    }
  }

  #detectGpu(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    gpuId: string,
    prior: GpuHealthState,
    health: GpuHealthSignals,
  ): void {
    const thermalCritical = this.#pushThermalCritical(
      ctx,
      events,
      gpuId,
      prior,
    );
    if (isAllNull(health)) {
      this.#rememberUnreadable(ctx, events, gpuId, prior, thermalCritical);
      return;
    }
    this.#pushXidEvents(ctx, events, gpuId, prior, health);
    this.#pushEccEvent(ctx, events, gpuId, health);
    this.#pushRemapEvents(ctx, events, gpuId, prior, health);
    this.#pushRetirementEvent(ctx, events, gpuId, prior, health);
    this.#state.set(gpuId, {
      lastXid: health.lastXidErrorCode,
      remapPending: health.remappedRows?.pending ?? false,
      remapFailed: health.remappedRows?.failureOccurred ?? false,
      retirementPending: health.retiredPagesPending ?? false,
      thermalCritical,
      hadHealthyRead: true,
    });
  }

  /**
   * Thermal comes from this tick's already-built `GpuSampleV4`
   * (sysfs/DCGM-fed on non-NVIDIA GPUs), not from `health` — it must
   * still be checked even when this GPU has no NVML health signals at
   * all (e.g. every AMD/Intel GPU, always all-null here).
   */
  #pushThermalCritical(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    gpuId: string,
    prior: GpuHealthState,
  ): boolean {
    const sample = ctx.gpus.find((s) => s.gpuId === gpuId);
    const temperatureCelsius = sample?.temperatureCelsius ?? null;
    const thermalCritical = temperatureCelsius !== null &&
      temperatureCelsius >= GPU_THERMAL_CRITICAL_CELSIUS;
    if (thermalCritical && !prior.thermalCritical) {
      events.push(
        makeEvent("gpu_thermal_critical", "critical", ctx.nowMs, {
          entityId: gpuId,
          payload: { temperatureCelsius },
        }),
      );
    }
    return thermalCritical;
  }

  #rememberUnreadable(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    gpuId: string,
    prior: GpuHealthState,
    thermalCritical: boolean,
  ): void {
    if (prior.hadHealthyRead) {
      events.push(
        makeEvent("gpu_fallen_off_bus", "critical", ctx.nowMs, {
          entityId: gpuId,
        }),
      );
    }
    this.#state.set(gpuId, {
      ...prior,
      thermalCritical,
      hadHealthyRead: false,
    });
  }

  #pushXidEvents(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    gpuId: string,
    prior: GpuHealthState,
    health: GpuHealthSignals,
  ): void {
    if (
      health.lastXidErrorCode === null ||
      health.lastXidErrorCode === prior.lastXid
    ) {
      return;
    }
    const fellOffBus = health.lastXidErrorCode === XID_FALLEN_OFF_BUS;
    events.push(
      makeEvent("gpu_xid", fellOffBus ? "critical" : "warning", ctx.nowMs, {
        entityId: gpuId,
        payload: { xid: health.lastXidErrorCode },
      }),
    );
    if (fellOffBus) {
      events.push(
        makeEvent("gpu_fallen_off_bus", "critical", ctx.nowMs, {
          entityId: gpuId,
        }),
      );
    }
  }

  #pushEccEvent(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    gpuId: string,
    health: GpuHealthSignals,
  ): void {
    if (health.eccDoubleBitAggregateTotal === null) return;
    const delta = ctx.tracker.delta(
      `events:gpu:${gpuId}:ecc`,
      health.eccDoubleBitAggregateTotal,
      ctx.bootGeneration,
    );
    if (delta === null || delta <= 0) return;
    events.push(
      makeEvent("gpu_ecc", "critical", ctx.nowMs, {
        entityId: gpuId,
        payload: { count: delta },
      }),
    );
  }

  #pushRemapEvents(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    gpuId: string,
    prior: GpuHealthState,
    health: GpuHealthSignals,
  ): void {
    const remapPending = health.remappedRows?.pending ?? false;
    const remapFailed = health.remappedRows?.failureOccurred ?? false;
    if (remapPending && !prior.remapPending) {
      events.push(
        makeEvent(
          "gpu_row_remap",
          remapFailed ? "critical" : "warning",
          ctx.nowMs,
          { entityId: gpuId, payload: { failureOccurred: remapFailed } },
        ),
      );
      return;
    }
    if (!remapFailed || prior.remapFailed) return;
    // A remap failure surfacing without a fresh pending rising edge
    // (already-pending row whose repair attempt then failed) must still
    // be reported — this is the severe case.
    events.push(
      makeEvent("gpu_row_remap", "critical", ctx.nowMs, {
        entityId: gpuId,
        payload: { failureOccurred: true },
      }),
    );
  }

  #pushRetirementEvent(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    gpuId: string,
    prior: GpuHealthState,
    health: GpuHealthSignals,
  ): void {
    const retirementPending = health.retiredPagesPending ?? false;
    if (!retirementPending || prior.retirementPending) return;
    events.push(
      makeEvent("gpu_retirement", "warning", ctx.nowMs, {
        entityId: gpuId,
      }),
    );
  }
}
