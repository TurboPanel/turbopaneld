import { restartDaemonService } from "./restart-daemon-service.ts";
import {
  type CommandRouterDeps,
  handleCommandDispatch,
} from "./commands/command-router.ts";
import {
  createInstanceHttpClient,
  describeInstance,
  fingerprintPemCertificate,
  type InstanceConfig,
  instanceUrl,
  instanceWebSocketUrl,
  normalizeCaFingerprint,
  resolveInstanceCaPath,
  resolveInstanceConfig,
  resolveServerIdentityDir,
} from "./paths.ts";
import {
  collectServerIps,
  readDefaultRouteInterfaces,
  type ServerReportedIp,
} from "../server-addresses.ts";
import {
  readRemoteFiles,
  resolveDefaultBranch,
} from "../deploy/release/read-remote-files.ts";
import { collectManagedLogs } from "../managed/logs.ts";
import { collectContainerLogs } from "../logs/container-tail.ts";
import { handleFabricPathProbe } from "./commands/fabric.ts";
import {
  type DevSyncState,
  MANAGED_DEV_SYNC_REFUSED_REASON,
  newDevSyncState,
  resolveDevSyncSourceRoot,
} from "../dev-sync-resolve.ts";
import {
  type DevSyncApplyFn,
  getCheckoutDevSyncApply,
} from "./dev-sync-runtime.ts";
import { applyPublicUrls } from "./public-urls-apply.ts";
import { writeInstanceTunnelToken } from "../tunnels.ts";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  sanitizeForLog,
} from "../logger.ts";
import { type DaemonKeyFile, loadDaemonKeyFile } from "../crypto/keys.ts";
import { readMachineKey } from "../host/machine-key.ts";
import { DaemonApiClient, DaemonApiError } from "./api-client.ts";
import {
  parseRehydrateDeploymentResults,
  rehydrateLocalDeployments,
} from "../deploy/rehydrate-deployments.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { sweepOrphanCommandLogs } from "../logs/orphan-sweep.ts";
import { classifyConnectFailure } from "./connect-failure.ts";
import { DaemonJwksClient } from "./jwks-client.ts";
import { DaemonTokenManager } from "./token-manager.ts";
import { enrollDaemon } from "./enroll.ts";
import { decodeBase64 } from "@std/encoding/base64";
import { getBuildInfo } from "../build-info.ts";
import { IdlePresence } from "./idle-presence.ts";
import type { MetricsCollector } from "../metrics/collector/index.ts";
import {
  collectMetricsCapabilities,
  type MetricsCapabilities,
} from "../metrics/capabilities.ts";
import type { MetricsScheduler } from "../metrics/scheduler.ts";
import { rebindMetricsScheduler } from "../metrics/scheduler.ts";
import { LiveLeaseManager } from "../metrics/live-leases.ts";
import {
  resolveHardwareProfile,
  writeHardwareProfile,
} from "../metrics/collector/sensors/overrides.ts";
import { handleDrivetempEnable } from "./commands/drivetemp.ts";
import type { DrivetempEnableResult } from "./commands/contracts.ts";
import type { HardwareProfile } from "../metrics/collector/types.ts";
import { resolveUpdateChannelConfig } from "../update/config.ts";
import { resolveUpdate } from "../update/resolver.ts";
import {
  buildRunReconcileArgs,
  downloadRunScript,
  encodeLicenseArg,
  executeRunReconcile,
  isPlaintextHttpUrl,
  resolveBootstrapInsecureTls,
  resolveRunScriptUrl,
} from "./run-reconcile.ts";
import { installOriginNeedsInsecureTls } from "./install-tls.ts";
import { ManagedHaObserver } from "./ha-observe.ts";

