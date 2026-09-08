/**
 * Vendor-neutral HTTP-router adapter interface — one adapter per shared
 * ingress router sidecar (Traefik). `router/index.ts`'s `buildRouterSample`
 * is the only orchestrator that calls these.
 *
 * Unlike `ingress/adapter.ts`, a router reading carries no `sourceId`: a host
 * runs exactly one shared HTTP router, so the family is host-wide and
 * singleton (the same shape `diagnostics` has). `read()` still decides
 * whether the router exists this tick — presence is scrape-derived, not
 * topology-enumerated — but it answers with a bare reading rather than an
 * identity-plus-reading pair.
 */
import type { RouterSample } from "../../contract.ts";
import type { CounterBaselineTracker } from "../baseline.ts";

/**
 * Partial, per-field router reading. A field left unset (not present in the
 * object) or explicitly `null` both mean "no reading for this field this
 * tick" — never fabricated, never coerced to `0`.
 */
export type RouterReading = Partial<RouterSample>;

/**
 * Shared context every adapter needs. `nowMs` is here (and not on
 * `IngressReadContext`) because two router fields are derived from
 * Unix-timestamp gauges — "how long since the last config reload" and "how
 * many days until the soonest cert expiry" are only meaningful relative to
 * the collector's own clock.
 */
export type RouterReadContext = {
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
  nowMs: number;
};

export type RouterAdapterId = "traefik";

/**
 * One HTTP-router telemetry source. `read` returning `null` means "no router
 * is reporting this tick" — the sidecar isn't running, its loopback endpoint
 * didn't answer, or the answer didn't look like this router's exposition.
 * Implementations must never throw — every failure path degrades to `null`
 * (whole reading) or a missing field (partial reading).
 */
export type RouterAdapter = {
  readonly id: RouterAdapterId;
  /** One-time availability probe (endpoint reachable). Memoized — never re-probed per tick. */
  probe(): Promise<void>;
  read(ctx: RouterReadContext): Promise<RouterReading | null>;
};

/** The adapters `buildRouterSample` reads every tick. */
export type RouterAdapterSet = {
  traefik: RouterAdapter;
};
