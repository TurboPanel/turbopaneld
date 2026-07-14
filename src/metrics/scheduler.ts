/**
 * Independent host-metrics cadence via an injected async send sink.
 *
 * Observes no traffic and shares nothing with {@link IdlePresence}: normal WS
 * activity cannot suppress scheduled samples, and metrics never suppresses
 * the cell ping. Emits fire-and-forget via the injected sink (authenticated
 * HTTP), not the daemon WebSocket.
 *
 * Interval cadence is independent of collect latency: the steady timer is armed
 * when the jittered first tick fires, not after the first collect completes.
 * Overlapping ticks are dropped (metrics is disposable) so the stateful
 * collector is never used concurrently and sent sequences stay monotonic.
 * Attach-scoped generation tokens ignore stale in-flight emits across
 * detach/reconnect.
 */
import { logInfo, logWarn, sanitizeForLog } from "../logger.ts";
import type { MetricsCollector } from "./collector/index.ts";

/** Steady metrics cadence (independent of IdlePresence / cell ping). */
export const METRICS_INTERVAL_MS = 60_000;

/**
 * Phase-only jitter bound (well under {@link METRICS_INTERVAL_MS}).
 * Shifts when the first sample fires per serverId; does not change cadence, so
 * chart resolution stays one sample per interval.
 */
export const METRICS_JITTER_MAX_MS = 5_000;

/** Minimum gap between repeated failure logs for the same key. */
export const METRICS_LOG_RATE_LIMIT_MS = 5 * 60_000;

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * Stable phase offset in `[0, maxMs]` from `serverId` (FNV-1a over char codes).
 * Same id ⇒ same value; no crypto / `Math.random`.
 */
export function deterministicJitterMs(serverId: string, maxMs: number): number {
  if (maxMs <= 0) return 0;
  let hash = FNV_OFFSET;
  for (let i = 0; i < serverId.length; i++) {
    hash ^= serverId.codePointAt(i) ?? 0;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) % (maxMs + 1);
}

export type MetricsLogLevel = "info" | "warn";

/** Async (or sync) sink that delivers a collected host-metrics sample. */
export type MetricsSink = (sample: unknown) => Promise<void> | void;

export type MetricsSchedulerOptions = {
  serverId: string;
  collectorFactory: () => MetricsCollector;
  intervalMs?: number;
  jitterMaxMs?: number;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  logRateLimitMs?: number;
  onLog?: (level: MetricsLogLevel, message: string) => void;
};

function defaultOnLog(level: MetricsLogLevel, message: string): void {
  if (level === "warn") {
    logWarn("metrics", message);
    return;
  }
  logInfo("metrics", message);
}

/**
 * Bind or rebind a process-local metrics scheduler to `serverId`.
 *
 * Compares against the scheduler's own tracked server id (not token state that
 * may already have been updated). Preserves process-local sequence via
 * {@link MetricsScheduler.setServerId} when the identity changes.
 */
export function rebindMetricsScheduler(args: {
  existing: MetricsScheduler | undefined;
  existingServerId: string | undefined;
  serverId: string;
  collectorFactory: () => MetricsCollector;
  schedulerOptions?: Omit<
    MetricsSchedulerOptions,
    "serverId" | "collectorFactory"
  >;
}): { scheduler: MetricsScheduler; serverId: string } {
  if (args.existing && args.existingServerId === args.serverId) {
    return { scheduler: args.existing, serverId: args.serverId };
  }

  if (args.existing) {
    args.existing.detach();
    args.existing.setServerId(args.serverId);
    return { scheduler: args.existing, serverId: args.serverId };
  }

  return {
    scheduler: new MetricsScheduler({
      ...args.schedulerOptions,
      serverId: args.serverId,
      collectorFactory: args.collectorFactory,
    }),
    serverId: args.serverId,
  };
}

export class MetricsScheduler {
  #serverId: string;
  readonly #collectorFactory: () => MetricsCollector;
  readonly #intervalMs: number;
  readonly #jitterMaxMs: number;
  readonly #now: () => number;
  readonly #setIntervalFn: typeof setInterval;
  readonly #clearIntervalFn: typeof clearInterval;
  readonly #setTimeoutFn: typeof setTimeout;
  readonly #clearTimeoutFn: typeof clearTimeout;
  readonly #logRateLimitMs: number;
  readonly #onLog: (level: MetricsLogLevel, message: string) => void;

  #send: MetricsSink | undefined;
  #collector: MetricsCollector | undefined;
  #firstTimer: ReturnType<typeof setTimeout> | undefined;
  #intervalTimer: ReturnType<typeof setInterval> | undefined;
  /** Process-local monotonic sequence — not reset on attach/detach. */
  #sequence = 0;
  #unsupportedStopped = false;
  /** Bumped on every attach/detach so in-flight emits cannot mutate a new attach. */
  #attachGeneration = 0;
  /**
   * Attach generation currently inside `#emit` (collect → send). Same-generation
   * ticks while set are skipped so collects never overlap.
   */
  #activeEmitGeneration: number | undefined;
  readonly #lastLoggedAt = new Map<string, number>();