type DaemonMessage =
  | { type: "echo"; payload: unknown; at: string }
  | { type: "version"; commit: string; branch: string; at: string }
  | { type: "addresses-request"; id: string; at: string }
  | {
    type: "addresses-result";
    id: string;
    ips: ServerReportedIp[];
    at: string;
  }
  | {
    type: "managed-logs-request";
    id: string;
    managedId: string;
    tail: number;
    at: string;
  }
  | {
    type: "container-logs-request";
    id: string;
    containerId: string;
    tail: number;
    at: string;
  }
  | {
    type: "repo-read-request";
    id: string;
    cloneUrl: string;
    ref: string;
    paths: string[];
    listPath?: string;
    maxBytesPerFile: number;
    credential?: string;
    credentialKind?: string;
    credentialUsername?: string;
    at: string;
  }
  | {
    type: "repo-read-result";
    id: string;
    ok: boolean;
    commitSha?: string;
    files?: {
      path: string;
      found: boolean;
      content?: string;
      bytes?: number;
      reason?: string;
    }[];
    entries?: { path: string; kind: string }[];
    error?: string;
    at: string;
  }
  | {
    type: "repo-default-branch-request";
    id: string;
    /** Anonymous only — the control plane never sends a credential here. */
    cloneUrl: string;
    at: string;
  }
  | {
    type: "repo-default-branch-result";
    id: string;
    ok: boolean;
    /** `null` when the remote answered but named no branch (an empty repo). */
    defaultBranch?: string | null;
    error?: string;
    at: string;
  }
  | {
    type: "managed-logs-result";
    id: string;
    logs: string;
    error?: string;
    at: string;
  }
  | { type: "metrics-capabilities-request"; id: string; at: string }
  | {
    type: "metrics-capabilities-result";
    id: string;
    capabilities?: MetricsCapabilities;
    error?: string;
    at: string;
  }
  | {
    type: "metrics-live-start";
    id: string;
    leaseId: string;
    /** Advisory from the control plane; the daemon applies its own live cadence. */
    intervalSeconds: number;
    expiresAt: string;
    at: string;
  }
  | {
    type: "metrics-live-start-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "metrics-live-stop"; id: string; leaseId: string; at: string }
  | {
    type: "metrics-live-stop-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "metrics-sensor-overrides-update";
    id: string;
    /** Full replacement — absent fields clear their setting. */
    overrides: HardwareProfile;
    at: string;
  }
  | {
    type: "metrics-sensor-overrides-update-result";
    id: string;
    ok: boolean;
    error?: string;
    /**
     * Present when this push flipped `drivetempEnabled` false/unset → true —
     * the module-load outcome plus sensor capabilities re-discovered right
     * after, awaited before this result is sent (never a bare fire-and-forget
     * ack). Absent when the flip edge didn't occur, or if the drivetemp
     * command itself failed unexpectedly (logged; `ok` above still reflects
     * whether the profile write succeeded).
     */
    drivetemp?: DrivetempEnableResult;
    at: string;
  }
  | {
    type: "container-logs-result";
    id: string;
    logs: string;
    error?: string;
    at: string;
  }
  | {
    type: "managed-ha-event";
    managedId: string;
    sourceMemberId?: string;
    at: string;
  }
  | {
    type: "fabric-paths-request";
    id: string;
    fabricId: string;
    probeMs: number;
    candidates: Array<{ publicKey: string; endpoints: string[] }>;
    at: string;
  }
  | {
    type: "fabric-paths-result";
    id: string;
    paths: Array<{
      publicKey: string;
      endpoint?: string;
      lastHandshakeAt?: string;
      health: "healthy" | "stale" | "never";
      latencyMs?: number;
    }>;
    error?: string;
    at: string;
  }
  | {
    type: "dev-sync-begin";
    id: string;
    totalChunks: number;
    totalBytes: number;
    at: string;
  }
  | {
    type: "dev-sync-chunk";
    id: string;
    index: number;
    data: string;
    at: string;
  }
  | { type: "dev-sync-end"; id: string; at: string }
  | {
    type: "dev-sync-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "tunnel-token"; id: string; token: string; at: string }
  | {
    type: "tunnel-token-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "public-urls-update"; id: string; urls: string[]; at: string }
  | {
    type: "public-urls-update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "update";
    id: string;
    channel?: string;
    updateUrl?: string;
    updateSha256?: string;
    at: string;
  }
  | {
    type: "update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "command-dispatch";
    id: string;
    commandId: string;
    commandType: string;
    payload: unknown;
    at: string;
  }
  | {
    type: "command-ack";
    id: string;
    at: string;
    daemonReceivedAt: string;
  }
  | {
    type: "command-outcome";
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    at: string;
    daemonReceivedAt?: string;
    daemonRespondedAt?: string;
  };

export interface InstanceClientOptions {
  config?: InstanceConfig;
  httpClient?: Deno.HttpClient;
  /** Initial reconnect delay; clamped to [DEFAULT_INITIAL_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS]. */
  reconnectDelayMs?: number;
  onMessage?: (message: DaemonMessage) => void;
  /** When set, enables host metrics on the daemon WebSocket. */
  metricsCollectorFactory?: () => MetricsCollector;
  /**
   * Checkout-sync unpack implementation. Production compile never supplies this;
   * source `main.ts` registers it via `enableCheckoutDevSync`.
   */
  applyDevSyncTarball?: DevSyncApplyFn;
}

export const DEFAULT_INITIAL_BACKOFF_MS = 2_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
export const PARKED_BACKOFF_MIN_MS = 5 * 60_000;
export const PARKED_BACKOFF_MAX_MS = 60 * 60_000;
const BACKOFF_MULTIPLIER = 2;

/** Clamp caller-provided reconnect delay to supported [min, max] bounds. */
export function normalizeReconnectDelayMs(reconnectDelayMs?: number): number {
  const value = reconnectDelayMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_INITIAL_BACKOFF_MS;
  }
  return Math.min(
    Math.max(value, DEFAULT_INITIAL_BACKOFF_MS),
    DEFAULT_MAX_BACKOFF_MS,
  );
}
/** Session open duration before a benign close resets reconnect backoff. */
export const STABLE_SESSION_MS = 5_000;
/** Delay after sending update-result before restarting, so the instance can persist it. */
export const UPDATE_RESULT_HANDOFF_DELAY_MS = 2_000;
/** Co-located install wait: poll readiness on a fixed cadence before first connect. */
const INSTALL_READINESS_POLL_MS = 5_000;
/** After a prior session, wait for the instance to come back after systemd restart. */
const INSTANCE_RESTART_WAIT_MS = 120_000;

const SERVER_ID_FILE = "server.id";
const SERVER_KEY_FILE = "server-key.json";
const KEY_ID_FILE = "server-key-id";
function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function resolveServerIdDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return resolveServerIdentityDir(env);
}

function resolveServerIdPath(dir = resolveServerIdDir()): string {
  return `${dir}/${SERVER_ID_FILE}`;
}

async function readServerId(
  dir = resolveServerIdDir(),
): Promise<string | undefined> {
  try {
    const id = await Deno.readTextFile(resolveServerIdPath(dir));
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function readDaemonKeyFile(
  dir = resolveServerIdDir(),
): Promise<DaemonKeyFile | null> {
  try {
    return await loadDaemonKeyFile(`${dir}/${SERVER_KEY_FILE}`);
  } catch {
    return null;
  }
}

async function readKeyId(
  dir = resolveServerIdDir(),
): Promise<string | undefined> {
  try {
    const keyId = await Deno.readTextFile(`${dir}/${KEY_ID_FILE}`);
    const trimmed = keyId.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function writeKeyId(
  keyId: string,
  dir = resolveServerIdDir(),
): Promise<void> {
  const trimmed = keyId.trim();
  if (!trimmed) return;
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/${KEY_ID_FILE}`, `${trimmed}\n`);
  } catch (err) {
    logWarn("instance", "failed to persist key id:", sanitizeForLog(err));
  }
}

async function readLicenseCredentials(
  dir = resolveServerIdDir(),
): Promise<
  { licenseId?: string; licenseToken?: string }
> {
  let licenseId: string;
  let licenseToken: string;
  try {
    licenseId = (await Deno.readTextFile(`${dir}/license.id`)).trim();
    licenseToken = (await Deno.readTextFile(`${dir}/license.token`)).trim();
  } catch {
    // Missing or unreadable license files.
    return {};
  }

  if (licenseId.length === 0 || licenseToken.length === 0) {
    return {};
  }

  return { licenseId, licenseToken };
}

function parseMessage(raw: string): DaemonMessage | null {
  try {
    return JSON.parse(raw) as DaemonMessage;
  } catch {
    return null;
  }
}

/** Removes only `server-key.json` + `server-key-id`; keeps persisted `server.id`. */
export async function clearDaemonKeyState(stateDir: string): Promise<void> {
  for (const file of [SERVER_KEY_FILE, KEY_ID_FILE]) {
    try {
      await Deno.remove(`${stateDir}/${file}`);
    } catch {
      // Missing files are fine.
    }
  }
}

export class InstanceClient {
  readonly #config: InstanceConfig;
  #httpClient: Deno.HttpClient | undefined;
  readonly #httpClientPinned: boolean;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #onMessage?: (message: DaemonMessage) => void;

  #ws: WebSocket | undefined;
  #stopped = false;
  #connectLoopStarted = false;
  #backoffMs: number;
  #hadStableSession = false;
  readonly #devSync = new Map<string, DevSyncState>();
  /** Transfer ids already refused at dev-sync-begin (managed / non-checkout). */
  readonly #devSyncRefused = new Set<string>();
  #tokenManager: DaemonTokenManager | undefined;
  #jwksClient: DaemonJwksClient | undefined;
  #apiClient: DaemonApiClient | undefined;
  #tokenServerId: string | undefined;
  #tokenKeyId: string | undefined;
  #forceEnrollPending = false;
  /** Orphan transcript sweep runs once per process, never on reconnect. */
  #orphanSweepStarted = false;
  #didCompleteSecretsRehydrate = false;
  #secretsRehydrateInFlight = false;
  #parked = false;
  #parkedReason: string | undefined;
  #parkedKind: "permanent" | "tls-trust" | undefined;
  #parkedBackoffMs = PARKED_BACKOFF_MIN_MS;
  #licenseStamp: string | undefined;
  #idlePresence: IdlePresence | undefined;
  #haObserver: ManagedHaObserver | undefined;
  #metricsScheduler: MetricsScheduler | undefined;
  /** Server id the current metrics scheduler was bound for (not `#tokenServerId`). */
  #metricsSchedulerServerId: string | undefined;
  /**
   * Live-metrics leases for the current socket session. Recreated fresh on
   * every (re)connect and never persisted, so leases cannot survive a daemon
   * restart or reconnect — a new session always starts at baseline cadence.
   */
  #liveLeases: LiveLeaseManager | undefined;
  readonly #metricsCollectorFactory?: () => MetricsCollector;
  readonly #applyDevSyncTarball?: DevSyncApplyFn;
  #updateInstallInProgress = false;
  /**
   * Identity directory captured at {@link start} so reconnects do not follow a
   * later `TURBOPANEL_DAEMON_STATE_DIR` change (parallel tests share process env).
   */
  #identityDir: string | undefined;

  constructor(options: InstanceClientOptions = {}) {
    this.#config = options.config ?? resolveInstanceConfig();
    this.#httpClient = options.httpClient;
    this.#httpClientPinned = options.httpClient !== undefined;
    this.#applyDevSyncTarball = Object.hasOwn(options, "applyDevSyncTarball")
      ? options.applyDevSyncTarball
      : getCheckoutDevSyncApply();
    this.#initialBackoffMs = normalizeReconnectDelayMs(
      options.reconnectDelayMs,
    );
    this.#maxBackoffMs = DEFAULT_MAX_BACKOFF_MS;
    this.#backoffMs = this.#initialBackoffMs;
    this.#onMessage = options.onMessage;
    this.#metricsCollectorFactory = options.metricsCollectorFactory;
  }

  get config(): InstanceConfig {
    return this.#config;
  }

  get target(): string {
    return describeInstance(this.#config);
  }

  /** Re-read the platform CA bundle (mtime+size cached) unless tests pinned a client. */
  async refreshPlatformCaClient(): Promise<void> {
    if (this.#httpClientPinned) return;
    const env = Deno.env.toObject();
    const caCertPath = resolveInstanceCaPath(env);
    const next = await createInstanceHttpClient(this.#config, {
      caCertPath,
      env,
    });
    if (next !== this.#httpClient) {
      this.#httpClient = next;
      this.#tokenManager = undefined;
      this.#jwksClient = undefined;
      this.#apiClient = undefined;
    }
    await this.#logCaFingerprintMismatch(caCertPath, env);
  }

  async #logCaFingerprintMismatch(
    caCertPath: string | undefined,
    env: Record<string, string | undefined>,
  ): Promise<void> {
    const expected = env.TURBOPANEL_INSTANCE_CA_FINGERPRINT?.trim();
    if (!expected || !caCertPath) return;
    try {
      const pem = await Deno.readTextFile(caCertPath);
      const actual = await fingerprintPemCertificate(pem);
      if (normalizeCaFingerprint(expected) !== actual) {
        logWarn(
          "instance",
          `tls-trust: expected CA fingerprint ${expected} but ${caCertPath} is ${actual}`,
        );
      }
    } catch {
      // Handshake classification reports unreadable CA material.
    }
  }

  #fetchInit(
    init: RequestInit = {},
  ): RequestInit & { client?: Deno.HttpClient } {
    return this.#httpClient ? { ...init, client: this.#httpClient } : init;
  }

  async fetchHealth(): Promise<{ ok: boolean }> {
    const response = await fetch(
      instanceUrl(this.#config, "/api/health"),
      this.#fetchInit(),
    );
    if (!response.ok) {
      throw new Error(`health check failed: HTTP ${response.status}`);
    }
    return await response.json();
  }

  async fetchDaemonReadiness(): Promise<
    { ok: boolean; ready: boolean; needsInstall?: boolean }
  > {
    const response = await fetch(
      instanceUrl(this.#config, "/api/daemon/v1/readiness"),
      this.#fetchInit(),
    );

    let body: {
      ok?: boolean;
      ready?: boolean;
      needsInstall?: boolean;
      error?: string;
    };
    try {
      body = await response.json();
    } catch {
      throw new Error(`daemon readiness check failed: HTTP ${response.status}`);
    }

    if (!response.ok) {
      if (body.ready === false) {
        return {
          ok: body.ok ?? true,
          ready: false,
          needsInstall: body.needsInstall,
        };
      }
      throw new Error(
        body.error ?? `daemon readiness check failed: HTTP ${response.status}`,
      );
    }

    return { ok: body.ok ?? true, ready: body.ready === true };
  }

  #isColocatedSocketMode(): boolean {
    return isColocatedSocketMode(this.#config);
  }

  async #waitForConnectPreconditions(): Promise<void> {
    if (this.#isColocatedSocketMode()) {
      const maxWaitMs = this.#hadStableSession ? INSTANCE_RESTART_WAIT_MS : 0;
      const started = now();
      while (true) {
        try {
          const readiness = await this.fetchDaemonReadiness();
          if (readiness.ready) return;
        } catch {
          // Instance unreachable during restart — keep polling when recovering.
        }
        if (maxWaitMs === 0 || now() - started >= maxWaitMs) {
          throw new Error("instance install incomplete");
        }
        await delay(
          fullJitterMs(this.#initialBackoffMs, INSTALL_READINESS_POLL_MS),
        );
      }
    }

    await this.fetchHealth();
  }

  #resetBackoff(): void {
    this.#backoffMs = this.#initialBackoffMs;
  }

  #increaseBackoff(): void {
    this.#backoffMs = nextBackoffMs(this.#backoffMs, this.#maxBackoffMs);
  }

  /** Full-jitter sleep: random delay in [floor, ceiling] inclusive. */
  #nextReconnectDelayMs(): number {
    return fullJitterMs(this.#initialBackoffMs, this.#backoffMs);
  }

  async fetchVersion(): Promise<{ commit: string; branch: string }> {
    const response = await fetch(
      instanceUrl(this.#config, "/api/daemon/v1/version"),
      this.#fetchInit(),
    );
    if (!response.ok) {
      throw new Error(`version fetch failed: HTTP ${response.status}`);
    }
    return await response.json();
  }

  async fetchConnections(): Promise<
    { connections: { id: string; connectedAt: string }[] }
  > {
    const response = await fetch(
      instanceUrl(this.#config, "/api/developer/v1/daemon/connections"),
      this.#fetchInit(),
    );
    if (!response.ok) {
      throw new Error(`connections fetch failed: HTTP ${response.status}`);
    }
    return await response.json();
  }

  start(): void {
    if (this.#connectLoopStarted) return;
    this.#connectLoopStarted = true;
    this.#stopped = false;
    this.#identityDir = resolveServerIdDir();
    this.#forceEnrollPending = isTruthyFlag(
      Deno.env.get("TURBOPANEL_FORCE_ENROLL"),
    );
    this.#runConnectLoop().catch((err) => {
      logWarn(
        "instance",
        "connect loop exited unexpectedly:",
        sanitizeForLog(err),
      );
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#idlePresence?.detach();
    this.#idlePresence = undefined;
    this.#haObserver?.detach();
    this.#haObserver = undefined;
    this.#metricsScheduler?.detach();
    this.#liveLeases?.dispose();
    this.#liveLeases = undefined;
    this.#metricsScheduler = undefined;
    this.#metricsSchedulerServerId = undefined;
    this.#tokenManager?.stop();
    this.#ws?.close();
    this.#ws = undefined;
  }

  send(message: DaemonMessage): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("instance websocket is not connected");
    }
    this.#ws.send(JSON.stringify(message));
    this.#idlePresence?.touchActivity();
  }

  async #runConnectLoop(): Promise<void> {
    while (!this.#stopped) {
      if (!(await this.#waitForParkedWake())) {
        if (this.#stopped) break;
        continue;
      }

      try {
        await this.#connectOnce();
      } catch (err) {
        await this.#handleConnectFailure(err);
      }

      if (this.#stopped) break;
      if (this.#parked) continue;
      const reconnectDelayMs = this.#nextReconnectDelayMs();
      logDebug(
        "instance",
        "reconnect scheduled in",
        reconnectDelayMs,
        "ms (ceiling",
        this.#backoffMs,
        "ms) via",
        sanitizeForLog(this.target),
      );
      await delay(reconnectDelayMs);
    }
  }

  /**
   * When parked, wait out the parked backoff and check for unpark conditions.
   * @returns true when the loop should proceed to `#connectOnce()`.
   */
  async #waitForParkedWake(): Promise<boolean> {
    if (!this.#parked) return true;
    await delay(this.#nextParkedDelayMs());
    if (this.#stopped) return false;
    if (await this.#shouldUnpark()) {
      this.#unpark();
      return true;
    }
    return false;
  }

  async #handleConnectFailure(err: unknown): Promise<void> {
    const logConnectFailure = this.#hadStableSession ? logWarn : logDebug;
    logConnectFailure(
      "instance",
      "websocket connect failed:",
      sanitizeForLog(err),
    );
    this.#closeActiveSocket();
    this.#idlePresence?.detach();
    this.#haObserver?.detach();
    this.#metricsScheduler?.detach();
    const classified = classifyConnectFailure(err);
    if (classified.kind === "permanent") {
      await this.#enterParkedState(classified.reason, "permanent");
    } else if (classified.kind === "tls-trust") {
      await this.#enterParkedState(classified.reason, "tls-trust");
    } else {
      this.#increaseBackoff();
    }
  }

  #serverIdentityDir(): string {
    return this.#identityDir ?? resolveServerIdDir();
  }

  async #readLicenseStamp(): Promise<string | undefined> {
    const { licenseId, licenseToken } = await readLicenseCredentials(
      this.#serverIdentityDir(),
    );
    if (!licenseId || !licenseToken) return undefined;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${licenseId}\n${licenseToken}`),
    );
    return Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  async #enterParkedState(
    reason: string,
    kind: "permanent" | "tls-trust" = "permanent",
  ): Promise<void> {
    this.#parked = true;
    this.#parkedReason = reason;
    this.#parkedKind = kind;
    this.#forceEnrollPending = false;
    this.#licenseStamp = await this.#readLicenseStamp();
    if (kind === "tls-trust") {
      const caPath = resolveInstanceCaPath() ?? "(none)";
      let fingerprint = "(unreadable)";
      try {
        if (caPath !== "(none)") {
          fingerprint = await fingerprintPemCertificate(
            await Deno.readTextFile(caPath),
          );
        }
      } catch {
        fingerprint = "(unreadable)";
      }
      logError(
        "instance",
        `tls-trust: platform CA does not validate the control plane (host=${
          sanitizeForLog(this.target)
        } caPath=${caPath} fingerprint=${fingerprint}); parked — re-run the installer with --instance-ca or --insecure-tls`,
      );
      return;
    }
    logError(
      "instance",
      `daemon control-plane permanently rejected enrollment (${reason}); parked — install a fresh registration key (Add Server) or point TURBOPANEL_INSTANCE_URL at the correct control plane, then the daemon auto-recovers`,
    );
  }

  #nextParkedDelayMs(): number {
    const delayMs = fullJitterMs(
      PARKED_BACKOFF_MIN_MS,
      this.#parkedBackoffMs,
    );
    this.#parkedBackoffMs = nextBackoffMs(
      this.#parkedBackoffMs,
      PARKED_BACKOFF_MAX_MS,
    );
    return delayMs;
  }

  async #shouldUnpark(): Promise<boolean> {
    if (this.#parkedKind === "tls-trust") return true;
    if (isTruthyFlag(Deno.env.get("TURBOPANEL_FORCE_ENROLL"))) return true;
    const stamp = await this.#readLicenseStamp();
    return stamp !== this.#licenseStamp;
  }

  #unpark(): void {
    const reason = this.#parkedReason ?? "unknown";
    const kind = this.#parkedKind;
    this.#parked = false;
    this.#parkedReason = undefined;
    this.#parkedKind = undefined;
    this.#parkedBackoffMs = PARKED_BACKOFF_MIN_MS;
    this.#resetBackoff();
    if (kind !== "tls-trust") {
      this.#forceEnrollPending = true;
    }
    logDebug(
      "instance",
      kind === "tls-trust"
        ? `unparking after tls-trust failure (${reason}); retrying with a fresh CA read`
        : `unparking after permanent rejection (${reason}); retrying enrollment`,
    );
  }

  #newWebSocket(jwt: string): WebSocket {
    const url = instanceWebSocketUrl(this.#config, "/ws/daemon/v1");
    const options = this.#httpClient
      ? {
        headers: { Authorization: `Bearer ${jwt}` },
        client: this.#httpClient,
      }
      : { headers: { Authorization: `Bearer ${jwt}` } };

    try {
      // Daemon WS auth requires Authorization header at upgrade time.
      return new WebSocket(url, options);
    } catch (error) {
      throw new Error(
        `websocket runtime does not support Authorization headers: ${
          sanitizeForLog(error)
        }`,
      );
    }
  }

  #closeActiveSocket(): void {
    const ws = this.#ws;
    if (
      !ws || ws.readyState === WebSocket.CLOSED ||
      ws.readyState === WebSocket.CLOSING
    ) {
      return;
    }
    try {
      ws.close();
    } catch {
      // Socket may already be gone.
    }
    if (this.#ws === ws) this.#ws = undefined;
  }

  async #loadOrEnrollIdentity(
    stateDir: string,
    machineKey: string | undefined,
    hostname: string,
  ): Promise<{
    keyFile: DaemonKeyFile | null;
    serverId: string | undefined;
    keyId: string | undefined;
  }> {
    const [loadedKeyFile, loadedServerId, loadedKeyId] = await Promise.all([
      readDaemonKeyFile(stateDir),
      readServerId(stateDir),
      readKeyId(stateDir),
    ]);

    let keyFile = loadedKeyFile;
    let serverId = loadedServerId;
    let keyId = loadedKeyId;
    const needsEnrollment = this.#forceEnrollPending || keyFile === null ||
      !serverId || !keyId;
    if (!needsEnrollment) {
      return { keyFile, serverId, keyId };
    }

    const licenseCredentials = await readLicenseCredentials(stateDir);
    if (!licenseCredentials.licenseId || !licenseCredentials.licenseToken) {
      throw new Error("missing license credentials for enrollment");
    }

    const enrollClient = this.#apiClient ?? new DaemonApiClient({
      config: this.#config,
      httpClient: this.#httpClient,
      getToken: () =>
        Promise.reject(new Error("token unavailable before enrollment")),
    });
    const enrollment = await enrollDaemon({
      apiClient: enrollClient,
      machineKey,
      hostname,
      licenseId: licenseCredentials.licenseId,
      licenseToken: licenseCredentials.licenseToken,
      stateDir,
    });
    keyFile = enrollment.keyFile;
    serverId = enrollment.serverId;
    keyId = enrollment.keyId;
    this.#forceEnrollPending = false;
    logInfo(
      "instance",
      "enrolled with instance as",
      sanitizeForLog(serverId),
    );
    return { keyFile, serverId, keyId };
  }

  #ensureAuthClients(
    identity: { keyFile: DaemonKeyFile; serverId: string; keyId: string },
    machineKey: string | undefined,
    hostname: string,
  ): void {
    const { keyFile, serverId, keyId } = identity;
    if (
      this.#tokenManager &&
      this.#apiClient &&
      this.#tokenServerId === serverId &&
      this.#tokenKeyId === keyId
    ) {
      return;
    }

    if (!this.#jwksClient) {
      const jwksApiClient = new DaemonApiClient({
        config: this.#config,
        httpClient: this.#httpClient,
        getToken: () =>
          Promise.reject(new Error("token unavailable for JWKS fetch")),
      });
      this.#jwksClient = new DaemonJwksClient({ apiClient: jwksApiClient });
    }

    const tokenManagerRef: { current?: DaemonTokenManager } = {};
    const apiClient = new DaemonApiClient({
      config: this.#config,
      httpClient: this.#httpClient,
      getToken: async (options) => {
        if (!tokenManagerRef.current) {
          throw new Error("token manager not initialized");
        }
        return await tokenManagerRef.current.getToken(options);
      },
    });
    const tokenManager = new DaemonTokenManager({
      keyFile,
      serverId,
      keyId,
      machineKey,
      hostname,
      apiClient,
      verifyToken: (token) => this.#jwksClient!.verifyInstanceJwt(token),
    });
    tokenManagerRef.current = tokenManager;
    this.#tokenManager = tokenManager;
    this.#apiClient = apiClient;
    this.#tokenServerId = serverId;
    this.#tokenKeyId = keyId;

    // Best-effort: re-upload transcripts spooled before a crash/restart. Once
    // per process only — `#ensureAuthClients` also runs on reconnect, and a
    // long-running command may still own its spool file by then.
    if (!this.#orphanSweepStarted) {
      this.#orphanSweepStarted = true;
      void sweepOrphanCommandLogs({
        send: (params) => apiClient.sendCommandLogChunk(params),
        layout: resolveLayout(Deno.env.toObject()),
      });
    }
  }

  async #recoverFromStaleIdentity(stateDir: string): Promise<void> {
    logWarn(
      "instance",
      "daemon identity is stale for this instance; clearing local key files and re-enrolling",
    );
    await clearDaemonKeyState(stateDir);
    this.#tokenManager = undefined;
    this.#apiClient = undefined;
    this.#tokenServerId = undefined;
    this.#tokenKeyId = undefined;
    this.#forceEnrollPending = true;
  }

  async #connectOnce(): Promise<void> {
    await this.refreshPlatformCaClient();
    await this.#waitForConnectPreconditions();

    // Do not close the active socket here: by the time #connectOnce() is called
    // from #runConnectLoop(), the previous socket has already closed naturally
    // (the loop awaits #connectOnce() which blocks until the 'close' event).
    // Calling #closeActiveSocket() here would kill a healthy connection on every
    // reconnect cycle, producing a perpetual ~2-second disconnect/reconnect storm.

    const stateDir = this.#serverIdentityDir();
    const machineKey = await readMachineKey();
    const hostname = Deno.hostname();

    for (let attempt = 0; attempt < 2; attempt++) {
      const identity = await this.#loadOrEnrollIdentity(
        stateDir,
        machineKey,
        hostname,
      );
      if (identity.keyFile === null || !identity.serverId || !identity.keyId) {
        throw new Error(
          "daemon identity incomplete after enrollment/auth bootstrap",
        );
      }

      this.#ensureAuthClients(
        {
          keyFile: identity.keyFile,
          serverId: identity.serverId,
          keyId: identity.keyId,
        },
        machineKey,
        hostname,
      );

      try {
        const jwt = await this.#tokenManager!.getToken();
        await this.#openDaemonWebSocket(jwt, identity.serverId);
        return;
      } catch (err) {
        if (
          attempt === 0 &&
          classifyConnectFailure(err).kind === "stale-identity"
        ) {
          await this.#recoverFromStaleIdentity(stateDir);
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      "daemon identity bootstrap failed after stale identity retry",
    );
  }

  async #openDaemonWebSocket(jwt: string, serverId: string): Promise<void> {
    const ws = this.#newWebSocket(jwt);
    this.#ws = ws;
    let sessionRegistered = false;
    this.#ensureIdlePresence(serverId);
    this.#ensureMetricsScheduler(serverId);

    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(sanitizeForLog(err)));
        };

        const cleanup = () => {
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onError);
          ws.removeEventListener("close", onClose);
        };

        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (event: Event) => {
          fail((event as ErrorEvent).message ?? "websocket error");
        };
        const onClose = () => {
          fail("websocket closed before open");
        };

        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
      });
    } catch (err) {
      // The WS upgrade was rejected before the socket opened. The most common
      // recoverable cause is a stale/expired daemon JWT (e.g. the instance's
      // signing secret rotated on restart), which the upgrade rejects with HTTP
      // 401 — surfaced here as a connect error (or an h2 protocol error when
      // proxied through Caddy), never as a 4401 close. Force a token refresh so
      // the next reconnect presents a freshly-signed token instead of looping
      // on the rejected one until it expires.
      await this.#tokenManager?.refresh().catch(() => {});
      throw err;
    }

    logDebug(
      "instance",
      "websocket connected via",
      sanitizeForLog(this.target),
    );

    sessionRegistered = true;
    this.#hadStableSession = true;
    const connectedAt = now();
    this.#idlePresence?.attach(ws);
    this.#ensureHaObserver();
    this.#haObserver?.attach();
    this.#metricsScheduler?.attach((sample) =>
      this.#apiClient?.sendHostMetrics(sample) ?? Promise.resolve()
    );
    this.#rehydrateDeploymentSecretsAfterConnect();

    ws.onmessage = (event) => {
      this.#idlePresence?.noteInboundActivity();
      const raw = typeof event.data === "string"
        ? event.data
        : String(event.data);

      const message = parseMessage(raw);
      if (!message) {
        logWarn("instance", "ignored non-JSON websocket message");
        return;
      }

      this.#onMessage?.(message);
      this.#handleMessage(message, ws);
    };

    ws.onclose = (event) => {
      if (event.code === 4401) {
        logWarn("instance", "authentication rejected");
      }
      if (sessionRegistered) {
        logInfo("instance", "websocket closed after registration");
      } else {
        logDebug("instance", "websocket closed before registration");
      }
      if (this.#ws === ws) this.#ws = undefined;
      this.#idlePresence?.detach();
      this.#haObserver?.detach();
      this.#metricsScheduler?.detach();
      // Live leases die with the socket — the next attach starts at baseline.
      this.#liveLeases?.dispose();
      // Container log collection deliberately survives the socket. Tearing it
      // down here dropped every line a container printed during the outage —
      // the tails would be re-attached with no cursor on the next presence ack
      // — and reconnects are exactly the case retention has to survive. The
      // collector holds its batches while `readyToSend()` is false and ships
      // them once the transport is back; only an org toggle stops it.
    };

    const closeEvent = await new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (event) => resolve(event as CloseEvent), {
        once: true,
      });
    });
    if (
      closeEvent.code === 4401 &&
      closeEvent.reason.includes("server row missing")
    ) {
      throw new DaemonApiError(404, "Server key not found");
    }
    const wasAuthFailure = closeEvent.code === 4401;
    if (wasAuthFailure) {
      await this.#tokenManager?.refresh();
    }

    const wasStableSession = sessionRegistered && !wasAuthFailure &&
      now() - connectedAt >= STABLE_SESSION_MS;
    if (wasStableSession) {
      this.#resetBackoff();
    } else {
      this.#increaseBackoff();
    }
  }

  #ensureHaObserver(): void {
    if (this.#haObserver) return;
    this.#haObserver = new ManagedHaObserver({
      send: (message) => {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
        this.#ws.send(JSON.stringify(message));
      },
    });
  }

  #ensureIdlePresence(serverId: string): void {
    if (this.#idlePresence && this.#tokenServerId === serverId) {
      return;
    }

    this.#idlePresence?.detach();
    this.#idlePresence = new IdlePresence({
      serverId,
      // A stalled/half-open socket never fires onclose/onerror on its own —
      // force-close it here so #runConnectLoop's close-event await resolves
      // and the normal reconnect/backoff path takes over. See idle-presence.ts.
      onStaleConnection: () => this.#closeActiveSocket(),
      // Daemon-side max-lifetime backstop (mirrors instance MAX_WS_CONNECTION_AGE_MS).
      onMaxAge: () => this.#closeActiveSocket(),
    });
  }

  #ensureMetricsScheduler(serverId: string): void {
    if (!this.#metricsCollectorFactory) return;

    const rebound = rebindMetricsScheduler({
      existing: this.#metricsScheduler,
      existingServerId: this.#metricsSchedulerServerId,
      serverId,
      collectorFactory: this.#metricsCollectorFactory,
      schedulerOptions: {
        collectionMode: () => this.#liveLeases?.collectionMode() ?? "baseline",
      },
    });
    this.#metricsScheduler = rebound.scheduler;
    this.#metricsSchedulerServerId = rebound.serverId;
    // Leases are session-scoped: a fresh manager per (re)connect guarantees
    // any previous session's live cadence never leaks into the new one.
    this.#liveLeases?.dispose();
    this.#liveLeases = new LiveLeaseManager({
      scheduler: rebound.scheduler,
    });
  }

  #rehydrateDeploymentSecretsAfterConnect(): void {
    if (this.#secretsRehydrateInFlight || !this.#apiClient) return;
    this.#secretsRehydrateInFlight = true;
    const apiClient = this.#apiClient;
    const composeUp = this.#didCompleteSecretsRehydrate
      ? "if-missing"
      : "always";
    clientTestHooks.rehydrateLocalDeployments({
      layout: resolveLayout(Deno.env.toObject()),
      decryptSecrets: (ciphertexts) => apiClient.decryptSecrets(ciphertexts),
      rehydrate: async (deployments) =>
        parseRehydrateDeploymentResults(
          await apiClient.rehydrateDeploymentSecrets(deployments),
        ),
      runDocker: defaultRunDocker,
      composeUp,
    }).then(() => {
      this.#didCompleteSecretsRehydrate = true;
    }).catch((err) => {
      logWarn(
        "instance",
        "deployment secret rehydrate failed:",
        sanitizeForLog(err),
      );
    }).finally(() => {
      this.#secretsRehydrateInFlight = false;
    });
  }

  // Identity is established locally (enrollment + server.id) and confirmed via
  // verified JWT `sub` in DaemonTokenManager — no socket message adopts serverId.
  #handleMessage(message: DaemonMessage, ws: WebSocket): void {
    switch (message.type) {
      case "version":
        // Informational only. The daemon never self-updates; updates are
        // operator-driven via the developer upgrade button / dev-sync push.
        break;
      case "echo":
        this.#echoMessage(message, ws);
        break;
      case "command-dispatch":
        this.#runSocketHandler(
          "command-dispatch",
          handleCommandDispatch(message, ws, this.#commandRouterDeps()),
        );
        break;
      case "addresses-request":
        this.#collectAddresses(message, ws);
        break;
      case "managed-logs-request":
        this.#collectManagedLogs(message, ws);
        break;
      case "metrics-capabilities-request":
        this.#collectMetricsCapabilities(message, ws);
        break;
      case "metrics-live-start":
        this.#applyLiveLeaseStart(message, ws);
        break;
      case "metrics-live-stop":
        this.#applyLiveLeaseStop(message, ws);
        break;
      case "metrics-sensor-overrides-update":
        this.#applySensorOverridesUpdate(message, ws);
        break;
      case "container-logs-request":
        this.#collectContainerLogs(message, ws);
        break;
      case "repo-read-request":
        this.#readRepository(message, ws);
        break;
      case "repo-default-branch-request":
        this.#resolveRepoDefaultBranch(message, ws);
        break;
      case "fabric-paths-request":
        this.#collectFabricPaths(message, ws);
        break;
      case "dev-sync-begin":
        this.#beginDevSync(message, ws);
        break;
      case "dev-sync-chunk":
        this.#bufferDevSyncChunk(message);
        break;
      case "dev-sync-end":
        this.#endDevSync(message.id, ws);
        break;
      case "tunnel-token":
        this.#runSocketHandler(
          "tunnel-token",
          this.#applyTunnelToken(message, ws),
        );
        break;
      case "public-urls-update":
        this.#runSocketHandler(
          "public-urls-update",
          this.#applyPublicUrls(message, ws),
        );
        break;
      case "update":
        this.#runSocketHandler("update", this.#applyUpdate(message, ws));
        break;
    }
  }

  #runSocketHandler(label: string, work: Promise<void>): void {
    void work.catch((err) => {
      logWarn("instance", `${label} handler failed:`, sanitizeForLog(err));
    });
  }

  #commandRouterDeps(): CommandRouterDeps | undefined {
    const apiClient = this.#apiClient;
    if (!apiClient) return undefined;
    return {
      decryptSecrets: (ciphertexts) => apiClient.decryptSecrets(ciphertexts),
      rehydrateDeploymentSecrets: (deployments) =>
        apiClient.rehydrateDeploymentSecrets(deployments),
      sendCommandLogChunk: (params) => apiClient.sendCommandLogChunk(params),
    };
  }

  #echoMessage(
    message: Extract<DaemonMessage, { type: "echo" }>,
    ws: WebSocket,
  ): void {
    logDebug(
      "instance",
      "echo from instance:",
      sanitizeForLog(message.payload),
    );
    ws.send(JSON.stringify(
      {
        type: "echo",
        payload: { received: message.payload, from: "daemon" },
        at: new Date().toISOString(),
      } satisfies DaemonMessage,
    ));
  }

  #beginDevSync(
    message: Extract<DaemonMessage, { type: "dev-sync-begin" }>,
    ws: WebSocket,
  ): void {
    // Gate the transfer up front: only daemons with a real checkout-backed
    // execution mode accept source-sync. Managed / compiled / JS-fallback
    // installs refuse immediately instead of buffering a full tarball just
    // to fail at dev-sync-end. The unpack implementation is absent from
    // production compile unless checkout-sync was explicitly enabled.
    if (!this.#applyDevSyncTarball) {
      this.#refuseDevSync(message.id, MANAGED_DEV_SYNC_REFUSED_REASON, ws);
      return;
    }
    const source = resolveDevSyncSourceRoot();
    if (!source.ok) {
      this.#refuseDevSync(message.id, source.reason, ws);
      return;
    }
    this.#devSync.set(message.id, newDevSyncState(message.totalChunks));
  }

  #bufferDevSyncChunk(
    message: Extract<DaemonMessage, { type: "dev-sync-chunk" }>,
  ): void {
    const state = this.#devSync.get(message.id);
    if (state) state.chunks[message.index] = message.data;
  }

  #endDevSync(id: string, ws: WebSocket): void {
    // Already refused at begin — swallow the trailing end so we don't send a
    // second dev-sync-result for the same transfer.
    if (this.#devSyncRefused.delete(id)) return;
    this.#runSocketHandler("dev-sync", this.#applyDevSync(id, ws));
  }

  /**
   * Reject a source-sync transfer up front on installs without an editable
   * daemon checkout. Records the id so the trailing dev-sync-end is ignored and
   * acks a single failed {@link dev-sync-result} to the instance, which
   * classifies the stable managed-install reason as a skipped daemon.
   */
  #refuseDevSync(id: string, reason: string, ws: WebSocket): void {
    this.#devSync.delete(id);
    this.#devSyncRefused.add(id);
    logWarn("dev-sync", "refused:", sanitizeForLog(reason));
    const result: DaemonMessage = {
      type: "dev-sync-result",
      id,
      ok: false,
      error: reason,
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  async #applyDevSync(id: string, ws: WebSocket): Promise<void> {
    const state = this.#devSync.get(id);
    this.#devSync.delete(id);
    let ok = false;
    let error: string | undefined;
    try {
      if (!state) throw new Error("no dev-sync in progress for this id");
      const apply = this.#applyDevSyncTarball;
      if (!apply) {
        throw new Error(MANAGED_DEV_SYNC_REFUSED_REASON);
      }
      const base64 = state.chunks.join("");
      const bytes = decodeBase64(base64);
      await apply(bytes);

      const restarted = await clientTestHooks.restartDaemonService();
      if (!restarted) {
        throw new Error("dev-sync unpack succeeded but daemon restart failed");
      }
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logError("dev-sync", "failed:", sanitizeForLog(error));
    }

    const result: DaemonMessage = {
      type: "dev-sync-result",
      id,
      ok,
      error,
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  async #applyTunnelToken(
    message: Extract<DaemonMessage, { type: "tunnel-token" }>,
    ws: WebSocket,
  ): Promise<void> {
    let ok = false;
    let error: string | undefined;
    try {
      await clientTestHooks.writeInstanceTunnelToken(message.token);
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logError("tunnel-token", "failed:", sanitizeForLog(error));
    }

    const result: DaemonMessage = {
      type: "tunnel-token-result",
      id: message.id,
      ok,
      error,
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  async #applyPublicUrls(
    message: Extract<DaemonMessage, { type: "public-urls-update" }>,
    ws: WebSocket,
  ): Promise<void> {
    let ok = false;
    let error: string | undefined;
    try {
      await clientTestHooks.applyPublicUrls(message.urls);
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logError("public-urls", "failed:", sanitizeForLog(error));
    }

    const result: DaemonMessage = {
      type: "public-urls-update-result",
      id: message.id,
      ok,
      error,
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  #resolveUpdateConfigForMessage(
    message: Extract<DaemonMessage, { type: "update" }>,
  ): ReturnType<typeof resolveUpdateChannelConfig> {
    const config = resolveUpdateChannelConfig(Deno.env.toObject());
    const msgChannel = message.channel?.trim();
    if (!msgChannel) return config;

    try {
      return resolveUpdateChannelConfig({
        ...Deno.env.toObject(),
        TURBOPANEL_UPDATE_CHANNEL: msgChannel,
      });
    } catch {
      return config;
    }
  }

  async #reconcileToLatestUpdate(
    config: ReturnType<typeof resolveUpdateChannelConfig>,
  ): Promise<boolean> {
    const updateInfo = await clientTestHooks.resolveUpdate(config);
    if (clientTestHooks.getBuildInfo().commit === updateInfo.commit) {
      logInfo(
        "update",
        "already on current commit",
        sanitizeForLog(updateInfo.commit),
      );
      return false;
    }

    const credentials = await readLicenseCredentials(this.#serverIdentityDir());
    if (!credentials.licenseId || !credentials.licenseToken) {
      throw new Error(
        "license credentials missing; re-run the installer with TURBOPANEL_LICENSE",
      );
    }

    const env = Deno.env.toObject();
    const instanceUrl = env.TURBOPANEL_INSTANCE_URL?.trim();
    const instanceCaPath = resolveInstanceCaPath(env);
    const dlBase = env.TURBOPANEL_DL_BASE?.trim();
    const runScriptUrl = resolveRunScriptUrl(this.#config, { dlBase });
    const publicTls = Boolean(
      instanceUrl && !installOriginNeedsInsecureTls(instanceUrl) &&
        !isPlaintextHttpUrl(instanceUrl),
    );
    const insecureTls = publicTls ? false : resolveBootstrapInsecureTls({
      releaseTlsInsecure: env.TURBOPANEL_RELEASE_TLS_INSECURE,
      runScriptUrl,
      instanceCaPath,
    });
    const licenseArg = encodeLicenseArg(
      credentials.licenseId,
      credentials.licenseToken,
    );
    const reconcileArgs = buildRunReconcileArgs({
      licenseArg,
      instanceUrl,
      instanceCaPath: publicTls ? undefined : instanceCaPath,
      insecureTls,
      dlBase,
    });

    logInfo(
      "update",
      "reconciling via run.sh",
      sanitizeForLog(runScriptUrl),
    );

    const script = await clientTestHooks.downloadRunScript(runScriptUrl, {
      insecureTls,
      caPath: (insecureTls || publicTls) ? undefined : instanceCaPath,
    });
    await clientTestHooks.executeRunReconcile({
      script,
      args: reconcileArgs,
      channel: config.channel,
    });
    return true;
  }

  #sendUpdateResult(
    ws: WebSocket,
    id: string,
    ok: boolean,
    error?: string,
  ): void {
    const result: DaemonMessage = {
      type: "update-result",
      id,
      ok,
      error,
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  async #applyUpdate(
    message: Extract<DaemonMessage, { type: "update" }>,
    ws: WebSocket,
  ): Promise<void> {
    // Long-running reconcile + restart runs here; the instance queues the request
    // and returns immediately — this path is decoupled from that HTTP lifecycle.
    if (this.#updateInstallInProgress) {
      this.#sendUpdateResult(
        ws,
        message.id,
        false,
        "update already in progress",
      );
      return;
    }

    this.#updateInstallInProgress = true;
    let ok = false;
    let shouldRestart = false;
    let error: string | undefined;
    try {
      const config = this.#resolveUpdateConfigForMessage(message);
      shouldRestart = await this.#reconcileToLatestUpdate(config);
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logError("update", "failed:", sanitizeForLog(error));
    }

    this.#sendUpdateResult(ws, message.id, ok, error);

    // Restart only after acking success and a short handoff delay, so the
    // instance can persist update-result before this process is replaced.
    if (ok && shouldRestart) {
      await new Promise((resolve) =>
        setTimeout(resolve, clientTestHooks.updateResultHandoffDelayMs)
      );
      const restarted = await clientTestHooks.restartDaemonService();
      if (!restarted) {
        logWarn(
          "update",
          "reconcile succeeded but systemd restart failed; daemon may still be on old code",
        );
      }
    }

    this.#updateInstallInProgress = false;
  }

  #collectAddresses(
    message: Extract<DaemonMessage, { type: "addresses-request" }>,
    ws: WebSocket,
  ): void {
    let ips: ServerReportedIp[];
    try {
      ips = clientTestHooks.collectServerIps(readDefaultRouteInterfaces());
    } catch (err) {
      logWarn(
        "instance",
        "collect addresses failed:",
        sanitizeForLog(err),
      );
      ips = [];
    }

    const result: DaemonMessage = {
      type: "addresses-result",
      id: message.id,
      ips,
      at: new Date().toISOString(),
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result));
    }
  }

  #collectManagedLogs(
    message: Extract<DaemonMessage, { type: "managed-logs-request" }>,
    ws: WebSocket,
  ): void {
    void this.#collectManagedLogsAsync(message, ws);
  }

  async #collectManagedLogsAsync(
    message: Extract<DaemonMessage, { type: "managed-logs-request" }>,
    ws: WebSocket,
  ): Promise<void> {
    let logs = "";
    let error: string | undefined;
    try {
      logs = await collectManagedLogs(message.managedId, {
        tail: message.tail,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn(
        "instance",
        "collect managed logs failed:",
        sanitizeForLog(err),
      );
    }

    const result: DaemonMessage = {
      type: "managed-logs-result",
      id: message.id,
      logs,
      ...(error === undefined ? {} : { error }),
      at: new Date().toISOString(),
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result));
    }
  }

  #collectMetricsCapabilities(
    message: Extract<DaemonMessage, { type: "metrics-capabilities-request" }>,
    ws: WebSocket,
  ): void {
    void this.#collectMetricsCapabilitiesAsync(message, ws);
  }

  async #collectMetricsCapabilitiesAsync(
    message: Extract<DaemonMessage, { type: "metrics-capabilities-request" }>,
    ws: WebSocket,
  ): Promise<void> {
    let capabilities: MetricsCapabilities | undefined;
    let error: string | undefined;
    try {
      capabilities = await collectMetricsCapabilities();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn(
        "instance",
        "collect metrics capabilities failed:",
        sanitizeForLog(err),
      );
    }

    const result: DaemonMessage = {
      type: "metrics-capabilities-result",
      id: message.id,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(error === undefined ? {} : { error }),
      at: new Date().toISOString(),
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result));
    }
  }

  #applyLiveLeaseStart(
    message: Extract<DaemonMessage, { type: "metrics-live-start" }>,
    ws: WebSocket,
  ): void {
    let ok = false;
    let error: string | undefined;
    try {
      const leases = this.#liveLeases;
      if (!leases) throw new Error("metrics are not enabled on this daemon");
      leases.start(message.leaseId, Date.parse(message.expiresAt));
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn("instance", "live lease start failed:", sanitizeForLog(err));
    }

    const result: DaemonMessage = {
      type: "metrics-live-start-result",
      id: message.id,
      ok,
      ...(error === undefined ? {} : { error }),
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  #applyLiveLeaseStop(
    message: Extract<DaemonMessage, { type: "metrics-live-stop" }>,
    ws: WebSocket,
  ): void {
    let ok = false;
    let error: string | undefined;
    try {
      const leases = this.#liveLeases;
      if (!leases) throw new Error("metrics are not enabled on this daemon");
      leases.stop(message.leaseId);
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn("instance", "live lease stop failed:", sanitizeForLog(err));
    }

    const result: DaemonMessage = {
      type: "metrics-live-stop-result",
      id: message.id,
      ok,
      ...(error === undefined ? {} : { error }),
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  #applySensorOverridesUpdate(
    message: Extract<
      DaemonMessage,
      { type: "metrics-sensor-overrides-update" }
    >,
    ws: WebSocket,
  ): void {
    void this.#applySensorOverridesUpdateAsync(message, ws);
  }

  async #applySensorOverridesUpdateAsync(
    message: Extract<
      DaemonMessage,
      { type: "metrics-sensor-overrides-update" }
    >,
    ws: WebSocket,
  ): Promise<void> {
    let ok = false;
    let error: string | undefined;
    let drivetemp: DrivetempEnableResult | undefined;
    try {
      const previous = await resolveHardwareProfile();
      // Full replacement: the pushed object is the complete hardware profile.
      await writeHardwareProfile(message.overrides ?? {});
      ok = true;

      // A flip from false/unset to true is the only edge that should load
      // the module — every later push with drivetempEnabled already true is
      // a no-op here. Awaited (not fire-and-forget) so this result reports
      // the real load outcome and refreshed sensor capabilities instead of
      // acking before that work has even run. Its own try/catch: the profile
      // write above is what `ok` reports, so a drivetemp-command failure
      // here degrades only the `drivetemp` field, never the overall ack.
      if (
        message.overrides?.drivetempEnabled === true &&
        previous.drivetempEnabled !== true
      ) {
        try {
          drivetemp = await handleDrivetempEnable(
            {},
            new Date().toISOString(),
          );
        } catch (err) {
          logWarn(
            "instance",
            "drivetemp enable failed:",
            sanitizeForLog(err),
          );
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn(
        "instance",
        "sensor overrides update failed:",
        sanitizeForLog(err),
      );
    }

    const result: DaemonMessage = {
      type: "metrics-sensor-overrides-update-result",
      id: message.id,
      ok,
      ...(error === undefined ? {} : { error }),
      ...(drivetemp === undefined ? {} : { drivetemp }),
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  #collectContainerLogs(
    message: Extract<DaemonMessage, { type: "container-logs-request" }>,
    ws: WebSocket,
  ): void {
    void this.#collectContainerLogsAsync(message, ws);
  }

  async #collectContainerLogsAsync(
    message: Extract<DaemonMessage, { type: "container-logs-request" }>,
    ws: WebSocket,
  ): Promise<void> {
    let logs = "";
    let error: string | undefined;
    try {
      const { stateDir } = resolveLayout(Deno.env.toObject());
      logs = await collectContainerLogs(message.containerId, {
        stateDir,
        tail: message.tail,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn(
        "instance",
        "collect container logs failed:",
        sanitizeForLog(err),
      );
    }

    const result: DaemonMessage = {
      type: "container-logs-result",
      id: message.id,
      logs,
      ...(error === undefined ? {} : { error }),
      at: new Date().toISOString(),
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result));
    }
  }

  #readRepository(
    message: Extract<DaemonMessage, { type: "repo-read-request" }>,
    ws: WebSocket,
  ): void {
    void this.#readRepositoryAsync(message, ws);
  }

  /**
   * Read files from a repository the control plane cannot reach itself.
   *
   * Answers on the same correlated request channel managed logs use — this is
   * interactive and read-only, so it is deliberately not a command: a command
   * row per read would pollute the append-only ledger that backs deploy
   * history.
   */
  async #readRepositoryAsync(
    message: Extract<DaemonMessage, { type: "repo-read-request" }>,
    ws: WebSocket,
  ): Promise<void> {
    const payload = await this.#buildRepoReadPayload(message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  // Sealed `tpdaemon.…` envelope, unsealed through the same API path every
  // deploy secret uses — the daemon never holds a long-lived key.
  async #resolveRepoReadCredential(
    message: Extract<DaemonMessage, { type: "repo-read-request" }>,
  ): Promise<
    { credential: string; credentialKind: "ssh_key" | "token" } | undefined
  > {
    if (message.credential === undefined) return undefined;
    const apiClient = this.#apiClient;
    if (!apiClient) throw new Error("api client unavailable");
    const [plaintext] = await apiClient.decryptSecrets([message.credential]);
    if (typeof plaintext !== "string") return undefined;
    const credentialKind = message.credentialKind === "ssh_key"
      ? "ssh_key"
      : "token";
    return { credential: plaintext, credentialKind };
  }

  async #buildRepoReadPayload(
    message: Extract<DaemonMessage, { type: "repo-read-request" }>,
  ): Promise<DaemonMessage> {
    try {
      const credential = await this.#resolveRepoReadCredential(message);
      const result = await readRemoteFiles({
        cloneUrl: message.cloneUrl,
        ref: message.ref,
        paths: message.paths,
        ...(message.listPath === undefined
          ? {}
          : { listPath: message.listPath }),
        maxBytesPerFile: message.maxBytesPerFile,
        ...credential,
        ...(message.credentialUsername === undefined
          ? {}
          : { credentialUsername: message.credentialUsername }),
      });
      return {
        type: "repo-read-result",
        id: message.id,
        ok: true,
        commitSha: result.commitSha,
        files: result.files,
        entries: result.entries,
        at: new Date().toISOString(),
      };
    } catch (err) {
      logWarn("instance", "repository read failed:", sanitizeForLog(err));
      return {
        type: "repo-read-result",
        id: message.id,
        ok: false,
        // Sanitized: a git error can echo the clone URL, which for an HTTPS
        // token lane carries the credential in userinfo.
        error: sanitizeForLog(
          err instanceof Error ? err.message : String(err),
        ),
        at: new Date().toISOString(),
      };
    }
  }

  /**
   * Answers the control plane's "what branch does this remote default to"
   * request for a clone URL the operator gave no default branch — anonymous
   * only, on the same correlated request channel `repo-read-request` uses.
   */
  #resolveRepoDefaultBranch(
    message: Extract<DaemonMessage, { type: "repo-default-branch-request" }>,
    ws: WebSocket,
  ): void {
    void this.#resolveRepoDefaultBranchAsync(message, ws);
  }

  async #resolveRepoDefaultBranchAsync(
    message: Extract<DaemonMessage, { type: "repo-default-branch-request" }>,
    ws: WebSocket,
  ): Promise<void> {
    const payload = await this.#buildRepoDefaultBranchPayload(message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  async #buildRepoDefaultBranchPayload(
    message: Extract<DaemonMessage, { type: "repo-default-branch-request" }>,
  ): Promise<DaemonMessage> {
    try {
      const result = await resolveDefaultBranch(message.cloneUrl);
      return {
        type: "repo-default-branch-result",
        id: message.id,
        ok: true,
        defaultBranch: result.defaultBranch,
        at: new Date().toISOString(),
      };
    } catch (err) {
      logWarn(
        "instance",
        "resolve default branch failed:",
        sanitizeForLog(err),
      );
      return {
        type: "repo-default-branch-result",
        id: message.id,
        ok: false,
        // Sanitized: same reasoning as `repo-read-result` — a git error can
        // echo the clone URL.
        error: sanitizeForLog(
          err instanceof Error ? err.message : String(err),
        ),
        at: new Date().toISOString(),
      };
    }
  }

  #collectFabricPaths(
    message: Extract<DaemonMessage, { type: "fabric-paths-request" }>,
    ws: WebSocket,
  ): void {
    void this.#collectFabricPathsAsync(message, ws);
  }

  async #collectFabricPathsAsync(
    message: Extract<DaemonMessage, { type: "fabric-paths-request" }>,
    ws: WebSocket,
  ): Promise<void> {
    let paths: Extract<
      DaemonMessage,
      { type: "fabric-paths-result" }
    >["paths"] = [];
    let error: string | undefined;
    try {
      paths = await clientTestHooks.handleFabricPathProbe(message);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn(
        "instance",
        "collect fabric paths failed:",
        sanitizeForLog(err),
      );
    }

    const result: DaemonMessage = {
      type: "fabric-paths-result",
      id: message.id,
      paths,
      ...(error === undefined ? {} : { error }),
      at: new Date().toISOString(),
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result));
    }
  }
}

