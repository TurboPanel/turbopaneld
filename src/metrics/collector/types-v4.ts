/**
 * v4 collector dependency seam — deliberately narrow: only what this phase's
 * collectors need (topology discovery, raw `/proc` reads, `statfs`, sysfs IO
 * for per-NIC directional stats, GPU/ingress/database-proxy telemetry
 * adapters, and the hardware-signal/event-detection seams below). This stays
 * separate from v3's `CollectorDeps` rather than mutating it in place.
 */
import type { TopologySnapshot } from "../topology/types.ts";
import type { DatabaseProxyAdapterSet } from "./database-proxy/adapter.ts";
import type { TopLevelEventCollector } from "./events/index.ts";
import type { GpuAdapterSet } from "./gpu/adapter.ts";
import type { IngressAdapterSet } from "./ingress/adapter.ts";
import type { SensorIo } from "./sensors/discovery.ts";
import type { StatfsResult } from "./types.ts";

export type CollectorDepsV4 = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  statfs: (
    path: string,
  ) => StatfsResult | null | Promise<StatfsResult | null>;
  now: () => number;
  /** This tick's topology discovery — networks/filesystems/blockDevices identity, generation, boot generation. */
  collectTopology: () => Promise<TopologySnapshot>;
  /** Sysfs access for per-NIC directional stats (`network.ts`'s `buildNetworkDeviceSamples`). */
  io: SensorIo;
  sysRoot?: string;
  /** Host page size in bytes (`parse-vmstat.ts`'s `resolvePageSizeBytes`), resolved once at construction, never per tick. */
  pageSizeBytes: number;
  /**
   * GPU telemetry adapters (sysfs/NVML/DCGM), constructed once at daemon
   * startup — `gpu/index.ts`'s `buildGpuSamples`. Optional: absent means
   * `gpus` stays `[]`, matching this phase's prior behavior for hosts/tests
   * that don't wire GPU telemetry.
   */
  gpuAdapters?: GpuAdapterSet;
  /**
   * Ingress traffic adapters (Caddy/Traefik loopback scrapes), constructed
   * once at daemon startup — `ingress/index.ts`'s `buildIngressSources`.
   * Optional: absent means `ingressSources` stays `[]`, matching this
   * phase's prior behavior for hosts/tests that don't wire ingress
   * telemetry.
   */
  ingressAdapters?: IngressAdapterSet;
  /**
   * Database-proxy traffic adapters (ProxySQL REST scrape), constructed once
   * at daemon startup — `database-proxy/index.ts`'s `buildDatabaseProxies`.
   * Optional: absent means `databaseProxies` stays `[]`, matching this
   * phase's prior behavior for hosts/tests that don't wire database-proxy
   * telemetry.
   */
  databaseProxyAdapters?: DatabaseProxyAdapterSet;
  /**
   * Event sub-collector aggregator (`events/index.ts`'s `EventCollectorSet`),
   * constructed once at daemon startup. Optional: absent means `events`
   * stays `[]`, matching every other adapter's absent-default convention.
   */
  eventCollectors?: TopLevelEventCollector;
};
