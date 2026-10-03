/**
 * Docker disk-usage rollup — the `managed.docker` family, reduced from the
 * Engine's `GET /system/df` response, plus the single `dockerUsedBytes` total
 * `managed.storage` carries.
 *
 * **Throttled like the directory walker, and for the same reason.**
 * `/system/df` makes the Engine walk every image, container, volume and
 * build-cache record; on a host with hundreds of images that is not a
 * per-tick call. So this module owns its own
 * {@link DOCKER_USAGE_REFRESH_INTERVAL_MS} timer, caches the last reading,
 * and the sample builder reads {@link DockerUsageSampler.latest}
 * synchronously.
 *
 * **Absent Docker degrades to absent, not to zero.** A host with no Docker
 * socket, or one whose Engine is unhealthy this minute, reports `null` — the
 * builder then omits `sample.dockerUsage` entirely, exactly the way
 * `DockerClient.ping()` treats an unreachable socket as "no Docker" rather
 * than "Docker with nothing running".
 */
import type { DockerSystemDf, DockerTypeUsage } from "../../docker/client.ts";
import type { DockerUsageSample } from "../../contracts/metrics-contract.ts";

/**
 * How often `/system/df` is re-read. Slower than the metrics tick and matched
 * to what the number actually does: image and volume footprints move when
 * someone deploys, not continuously.
 */
export const DOCKER_USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Per-call ceiling for `/system/df`; one hung call must not freeze the family. */
export const DOCKER_USAGE_TIMEOUT_MS = 60_000;

/** Failure back-off ceiling: the refresh delay doubles per failure up to this. */
export const DOCKER_USAGE_MAX_BACKOFF_MS = 30 * 60_000;

/** A completed reading: the ten breakdown fields plus the total `managed.storage` carries. */
export type DockerUsageReading = {
  usage: DockerUsageSample;
  /**
   * Sum of layers + container writable layers + volumes + build cache — the
   * one field this family shares with `StorageSample`. `null` when any
   * component is unknown, since a partial sum understates the total.
   */
  dockerUsedBytes: number | null;
  /**
   * `true` when the newest refresh failed (timeout, socket error) and this is
   * the last good reading carried forward. Absent/`false` when current.
   */
  stale?: boolean;
};

/** Finite non-negative number, or `null` — an absent Engine field is never `0`. */
function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * Sum `pick` across `entries`, keeping `null` when the array itself is absent.
 *
 * An individual entry whose field is missing contributes `0` rather than
 * poisoning the whole sum: the Engine omits `SizeRw` on a container it has
 * not sized, and one unsized container should not blank the containers total.
 * A *missing array* is different — that section was not returned at all, so
 * there is no total to report.
 */
function sumOrNull<T>(
  entries: readonly T[] | undefined,
  pick: (entry: T) => number | null,
): number | null {
  if (!entries) return null;
  let total = 0;
  for (const entry of entries) total += pick(entry) ?? 0;
  return total;
}

function countOrNull(entries: readonly unknown[] | undefined): number | null {
  return entries ? entries.length : null;
}

/** Sum of every component, or `null` when any one of them is unknown. */
function totalUsedBytes(usage: DockerUsageSample): number | null {
  const parts = [
    usage.layersBytes,
    usage.containersBytes,
    usage.volumesBytes,
    usage.buildCacheBytes,
  ];
  if (parts.includes(null)) return null;
  return (parts as number[]).reduce((sum, value) => sum + value, 0);
}

/**
 * Reduce one `/system/df` response.
 *
 * `layersBytes` comes from the Engine's own `LayersSize` — the deduplicated
 * on-disk total — never from summing `Images[].Size`, which counts every
 * shared base layer once per image.
 *
 * Each `*ReclaimableBytes` is what a prune would actually free: images no
 * container references (`Containers === 0`), volumes nothing references
 * (`RefCount === 0`), and build-cache entries not in use.
 */
export function reduceDockerSystemDf(df: DockerSystemDf): DockerUsageReading {
  const usage = applyTypeUsages(df, reduceLegacyDf(df));
  return { usage, dockerUsedBytes: totalUsedBytes(usage) };
}

/**
 * Overlay the Docker 29 `*DiskUsage` summaries on a legacy reduction. Where
 * the Engine supplies one, its own `TotalSize`/`Reclaimable`/`TotalCount` win:
 * the deprecated per-object arrays overcount reclaimable image bytes.
 */
function applyTypeUsages(
  df: DockerSystemDf,
  legacy: DockerUsageSample,
): DockerUsageSample {
  const usage = { ...legacy };
  const images: DockerTypeUsage | undefined = df.ImagesDiskUsage;
  if (images) {
    usage.layersBytes = numberOrNull(images.TotalSize) ?? usage.layersBytes;
    usage.imagesCount = numberOrNull(images.TotalCount) ?? usage.imagesCount;
    usage.imagesReclaimableBytes = numberOrNull(images.Reclaimable) ??
      usage.imagesReclaimableBytes;
  }
  const containers = df.ContainersDiskUsage;
  if (containers) {
    usage.containersBytes = numberOrNull(containers.TotalSize) ??
      usage.containersBytes;
    usage.containersCount = numberOrNull(containers.TotalCount) ??
      usage.containersCount;
  }
  const volumes = df.VolumesDiskUsage;
  if (volumes) {
    usage.volumesBytes = numberOrNull(volumes.TotalSize) ?? usage.volumesBytes;
    usage.volumesCount = numberOrNull(volumes.TotalCount) ??
      usage.volumesCount;
    usage.volumesReclaimableBytes = numberOrNull(volumes.Reclaimable) ??
      usage.volumesReclaimableBytes;
  }
  const cache = df.BuildCacheDiskUsage;
  if (cache) {
    usage.buildCacheBytes = numberOrNull(cache.TotalSize) ??
      usage.buildCacheBytes;
    usage.buildCacheReclaimableBytes = numberOrNull(cache.Reclaimable) ??
      usage.buildCacheReclaimableBytes;
  }
  return usage;
}