let nowFn: () => number = () => Date.now();
let delayFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function now(): number {
  return nowFn();
}

function delay(ms: number): Promise<void> {
  return delayFn(ms);
}

/**
 * Test-only injection for wall-clock and delay. Returns a restore function.
 * Default behavior is byte-identical to Date.now / setTimeout.
 */
export function installClientTimeSource(source: {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}): () => void {
  const previousNow = nowFn;
  const previousDelay = delayFn;
  if (source.now) nowFn = source.now;
  if (source.delay) delayFn = source.delay;
  return () => {
    nowFn = previousNow;
    delayFn = previousDelay;
  };
}

type ClientTestHooks = {
  restartDaemonService: typeof restartDaemonService;
  resolveUpdate: typeof resolveUpdate;
  getBuildInfo: typeof getBuildInfo;
  downloadRunScript: typeof downloadRunScript;
  executeRunReconcile: typeof executeRunReconcile;
  collectServerIps: typeof collectServerIps;
  handleFabricPathProbe: typeof handleFabricPathProbe;
  writeInstanceTunnelToken: typeof writeInstanceTunnelToken;
  applyPublicUrls: typeof applyPublicUrls;
  rehydrateLocalDeployments: typeof rehydrateLocalDeployments;
  /** Override UPDATE_RESULT_HANDOFF_DELAY_MS for host-free update tests. */
  updateResultHandoffDelayMs: number;
};

