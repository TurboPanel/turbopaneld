/**
 * Database-proxy domain orchestrator — reads the ProxySQL adapter each tick
 * and collects whatever answers. Mirrors `ingress/index.ts`'s
 * `buildIngressSources` contract exactly, scaled down to one adapter: no
 * topology-enumerated entity list, presence is scrape-derived, a `null`
 * result omits the source entirely (never an all-`null` placeholder) and
 * invalidates its counter-baseline namespace.
 */
import type { DatabaseProxySample } from "../../contract.ts";
import type { CounterBaselineTracker } from "../baseline.ts";
import type {
  DatabaseProxyAdapter,
  DatabaseProxyAdapterSet,
  DatabaseProxyReadContext,
  DatabaseProxyReading,
} from "./adapter.ts";

export type {
  DatabaseProxyAdapter,
  DatabaseProxyAdapterId,
  DatabaseProxyAdapterSet,
  DatabaseProxyReadContext,
  DatabaseProxyReading,
} from "./adapter.ts";
export {
  PROXYSQL_REST_ADDR,
  ProxySqlDatabaseProxyAdapter,
} from "./proxysql.ts";

const EMPTY_DATABASE_PROXY_FIELDS: Omit<
  DatabaseProxySample,
  "sourceId" | "sourceKind"
> = {
  queries: null,
  slowQueries: null,
  queryLatencyMsAvg: null,
  backendLatencyMsAvg: null,
  activeTransactions: null,
  clientConnections: null,
  clientConnectionsCreated: null,
  clientConnectionsAborted: null,
  connectionsRejectedMaxConns: null,
  backendConnections: null,
  backendConnectionsCreated: null,
  backendConnectionsAborted: null,
  connectionErrors: null,
  backendsUp: null,
  backendsTotal: null,
  bytesFromBackends: null,
  bytesToBackends: null,
};

function toSample(
  sourceId: string,
  sourceKind: string,
  reading: DatabaseProxyReading,
): DatabaseProxySample {
  return {
    sourceId,
    sourceKind,
    ...EMPTY_DATABASE_PROXY_FIELDS,
    ...reading,
  };
}

async function readOne(
  adapter: DatabaseProxyAdapter,
  ctx: DatabaseProxyReadContext,
): Promise<DatabaseProxySample | null> {
  try {
    const result = await adapter.read(ctx);
    if (result === null) return null;
    return toSample(result.sourceId, result.sourceKind, result.reading);
  } catch {
    return null;
  }
}

/**
 * Read every configured database-proxy adapter this tick.
 * `adapters === undefined` (no database-proxy telemetry wired, e.g. a test
 * collector) returns `[]`, matching `gpu/index.ts`'s absent-adapter-set
 * fallback.
 */
export async function buildDatabaseProxies(
  adapters: DatabaseProxyAdapterSet | undefined,
  ctx: {
    tracker: CounterBaselineTracker;
    bootGeneration: number;
    seconds: number;
  },
): Promise<DatabaseProxySample[]> {
  if (!adapters) return [];
  const readCtx: DatabaseProxyReadContext = ctx;

  const proxysql = await readOne(adapters.proxysql, readCtx);
  if (proxysql !== null) return [proxysql];

  ctx.tracker.invalidatePrefix("dbproxy:proxysql:");
  return [];
}