  constructor(options: MetricsSchedulerOptions) {
    this.#serverId = options.serverId;
    this.#collectorFactory = options.collectorFactory;
    this.#intervalMs = options.intervalMs ?? METRICS_INTERVAL_MS;
    this.#jitterMaxMs = options.jitterMaxMs ?? METRICS_JITTER_MAX_MS;
    this.#now = options.now ?? Date.now;
    this.#setIntervalFn = options.setIntervalFn ?? setInterval;
    this.#clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.#setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.#clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.#logRateLimitMs = options.logRateLimitMs ?? METRICS_LOG_RATE_LIMIT_MS;
    this.#onLog = options.onLog ?? defaultOnLog;
  }

  /** Jitter applied for the current serverId (test/introspection helper). */
  jitterMs(): number {
    return deterministicJitterMs(this.#serverId, this.#jitterMaxMs);
  }

  /** Current server id used for deterministic jitter. */
  serverId(): string {
    return this.#serverId;
  }

  /**
   * Update server identity for jitter. Process-local sequence is preserved.
   * Caller must detach before rebinding if a socket is attached.
   */
  setServerId(serverId: string): void {
    this.#serverId = serverId;
  }

  attach(send: MetricsSink): void {
    this.detach();
    this.#attachGeneration += 1;
    const generation = this.#attachGeneration;

    let collector: MetricsCollector;
    try {
      collector = this.#collectorFactory();
    } catch (err) {
      this.#logRateLimited(
        "factory",
        "warn",
        "collector factory failed:",
        sanitizeForLog(err),
      );
      // Leave metrics disabled for this attach — do not throw.
      return;
    }

    this.#send = send;
    this.#collector = collector;
    this.#unsupportedStopped = false;

    const jitterMs = deterministicJitterMs(this.#serverId, this.#jitterMaxMs);
    this.#firstTimer = this.#setTimeoutFn(() => {
      this.#firstTimer = undefined;
      // Arm the steady interval immediately so cadence tracks the jittered
      // schedule, not first-collect completion latency.
      void this.#emit(generation, send);
      this.#armInterval(generation, send);
    }, jitterMs);
  }

  #armInterval(generation: number, send: MetricsSink): void {
    if (generation !== this.#attachGeneration) return;
    if (this.#unsupportedStopped || this.#send !== send) return;
    if (this.#intervalTimer !== undefined) return;
    this.#intervalTimer = this.#setIntervalFn(() => {
      void this.#emit(generation, send);
    }, this.#intervalMs);
  }

  detach(): void {
    this.#attachGeneration += 1;
    if (this.#firstTimer !== undefined) {
      this.#clearTimeoutFn(this.#firstTimer);
      this.#firstTimer = undefined;
    }
    if (this.#intervalTimer !== undefined) {
      this.#clearIntervalFn(this.#intervalTimer);
      this.#intervalTimer = undefined;
    }
    this.#send = undefined;
    this.#collector = undefined;
  }

  async #emit(generation: number, send: MetricsSink): Promise<void> {
    if (generation !== this.#attachGeneration) return;
    if (this.#unsupportedStopped) return;
    // Drop overlapping ticks — do not queue a backlog of collects.
    if (this.#activeEmitGeneration === generation) return;

    const collector = this.#collector;
    if (!collector) return;

    this.#activeEmitGeneration = generation;
    this.#sequence += 1;
    const sequence = this.#sequence;

    try {
      let result;
      try {
        result = await collector.collect({ sequence });
      } catch (err) {
        if (generation !== this.#attachGeneration) return;
        this.#logRateLimited(
          "collect",
          "warn",
          "collect failed:",
          sanitizeForLog(err),
        );
        return;
      }

      if (generation !== this.#attachGeneration) return;

      if (!result.supported) {
        this.#logRateLimited(
          "unsupported",
          "warn",
          "metrics unsupported:",
          sanitizeForLog(result.reason),
        );
        this.#stopPeriodicTimer();
        this.#unsupportedStopped = true;
        return;
      }

      if (this.#send !== send) return;

      try {
        await send(result.sample);
      } catch (err) {
        this.#logRateLimited(
          "send",
          "warn",
          "send failed:",
          sanitizeForLog(err),
        );
      }
    } finally {
      if (this.#activeEmitGeneration === generation) {
        this.#activeEmitGeneration = undefined;
      }
    }
  }

  #stopPeriodicTimer(): void {
    if (this.#intervalTimer === undefined) return;
    this.#clearIntervalFn(this.#intervalTimer);
    this.#intervalTimer = undefined;
  }

  #logRateLimited(
    key: string,
    level: MetricsLogLevel,
    ...parts: unknown[]
  ): void {
    const now = this.#now();
    const last = this.#lastLoggedAt.get(key);
    if (last !== undefined && now - last < this.#logRateLimitMs) return;
    this.#lastLoggedAt.set(key, now);
    this.#onLog(level, parts.map(String).join(" "));
  }
}