let clientTestHooks: ClientTestHooks = {
  restartDaemonService,
  resolveUpdate,
  getBuildInfo,
  downloadRunScript,
  executeRunReconcile,
  collectServerIps,
  handleFabricPathProbe,
  writeInstanceTunnelToken,
  applyPublicUrls,
  rehydrateLocalDeployments,
  updateResultHandoffDelayMs: UPDATE_RESULT_HANDOFF_DELAY_MS,
};

/**
 * Test-only leaf-dep injection for update / tunnel / rehydrate / probe paths.
 * Returns a restore function. Production defaults are the real module exports.
 */
export function installClientTestHooks(
  source: Partial<ClientTestHooks>,
): () => void {
  const previous = clientTestHooks;
  clientTestHooks = { ...previous, ...source };
  return () => {
    clientTestHooks = previous;
  };
}

function nextBackoffMs(current: number, max: number): number {
  return Math.min(current * BACKOFF_MULTIPLIER, max);
}

/** Full-jitter delay in [floor, ceiling] inclusive (AWS-style de-correlation). */
export function fullJitterMs(floor: number, ceiling: number): number {
  const lo = Math.min(floor, ceiling);
  const hi = Math.max(floor, ceiling);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1)); // NOSONAR typescript:S2245 — jitter timing only, not a security context
}