function reduceLegacyDf(df: DockerSystemDf): DockerUsageSample {
  return {
    layersBytes: numberOrNull(df.LayersSize),
    imagesCount: countOrNull(df.Images),
    imagesReclaimableBytes: df.Images
      ? sumOrNull(
        df.Images.filter((image) => image.Containers === 0),
        (image) => numberOrNull(image.Size),
      )
      : null,
    containersBytes: sumOrNull(
      df.Containers,
      (container) => numberOrNull(container.SizeRw),
    ),
    containersCount: countOrNull(df.Containers),
    volumesBytes: sumOrNull(
      df.Volumes,
      (volume) => numberOrNull(volume.UsageData?.Size),
    ),
    volumesCount: countOrNull(df.Volumes),
    volumesReclaimableBytes: df.Volumes
      ? sumOrNull(
        df.Volumes.filter((volume) => volume.UsageData?.RefCount === 0),
        (volume) => numberOrNull(volume.UsageData?.Size),
      )
      : null,
    buildCacheBytes: sumOrNull(
      df.BuildCache,
      (entry) => numberOrNull(entry.Size),
    ),
    buildCacheReclaimableBytes: df.BuildCache
      ? sumOrNull(
        df.BuildCache.filter((entry) => entry.InUse === false),
        (entry) => numberOrNull(entry.Size),
      )
      : null,
  };
}

export type DockerUsageDeps = {
  /** `DockerClient.systemDf`, or a stub. Throwing means "no Docker this round". */
  systemDf: (signal: AbortSignal) => Promise<DockerSystemDf>;
  intervalMs?: number;
  /** Per-call abort timeout; default {@link DOCKER_USAGE_TIMEOUT_MS}. */
  timeoutMs?: number;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onError?: (error: unknown) => void;
};

/**
 * Owns the `/system/df` timer and the cached reading. Started once at daemon
 * boot and stopped on shutdown, independent of the metrics scheduler's
 * attach/detach cycle — same lifecycle as `DirectoryUsageWalker`, and for the
 * same reason: the reading describes the host, not a connection.
 *
 * Overlapping refreshes are dropped rather than queued.
 */
export class DockerUsageSampler {
  readonly #deps: DockerUsageDeps;
  readonly #intervalMs: number;
  readonly #setIntervalFn: typeof setInterval;
  readonly #clearIntervalFn: typeof clearInterval;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #reading: DockerUsageReading | null = null;
  #failures = 0;
  #nextAttemptAt = 0;

  constructor(deps: DockerUsageDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ?? DOCKER_USAGE_REFRESH_INTERVAL_MS;
    this.#setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.#clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  /** Last successful reading, or `null` when Docker is absent / not yet read. */
  latest(): DockerUsageReading | null {
    if (!this.#reading) return null;
    return this.#failures > 0
      ? { ...this.#reading, stale: true }
      : this.#reading;
  }

  /** Delay after `failures` consecutive failures: interval doubled, capped. */
  static backoffMs(intervalMs: number, failures: number): number {
    if (failures <= 0) return intervalMs;
    return Math.min(
      intervalMs * 2 ** failures,
      Math.max(DOCKER_USAGE_MAX_BACKOFF_MS, intervalMs),
    );
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.refresh();
    this.#timer = this.#setIntervalFn(() => {
      void this.refresh();
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer === undefined) return;
    this.#clearIntervalFn(this.#timer);
    this.#timer = undefined;
  }

  async refresh(): Promise<void> {
    if (this.#running) return;
    const now = (this.#deps.now ?? Date.now)();
    if (now < this.#nextAttemptAt) return;
    this.#running = true;
    try {
      const signal = AbortSignal.timeout(
        this.#deps.timeoutMs ?? DOCKER_USAGE_TIMEOUT_MS,
      );
      this.#reading = reduceDockerSystemDf(await this.#deps.systemDf(signal));
      this.#failures = 0;
      this.#nextAttemptAt = 0;
    } catch (error) {
      // Socket gone, Engine restarting, timeout, permission revoked: keep the
      // last good reading (flagged stale) rather than blanking a panel on one
      // failed poll, and back off exponentially so a struggling Engine is not
      // re-walked every interval. A daemon that never once succeeded still
      // reports `null`, so the family stays absent instead of emitting zeros.
      this.#failures += 1;
      this.#nextAttemptAt = now +
        DockerUsageSampler.backoffMs(this.#intervalMs, this.#failures);
      this.#deps.onError?.(error);
    } finally {
      this.#running = false;
    }
  }
}
