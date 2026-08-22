/**
 * Container log collector.
 *
 * Discovers the containers this host's own deployments own, tails each one's
 * stdout/stderr, redacts every line against the process-wide deny-set, and
 * ships bounded batches to `POST /api/daemon/v1/logs/containers`.
 *
 * **Identity comes from deployment state, not from container labels.** The
 * daemon already wrote `deployment.json` for every environment it deployed;
 * that manifest — plus Compose's own `com.docker.compose.{project,service}`
 * labels — is what maps an observed container id back to an environment and a
 * service. `com.turbopanel.*` labels are only as trustworthy as whatever last
 * touched the container, and a drifted or missing one would ingest lines under
 * the wrong tenant identity (or none at all).
 *
 * **Why the docker CLI and not the Engine API.** Everything else in this repo
 * reaches Docker through `src/deploy/docker-cli.ts`, which already owns the
 * escalation ladder (direct → `sudo -n -u <self>` after a `docker` group change
 * → `sudo -n --` for a root-only socket). Talking to `/var/run/docker.sock`
 * directly here would fork a second, weaker access model that breaks on exactly
 * the hosts that ladder exists for. `docker container logs --follow` gives one
 * structured stream per container — stdout and stderr stay separate on the
 * child's own pipes — which is what the Engine API's multiplexed frames would
 * have bought us anyway.
 *
 * **Nothing here is load-bearing.** Container output is disposable telemetry:
 * a tail that dies, a batch that cannot be delivered, or a buffer that
 * overflows is warned about (rate-limited) and dropped. No failure in this
 * module may ever surface in a command outcome or stop a deploy.
 */

import { logWarn, sanitizeForLog } from "../logger.ts";
import { pumpLines } from "./line-stream.ts";
import {
  runDocker as defaultRunDocker,
  type RunDockerFn,
  spawnDockerStreaming,
} from "../deploy/docker-cli.ts";
import {
  parseComposePsEntries,
  readComposePsLabels,
} from "../deploy/compose-ps.ts";
import {
  LABEL_COMPOSE_PROJECT,
  LABEL_COMPOSE_SERVICE,
} from "../deploy/labels.ts";
import { listLocalDeploymentManifests } from "../deploy/compose-files.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  type ContainerLogBatchEvent,
  type ContainerLogStream,
  type ContainerLogTarget,
  MAX_CONTAINER_LOG_INGEST_BATCH,
  type SendContainerLogBatchFn,
  truncateContainerLogMessage,
} from "./container-log-contracts.ts";
import {
  type MutableTranscriptRedactor,
  sharedSecretRedactor,
} from "./redactor.ts";

/**
 * Flush cadence. Deliberately the same numbers `spool.ts` uses for execution
 * logs — one batching rhythm in the daemon, not two.
 */
export const CONTAINER_LOG_FLUSH_INTERVAL_MS = 750;
export const CONTAINER_LOG_FLUSH_BYTES = 64 * 1024;

/**
 * Ring-buffer ceiling. Container logs have no spool file (unlike execution
 * logs, whose transcript is product data): when the control plane is
 * unreachable the buffer fills and the **oldest** lines are dropped, so a
 * wedged uploader costs bounded memory instead of the host.
 */
export const MAX_BUFFERED_CONTAINER_LOG_EVENTS = 20_000;

/** How often the container set is re-discovered (restarts, new deploys). */
export const CONTAINER_DISCOVERY_INTERVAL_MS = 15_000;

/** Backoff before re-attaching a tail whose child exited. */
export const CONTAINER_TAIL_RETRY_MS = 5_000;

/** At most one drop-accounting warning per this window (never per line). */
export const DROP_WARN_INTERVAL_MS = 60_000;

/** Docker `--timestamps` prefix: RFC3339Nano, then a single space. */
const DOCKER_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.?\d*Z?)\s(.*)$/;

