import { type BuildInfo, getBuildInfo } from "../build-info.ts";
import { type HostDockerMetadata, readDocker } from "../host/docker.ts";
import {
  getHostHelloIdentity,
  type HostHelloIdentity,
} from "../host/os-release.ts";
import { type HostTimeSync, readTimeSync } from "../host/time-sync.ts";
import { logInfo, logWarn, sanitizeForLog } from "../logger.ts";
import {
  collectServerIps,
  type ServerReportedIp,
} from "../server-addresses.ts";
import type { HostResources } from "../host/host-inventory.ts";

export const IDLE_PRESENCE_MS = 60_000;

/**
 * Hard lifetime cap for a single daemon↔instance WebSocket. Mirrors the
 * instance's `MAX_WS_CONNECTION_AGE_MS` (`src/daemon/cell/socket-health.ts`).
 * Post AE-driven sweep, this daemon-side recycle is the primary enforcer of
 * the hard lifetime cap (the instance only watchdogs AE-suspect servers).
 */
export const MAX_CONNECTION_AGE_MS = 2 * 60 * 60 * 1_000;

// Must match DAEMON_CELL_PING in instance/src/daemon/cell/protocol.ts exactly.
const CELL_PING_MESSAGE = '{"type":"ping"}';

export type IdlePresenceOptions = {
  serverId: string;
  /** Override for tests; defaults to {@link IDLE_PRESENCE_MS}. */
  idleCheckIntervalMs?: number;
  idleThresholdMs?: number;
  /** Minimum spacing between routine cell pings; defaults to {@link idleCheckIntervalMs}. */
  minPresenceIntervalMs?: number;
  /**
   * How long we tolerate sending cell pings with zero inbound traffic before
   * treating the socket as dead (see the "Zombie-connection note" on
   * {@link IdlePresence}). Defaults to 3x {@link idleThresholdMs}.
   */
  staleConnectionMs?: number;
  /**
   * Invoked at most once per `attach()` when {@link staleConnectionMs} elapses
   * with no inbound traffic despite outgoing pings. The owner is expected to
   * close/replace the socket so the reconnect loop can run.
   */
  onStaleConnection?: () => void;
  /** Override for tests; defaults to {@link MAX_CONNECTION_AGE_MS}. */
  maxConnectionAgeMs?: number;
  /**
   * Invoked at most once per `attach()` when the connection exceeds its max
   * lifetime. The owner is expected to close/replace the socket so the
   * reconnect loop can run.
   */
  onMaxAge?: () => void;
};

type PresenceSnapshot = {
  timeSync: HostTimeSync;
  ips: ServerReportedIp[];
  /** Present only when the Docker CLI is installed. */
  docker?: HostDockerMetadata;
};

type BuildInfoProvider = () => BuildInfo;
type HostHelloIdentityProvider = () => HostHelloIdentity;
type PresenceSnapshotProvider = () => PresenceSnapshot;

function defaultPresenceSnapshot(): PresenceSnapshot {
  const docker = readDocker();
  return {
    timeSync: readTimeSync(),
    ips: collectServerIps(),
    ...(docker ? { docker } : {}),
  };
}

let buildInfoProvider: BuildInfoProvider = getBuildInfo;
let hostHelloIdentityProvider: HostHelloIdentityProvider = getHostHelloIdentity;
let presenceSnapshotProvider: PresenceSnapshotProvider =
  defaultPresenceSnapshot;

/**
 * Test-only injection for hello/heartbeat presence inputs. Returns a restore
 * function. Default behavior is byte-identical to the live host providers.
 */
export function installIdlePresenceProviders(source: {
  getBuildInfo?: BuildInfoProvider;
  getHostHelloIdentity?: HostHelloIdentityProvider;
  collectPresenceSnapshot?: PresenceSnapshotProvider;
}): () => void {
  const previousBuildInfo = buildInfoProvider;
  const previousHost = hostHelloIdentityProvider;
  const previousPresence = presenceSnapshotProvider;
  if (source.getBuildInfo) buildInfoProvider = source.getBuildInfo;
  if (source.getHostHelloIdentity) {
    hostHelloIdentityProvider = source.getHostHelloIdentity;
  }
  if (source.collectPresenceSnapshot) {
    presenceSnapshotProvider = source.collectPresenceSnapshot;
  }
  return () => {
    buildInfoProvider = previousBuildInfo;
    hostHelloIdentityProvider = previousHost;
    presenceSnapshotProvider = previousPresence;
  };
}

