/**
 * Ingress domain orchestrator — reads every configured ingress adapter
 * (Caddy, Traefik) independently each tick and collects whatever answers.
 *
 * Unlike `gpu/index.ts`'s `buildGpuSamples`, there is no topology-enumerated
 * entity list to iterate: an ingress source's presence is entirely
 * scrape-derived, so the output array can hold 0, 1, or both sources
 * depending on which sidecars are actually running this tick. Each adapter
 * is read independently and wrapped in try/catch so one adapter throwing
 * never drops the other's reading; a `null` result (absent/unreachable this
 * tick) omits that source from the array entirely — never an all-`null`
 * placeholder entry — and invalidates that source's counter-baseline
 * namespace so a later readable tick re-origins instead of diffing across
 * the gap.
 */
import type { IngressSourceSampleV5 } from "../../contract-v5.ts";
import type { CounterBaselineTracker } from "../baseline.ts";
import type {
  IngressAdapter,
  IngressAdapterSet,
  IngressReadContext,
  IngressReading,
} from "./adapter.ts";

export type {
  IngressAdapter,
  IngressAdapterId,
  IngressAdapterSet,
  IngressReadContext,
  IngressReading,
} from "./adapter.ts";
export { CaddyIngressAdapter, SITE_CADDY_ADMIN_ADDR } from "./caddy-v5.ts";
export { TRAEFIK_METRICS_ADDR, TraefikIngressAdapter } from "./traefik.ts";

const EMPTY_INGRESS_FIELDS: Omit<
  IngressSourceSampleV5,
  "sourceId" | "sourceKind"
> = {
  requests: null,
  responses2xx: null,
  responses3xx: null,
  responses4xx: null,
  responses5xx: null,
  requestErrors: null,
  requestBytes: null,
  responseBytes: null,
  requestDurationSecondsAvg: null,
  requestsUnder100ms: null,
  requestsUnder500ms: null,
  requestsUnder1s: null,
  requestsUnder5s: null,
  requestsInFlight: null,
  upstreamsHealthy: null,
  upstreamsTotal: null,
  retries: null,
};

function toSample(
  sourceId: string,
  sourceKind: string,
  reading: IngressReading,
): IngressSourceSampleV5 {
  return { sourceId, sourceKind, ...EMPTY_INGRESS_FIELDS, ...reading };
}

async function readOne(
  adapter: IngressAdapter,
  ctx: IngressReadContext,
): Promise<IngressSourceSampleV5 | null> {
  try {
    const result = await adapter.read(ctx);
    if (result === null) return null;
    return toSample(result.sourceId, result.sourceKind, result.reading);
  } catch {
    return null;
  }
}

/** Every counter-baseline key namespace an adapter might have written for `id`. */
function invalidateKnownBaselineKeys(
  tracker: CounterBaselineTracker,
  id: string,
): void {
  tracker.invalidatePrefix(`ingress:${id}:`);
}

/**
 * Read every configured ingress adapter this tick. `adapters === undefined`
 * (no ingress telemetry wired, e.g. a test collector) returns `[]`,
 * matching `gpu/index.ts`'s absent-adapter-set fallback.
 */
export async function buildIngressSources(
  adapters: IngressAdapterSet | undefined,
  ctx: {
    tracker: CounterBaselineTracker;
    bootGeneration: number;
    seconds: number;
  },
): Promise<IngressSourceSampleV5[]> {
  if (!adapters) return [];
  const readCtx: IngressReadContext = ctx;

  const [caddy, traefik] = await Promise.all([
    readOne(adapters.caddy, readCtx),
    readOne(adapters.traefik, readCtx),
  ]);

  const sources: IngressSourceSampleV5[] = [];
  if (caddy !== null) {
    sources.push(caddy);
  } else {
    invalidateKnownBaselineKeys(ctx.tracker, "caddy");
  }
  if (traefik !== null) {
    sources.push(traefik);
  } else {
    invalidateKnownBaselineKeys(ctx.tracker, "traefik");
  }
  return sources;
}
