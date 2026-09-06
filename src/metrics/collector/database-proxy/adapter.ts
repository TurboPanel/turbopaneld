/**
 * Vendor-neutral database-proxy traffic adapter interface — one adapter per
 * loopback database-proxy sidecar (ProxySQL). `database-proxy/index.ts`'s
 * `buildDatabaseProxies` is the only orchestrator that calls these.
 *
 * Presence is scrape-derived the same way ingress sources are (see
 * `ingress/adapter.ts`'s doc comment) — there is no topology-enumerated
 * entity list, so `read()` itself decides whether its source exists this
 * tick.
 */
import type { DatabaseProxySampleV4 } from "../../contract-v4.ts";
import type { CounterBaselineTracker } from "../baseline.ts";

/**
 * Partial, per-field database-proxy reading. A field left unset (not present
 * in the object) or explicitly `null` both mean "no reading for this field
 * this tick" — never fabricated, never coerced to `0`.
 */
export type DatabaseProxyReading = Partial<
  Omit<DatabaseProxySampleV4, "sourceId" | "sourceKind">
>;

/** Shared context every adapter needs to compute rates from cumulative counters. */
export type DatabaseProxyReadContext = {
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
};

export type DatabaseProxyAdapterId = "proxysql";

/**
 * One database-proxy telemetry source. `read` returning `null` means "this
 * source is absent or unreachable this tick". Implementations must never
 * throw — every failure path degrades to `null` (whole reading) or a
 * missing field (partial reading).
 */
export type DatabaseProxyAdapter = {
  readonly id: DatabaseProxyAdapterId;
  /** One-time availability probe (endpoint reachable). Memoized — never re-probed per tick. */
  probe(): Promise<void>;
  read(
    ctx: DatabaseProxyReadContext,
  ): Promise<
    | { sourceId: string; sourceKind: string; reading: DatabaseProxyReading }
    | null
  >;
};

/** The adapters `buildDatabaseProxies` reads every tick. */
export type DatabaseProxyAdapterSet = {
  proxysql: DatabaseProxyAdapter;
};