/**
 * Tracks idle presence for one daemon<->instance WebSocket and detects
 * "zombie" connections.
 *
 * Zombie-connection note: a WebSocket can go half-open — the local socket
 * object still reports `OPEN` and `ws.send()` keeps "succeeding" (the OS just
 * buffers the write) even though the peer is long gone and nothing is coming
 * back. Historically this class only tracked "have we sent or received
 * *anything* recently", and `#sendCellPing` re-armed that same clock on every
 * successful *send* — so a one-way-dead socket could ping into the void
 * forever without ever being detected, leaving the daemon "connected" in its
 * own eyes while the instance had already reaped the session (see
 * `daemon-cell event=detach code=1006` / offline-sweep in the instance repo).
 * `#lastInboundAt` is the fix: it only advances on confirmed inbound traffic
 * (`noteInboundActivity()`, wired to `ws.onmessage`), so a stalled read is
 * detected independent of how many pings we've successfully sent.
 */
export class IdlePresence {
  readonly #idleCheckIntervalMs: number;
  readonly #idleThresholdMs: number;
  readonly #minPresenceIntervalMs: number;
  readonly #staleConnectionMs: number;
  readonly #onStaleConnection: (() => void) | undefined;
  readonly #maxConnectionAgeMs: number;
  readonly #onMaxAge: (() => void) | undefined;

  #ws: WebSocket | undefined;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #lastActivityAt = Date.now();
  #lastInboundAt = Date.now();
  #lastPresenceSendAt = 0;
  #lastDaemonBuildCommit: string | undefined;
  #lastPresenceSnapshot: string | undefined;
  #staleReported = false;
  #connectedAtMs = Date.now();
  #maxAgeReported = false;

  constructor(options: IdlePresenceOptions) {
    this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? IDLE_PRESENCE_MS;
    this.#idleThresholdMs = options.idleThresholdMs ?? IDLE_PRESENCE_MS;
    this.#minPresenceIntervalMs = options.minPresenceIntervalMs ??
      this.#idleCheckIntervalMs;
    this.#staleConnectionMs = options.staleConnectionMs ??
      this.#idleThresholdMs * 3;
    this.#onStaleConnection = options.onStaleConnection;
    this.#maxConnectionAgeMs = options.maxConnectionAgeMs ??
      MAX_CONNECTION_AGE_MS;
    this.#onMaxAge = options.onMaxAge;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  touchActivity(): void {
    this.#lastActivityAt = Date.now();
  }

  /** Call only for confirmed inbound WebSocket traffic — see class docs. */
  noteInboundActivity(): void {
    const now = Date.now();
    this.#lastActivityAt = now;
    this.#lastInboundAt = now;
    this.#staleReported = false;
  }

  attach(ws: WebSocket): void {
    this.detach();
    this.#ws = ws;
    this.#lastActivityAt = Date.now();
    this.#lastInboundAt = Date.now();
    this.#staleReported = false;
    this.#connectedAtMs = Date.now();
    this.#maxAgeReported = false;
    this.#sendHello();
    this.#idleTimer = setInterval(() => {
      if (this.#checkMaxConnectionAge()) return;
      this.#checkStaleConnection();
      this.#maybeSendPresence();
    }, this.#idleCheckIntervalMs);
  }

  detach(): void {
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    this.#ws = undefined;
  }

  /**
   * Returns true when the connection was recycled so the tick can stop early
   * (no cell ping on a socket that is about to close).
   */
  #checkMaxConnectionAge(): boolean {
    if (this.#maxAgeReported) return false;
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    const ageMs = Date.now() - this.#connectedAtMs;
    if (ageMs < this.#maxConnectionAgeMs) return false;
    this.#maxAgeReported = true;
    logInfo(
      "instance",
      "recycling connection older than",
      ageMs,
      "ms; forcing reconnect",
    );
    this.#onMaxAge?.();
    return true;
  }

  #checkStaleConnection(): void {
    if (this.#staleReported) return;
    const silentForMs = Date.now() - this.#lastInboundAt;
    if (silentForMs <= this.#staleConnectionMs) return;
    this.#staleReported = true;
    logWarn(
      "instance",
      "no inbound cell traffic for",
      silentForMs,
      "ms despite outgoing pings; forcing reconnect",
    );
    this.#onStaleConnection?.();
  }

  #collectPresenceSnapshot(): PresenceSnapshot {
    return presenceSnapshotProvider();
  }

  #serializePresenceSnapshot(snapshot: PresenceSnapshot): string {
    return JSON.stringify(snapshot);
  }

  #sendHello(): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const daemonBuild = buildInfoProvider();
    this.#lastDaemonBuildCommit = daemonBuild.commit;
    const host = hostHelloIdentityProvider();
    const presence = this.#collectPresenceSnapshot();
    this.#lastPresenceSnapshot = this.#serializePresenceSnapshot(presence);

