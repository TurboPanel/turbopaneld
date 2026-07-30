import { restartDaemonService } from "./restart-daemon-service.ts";
import { handleCommandDispatch } from "./commands/command-router.ts";
import {
  createInstanceHttpClient,
  describeInstance,
  type InstanceConfig,
  instanceUrl,
  instanceWebSocketUrl,
  resolveInstanceCaPath,
  resolveInstanceConfig,
  resolveServerIdentityDir,
  resolveServerKeyPath,
} from "./paths.ts";
import { collectServerAddresses } from "../server-addresses.ts";
import { collectManagedLogs } from "../managed/logs.ts";
import {
  applyDevSyncTarball,
  type DevSyncState,
  newDevSyncState,
  resolveDevSyncSourceRoot,
} from "../dev-sync-apply.ts";
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
import { classifyConnectFailure } from "./connect-failure.ts";
import { DaemonJwksClient } from "./jwks-client.ts";
import { DaemonTokenManager } from "./token-manager.ts";
import { enrollDaemon } from "./enroll.ts";
import { decodeBase64 } from "@std/encoding/base64";
import { getBuildInfo } from "../build-info.ts";
import { IdlePresence } from "./idle-presence.ts";
import type { MetricsCollector } from "../metrics/collector/index.ts";
import {
  MetricsScheduler,
  rebindMetricsScheduler,
} from "../metrics/scheduler.ts";
import { resolveUpdateChannelConfig } from "../update/config.ts";
import { resolveUpdate } from "../update/resolver.ts";
import {
  buildRunReconcileArgs,
  downloadRunScript,
  encodeLicenseArg,
  executeRunReconcile,
  resolveBootstrapInsecureTls,
  resolveRunScriptUrl,
} from "./run-reconcile.ts";

