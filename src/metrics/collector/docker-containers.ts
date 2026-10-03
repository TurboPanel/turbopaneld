/**
 * Container health and resource reading for the v7 Docker row: running /
 * unhealthy / restarting counts, unexpected exits, container CPU / memory /
 * OOM kills (cgroup v2, see `container-cgroup.ts`) and the Traefik backend
 * health DERIVED from container state — Traefik only reports backend health
 * for services with a healthcheck and TurboPanel sets none, so scraping it
 * would always be empty. Total = containers labelled `traefik.enable=true`;
 * up = running and not unhealthy; unhealthy names ride along as text.
 *
 * Like `DockerUsageSampler` this owns its timer; the metrics tick only reads
 * {@link ContainerHealthSampler.latest}. Names are short container names —
 * never images, commands, labels or addresses.
 */
import type { ContainerSummary, DockerEvent } from "../../docker/client.ts";
import type { CounterBaselineTracker } from "./baseline.ts";
import {
  CGROUP_V2_ROOT,
  cgroupSlicePath,
  CONTAINER_CGROUP_PARENT,
  containerCpuPercent,
  containerMemoryBytes,
  parseCpuUsageUsec,
  parseOomKills,
} from "./container-cgroup.ts";

export const CONTAINER_HEALTH_REFRESH_INTERVAL_MS = 30_000;
const MAX_NAMES = 8;
const MAX_NAME_LENGTH = 48;
/** A `die` this soon after a `kill` is a requested stop (deploy, `docker stop`). */
const REQUESTED_STOP_WINDOW_MS = 60_000;

export type ContainerHealthReading = {
  running: number;
  unhealthy: number;
  restarting: number;
  unhealthyNames: string[];
  /** Cumulative since the sampler started; the collector turns it into a delta. */
  unexpectedExitsTotal: number;
  /** Cumulative `oom_kill` of the container slice; `null` without the slice. */
  oomKillsTotal: number | null;
  /** Share of the whole host, 0-100. */
  cpuPercent: number | null;
  /** `memory.current` minus `inactive_file`. */
  memoryBytes: number | null;
  traefik: {
    total: number;
    up: number;
    unhealthyNames: string[];
  };
};

