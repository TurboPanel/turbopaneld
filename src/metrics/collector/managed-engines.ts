/**
 * Managed-engine census — the twelve per-engine fields of the
 * `managed.storage` family (`postgres` / `mysql` / `mariadb` × instances
 * running / healthy, connections used / max), sourced from the managed
 * engines' own runtime and lifecycle state.
 *
 * **Discovery is by label, not by image.** Every managed compose service is
 * stamped `tp.managed.engine=<code>` (`../../managed/compose.ts`'s
 * `MANAGED_ENGINE_LABEL`), so one Docker Engine `GET /containers/json?all=true`
 * over the socket finds every managed engine instance on the host and its
 * state — the same observed-state discipline `managed/lifecycle.ts` uses
 * (`docker compose ps`), never the requested action. `instancesRunning` is
 * the count in Docker's `running` state.
 *
 * **Health and connections come from the engine runtime.** Each running
 * instance is asked `ManagedEngineRuntime.readCensus` — the readiness probe
 * `waitReady` polls (`pg_isready` / `mysqladmin ping`), run once, plus the
 * connection budget — through the same `docker exec` path `apply.ts` and
 * `lifecycle.ts` use. `instancesHealthy` counts the instances whose probe
 * passed; `connectionsUsed` / `connectionsMax` sum across the instances that
 * answered the census query.
 *
 * **Throttled like the Docker-usage sampler, and for the same reason.** The
 * exec is a subprocess, which the 60 s tick must never spawn (see
 * `../AGENTS.md`), so this module owns its own
 * {@link MANAGED_ENGINE_CENSUS_REFRESH_INTERVAL_MS} timer — the `smart.ts`
 * precedent — caches the last reading, and the sample builder reads
 * {@link ManagedEngineSampler.latest} synchronously.
 *
 * **Absent engines stay `null`, present engines report numbers.** An engine
 * with no container of its kind on the host keeps all four fields `null`
 * (the console hides that engine's series on `null`); an engine with
 * containers present in any state reports real counts, including `0`
 * running. A host with no Docker at all reports `null` for every engine.
 */
import type { ContainerSummary } from "../../docker/client.ts";
import type {
  ManagedEngineCensus,
  ManagedEngineContext,
  ManagedEngineRuntime,
} from "../../managed/engines/types.ts";
import {
  STORAGE_ENGINE_KEYS,
  type StorageEngineKey,
  type StorageEngineSample,
} from "../contract.ts";

/** Mirrors `managed/compose.ts`'s `MANAGED_ENGINE_LABEL` — the census's only discovery key. */
export const MANAGED_ENGINE_LABEL = "tp.managed.engine";

/** Compose's own service label — the engine's compose service name, for the exec context. */
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/**
 * How often the census is re-read. Slower than the metrics tick: it costs
 * one `docker exec` per running instance, and instance counts move when
 * someone applies or restarts a managed service, not continuously.
 */
export const MANAGED_ENGINE_CENSUS_REFRESH_INTERVAL_MS = 5 * 60_000;

/** One completed census: the per-engine groups `StorageSample` carries verbatim. */
export type ManagedEngineCensusReading = Record<
  StorageEngineKey,
  StorageEngineSample
>;

/** A managed engine container as the census sees it. */
export type ManagedEngineContainer = {
  containerId: string;
  engine: StorageEngineKey;
  composeServiceName: string;
  running: boolean;
};

/** The four `null` readings of an engine with no instance on this host. */
export function emptyStorageEngine(): StorageEngineSample {
  return {
    instancesRunning: null,
    instancesHealthy: null,
    connectionsUsed: null,
    connectionsMax: null,
  };
}

export function emptyManagedEngineCensus(): ManagedEngineCensusReading {
  return {
    postgres: emptyStorageEngine(),
    mysql: emptyStorageEngine(),
    mariadb: emptyStorageEngine(),
  };
}

function isStorageEngineKey(value: unknown): value is StorageEngineKey {
  return typeof value === "string" &&
    (STORAGE_ENGINE_KEYS as readonly string[]).includes(value);
}

/**
 * The managed engine containers among a `GET /containers/json?all=true`
 * listing — those labelled with an engine the family reports. Other managed
 * engine codes (a cache, an analytics store) carry the label too but have no
 * group on `StorageSample`, so they are skipped rather than miscounted.
 */
export function managedEngineContainers(
  containers: readonly ContainerSummary[],
): ManagedEngineContainer[] {
  const out: ManagedEngineContainer[] = [];
  for (const container of containers) {
    const engine = container.Labels?.[MANAGED_ENGINE_LABEL];
    if (!isStorageEngineKey(engine)) continue;
    if (typeof container.Id !== "string" || container.Id.length === 0) continue;
    out.push({
      containerId: container.Id,
      engine,
      composeServiceName: container.Labels?.[COMPOSE_SERVICE_LABEL] ?? engine,
      running: container.State === "running",
    });
  }
  return out;
}

