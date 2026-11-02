import { type BuildInfo, getBuildInfo } from "../build-info.ts";
import { DAEMON_VERSION } from "../version.ts";
import {
  resolveUpdateChannelConfig,
  type UpdateChannelConfig,
} from "../update/config.ts";
import { type HostDockerMetadata, readDocker } from "../host/docker.ts";
import {
  type HostRuntimeMetadata,
  readHostRuntimes,
} from "../host/runtimes.ts";
import {
  getHostHelloIdentity,
  type HostHelloIdentity,
} from "../host/os-release.ts";
import { type HostTimeSync, readTimeSync } from "../host/time-sync.ts";
import {
  readReleaseLinkScanReport,
  type ReleaseLinkScanReport,
} from "../deploy/release/live-release-scan.ts";
import { resolveLayout } from "../paths/layout.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  COMMAND_RECOVERY_FEATURE,
  DAEMON_WIRE_FEATURES,
} from "./version-wire.ts";
import type { CommandRecoveryReport } from "../contracts/cell-messages.ts";
import {
  panelPinReport,
  readPanelIdentityPinSync,
} from "./panel-identity-pin.ts";
import {
  collectServerIps,
  readDefaultRouteInterfaces,
  readHostInterfaceLinkStates,
  type ServerReportedIp,
} from "../host/server-addresses.ts";
import {
  HOST_CAPACITY_TOLERANCE_BYTES,
  type HostResources,
  readHostResources,
} from "../host/host-inventory.ts";
import {
  readServiceRunStates,
  type ServiceRunState,
} from "../host/service-run-state.ts";

export const IDLE_PRESENCE_MS = 60_000;

/** Bounds for a control-plane advised heartbeat (the `version` frame is unsigned). */
export const HEARTBEAT_MIN_S = 15;
export const HEARTBEAT_MAX_S = 120;

/**
 * Validates an advised heartbeat in seconds. Returns whole seconds, or null
 * when the value is not a finite number inside [HEARTBEAT_MIN_S, HEARTBEAT_MAX_S].
 */
export function clampHeartbeatSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const seconds = Math.round(value);
  if (seconds < HEARTBEAT_MIN_S || seconds > HEARTBEAT_MAX_S) return null;
  return seconds;
}

/**
 * Heartbeat to apply in ms for an advised value, or null to keep the default.
 * A verified signed hello wins, so the unsigned advice is ignored once
 * `pinnedHelloApplied` is true.
 */
export function advisedHeartbeatMs(
  advised: unknown,
  pinnedHelloApplied: boolean,
): number | null {
  if (pinnedHelloApplied) return null;
  const seconds = clampHeartbeatSeconds(advised);
  return seconds === null ? null : seconds * 1000;
}

/**
 * Floor cadence for the app-level `heartbeat`, independent of change detection.
 *
 * Heartbeats are otherwise only sent when a presence fact moved. On an idle
 * connection nothing changes for hours, so without this floor the daemon would
 * never re-publish host facts (timeSync, addresses, Docker, runtimes) until
 * something happened to move. Five minutes is cheap: one extra presence frame
 * per daemon, and it still refreshes those facts on an otherwise-silent
 * connection. The raw cell ping cannot carry them: on the Workers transport it
 * is answered by `setWebSocketAutoResponse` without ever waking the cell.
 */
export const PRESENCE_REFRESH_MS = 5 * 60_000;

/**
 * Hard lifetime cap for a single daemon↔instance WebSocket. Mirrors the
 * instance's `MAX_WS_CONNECTION_AGE_MS` (`src/daemon/cell/socket-health.ts`).
 * Post AE-driven sweep, this daemon-side recycle is the primary enforcer of
 * the hard lifetime cap (the instance only watchdogs AE-suspect servers).
 */
export const MAX_CONNECTION_AGE_MS = 2 * 60 * 60 * 1_000;