type DaemonMessage =
  | { type: "echo"; payload: unknown; at: string }
  | { type: "version"; commit: string; branch: string; at: string }
  | { type: "addresses-request"; id: string; at: string }
  | {
    type: "addresses-result";
    id: string;
    addresses: {
      privateIpv4: string[];
      privateIpv6: string[];
      publicIpv4: string[];
      publicIpv6: string[];
    };
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
    type: "managed-logs-result";
    id: string;
    logs: string;
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

function resolveServerIdPath(): string {
  return `${resolveServerIdDir()}/${SERVER_ID_FILE}`;
}

async function readServerId(): Promise<string | undefined> {
  try {
    const id = await Deno.readTextFile(resolveServerIdPath());
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function readDaemonKeyFile(): Promise<DaemonKeyFile | null> {
  try {
    return await loadDaemonKeyFile(resolveServerKeyPath());
  } catch {
    return null;
  }
}

async function readKeyId(): Promise<string | undefined> {
  try {
    const keyId = await Deno.readTextFile(
      `${resolveServerIdDir()}/${KEY_ID_FILE}`,
    );
    const trimmed = keyId.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function writeKeyId(keyId: string): Promise<void> {
  const trimmed = keyId.trim();
  if (!trimmed) return;
  try {
    const dir = resolveServerIdDir();
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/${KEY_ID_FILE}`, `${trimmed}\n`);
  } catch (err) {
    logWarn("instance", "failed to persist key id:", sanitizeForLog(err));
  }
}

async function readLicenseCredentials(): Promise<
  { licenseId?: string; licenseToken?: string }
> {
  const dir = resolveServerIdDir();

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

async function clearDaemonKeyState(stateDir: string): Promise<void> {
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
  readonly #httpClient: Deno.HttpClient | undefined;
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
  #parked = false;
  #parkedReason: string | undefined;
  #parkedBackoffMs = PARKED_BACKOFF_MIN_MS;
  #licenseStamp: string | undefined;
  #idlePresence: IdlePresence | undefined;
  #metricsScheduler: MetricsScheduler | undefined;
  /** Server id the current metrics scheduler was bound for (not `#tokenServerId`). */
  #metricsSchedulerServerId: string | undefined;
  readonly #metricsCollectorFactory?: () => MetricsCollector;
  #updateInstallInProgress = false;

  constructor(options: InstanceClientOptions = {}) {
    this.#config = options.config ?? resolveInstanceConfig();
    this.#httpClient = options.httpClient;
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
      const started = Date.now();
      while (true) {
        try {
          const readiness = await this.fetchDaemonReadiness();
          if (readiness.ready) return;
        } catch {
          // Instance unreachable during restart — keep polling when recovering.
        }
        if (maxWaitMs === 0 || Date.now() - started >= maxWaitMs) {
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
    this.#metricsScheduler?.detach();
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
    this.#metricsScheduler?.detach();
    const classified = classifyConnectFailure(err);
    if (classified.kind === "permanent") {
      await this.#enterParkedState(classified.reason);
    } else {
      this.#increaseBackoff();
    }
  }

  async #readLicenseStamp(): Promise<string | undefined> {
    const { licenseId, licenseToken } = await readLicenseCredentials();
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

  async #enterParkedState(reason: string): Promise<void> {
    this.#parked = true;
    this.#parkedReason = reason;
    this.#forceEnrollPending = false;
    this.#licenseStamp = await this.#readLicenseStamp();
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
    if (isTruthyFlag(Deno.env.get("TURBOPANEL_FORCE_ENROLL"))) return true;
    const stamp = await this.#readLicenseStamp();
    return stamp !== this.#licenseStamp;
  }

  #unpark(): void {
    const reason = this.#parkedReason ?? "unknown";
    this.#parked = false;
    this.#parkedReason = undefined;
    this.#parkedBackoffMs = PARKED_BACKOFF_MIN_MS;
    this.#resetBackoff();
    this.#forceEnrollPending = true;
    logDebug(
      "instance",
      `unparking after permanent rejection (${reason}); retrying enrollment`,
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
      readDaemonKeyFile(),
      readServerId(),
      readKeyId(),
    ]);

    let keyFile = loadedKeyFile;
    let serverId = loadedServerId;
    let keyId = loadedKeyId;
    const needsEnrollment = this.#forceEnrollPending || keyFile === null ||
      !serverId || !keyId;
    if (!needsEnrollment) {
      return { keyFile, serverId, keyId };
    }

    const licenseCredentials = await readLicenseCredentials();
    if (!licenseCredentials.licenseId || !licenseCredentials.licenseToken) {
      throw new Error("missing license credentials for enrollment");
    }

    const enrollClient = this.#apiClient ?? new DaemonApiClient({
      config: this.#config,
      httpClient: this.#httpClient,
      getToken: async () => {
        throw new Error("token unavailable before enrollment");
      },
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
        getToken: async () => {
          throw new Error("token unavailable for JWKS fetch");
        },
      });
      this.#jwksClient = new DaemonJwksClient({ apiClient: jwksApiClient });
    }

    let tokenManagerRef: DaemonTokenManager | undefined;
    const apiClient = new DaemonApiClient({
      config: this.#config,
      httpClient: this.#httpClient,
      getToken: async (options) => {
        if (!tokenManagerRef) {
          throw new Error("token manager not initialized");
        }
        return await tokenManagerRef.getToken(options);
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
    tokenManagerRef = tokenManager;
    this.#tokenManager = tokenManager;
    this.#apiClient = apiClient;
    this.#tokenServerId = serverId;
    this.#tokenKeyId = keyId;
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
    await this.#waitForConnectPreconditions();

    // Do not close the active socket here: by the time #connectOnce() is called
    // from #runConnectLoop(), the previous socket has already closed naturally
    // (the loop awaits #connectOnce() which blocks until the 'close' event).
    // Calling #closeActiveSocket() here would kill a healthy connection on every
    // reconnect cycle, producing a perpetual ~2-second disconnect/reconnect storm.

    const stateDir = resolveServerIdDir();
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
    const connectedAt = Date.now();
    this.#idlePresence?.attach(ws);
    this.#metricsScheduler?.attach((sample) =>
      this.#apiClient?.sendHostMetrics(sample) ?? Promise.resolve()
    );

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
      this.#metricsScheduler?.detach();
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
      Date.now() - connectedAt >= STABLE_SESSION_MS;
    if (wasStableSession) {
      this.#resetBackoff();
    } else {
      this.#increaseBackoff();
    }
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
    });
    this.#metricsScheduler = rebound.scheduler;
    this.#metricsSchedulerServerId = rebound.serverId;
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
        break;
      case "command-dispatch":
        handleCommandDispatch(message, ws, {
          decryptSecrets: this.#apiClient
            ? (ciphertexts) => this.#apiClient!.decryptSecrets(ciphertexts)
            : undefined,
        }).catch((err) => {
          logWarn(
            "instance",
            "command-dispatch handler failed:",
            sanitizeForLog(err),
          );
        });
        break;
      case "addresses-request":
        this.#collectAddresses(message, ws);
        break;
      case "managed-logs-request":
        this.#collectManagedLogs(message, ws);
        break;
      case "dev-sync-begin": {
        // Gate the transfer up front: only daemons with a real checkout-backed
        // execution mode accept source-sync. Managed / compiled / JS-fallback
        // installs refuse immediately instead of buffering a full tarball just
        // to fail at dev-sync-end.
        const source = resolveDevSyncSourceRoot();
        if (!source.ok) {
          this.#refuseDevSync(message.id, source.reason, ws);
          break;
        }
        this.#devSync.set(message.id, newDevSyncState(message.totalChunks));
        break;
      }
      case "dev-sync-chunk": {
        const state = this.#devSync.get(message.id);
        if (state) state.chunks[message.index] = message.data;
        break;
      }
      case "dev-sync-end":
        // Already refused at begin — swallow the trailing end so we don't send a
        // second dev-sync-result for the same transfer.
        if (this.#devSyncRefused.delete(message.id)) break;
        this.#applyDevSync(message.id, ws).catch((err) => {
          logWarn(
            "instance",
            "dev-sync handler failed:",
            sanitizeForLog(err),
          );
        });
        break;
      case "tunnel-token":
        this.#applyTunnelToken(message, ws).catch((err) => {
          logWarn(
            "instance",
            "tunnel-token handler failed:",
            sanitizeForLog(err),
          );
        });
        break;
      case "public-urls-update":
        this.#applyPublicUrls(message, ws).catch((err) => {
          logWarn(
            "instance",
            "public-urls-update handler failed:",
            sanitizeForLog(err),
          );
        });
        break;
      case "update":
        void this.#applyUpdate(message, ws).catch((err) => {
          logWarn("instance", "update handler failed:", sanitizeForLog(err));
        });
        break;
    }
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
      const base64 = state.chunks.join("");
      const bytes = decodeBase64(base64);
      await applyDevSyncTarball(bytes);

      const restarted = await restartDaemonService();
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
      await writeInstanceTunnelToken(message.token);
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
      await applyPublicUrls(message.urls);
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
    let config = resolveUpdateChannelConfig(Deno.env.toObject());
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
    const updateInfo = await resolveUpdate(config);
    if (getBuildInfo().commit === updateInfo.commit) {
      logInfo(
        "update",
        "already on current commit",
        sanitizeForLog(updateInfo.commit),
      );
      return false;
    }

    const credentials = await readLicenseCredentials();
    if (!credentials.licenseId || !credentials.licenseToken) {
      throw new Error(
        "license credentials missing; re-run the installer with TURBOPANEL_LICENSE",
      );
    }

    const env = Deno.env.toObject();
    const instanceUrl = env.TURBOPANEL_INSTANCE_URL?.trim();
    const instanceCaPath = resolveInstanceCaPath(env);
    const runScriptUrl = resolveRunScriptUrl(this.#config);
    const insecureTls = resolveBootstrapInsecureTls({
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
      instanceCaPath,
      insecureTls,
    });

    logInfo(
      "update",
      "reconciling via run.sh",
      sanitizeForLog(runScriptUrl),
    );

    const script = await downloadRunScript(runScriptUrl, {
      insecureTls,
      caPath: insecureTls ? undefined : instanceCaPath,
    });
    await executeRunReconcile({
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
        setTimeout(resolve, UPDATE_RESULT_HANDOFF_DELAY_MS)
      );
      const restarted = await restartDaemonService();
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
    let addresses: Extract<
      DaemonMessage,
      { type: "addresses-result" }
    >["addresses"];
    try {
      addresses = collectServerAddresses();
    } catch (err) {
      logWarn(
        "instance",
        "collect addresses failed:",
        sanitizeForLog(err),
      );
      addresses = {
        privateIpv4: [],
        privateIpv6: [],
        publicIpv4: [],
        publicIpv6: [],
      };
    }

    const result: DaemonMessage = {
      type: "addresses-result",
      id: message.id,
      addresses,
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
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForRemoteHealth(
  client: InstanceClient,
  initialBackoffMs: number,
): Promise<void> {
  let waitingLogged = false;
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
    } catch {
      if (!waitingLogged) {
        logInfo(
          "instance",
          "waiting for instance to become available via",
          sanitizeForLog(client.target),
        );
        waitingLogged = true;
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
  const env = Deno.env.toObject();
  const caCertPath = resolveInstanceCaPath(env);
  const httpClient = options.httpClient ??
    await createInstanceHttpClient(config, { caCertPath });

  const client = new InstanceClient({
    ...options,
    config,
    httpClient,
    reconnectDelayMs: initialBackoffMs,
  });

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
