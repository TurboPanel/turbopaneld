/**
 * Crash-loop guard: a service container that keeps dying stops being
 * restarted.
 *
 * Docker restarts a failing container forever under `always` and
 * `unless-stopped`, so without a limit a broken release burns CPU and fills
 * the logs until someone notices. The guard counts restarts since the
 * container last stayed up for {@link SERVICE_SETTLE_MS}; at
 * {@link SERVICE_CRASH_LIMIT} it runs `docker stop` once. The authored restart
 * policy is left alone, so a later start from the console (or a redeploy) gets
 * the normal behaviour back: Docker zeroes `RestartCount` on a manual start.
 *
 * The result of a review is attached to each observation as `crashStreak` and
 * `crashStopped`; `service-run-state.ts` turns that into
 * `stopped_after_crashes`.
 */
import {
  SERVICE_CRASH_LIMIT,
  SERVICE_SETTLE_MS,
} from "../contracts/service-run-state.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import {
  dockerStatusOf,
  type ServiceContainerObservation,
  upForMs,
} from "./service-run-state.ts";

export type StopContainer = (containerId: string) => Promise<void>;

type Tracked = {
  /** `RestartCount` at the last time the container proved itself stable. */
  baseline: number;
  /** The guard stopped this container; it stays marked until it starts again. */
  stopped: boolean;
  /** `StartedAt` of the run the guard stopped, to tell a later start from stale data. */
  stoppedRun?: string;
  stopping: boolean;
};

/** `docker stop` through the daemon's Docker CLI; throws when Docker refuses. */
export async function stopCrashLoopingContainer(
  containerId: string,
  run: typeof runDocker = runDocker,
): Promise<void> {
  const result = await run(["stop", "--time", "10", containerId]);
  if (!result.success) {
    throw new Error(
      `docker stop failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

/**
 * True when the container has just shown it can stay up: running past the
 * settle window now, or its last run (the one that just ended) lasted that long.
 */
function provedStable(
  obs: ServiceContainerObservation,
  status: string,
  nowMs: number,
): boolean {
  if (status === "running") {
    const upMs = upForMs(obs.inspect, nowMs);
    return upMs !== undefined && upMs >= SERVICE_SETTLE_MS;
  }
  if (status !== "restarting" && status !== "exited") return false;
  const state = obs.inspect?.State;
  const started = Date.parse(state?.StartedAt ?? "");
  const finished = Date.parse(state?.FinishedAt ?? "");
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return false;
  return finished - started >= SERVICE_SETTLE_MS;
}

export class CrashLoopGuard {
  readonly #tracked = new Map<string, Tracked>();
  readonly #stop: StopContainer;
  readonly #limit: number;

  constructor(stop: StopContainer, limit: number = SERVICE_CRASH_LIMIT) {
    this.#stop = stop;
    this.#limit = limit;
  }

  /**
   * Update the per-container restart streaks, stop any container past the
   * limit (in the background, once), and return the observations carrying
   * `crashStreak` / `crashStopped`.
   */
  review(
    observations: readonly ServiceContainerObservation[],
    nowMs: number,
  ): ServiceContainerObservation[] {
    const liveIds = new Set(observations.map((obs) => obs.containerId));
    for (const id of this.#tracked.keys()) {
      if (!liveIds.has(id)) this.#tracked.delete(id);
    }
    return observations.map((obs) => this.#reviewOne(obs, nowMs));
  }

  #reviewOne(
    obs: ServiceContainerObservation,
    nowMs: number,
  ): ServiceContainerObservation {
    const status = dockerStatusOf(obs);
    const count = obs.inspect?.RestartCount ?? 0;
    const entry = this.#entryFor(obs.containerId, status, count);
    // Docker zeroes the count on a manual start.
    if (count < entry.baseline) entry.baseline = 0;
    if (status === "running" || status === "restarting") {
      this.#clearIfStartedAgain(entry, obs);
    }
    if (provedStable(obs, status, nowMs) && !entry.stopped) {
      entry.baseline = count;
    }
    const streak = count - entry.baseline;
    const failing = status === "restarting" || status === "running";
    if (
      streak >= this.#limit && failing && !entry.stopped && !entry.stopping
    ) {
      this.#stopInBackground(obs, entry, count);
    }
    return { ...obs, crashStreak: streak, crashStopped: entry.stopped };
  }

  #entryFor(containerId: string, status: string, count: number): Tracked {
    const known = this.#tracked.get(containerId);
    if (known) return known;
    // A container first seen running is trusted with its history; one first
    // seen failing carries its whole count.
    const entry: Tracked = {
      baseline: status === "running" ? count : 0,
      stopped: false,
      stopping: false,
    };
    this.#tracked.set(containerId, entry);
    return entry;
  }

  #clearIfStartedAgain(
    entry: Tracked,
    obs: ServiceContainerObservation,
  ): void {
    if (!entry.stopped || entry.stopping) return;
    if (obs.inspect?.State?.StartedAt !== entry.stoppedRun) {
      entry.stopped = false;
      entry.stoppedRun = undefined;
    }
  }

  #stopInBackground(
    obs: ServiceContainerObservation,
    entry: Tracked,
    count: number,
  ): void {
    entry.stopping = true;
    const run = obs.inspect?.State?.StartedAt;
    this.#stop(obs.containerId).then(
      () => {
        entry.stopped = true;
        entry.stoppedRun = run;
        logInfo(
          "sentinel",
          `stopped crash-looping container ${
            obs.containerId.slice(0, 12)
          } after ${count} restarts`,
        );
      },
      (err: unknown) => {
        logWarn(
          "sentinel",
          "crash-loop stop failed:",
          err instanceof Error ? err.message : err,
        );
      },
    ).finally(() => {
      entry.stopping = false;
    });
  }
}