/** Default forced-recycle age is spread by +-10% so a fleet that connected together does not recycle together. */
export const MAX_CONNECTION_AGE_JITTER = 0.1;

/** Per-connection recycle age: `baseMs` spread uniformly by +-`MAX_CONNECTION_AGE_JITTER`. */
export function jitteredMaxConnectionAgeMs(
  baseMs: number,
  random: () => number = Math.random,
): number {
  const spread = (random() * 2 - 1) * MAX_CONNECTION_AGE_JITTER;
  return Math.round(baseMs * (1 + spread));
}

// Must match DAEMON_CELL_PING in instance/src/daemon/cell/protocol.ts exactly.
const CELL_PING_MESSAGE = '{"type":"ping"}';

export type IdlePresenceOptions = {
  serverId: string;
  /** Override for tests; defaults to {@link IDLE_PRESENCE_MS}. */
  idleCheckIntervalMs?: number;
  /**
   * Floor cadence for the app-level heartbeat even with nothing to report;
   * defaults to {@link PRESENCE_REFRESH_MS}. See that constant for why an idle
   * connection still refreshes presence facts.
   */
  presenceRefreshIntervalMs?: number;
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
  /**
   * True when the control plane lists `host-capacity-v1`. Only then does a
   * heartbeat carry `resources.{memory,swap,cpus}` after they move; an older
   * control plane keeps the hello figures. Defaults to never.
   */
  hostCapacityFlag?: () => boolean;
  /**
   * Running and unconfirmed command ids (`command-recovery-v1`). Added to
   * `hello` whenever not empty (the control plane's feature list is not known
   * yet at that point; an older one ignores the field) and to `heartbeat` only
   * once {@link peerSupports} says the control plane advertises the feature.
   */
  commandReport?: () => CommandRecoveryReport | undefined;
  peerSupports?: (feature: string) => boolean;
};

/** The part of host resources a heartbeat re-sends when it moves. */
export type HostCapacitySnapshot = Pick<
  HostResources,
  "memory" | "swap" | "cpus" | "dynamicMemory"
>;

/** Capacity fields of `resources`, or `undefined` when it has none. */
export function hostCapacityFromResources(
  resources: HostResources | undefined,
): HostCapacitySnapshot | undefined {
  if (!resources) return undefined;
  const capacity: HostCapacitySnapshot = {};
  if (resources.memory) capacity.memory = resources.memory;
  if (resources.swap) capacity.swap = resources.swap;
  if (resources.cpus) capacity.cpus = resources.cpus;
  if (resources.dynamicMemory) capacity.dynamicMemory = resources.dynamicMemory;
  return Object.keys(capacity).length > 0 ? capacity : undefined;
}

function movedBeyondTolerance(
  previous: number | undefined,
  next: number | undefined,
): boolean {
  if (previous === undefined || next === undefined) return previous !== next;
  return Math.abs(next - previous) > HOST_CAPACITY_TOLERANCE_BYTES;
}

/**
 * True when `next` is worth a heartbeat against what was last sent: MemTotal
 * or present memory moved by more than 32 MiB, the CPU list changed (it is
 * only re-read when the online CPU set changes), or the dynamic-memory flag
 * appeared or went away. An unreadable `next` never sends.
 */
export function hostCapacityMoved(
  previous: HostCapacitySnapshot | undefined,
  next: HostCapacitySnapshot | undefined,
): boolean {
  if (!next) return false;
  if (!previous) return true;
  return movedBeyondTolerance(
    previous.memory?.totalBytes,
    next.memory?.totalBytes,
  ) ||
    movedBeyondTolerance(
      previous.memory?.presentBytes,
      next.memory?.presentBytes,
    ) ||
    JSON.stringify(previous.cpus) !== JSON.stringify(next.cpus) ||
    Boolean(previous.dynamicMemory) !== Boolean(next.dynamicMemory);
}