/** `docker exec -i <id> <argv>` with `input` on stdin — the managed handlers' exec shape. */
export type ManagedEngineExecFn = (
  containerId: string,
  argv: string[],
  input?: string,
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/** The slice of a runtime descriptor the census needs. */
export type ManagedEngineCensusRuntime = Pick<
  ManagedEngineRuntime,
  "rootUsername" | "defaultDatabase" | "readCensus"
>;

export type ManagedEngineCensusDeps = {
  /** `DockerClient.listContainers(true)`, or a stub. Throwing means "no Docker this round". */
  listContainers: () => Promise<ContainerSummary[]>;
  /** The runtime registry (`managed/engines/index.ts`'s `getManagedEngineRuntime`); `null` skips the instance probe. */
  runtimeFor: (engine: StorageEngineKey) => ManagedEngineCensusRuntime | null;
  /** The exec runner, `deploy/docker-cli.ts`'s `runDocker` in production. */
  exec: ManagedEngineExecFn;
};

async function censusOf(
  container: ManagedEngineContainer,
  runtime: ManagedEngineCensusRuntime,
  exec: ManagedEngineExecFn,
): Promise<ManagedEngineCensus | null> {
  if (!runtime.readCensus) return null;
  const ctx: ManagedEngineContext = {
    containerId: container.containerId,
    composeServiceName: container.composeServiceName,
    rootUsername: runtime.rootUsername,
    defaultDatabase: runtime.defaultDatabase,
    exec: (argv, input) => exec(container.containerId, argv, input),
  };
  try {
    return await runtime.readCensus(ctx);
  } catch {
    // A runtime that throws here is a bug in the runtime, not a health
    // signal; count the instance as unread rather than as down.
    return null;
  }
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * One full census: list, group by engine, probe every running instance.
 * Pure over its deps; the sampler below owns the timer and the cache.
 */
export async function readManagedEngineCensus(
  deps: ManagedEngineCensusDeps,
): Promise<ManagedEngineCensusReading> {
  const reading = emptyManagedEngineCensus();
  const containers = managedEngineContainers(await deps.listContainers());
  for (const engine of STORAGE_ENGINE_KEYS) {
    const instances = containers.filter((c) => c.engine === engine);
    if (instances.length === 0) continue;
    const running = instances.filter((c) => c.running);
    const runtime = deps.runtimeFor(engine);
    const censuses = runtime
      ? await Promise.all(running.map((c) => censusOf(c, runtime, deps.exec)))
      : running.map(() => null);
    const answered = censuses.filter((c): c is ManagedEngineCensus =>
      c !== null
    );
    // No runtime probe for this engine: running is known, health is not.
    const probed = runtime?.readCensus !== undefined;
    reading[engine] = {
      instancesRunning: running.length,
      instancesHealthy: probed
        ? answered.filter((c) => c.healthy).length
        : null,
      connectionsUsed: sumOrNull(answered.map((c) => c.connectionsUsed)),
      connectionsMax: sumOrNull(answered.map((c) => c.connectionsMax)),
    };
  }
  return reading;
}

export type ManagedEngineSamplerDeps = ManagedEngineCensusDeps & {
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onError?: (error: unknown) => void;
};

/**
 * Owns the census timer and the cached reading. Started once at daemon boot
 * and stopped on shutdown, independent of the metrics scheduler's
 * attach/detach cycle — the same lifecycle as `DockerUsageSampler`, and for
 * the same reason: the reading describes the host, not a connection.
 *
 * Overlapping refreshes are dropped rather than queued.
 */
export class ManagedEngineSampler {
  readonly #deps: ManagedEngineSamplerDeps;
  readonly #intervalMs: number;
  readonly #setIntervalFn: typeof setInterval;
  readonly #clearIntervalFn: typeof clearInterval;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #reading: ManagedEngineCensusReading | null = null;

  constructor(deps: ManagedEngineSamplerDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ??
      MANAGED_ENGINE_CENSUS_REFRESH_INTERVAL_MS;
    this.#setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.#clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  /** Last successful census, or `null` when Docker is absent / not yet read. */
  latest(): ManagedEngineCensusReading | null {
    return this.#reading;
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
    this.#running = true;
    try {
      this.#reading = await readManagedEngineCensus(this.#deps);
    } catch (error) {
      // Socket gone, Engine restarting: keep the last census rather than
      // blanking the engine series on one failed poll. A daemon that never
      // once listed containers still reports `null` for every engine.
      this.#deps.onError?.(error);
    } finally {
      this.#running = false;
    }
  }
}