    try {
      const resources: HostResources = {
        ...(host.resources ?? {}),
        ips: presence.ips,
      };
      ws.send(JSON.stringify({
        type: "hello",
        at: new Date().toISOString(),
        daemonBuild,
        ...(host.hostname ? { hostname: host.hostname } : {}),
        ...(host.machineKey ? { machineKey: host.machineKey } : {}),
        ...(host.os ? { os: host.os } : {}),
        resources,
        timeSync: presence.timeSync,
        ...(presence.docker ? { docker: presence.docker } : {}),
      }));
      this.#lastActivityAt = Date.now();
    } catch (err) {
      logWarn("instance", "hello send failed:", sanitizeForLog(err));
    }
  }

  /**
   * Steady-state presence on a fixed cadence, regardless of other traffic on
   * the connection:
   *
   * 1. The raw cell ping — always sent on this cadence. Keeps the instance's
   *    `getWebSocketAutoResponseTimestamp` warm (the offline-sweep cron's cheap
   *    liveness signal for a hibernating Durable Object; see
   *    `cell/offline-sweep.ts`). Answered by `setWebSocketAutoResponse` at
   *    the runtime level without waking the DO.
   * 2. The app-level heartbeat — sent when the daemon build commit changed
   *    since the last hello/heartbeat, **or** when `timeSync` / `resources.ips` /
   *    `docker` changed since the last presence snapshot (change-detected,
   *    cadence-bound).
   *
   * Offline self-heal (Postgres `connected: false` while the socket is still
   * live) is handled by the instance offline-sweep cron re-projecting online
   * via `onDaemonConnected` — not by a periodic heartbeat from the daemon.
   *
   * Only `minPresenceIntervalMs` spacing applies to the cell ping. The
   * heartbeat is not gated behind idle detection so a busy connection still
   * gets ping cadence; `#sendHello` seeds `#lastDaemonBuildCommit` and
   * `#lastPresenceSnapshot` on attach so the first post-attach tick sends
   * ping only unless presence fields changed.
   */
  #maybeSendPresence(): void {
    // When minPresenceIntervalMs equals the check interval (production default),
    // setInterval can fire a few ms early and the old `< min` guard skipped the
    // ping entirely — every-other-tick gaps then raced Redis coalesce past the
    // 150s offline sweep. Allow ~5s skew in that equal-interval case. When the
    // caller sets a *larger* min interval (tests / burst control), honor it fully.
    const skipBelowMs = this.#minPresenceIntervalMs > this.#idleCheckIntervalMs
      ? this.#minPresenceIntervalMs
      : Math.max(0, this.#minPresenceIntervalMs - 5_000);
    if (
      this.#lastPresenceSendAt > 0 &&
      Date.now() - this.#lastPresenceSendAt < skipBelowMs
    ) {
      return;
    }
    this.#sendCellPing();
    const daemonBuild = buildInfoProvider();
    const daemonBuildChanged =
      daemonBuild.commit !== this.#lastDaemonBuildCommit;

    const presence = this.#collectPresenceSnapshot();
    const serialized = this.#serializePresenceSnapshot(presence);
    const presenceChanged = serialized !== this.#lastPresenceSnapshot;

    if (daemonBuildChanged || presenceChanged) {
      this.#sendHeartbeat({
        daemonBuild: daemonBuildChanged ? daemonBuild : undefined,
        timeSync: presenceChanged ? presence.timeSync : undefined,
        resources: presenceChanged ? { ips: presence.ips } : undefined,
        docker: presenceChanged ? presence.docker : undefined,
      });
      if (presenceChanged) {
        this.#lastPresenceSnapshot = serialized;
      }
    }
  }

  #sendCellPing(): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      ws.send(CELL_PING_MESSAGE);
      const now = Date.now();
      this.#lastActivityAt = now;
      this.#lastPresenceSendAt = now;
    } catch (err) {
      logWarn("instance", "cell ping send failed:", sanitizeForLog(err));
    }
  }

  #sendHeartbeat(fields: {
    daemonBuild?: BuildInfo;
    timeSync?: HostTimeSync;
    resources?: HostResources;
    docker?: HostDockerMetadata;
  }): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const payload: {
      type: "heartbeat";
      at: string;
      daemonBuild?: BuildInfo;
      timeSync?: HostTimeSync;
      resources?: HostResources;
      docker?: HostDockerMetadata;
    } = {
      type: "heartbeat",
      at: new Date().toISOString(),
    };
    if (fields.daemonBuild) {
      payload.daemonBuild = fields.daemonBuild;
      this.#lastDaemonBuildCommit = fields.daemonBuild.commit;
    }
    if (fields.timeSync) payload.timeSync = fields.timeSync;
    if (fields.resources) payload.resources = fields.resources;
    if (fields.docker) payload.docker = fields.docker;

    try {
      ws.send(JSON.stringify(payload));
      this.#lastActivityAt = Date.now();
    } catch (err) {
      logWarn("instance", "heartbeat send failed:", sanitizeForLog(err));
    }
  }
}