type PresenceSnapshot = {
  timeSync: HostTimeSync;
  ips: ServerReportedIp[];
  /** Present only when the Docker CLI is installed. */
  docker?: HostDockerMetadata;
  /**
   * Runtimes installed on this host (PHP series, tenant Node, lsphp).
   *
   * Rides the existing change-detection rather than a new command: the control
   * plane needs this to validate a requested PHP series *before* queueing a
   * deploy, and presence is already the channel that answers "what is true
   * about this host right now".
   */
  runtimes?: HostRuntimeMetadata;
  /**
   * Per-service run state (running / restart count / last error), present only
   * while the sentinel watches Docker. An empty list is meaningful: it tells the
   * control plane every service on this host is gone.
   */
  services?: ServiceRunState[];
  /**
   * Summary of the boot-time check of live releases for links that leave the
   * release (`release-link-scan.json`). The scan runs in the background after
   * the daemon is up, so it usually lands after the first hello and arrives on
   * a later heartbeat through the same change detection.
   */
  releaseLinkScan?: ReleaseLinkScanReport;
};

type BuildInfoProvider = () => BuildInfo;
type UpdateChannelConfigProvider = () => UpdateChannelConfig;
type HostHelloIdentityProvider = () => HostHelloIdentity;
type PresenceSnapshotProvider = () => PresenceSnapshot;
type HostResourcesProvider = () => HostResources | undefined;

/** `daemonBuild` on the wire: BuildInfo plus the live-resolved channel —
 * channel is a placement fact, never baked into BuildInfo itself — and the
 * daemon's semver (src/version.ts), which the control plane holds against
 * its supported range. */
type DaemonBuildWire = BuildInfo & { channel: string; version: string };

/** Presence never fails on this: no env or file access just means no report. */
function readLinkScanForPresence(): ReleaseLinkScanReport | undefined {
  try {
    return readReleaseLinkScanReport(resolveLayout(Deno.env.toObject()));
  } catch {
    return undefined;
  }
}

/** The hello's `panelPin` (how this server pinned the panel key), when it has a pin. */
function panelPinField(): { panelPin?: ReturnType<typeof panelPinReport> } {
  const panelPin = panelPinReport(readPanelIdentityPinSync());
  return panelPin ? { panelPin } : {};
}

function defaultPresenceSnapshot(): PresenceSnapshot {
  const docker = readDocker();
  const runtimes = readHostRuntimes();
  const services = readServiceRunStates();
  const releaseLinkScan = readLinkScanForPresence();
  return {
    timeSync: readTimeSync(),
    ips: collectServerIps(
      readDefaultRouteInterfaces(),
      readHostInterfaceLinkStates(),
    ),
    ...(docker ? { docker } : {}),
    ...(runtimes ? { runtimes } : {}),
    ...(services ? { services } : {}),
    ...(releaseLinkScan ? { releaseLinkScan } : {}),
  };
}

// resolveUpdateChannelConfig() reads Deno.env — its own doc says invalid
// values "crash at startup", i.e. it's meant to be resolved once, not
// per-message. hello/heartbeat fire far more often than the channel can
// possibly change (only a process restart changes it), so the default path
// memoizes the first resolution; an injected test provider bypasses the
// cache entirely and is called fresh every time, as before.
let cachedUpdateChannelConfig: UpdateChannelConfig | undefined;
function defaultUpdateChannelConfig(): UpdateChannelConfig {
  cachedUpdateChannelConfig ??= resolveUpdateChannelConfig();
  return cachedUpdateChannelConfig;
}

let buildInfoProvider: BuildInfoProvider = getBuildInfo;
let updateChannelConfigProvider: UpdateChannelConfigProvider =
  defaultUpdateChannelConfig;
let hostHelloIdentityProvider: HostHelloIdentityProvider = getHostHelloIdentity;
let presenceSnapshotProvider: PresenceSnapshotProvider =
  defaultPresenceSnapshot;