/** Split a `--timestamps` line into its stamp and the message it prefixes. */
export function splitDockerTimestampLine(
  line: string,
): { timestamp: string | null; message: string } {
  const match = DOCKER_TIMESTAMP_RE.exec(line);
  if (!match) return { timestamp: null, message: line };
  const parsed = new Date(match[1] ?? "");
  if (Number.isNaN(parsed.getTime())) return { timestamp: null, message: line };
  return { timestamp: parsed.toISOString(), message: match[2] ?? "" };
}

/** One live tail. Cancelled by aborting `controller`. */
export type TailContainerFn = (params: {
  containerId: string;
  /** RFC3339 lower bound so a re-attach does not replay the whole log. */
  since: string | undefined;
  onLine: (stream: ContainerLogStream, line: string) => void;
  signal: AbortSignal;
}) => Promise<void>;

export type DiscoverContainersFn = () => Promise<ContainerLogTarget[]>;

export type ContainerLogCollectorOptions = {
  /** This host's server id — advisory on the wire; the route re-stamps it. */
  serverId: string;
  send: SendContainerLogBatchFn;
  /**
   * Hold batches instead of shipping them while this returns false (no
   * transport). Buffered lines survive the outage inside the ring buffer and
   * ship on the next flush; without this a disconnected daemon would "flush"
   * every 750ms straight into the drop counter. Defaults to always-ready.
   */
  readyToSend?: () => boolean;
  /**
   * Deny-set. Defaults to the **process-wide** one (`sharedSecretRedactor`),
   * which already holds everything this daemon has ever decrypted — a
   * per-collector deny-set would start empty on every restart and leak
   * previously decrypted values into retained logs.
   */
  redactor?: MutableTranscriptRedactor;
  /** Daemon layout — required unless `discover` is injected. */
  layout?: Pick<LayoutPaths, "stateDir"> | { stateDir: string };
  discover?: DiscoverContainersFn;
  tail?: TailContainerFn;
  flushIntervalMs?: number;
  flushBytes?: number;
  maxBufferedEvents?: number;
  maxBatchSize?: number;
  discoveryIntervalMs?: number;
  tailRetryMs?: number;
  /** Injectable clock (tests) — defaults to `Date.now`. */
  now?: () => number;
  /** Injectable timer (tests) — defaults to `setInterval`. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

/** Drop accounting, surfaced for tests and the rate-limited warning. */
export type ContainerLogCollectorStats = {
  buffered: number;
  droppedEvents: number;
  sentEvents: number;
  failedBatches: number;
  tailedContainers: number;
};

/** One container as `docker ps` observed it — liveness and identity keys only. */
export type ObservedContainer = {
  containerId: string;
  /** Compose project name (`com.docker.compose.project`), or null. */
  composeProject: string | null;
  /** Compose service name (`com.docker.compose.service`), or null. */
  composeService: string | null;
};

export type ObserveContainersFn = () => Promise<ObservedContainer[]>;

/**
 * Deployment identity, keyed by compose project name.
 *
 * Built from `<stateDir>/deployments/<projectId>/<environmentId>/deployment.json`
 * — the manifests this daemon wrote itself.
 */
export type DeploymentIdentityIndex = Map<string, {
  environmentId: string;
  serviceIds: Record<string, string>;
}>;

export type LoadDeploymentIdentityFn = () => Promise<DeploymentIdentityIndex>;

/**
 * Observe running containers via `docker ps`.
 *
 * Filtered on Compose's own project label: a container Compose did not create
 * cannot belong to a deployment manifest, so it can never resolve to a tenant
 * identity. Nothing here reads a `com.turbopanel.*` label — this call answers
 * "which container ids are alive", and the manifest answers "whose are they".
 */
export function createDockerPsObservation(
  runDocker: RunDockerFn = defaultRunDocker,
): ObserveContainersFn {
  return async () => {
    const result = await runDocker([
      "ps",
      "--no-trunc",
      "--filter",
      `label=${LABEL_COMPOSE_PROJECT}`,
      "--format",
      "{{json .}}",
    ]);
    if (!result.success) {
      logWarn(
        "container-logs",
        `container discovery failed: ${
          sanitizeForLog(result.stderr || "docker ps failed")
        }`,
      );
      return [];
    }
    const observed: ObservedContainer[] = [];
    for (const entry of parseComposePsEntries(result.stdout)) {
      const containerId = entry.ID;
      if (typeof containerId !== "string" || containerId.length === 0) continue;
      const labels = readComposePsLabels(entry);
      observed.push({
        containerId,
        composeProject: labels[LABEL_COMPOSE_PROJECT] ?? null,
        composeService: labels[LABEL_COMPOSE_SERVICE] ?? null,
      });
    }
    return observed;
  };
}

/**
 * Read every local `deployment.json` into a compose-project-keyed index.
 *
 * A manifest that cannot be read is simply absent: its containers then fail to
 * resolve and are not tailed, which is the safe direction — better no lines
 * than lines stamped with a guessed tenant identity.
 */
export function createDeploymentIdentityLoader(
  layout: { stateDir: string },
): LoadDeploymentIdentityFn {
  return async () => {
    const index: DeploymentIdentityIndex = new Map();
    let manifests: Awaited<ReturnType<typeof listLocalDeploymentManifests>>;
    try {
      manifests = await listLocalDeploymentManifests(layout);
    } catch (err) {
      logWarn(
        "container-logs",
        `deployment manifest scan failed: ${sanitizeForLog(err)}`,
      );
      return index;
    }
    for (const { manifest } of manifests) {
      if (!manifest.projectName) continue;
      index.set(manifest.projectName, {
        environmentId: manifest.environmentId,
        serviceIds: manifest.serviceIds ?? {},
      });
    }
    return index;
  };
}

/**
 * Join observed containers against local deployment manifests.
 *
 * Containers whose compose project is not one of this host's deployments are
 * dropped: platform system stacks, managed engines, and operator one-offs are
 * out of scope for tenant-visible container logs, exactly as the old
 * `com.turbopanel.environment` filter intended — but decided from deployment
 * state rather than from a label a tenant compose file could set.
 */
export function resolveContainerLogTargets(
  observed: readonly ObservedContainer[],
  index: DeploymentIdentityIndex,
): ContainerLogTarget[] {
  const targets: ContainerLogTarget[] = [];
  for (const container of observed) {
    if (!container.composeProject) continue;
    const deployment = index.get(container.composeProject);
    if (!deployment) continue;
    const serviceId = container.composeService
      ? deployment.serviceIds[container.composeService] ?? null
      : null;
    targets.push({
      containerId: container.containerId,
      environmentId: deployment.environmentId,
      serviceId,
    });
  }
  return targets;
}

/**
 * Default discovery: `docker ps` for liveness, `deployment.json` for identity.
 */
export function createDeploymentManifestDiscovery(options: {
  layout: { stateDir: string };
  observe?: ObserveContainersFn;
  loadIdentity?: LoadDeploymentIdentityFn;
}): DiscoverContainersFn {
  const observe = options.observe ?? createDockerPsObservation();
  const loadIdentity = options.loadIdentity ??
    createDeploymentIdentityLoader(options.layout);
  return async () => {
    const [observed, index] = await Promise.all([observe(), loadIdentity()]);
    return resolveContainerLogTargets(observed, index);
  };
}

/**
 * Default tail: `docker container logs --follow --timestamps [--since …]`.
 *
 * stdout and stderr are pumped from the child's own pipes, so the stream tag is
 * the real one rather than a guess from the line's content.
 */
export const tailContainerWithDockerCli: TailContainerFn = async (params) => {
  const args = [
    "container",
    "logs",
    "--follow",
    "--timestamps",
    ...(params.since ? ["--since", params.since] : ["--tail", "0"]),
    params.containerId,
  ];
  const child = await spawnDockerStreaming(args, { stdout: "piped" });
  const abort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  };
  if (params.signal.aborted) {
    abort();
  } else {
    params.signal.addEventListener("abort", abort, { once: true });
  }
  try {
    await Promise.all([
      child.status,
      pumpLines(child.stdout, (line) => params.onLine("stdout", line)),
      pumpLines(child.stderr, (line) => params.onLine("stderr", line)),
    ]);
  } finally {
    params.signal.removeEventListener("abort", abort);
  }
};