function shortName(summary: ContainerSummary): string {
  const raw = summary.Names?.[0] ?? summary.Id.slice(0, 12);
  return raw.replace(/^\//, "").slice(0, MAX_NAME_LENGTH);
}

function isUnhealthy(summary: ContainerSummary): boolean {
  return summary.State === "running" && /\(unhealthy\)/.test(summary.Status);
}

/** Pure reduction of the container list (no cgroup, no events). */
export function summarizeContainers(
  summaries: readonly ContainerSummary[],
): Pick<
  ContainerHealthReading,
  "running" | "unhealthy" | "restarting" | "unhealthyNames" | "traefik"
> {
  let running = 0;
  let restarting = 0;
  const unhealthyNames: string[] = [];
  let traefikTotal = 0;
  let traefikUp = 0;
  const traefikUnhealthy: string[] = [];
  for (const summary of summaries) {
    const isRunning = summary.State === "running";
    const unhealthy = isUnhealthy(summary);
    if (isRunning) running += 1;
    if (summary.State === "restarting") restarting += 1;
    if (unhealthy) unhealthyNames.push(shortName(summary));
    if (summary.Labels?.["traefik.enable"] !== "true") continue;
    traefikTotal += 1;
    if (isRunning && !unhealthy) traefikUp += 1;
    else if (unhealthy) traefikUnhealthy.push(shortName(summary));
  }
  return {
    running,
    unhealthy: unhealthyNames.length,
    restarting,
    unhealthyNames: unhealthyNames.slice(0, MAX_NAMES),
    traefik: {
      total: traefikTotal,
      up: traefikUp,
      unhealthyNames: traefikUnhealthy.slice(0, MAX_NAMES),
    },
  };
}

/**
 * Counts only unexpected exits from the container event stream. Every deploy
 * and stop also emits `die`, but those are preceded by a `kill` (docker stop /
 * restart / daemon-issued stop all send a signal first); a crash, an OOM kill
 * or a process that simply returns does not. A clean exit code 0 is not an
 * incident (batch and one-shot containers) and is not counted.
 */
export class UnexpectedExitTracker {
  #total = 0;
  readonly #killedAt = new Map<string, number>();

  total(): number {
    return this.#total;
  }

  observe(event: DockerEvent, nowMs: number): void {
    const id = event.Actor?.ID;
    if (!id) return;
    if (event.Action === "kill") {
      this.#killedAt.set(id, nowMs);
      return;
    }
    if (event.Action === "destroy" || event.Action === "remove") {
      this.#killedAt.delete(id);
      return;
    }
    if (event.Action !== "die") return;
    const killedAt = this.#killedAt.get(id);
    this.#killedAt.delete(id);
    if (
      killedAt !== undefined && nowMs - killedAt <= REQUESTED_STOP_WINDOW_MS
    ) {
      return;
    }
    if (event.Actor.Attributes?.exitCode === "0") return;
    this.#total += 1;
  }
}

export type ContainerHealthDeps = {
  listContainers: () => Promise<ContainerSummary[]>;
  streamEvents: (signal: AbortSignal) => AsyncGenerator<DockerEvent>;
  /** Read a file under the container slice (`cpu.stat`...); `undefined` when absent. */
  readCgroupFile: (name: string) => Promise<string | undefined>;
  cpuCount: () => number;
  now?: () => number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

/** Default cgroup reader rooted at the container slice. */
export function defaultCgroupReader(
  root = cgroupSlicePath(CONTAINER_CGROUP_PARENT, CGROUP_V2_ROOT),
): (name: string) => Promise<string | undefined> {
  return async (name) => {
    try {
      return await Deno.readTextFile(`${root}/${name}`);
    } catch {
      return undefined;
    }
  };
}

export class ContainerHealthSampler {
  readonly #deps: ContainerHealthDeps;
  readonly #exits = new UnexpectedExitTracker();
  #timer: ReturnType<typeof setInterval> | undefined;
  #abort: AbortController | undefined;
  #running = false;
  #reading: ContainerHealthReading | null = null;
  #cpuPrev: { usageUsec: number; atMs: number } | undefined;

  constructor(deps: ContainerHealthDeps) {
    this.#deps = deps;
  }

  latest(): ContainerHealthReading | null {
    if (!this.#reading) return null;
    return {
      ...this.#reading,
      unexpectedExitsTotal: this.#exits.total(),
    };
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#abort = new AbortController();
    void this.#consumeEvents(this.#abort.signal);
    void this.refresh();
    this.#timer = setInterval(
      () => void this.refresh(),
      this.#deps.intervalMs ?? CONTAINER_HEALTH_REFRESH_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
  }

  async #consumeEvents(signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.#deps.streamEvents(signal)) {
        this.#exits.observe(event, (this.#deps.now ?? Date.now)());
      }
    } catch (error) {
      if (!signal.aborted) this.#deps.onError?.(error);
    }
    if (signal.aborted) return;
    // Stream ended or failed: reconnect after a pause.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (!signal.aborted) void this.#consumeEvents(signal);
  }

  /** Feed one event directly (tests, and the monitor if it ever shares one stream). */
  observeEvent(event: DockerEvent): void {
    this.#exits.observe(event, (this.#deps.now ?? Date.now)());
  }

  async refresh(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const summaries = await this.#deps.listContainers();
      const resources = await this.#readResources();
      this.#reading = {
        ...summarizeContainers(summaries),
        unexpectedExitsTotal: this.#exits.total(),
        ...resources,
      };
    } catch (error) {
      this.#deps.onError?.(error);
    } finally {
      this.#running = false;
    }
  }

  async #readResources(): Promise<
    Pick<ContainerHealthReading, "oomKillsTotal" | "cpuPercent" | "memoryBytes">
  > {
    const read = this.#deps.readCgroupFile;
    const [cpuStat, events, current, stat] = await Promise.all([
      read("cpu.stat"),
      read("memory.events"),
      read("memory.current"),
      read("memory.stat"),
    ]);
    const nowMs = (this.#deps.now ?? Date.now)();
    const usage = cpuStat === undefined ? null : parseCpuUsageUsec(cpuStat);
    let cpuPercent: number | null = null;
    if (usage === null) {
      this.#cpuPrev = undefined;
    } else {
      cpuPercent = containerCpuPercent(
        this.#cpuPrev,
        usage,
        nowMs,
        this.#deps.cpuCount(),
      );
      this.#cpuPrev = { usageUsec: usage, atMs: nowMs };
    }
    return {
      oomKillsTotal: events === undefined ? null : parseOomKills(events),
      cpuPercent,
      memoryBytes: containerMemoryBytes(current, stat),
    };
  }
}

/** Per-sample semantic fields (counters turned into deltas) for the packer. */
export type ContainerHealthSample =
  & Omit<ContainerHealthReading, "unexpectedExitsTotal" | "oomKillsTotal">
  & { unexpectedExits: number | null; oomKills: number | null };

export function toContainerHealthSample(
  reading: ContainerHealthReading,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
): ContainerHealthSample {
  const { unexpectedExitsTotal, oomKillsTotal, ...rest } = reading;
  const oomKills = oomKillsTotal === null
    ? null
    : tracker.delta("docker:containers:oom", oomKillsTotal, bootGeneration);
  if (oomKillsTotal === null) tracker.invalidate("docker:containers:oom");
  return {
    ...rest,
    unexpectedExits: tracker.delta(
      "docker:containers:exits",
      unexpectedExitsTotal,
      bootGeneration,
    ),
    oomKills,
  };
}