let hostResourcesProvider: HostResourcesProvider = () => readHostResources();

function currentDaemonBuild(): DaemonBuildWire {
  return {
    ...buildInfoProvider(),
    channel: updateChannelConfigProvider().channel,
    version: DAEMON_VERSION,
  };
}

/**
 * Test-only injection for hello/heartbeat presence inputs. Returns a restore
 * function. Default behavior is byte-identical to the live host providers.
 */
export function installIdlePresenceProviders(source: {
  getBuildInfo?: BuildInfoProvider;
  resolveUpdateChannelConfig?: UpdateChannelConfigProvider;
  getHostHelloIdentity?: HostHelloIdentityProvider;
  collectPresenceSnapshot?: PresenceSnapshotProvider;
  readHostResources?: HostResourcesProvider;
}): () => void {
  const previousBuildInfo = buildInfoProvider;
  const previousChannel = updateChannelConfigProvider;
  const previousHost = hostHelloIdentityProvider;
  const previousPresence = presenceSnapshotProvider;
  const previousResources = hostResourcesProvider;
  if (source.getBuildInfo) buildInfoProvider = source.getBuildInfo;
  if (source.resolveUpdateChannelConfig) {
    updateChannelConfigProvider = source.resolveUpdateChannelConfig;
  }
  if (source.getHostHelloIdentity) {
    hostHelloIdentityProvider = source.getHostHelloIdentity;
  }
  if (source.collectPresenceSnapshot) {
    presenceSnapshotProvider = source.collectPresenceSnapshot;
  }
  if (source.readHostResources) {
    hostResourcesProvider = source.readHostResources;
  }
  return () => {
    buildInfoProvider = previousBuildInfo;
    updateChannelConfigProvider = previousChannel;
    hostHelloIdentityProvider = previousHost;
    presenceSnapshotProvider = previousPresence;
    hostResourcesProvider = previousResources;
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
  #idleCheckIntervalMs: number;
  #idleThresholdMs: number;
  #minPresenceIntervalMs: number;
  readonly #presenceRefreshIntervalMs: number;
  #staleConnectionMs: number;
  readonly #onStaleConnection: (() => void) | undefined;
  readonly #baseMaxConnectionAgeMs: number;
  readonly #jitterMaxAge: boolean;
  #maxConnectionAgeMs: number;
  readonly #onMaxAge: (() => void) | undefined;
  readonly #hostCapacityFlag: (() => boolean) | undefined;
  readonly #commandReport: IdlePresenceOptions["commandReport"];
  readonly #peerSupports: IdlePresenceOptions["peerSupports"];

  #ws: WebSocket | undefined;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #lastActivityAt = Date.now();
  #lastInboundAt = Date.now();
  #lastPresenceSendAt = 0;
  /** Last app-level presence frame (`hello` or `heartbeat`) sent on this socket. */
  #lastPresenceFrameAt = 0;
  #lastDaemonBuildCommit: string | undefined;
  #lastPresenceSnapshot: string | undefined;
  /** Capacity figures in the last hello or heartbeat that carried them. */
  #lastCapacity: HostCapacitySnapshot | undefined;
  #staleReported = false;
  #connectedAtMs = Date.now();
  #maxAgeReported = false;

  constructor(options: IdlePresenceOptions) {
    this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? IDLE_PRESENCE_MS;
    this.#idleThresholdMs = options.idleThresholdMs ?? IDLE_PRESENCE_MS;
    this.#minPresenceIntervalMs = options.minPresenceIntervalMs ??
      this.#idleCheckIntervalMs;
    this.#presenceRefreshIntervalMs = options.presenceRefreshIntervalMs ??
      PRESENCE_REFRESH_MS;
    this.#staleConnectionMs = options.staleConnectionMs ??
      this.#idleThresholdMs * 3;
    this.#onStaleConnection = options.onStaleConnection;
    this.#baseMaxConnectionAgeMs = options.maxConnectionAgeMs ??
      MAX_CONNECTION_AGE_MS;
    // Only the production default is jittered; explicit overrides stay exact.
    this.#jitterMaxAge = options.maxConnectionAgeMs === undefined;
    this.#maxConnectionAgeMs = this.#baseMaxConnectionAgeMs;
    this.#onMaxAge = options.onMaxAge;
    this.#hostCapacityFlag = options.hostCapacityFlag;
    this.#commandReport = options.commandReport;
    this.#peerSupports = options.peerSupports;
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
    this.#maxConnectionAgeMs = this.#jitterMaxAge
      ? jitteredMaxConnectionAgeMs(this.#baseMaxConnectionAgeMs)
      : this.#baseMaxConnectionAgeMs;
    this.#maxAgeReported = false;
    this.#lastPresenceFrameAt = 0;
    this.#sendHello();
    this.#armIdleTimer();
  }

  #armIdleTimer(): void {
    this.#idleTimer = setInterval(() => {
      if (this.#checkMaxConnectionAge()) return;
      this.#checkStaleConnection();
      this.#maybeSendPresence();
    }, this.#idleCheckIntervalMs);
  }

  /**
   * Applies an advised heartbeat: the ping cadence, its spacing and the
   * stale-socket threshold (3x) all follow `ms`. The timer is re-armed when
   * the socket is already attached, which is the normal order because the
   * control plane's `version` frame arrives after `attach()`.
   */
  setIdleThresholdMs(ms: number): void {
    this.#idleCheckIntervalMs = ms;
    this.#idleThresholdMs = ms;
    this.#minPresenceIntervalMs = ms;
    this.#staleConnectionMs = ms * 3;
    if (this.#idleTimer === undefined) return;
    clearInterval(this.#idleTimer);
    this.#armIdleTimer();
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

  /** `{ commands }` when there is something to report (and, for a heartbeat, the peer supports it). */
  #commandsField(
    needsPeer: boolean,
  ): { commands?: CommandRecoveryReport } {
    if (needsPeer && this.#peerSupports?.(COMMAND_RECOVERY_FEATURE) !== true) {
      return {};
    }
    const commands = this.#commandReport?.();
    return commands ? { commands } : {};
  }

  #sendHello(): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const daemonBuild = currentDaemonBuild();
    this.#lastDaemonBuildCommit = daemonBuild.commit;
    const host = hostHelloIdentityProvider();
    const presence = this.#collectPresenceSnapshot();
    this.#lastPresenceSnapshot = this.#serializePresenceSnapshot(presence);
    this.#lastCapacity = hostCapacityFromResources(host.resources);

    try {
      const resources: HostResources = host.resources
        ? { ...host.resources, ips: presence.ips }
        : { ips: presence.ips };
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
        ...(presence.runtimes ? { runtimes: presence.runtimes } : {}),
        ...(presence.services ? { services: presence.services } : {}),
        ...(presence.releaseLinkScan
          ? { releaseLinkScan: presence.releaseLinkScan }
          : {}),
        features: [...DAEMON_WIRE_FEATURES],
        ...panelPinField(),
        ...this.#commandsField(false),
      }));
      this.#lastActivityAt = Date.now();
      this.#lastPresenceFrameAt = this.#lastActivityAt;
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
   *    `docker` / `releaseLinkScan` changed since the last presence snapshot (change-detected,
   *    cadence-bound), **or** — only when the control plane lists
   *    `host-capacity-v1` — when memory or the online CPU set moved (see
   *    {@link hostCapacityMoved}), **or** when no presence frame has gone out for
   *    {@link PRESENCE_REFRESH_MS}. That last case is the cheap floor that
   *    still refreshes presence facts on a connection where nothing else
   *    ever changes — see {@link PRESENCE_REFRESH_MS}.
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
  /**
   * When minPresenceIntervalMs equals the check interval (production default),
   * setInterval can fire a few ms early and the old `< min` guard skipped the
   * ping entirely — every-other-tick gaps then raced Redis coalesce past the
   * 150s offline sweep. Allow ~5s skew in that equal-interval case. When the
   * caller sets a *larger* min interval (tests / burst control), honor it fully.
   */
  #presencePingDue(): boolean {
    if (this.#lastPresenceSendAt <= 0) return true;
    const skipBelowMs = this.#minPresenceIntervalMs > this.#idleCheckIntervalMs
      ? this.#minPresenceIntervalMs
      : Math.max(0, this.#minPresenceIntervalMs - 5_000);
    return Date.now() - this.#lastPresenceSendAt >= skipBelowMs;
  }

  /** `undefined` for any part means "this one did not move; omit it". */
  #sendPresenceHeartbeat(
    daemonBuild: BuildInfo | undefined,
    presence: PresenceSnapshot | undefined,
    capacity: HostCapacitySnapshot | undefined,
  ): void {
    const resources: HostResources | undefined = presence || capacity
      ? { ...(presence ? { ips: presence.ips } : {}), ...capacity }
      : undefined;
    this.#sendHeartbeat({
      daemonBuild,
      timeSync: presence?.timeSync,
      resources,
      docker: presence?.docker,
      runtimes: presence?.runtimes,
      services: presence?.services,
      releaseLinkScan: presence?.releaseLinkScan,
    });
  }

  /** Moved capacity to re-send, or `undefined` (also for an older control plane). */
  #capacityToSend(): HostCapacitySnapshot | undefined {
    if (!this.#hostCapacityFlag?.()) return undefined;
    const next = hostCapacityFromResources(hostResourcesProvider());
    if (!hostCapacityMoved(this.#lastCapacity, next)) return undefined;
    this.#lastCapacity = next;
    return next;
  }

  #maybeSendPresence(): void {
    if (!this.#presencePingDue()) return;
    this.#sendCellPing();
    const daemonBuild = currentDaemonBuild();
    const daemonBuildChanged =
      daemonBuild.commit !== this.#lastDaemonBuildCommit;

    const presence = this.#collectPresenceSnapshot();
    const serialized = this.#serializePresenceSnapshot(presence);
    const presenceChanged = serialized !== this.#lastPresenceSnapshot;
    const capacity = this.#capacityToSend();

    // Nothing moved *and* the connection is inside its refresh window: stay
    // silent. Otherwise send, so an idle daemon still refreshes presence
    // facts on the cheap floor.
    const refreshDue = this.#lastPresenceFrameAt === 0 ||
      Date.now() - this.#lastPresenceFrameAt >= this.#presenceRefreshIntervalMs;

    if (daemonBuildChanged || presenceChanged || capacity || refreshDue) {
      this.#sendPresenceHeartbeat(
        daemonBuildChanged ? daemonBuild : undefined,
        presenceChanged ? presence : undefined,
        capacity,
      );
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
    runtimes?: HostRuntimeMetadata;
    services?: ServiceRunState[];
    releaseLinkScan?: ReleaseLinkScanReport;
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
      runtimes?: HostRuntimeMetadata;
      services?: ServiceRunState[];
      releaseLinkScan?: ReleaseLinkScanReport;
      commands?: CommandRecoveryReport;
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
    if (fields.runtimes) payload.runtimes = fields.runtimes;
    if (fields.services) payload.services = fields.services;
    if (fields.releaseLinkScan) {
      payload.releaseLinkScan = fields.releaseLinkScan;
    }

    Object.assign(payload, this.#commandsField(true));

    try {
      ws.send(JSON.stringify(payload));
      this.#lastActivityAt = Date.now();
      this.#lastPresenceFrameAt = this.#lastActivityAt;
    } catch (err) {
      logWarn("instance", "heartbeat send failed:", sanitizeForLog(err));
    }
  }
}