function isColocatedSocketMode(config: InstanceConfig): boolean {
  return config.kind === "socket";
}

async function waitForColocatedReadiness(
  client: InstanceClient,
  initialBackoffMs: number,
): Promise<void> {
  while (true) {
    try {
      const readiness = await client.fetchDaemonReadiness();
      if (readiness.ready) {
        logInfo(
          "instance",
          "instance ready for daemon registration via",
          sanitizeForLog(client.target),
        );
        break;
      }
    } catch {
      // Instance not reachable yet — keep polling silently.
    }
    await delay(
      fullJitterMs(initialBackoffMs, INSTALL_READINESS_POLL_MS),
    );
  }
}

function describeHealthCheckFailure(err: unknown): string {
  if (!(err instanceof Error)) return sanitizeForLog(err);
  const msg = err.message;
  if (
    /certificate|tls|ssl|NotValidForName|UnknownIssuer|invalid peer/i.test(msg)
  ) {
    return `${msg} — ensure the control plane leaf cert SAN includes the ` +
      "hostname in TURBOPANEL_INSTANCE_URL (Admin → Public URLs → Save & Apply)";
  }
  return msg;
}

async function waitForRemoteHealth(
  client: InstanceClient,
  initialBackoffMs: number,
): Promise<void> {
  let waitingLogged = false;
  let failureCount = 0;
  let backoffMs = initialBackoffMs;

  while (true) {
    try {
      await client.fetchHealth();
      logInfo(
        "instance",
        "instance available via",
        sanitizeForLog(client.target),
      );
      break;
    } catch (err) {
      failureCount += 1;
      const detail = describeHealthCheckFailure(err);
      if (!waitingLogged) {
        logInfo(
          "instance",
          "waiting for instance to become available via",
          sanitizeForLog(client.target),
        );
        waitingLogged = true;
      }
      if (failureCount === 1 || failureCount % 10 === 0) {
        logInfo(
          "instance",
          "health check failed (retrying):",
          sanitizeForLog(detail),
        );
        logWarn(
          "instance",
          "health check failed (retrying):",
          sanitizeForLog(detail),
        );
      }
      await delay(fullJitterMs(initialBackoffMs, backoffMs));
      backoffMs = nextBackoffMs(backoffMs, DEFAULT_MAX_BACKOFF_MS);
    }
  }
}

export async function connectInstance(
  options: InstanceClientOptions = {},
): Promise<InstanceClient> {
  const initialBackoffMs = normalizeReconnectDelayMs(options.reconnectDelayMs);
  const config = options.config ?? resolveInstanceConfig();

  const client = new InstanceClient({
    ...options,
    config,
    reconnectDelayMs: initialBackoffMs,
  });
  await client.refreshPlatformCaClient();

  const socketMode = isColocatedSocketMode(config);

  if (socketMode) {
    await waitForColocatedReadiness(client, initialBackoffMs);
  } else {
    await waitForRemoteHealth(client, initialBackoffMs);
  }

  client.start();
  return client;
}

export type { DaemonMessage };
export { readKeyId, writeKeyId };
