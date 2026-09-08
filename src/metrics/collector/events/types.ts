/**
 * Shared event-detection context/helpers for `collector/events/`.
 *
 * Every sub-collector in this directory holds its own dedupe/cooldown state
 * (last-emitted-kind, cooldown timestamps, or a simple prior-value map) and
 * exposes a `detect(ctx): MetricEvent[] | Promise<MetricEvent[]>` method.
 * `EventCollectorSet` (`index.ts`) is the only orchestrator that calls these —
 * it wraps each in `safeAsync` so one collector throwing never drops another's
 * events, and truncates the combined result to
 * {@link MAX_EVENTS_PER_DETECT_TICK} before returning (mirrors
 * `contract.ts`'s `MAX_METRIC_EVENTS_PER_SAMPLE` — `buildMetricsSample`
 * throws the whole sample away over that cap, so the event set must never
 * hand it more).
 */
import type {
  GpuSample,
  HardwareSignalSample,
  MetricEvent,
  MetricEventKind,
  MetricEventSeverity,
} from "../../contract.ts";
import { fnv1aHex } from "../../topology/identity.ts";
import type { TopologySnapshot } from "../../topology/types.ts";
import type { CounterBaselineTracker } from "../baseline.ts";
import type { GpuThermalReadings } from "../gpu/index.ts";
import type { MountEntry } from "../mounts.ts";
import type { SensorCandidate } from "../types.ts";
import type { SensorIo } from "../sensors/discovery.ts";

/** Mirrors `contract.ts`'s private `MAX_METRIC_EVENTS_PER_SAMPLE` — kept in sync by hand, checked by `events/index.test.ts`. */
export const MAX_EVENTS_PER_DETECT_TICK = 128;

/** Stable signal identity → discovered sensor candidate, from `hardware-signals.ts`'s live discovery this tick. */
export type HardwareSignalCandidateMap = ReadonlyMap<string, SensorCandidate>;

/**
 * Everything a per-catalog-area detector might need. Not every field is used
 * by every detector — this is one shared shape rather than N bespoke ones so
 * `EventCollectorSet.detect` can build it once per tick.
 */
export type EventDetectContext = {
  nowMs: number;
  snapshot: TopologySnapshot;
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
  /** This tick's already-built GPU samples (`linux-collector.ts` builds these before events). */
  gpus: GpuSample[];
  /**
   * This tick's merged per-GPU physical readings (temperature/memory
   * temperature/power), keyed by `gpuId`. Deliberately taken straight from
   * the adapter merge rather than read back out of `hardwareSignals`: those
   * are `[]` on a GPU-passthrough VM (the whole `hardware.physical` family
   * is `isPhysicalMachine()`-gated), which would silently stop
   * `gpu_thermal_critical` from ever firing there.
   */
  gpuThermals: GpuThermalReadings;
  /** This tick's already-built hardware-signal samples (`hardware-signals.ts`). */
  hardwareSignals: HardwareSignalSample[];
  hardwareSignalCandidates: HardwareSignalCandidateMap;
  /** Raw cumulative `/proc/vmstat` `oom_kill` counter this tick; `null` when absent (older kernels). */
  oomKillTotal: number | null;
  conntrackUsedPercent: number | null;
  /** Parsed `/proc/mounts` rows this tick; `[]` when unreadable. */
  mountEntries: MountEntry[];
  /** Raw `/proc/mdstat` text this tick; `undefined` when unreadable (no `mdadm`/kernel support). */
  mdstatText: string | undefined;
  io: SensorIo;
  sysRoot?: string;
  /** Resolved once per process (DMI is static) by `EventCollectorSet` via `topology/physical-classifier.ts`'s `isPhysicalMachine` — never re-derived per detector. */
  isPhysical: boolean;
};

/** One event sub-collector — the shape `EventCollectorSet` composes. Implementations hold their own tick-to-tick state. */
export type EventCollector = {
  detect(ctx: EventDetectContext): MetricEvent[] | Promise<MetricEvent[]>;
};

export type MakeEventOptions = {
  entityId?: string;
  source?: string;
  payload?: Record<string, string | number | boolean | null>;
};

/**
 * Canonical (key-sorted) rendering of a payload record for identity hashing —
 * independent of the insertion order a call site happened to build it in.
 */
function stablePayloadKey(
  payload: Record<string, string | number | boolean | null> | undefined,
): string {
  if (!payload) return "";
  return Object.keys(payload)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${payload[key]}`)
    .join("&");
}

/**
 * Deterministic `eventId`: a hash of `kind` + `entityId`/`source` + the
 * payload that actually defines the transition — deliberately excluding
 * `nowMs`/wall-clock time, so the same logical transition (same collector,
 * same entity, same before/after payload) always yields the same identifier,
 * however many times it is detected, rebuilt, or resent. Two genuinely
 * distinct transitions that happen to carry identical payloads (e.g. two
 * separate single-victim `oom_kill` ticks) collapse to the same id — an
 * accepted tradeoff for stable, hash-based identity with no stored state.
 */
function eventIdentity(
  kind: MetricEventKind,
  options: MakeEventOptions | undefined,
): string {
  const entity = options?.entityId ?? options?.source ?? "";
  const key = `${kind}|${entity}|${stablePayloadKey(options?.payload)}`;
  return `evt:${fnv1aHex(key)}`;
}

/** Build one `MetricEvent` — the single place every detector stamps `eventId`/`at`. */
export function makeEvent(
  kind: MetricEventKind,
  severity: MetricEventSeverity,
  nowMs: number,
  options?: MakeEventOptions,
): MetricEvent {
  const event: MetricEvent = {
    eventId: eventIdentity(kind, options),
    at: new Date(nowMs).toISOString(),
    kind,
    severity,
  };
  if (options?.entityId !== undefined) event.entityId = options.entityId;
  if (options?.source !== undefined) event.source = options.source;
  if (options?.payload !== undefined) event.payload = options.payload;
  return event;
}
