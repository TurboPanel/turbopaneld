/**
 * Router domain orchestrator — reads the configured HTTP-router adapter each
 * tick and returns its host-wide reading. Mirrors `ingress/index.ts`'s
 * `buildIngressSources` contract, minus the entity array: the family is a
 * singleton, so this returns one sample or `null`, not a list.
 *
 * Presence is scrape-derived, not topology-enumerated. A `null` result omits
 * the family from the wire sample entirely — never an all-`null` placeholder
 * object — and invalidates the adapter's counter-baseline namespace so a
 * later readable tick re-origins instead of diffing across the gap.
 */
import type { RouterSample } from "../../contract.ts";
import type { CounterBaselineTracker } from "../baseline.ts";
import type {
  RouterAdapter,
  RouterAdapterSet,
  RouterReadContext,
  RouterReading,
} from "./adapter.ts";

export type {
  RouterAdapter,
  RouterAdapterId,
  RouterAdapterSet,
  RouterReadContext,
  RouterReading,
} from "./adapter.ts";
export { TRAEFIK_METRICS_ADDR, TraefikRouterAdapter } from "./traefik.ts";

const EMPTY_ROUTER_FIELDS: RouterSample = {
  backendsUp: null,
  backendsTotal: null,
  servicesTotal: null,
  routersTotal: null,
  retries: null,
  backendErrors5xx: null,
  backendLatencyMsAvg: null,
  backendRequests: null,
  httpOpenConnections: null,
  configReloads: null,
  configLastReloadAgeSeconds: null,
  tlsCertSoonestExpiryDays: null,
};

function toSample(reading: RouterReading): RouterSample {
  return { ...EMPTY_ROUTER_FIELDS, ...reading };
}

async function readOne(
  adapter: RouterAdapter,
  ctx: RouterReadContext,
): Promise<RouterSample | null> {
  try {
    const reading = await adapter.read(ctx);
    if (reading === null) return null;
    return toSample(reading);
  } catch {
    return null;
  }
}

/**
 * Read the configured router adapter this tick. `adapters === undefined` (no
 * router telemetry wired, e.g. a test collector) returns `null`, matching
 * `gpu/index.ts`'s absent-adapter-set fallback.
 */
export async function buildRouterSample(
  adapters: RouterAdapterSet | undefined,
  ctx: {
    tracker: CounterBaselineTracker;
    bootGeneration: number;
    seconds: number;
    nowMs: number;
  },
): Promise<RouterSample | null> {
  if (!adapters) return null;
  const readCtx: RouterReadContext = ctx;

  const traefik = await readOne(adapters.traefik, readCtx);
  if (traefik !== null) return traefik;

  ctx.tracker.invalidatePrefix("router:traefik:");
  return null;
}