function createDefaultDiscovery(
  layout: { stateDir: string } | undefined,
): DiscoverContainersFn {
  if (!layout) {
    throw new TypeError(
      "container log collection needs a layout (or an injected discover)",
    );
  }
  return createDeploymentManifestDiscovery({ layout });
}

/**
 * Process-wide tail cursors — the newest line timestamp seen per container and
 * per environment.
 *
 * They deliberately outlive the collector. A collector is torn down whenever
 * the org toggle flips or the daemon rebinds its server id; a fresh one that
 * attached with `--tail 0` would silently discard everything the container
 * printed in between, which is exactly the outage this pipeline is supposed to
 * survive. The per-environment cursor covers the other half of the problem: a
 * container that was **recreated** has a brand-new id and therefore no cursor
 * of its own, but its replacement is tailed from where its environment left
 * off rather than from the moment discovery happened to notice it.
 *
 * `--since` is inclusive, so a resume can re-emit the line at exactly the
 * cursor timestamp. A duplicated line is a cosmetic problem; a lost one is not.
 */
const MAX_TRACKED_CONTAINER_CURSORS = 5_000;
const containerLogCursors = new Map<string, string>();
const environmentLogCursors = new Map<string, string>();

/** Insertion-ordered prune — the oldest key goes first once the cap is hit. */
function rememberCursor(
  store: Map<string, string>,
  key: string,
  timestamp: string,
): void {
  const existing = store.get(key);
  if (existing !== undefined && existing >= timestamp) return;
  store.delete(key);
  store.set(key, timestamp);
  while (store.size > MAX_TRACKED_CONTAINER_CURSORS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** Newest line timestamp seen for a container, across collector instances. */
export function containerLogCursor(containerId: string): string | undefined {
  return containerLogCursors.get(containerId);
}

/** Test-only: forget every retained cursor. */
export function resetContainerLogCursorsForTests(): void {
  containerLogCursors.clear();
  environmentLogCursors.clear();
}

type TailState = {
  target: ContainerLogTarget;
  controller: AbortController;
  /** Newest timestamp seen, so a re-attach resumes instead of replaying. */
  cursor: string | undefined;
  /** Set while a retry is pending so the discovery tick does not double-start. */
  retryAt: number;
};

/**
 * Per-host container log pipeline. Construct once; `start()` / `stop()` are
 * idempotent so the org-level enable flag can flip without a daemon restart.
 */
export class ContainerLogCollector {
  readonly #options: Required<
    Pick<
      ContainerLogCollectorOptions,
      | "serverId"
      | "send"
      | "flushIntervalMs"
      | "flushBytes"
      | "maxBufferedEvents"
      | "maxBatchSize"
      | "discoveryIntervalMs"
      | "tailRetryMs"
      | "now"
      | "readyToSend"
    >
  >;
  readonly #redactor: MutableTranscriptRedactor;
  readonly #discover: DiscoverContainersFn;
  readonly #tail: TailContainerFn;
  readonly #setInterval: typeof setInterval;
  readonly #clearInterval: typeof clearInterval;

  readonly #tails = new Map<string, TailState>();
  readonly #buffer: ContainerLogBatchEvent[] = [];
  #bufferBytes = 0;
  #lastFlushAt: number;
  #droppedEvents = 0;
  #sentEvents = 0;
  #failedBatches = 0;
  #lastDropWarnAt = 0;
  #running = false;
  #discoveryTimer: ReturnType<typeof setInterval> | undefined;
  #flushTimer: ReturnType<typeof setInterval> | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: ContainerLogCollectorOptions) {
    const now = options.now ?? Date.now;
    this.#options = {
      serverId: options.serverId,
      send: options.send,
      flushIntervalMs: options.flushIntervalMs ??
        CONTAINER_LOG_FLUSH_INTERVAL_MS,
      flushBytes: options.flushBytes ?? CONTAINER_LOG_FLUSH_BYTES,
      maxBufferedEvents: options.maxBufferedEvents ??
        MAX_BUFFERED_CONTAINER_LOG_EVENTS,
      maxBatchSize: options.maxBatchSize ?? MAX_CONTAINER_LOG_INGEST_BATCH,
      discoveryIntervalMs: options.discoveryIntervalMs ??
        CONTAINER_DISCOVERY_INTERVAL_MS,
      tailRetryMs: options.tailRetryMs ?? CONTAINER_TAIL_RETRY_MS,
      now,
      readyToSend: options.readyToSend ?? (() => true),
    };
    this.#redactor = options.redactor ?? sharedSecretRedactor();
    this.#discover = options.discover ?? createDefaultDiscovery(options.layout);
    this.#tail = options.tail ?? tailContainerWithDockerCli;
    this.#setInterval = options.setIntervalFn ?? setInterval;
    this.#clearInterval = options.clearIntervalFn ?? clearInterval;
    this.#lastFlushAt = now();
  }

  get running(): boolean {
    return this.#running;
  }

  /** Host this collector was built for — see {@link startContainerLogCollection}. */
  get serverId(): string {
    return this.#options.serverId;
  }

  stats(): ContainerLogCollectorStats {
    return {
      buffered: this.#buffer.length,
      droppedEvents: this.#droppedEvents,
      sentEvents: this.#sentEvents,
      failedBatches: this.#failedBatches,
      tailedContainers: this.#tails.size,
    };
  }

  /** Extend the deny-set with plaintext the daemon just decrypted. */
  addSecrets(values: readonly (string | null | undefined)[]): void {
    this.#redactor.add(values);
  }

  /** Idempotent. Runs one discovery pass immediately, then on a timer. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#discoveryTimer = this.#setInterval(() => {
      void this.reconcile();
    }, this.#options.discoveryIntervalMs);
    this.#flushTimer = this.#setInterval(() => {
      if (this.#flushDue()) this.#queueFlush();
    }, this.#options.flushIntervalMs);
    void this.reconcile();
  }

  /**
   * Idempotent. Aborts every tail and flushes whatever is buffered — a stop is
   * an operator turning the feature off, not a reason to lose the last batch.
   */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    if (this.#discoveryTimer !== undefined) {
      this.#clearInterval(this.#discoveryTimer);
      this.#discoveryTimer = undefined;
    }
    if (this.#flushTimer !== undefined) {
      this.#clearInterval(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    for (const state of this.#tails.values()) state.controller.abort();
    this.#tails.clear();
    this.#queueFlush();
    await this.#chain;
  }

  /**
   * One discovery pass: start a tail for every newly-seen container, abort the
   * tails of containers that are gone. Safe to call concurrently with itself.
   */
  async reconcile(): Promise<void> {
    if (!this.#running) return;
    let targets: ContainerLogTarget[];
    try {
      targets = await this.#discover();
    } catch (err) {
      logWarn(
        "container-logs",
        `container discovery failed: ${sanitizeForLog(err)}`,
      );
      return;
    }
    if (!this.#running) return;

    const seen = new Set<string>();
    for (const target of targets) {
      seen.add(target.containerId);
      const existing = this.#tails.get(target.containerId);
      if (existing) {
        // A redeploy that reuses the container id can move it to a different
        // service (or give it one it did not have).
        existing.target = target;
        continue;
      }
      this.#startTail(target, this.#resumeCursor(target));
    }
    for (const [containerId, state] of this.#tails) {
      if (seen.has(containerId)) continue;
      state.controller.abort();
      this.#tails.delete(containerId);
    }
  }

  /**
   * Where a newly-attached tail resumes from.
   *
   * The container's own cursor first (a tail that was torn down mid-stream),
   * then its environment's (a **recreated** container: new id, no cursor of
   * its own, but its predecessor's output tells us what has already been
   * shipped), and only then "now". Never `--tail 0` on a container we have
   * history for — that is the silent-loss case.
   */
  #resumeCursor(target: ContainerLogTarget): string {
    const own = containerLogCursors.get(target.containerId);
    if (own) return own;
    const environment = target.environmentId
      ? environmentLogCursors.get(target.environmentId)
      : undefined;
    if (environment) return environment;
    return new Date(this.#options.now()).toISOString();
  }

  #startTail(target: ContainerLogTarget, cursor: string | undefined): void {
    const controller = new AbortController();
    const state: TailState = { target, controller, cursor, retryAt: 0 };
    this.#tails.set(target.containerId, state);
    void this.#tail({
      containerId: target.containerId,
      since: cursor,
      onLine: (stream, line) => this.#onLine(state, stream, line),
      signal: controller.signal,
    })
      .catch((err) => {
        logWarn(
          "container-logs",
          `tail failed container=${sanitizeForLog(target.containerId)}: ${
            sanitizeForLog(err)
          }`,
        );
      })
      .finally(() => {
        this.#onTailEnded(state);
      });
  }

  /**
   * A tail that ends while the container is still running (docker restarted it,
   * the CLI was killed) is re-attached from the cursor after a short backoff.
   * A tail whose entry was already removed by `reconcile` is simply done.
   */
  #onTailEnded(state: TailState): void {
    const containerId = state.target.containerId;
    if (this.#tails.get(containerId) !== state) return;
    this.#tails.delete(containerId);
    if (!this.#running || state.controller.signal.aborted) return;
    setTimeout(() => {
      if (!this.#running || this.#tails.has(containerId)) return;
      // `state.cursor` is unset when this tail never produced a timestamped
      // line; fall back to the retained cursors rather than to `--tail 0`.
      this.#startTail(
        state.target,
        state.cursor ?? this.#resumeCursor(state.target),
      );
    }, this.#options.tailRetryMs);
  }

  #onLine(state: TailState, stream: ContainerLogStream, line: string): void {
    if (!this.#running) return;
    const split = splitDockerTimestampLine(line);
    if (split.timestamp) {
      state.cursor = split.timestamp;
      rememberCursor(
        containerLogCursors,
        state.target.containerId,
        split.timestamp,
      );
      if (state.target.environmentId) {
        rememberCursor(
          environmentLogCursors,
          state.target.environmentId,
          split.timestamp,
        );
      }
    }
    // Redact before the line is buffered — plaintext secrets never sit in the
    // batch waiting for an upload, exactly like the execution-log sink.
    const redacted = this.#redactor.redact(split.message);
    if (redacted.length === 0) return;
    const event: ContainerLogBatchEvent = {
      timestamp: split.timestamp ?? new Date(this.#options.now()).toISOString(),
      organizationId: "",
      serverId: this.#options.serverId,
      environmentId: state.target.environmentId,
      serviceId: state.target.serviceId,
      containerId: state.target.containerId,
      stream,
      message: truncateContainerLogMessage(redacted),
    };
    this.#push(event);
    if (this.#flushDue()) this.#queueFlush();
  }

  /** Append, dropping the oldest events once the ring buffer is full. */
  #push(event: ContainerLogBatchEvent): void {
    this.#buffer.push(event);
    this.#bufferBytes += event.message.length;
    const overflow = this.#buffer.length - this.#options.maxBufferedEvents;
    if (overflow <= 0) return;
    const dropped = this.#buffer.splice(0, overflow);
    for (const entry of dropped) this.#bufferBytes -= entry.message.length;
    this.#droppedEvents += dropped.length;
    this.#warnDropsRateLimited();
  }

  /** One summary line per {@link DROP_WARN_INTERVAL_MS} — never per line. */
  #warnDropsRateLimited(): void {
    const now = this.#options.now();
    if (now - this.#lastDropWarnAt < DROP_WARN_INTERVAL_MS) return;
    this.#lastDropWarnAt = now;
    logWarn(
      "container-logs",
      `dropped ${this.#droppedEvents} container log line(s) since start; ` +
        `buffer is at its ${this.#options.maxBufferedEvents}-event cap`,
    );
  }

  #flushDue(): boolean {
    if (this.#buffer.length === 0) return false;
    if (this.#buffer.length >= this.#options.maxBatchSize) return true;
    if (this.#bufferBytes >= this.#options.flushBytes) return true;
    return this.#options.now() - this.#lastFlushAt >=
      this.#options.flushIntervalMs;
  }

  #queueFlush(): void {
    this.#chain = this.#chain.then(() => this.flush());
  }

  /**
   * Ship every buffered batch. Never throws: a failed batch is counted and
   * dropped rather than retried forever against a control plane that is down —
   * the ring buffer is the only backpressure this pipeline has.
   */
  async flush(): Promise<void> {
    // No transport: keep the lines buffered rather than shipping them into a
    // guaranteed failure. The ring buffer still bounds memory, so a long
    // outage costs the oldest lines instead of every line.
    if (!this.#options.readyToSend()) return;
    for (;;) {
      const batch = this.#takeBatch();
      if (!batch) return;
      try {
        await this.#options.send(batch);
        this.#sentEvents += batch.length;
      } catch (err) {
        this.#failedBatches += 1;
        this.#droppedEvents += batch.length;
        logWarn(
          "container-logs",
          `container log batch dropped (${batch.length} lines): ${
            sanitizeForLog(err)
          }`,
        );
      }
    }
  }

  #takeBatch(): ContainerLogBatchEvent[] | null {
    if (this.#buffer.length === 0) return null;
    const batch = this.#buffer.splice(0, this.#options.maxBatchSize);
    for (const entry of batch) this.#bufferBytes -= entry.message.length;
    this.#lastFlushAt = this.#options.now();
    return batch;
  }
}

let activeCollector: ContainerLogCollector | undefined;

/** True while a collector is running in this process. */
export function isContainerLogCollectionEnabled(): boolean {
  return activeCollector?.running === true;
}

/** The running collector, if any (deny-set updates, tests). */
export function activeContainerLogCollector():
  | ContainerLogCollector
  | undefined {
  return activeCollector;
}

/**
 * Start collection for this host. Idempotent per server id: calling it again
 * with the same server while a collector runs is a no-op, so a repeated
 * `containerLogsEnabled: true` on every heartbeat costs nothing.
 *
 * A replacement collector inherits both process-wide pieces of state that make
 * a restart survivable: the deny-set (`sharedSecretRedactor`) and the tail
 * cursors, so it neither forgets old secrets nor re-attaches with `--tail 0`.
 */
export function startContainerLogCollection(
  options: ContainerLogCollectorOptions,
): ContainerLogCollector {
  const existing = activeCollector;
  if (existing?.running && existing.serverId === options.serverId) {
    return existing;
  }
  if (existing) void existing.stop();
  const collector = new ContainerLogCollector(options);
  activeCollector = collector;
  collector.start();
  return collector;
}

/** Stop collection. Idempotent; flushes what is buffered before resolving. */
export async function stopContainerLogCollection(): Promise<void> {
  const collector = activeCollector;
  activeCollector = undefined;
  if (!collector) return;
  await collector.stop();
}
