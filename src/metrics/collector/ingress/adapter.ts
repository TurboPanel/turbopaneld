/**
 * Vendor-neutral ingress traffic adapter interface — one adapter per
 * loopback proxy sidecar (Caddy, Traefik). `ingress/index.ts`'s
 * `buildIngressSources` is the only orchestrator that calls these.
 *
 * Unlike GPUs (topology-enumerated identity) an ingress source's presence is
 * scrape-derived: there is no topology list of "ingress sources" to iterate
 * over, so `read()` itself decides whether its source exists this tick
 * (reachable + expected metrics present) and, if so, returns its own
 * `sourceId`/`sourceKind` alongside the reading.
 */
import type { IngressSourceSampleV5 } from "../../contract-v5.ts";
import type { CounterBaselineTracker } from "../baseline.ts";

/**
 * Partial, per-field ingress reading. A field left unset (not present in the
 * object) or explicitly `null` both mean "no reading for this field this
 * tick" — never fabricated, never coerced to `0`.
 */
export type IngressReading = Partial<
  Omit<IngressSourceSampleV5, "sourceId" | "sourceKind">
>;

/** Shared context every adapter needs to compute rates from cumulative counters. */
export type IngressReadContext = {
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
};

export type IngressAdapterId = "caddy" | "traefik";

/**
 * One ingress telemetry source. `read` returning `null` means "this source
 * is absent or unreachable this tick" — the sidecar isn't running, its
 * loopback endpoint didn't answer, or the answer didn't look like this
 * source's exposition. Implementations must never throw — every failure path
 * degrades to `null` (whole reading) or a missing field (partial reading).
 */
export type IngressAdapter = {
  readonly id: IngressAdapterId;
  /** One-time availability probe (endpoint reachable). Memoized — never re-probed per tick. */
  probe(): Promise<void>;
  read(
    ctx: IngressReadContext,
  ): Promise<
    { sourceId: string; sourceKind: string; reading: IngressReading } | null
  >;
};

/** The adapters `buildIngressSources` reads every tick. */
export type IngressAdapterSet = {
  caddy: IngressAdapter;
  traefik: IngressAdapter;
};
