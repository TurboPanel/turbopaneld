import {
  createInstanceHttpClient,
  describeInstance,
  type InstanceConfig,
  instanceUrl,
  instanceWebSocketUrl,
  resolveInstanceConfig,
} from "./paths.ts";
import { collectServerAddresses } from "../server-addresses.ts";
import {
  applyDevSyncTarball,
  type DevSyncState,
  newDevSyncState,
} from "../dev-sync-apply.ts";
import { applyPublicUrls } from "./public-urls-apply.ts";
import { writeInstanceTunnelToken } from "../tunnels.ts";
import { logDebug, logError, logInfo, logWarn } from "../logger.ts";
import { type DaemonKeyFile, loadDaemonKeyFile } from "../crypto/keys.ts";
import { DaemonApiClient } from "./api-client.ts";
import { DaemonTokenManager } from "./token-manager.ts";
import { enrollDaemon } from "./enroll.ts";
import { decodeBase64 } from "@std/encoding/base64";
import { getBuildInfo } from "../build-info.ts";
import {
  PRESENCE_HEARTBEAT_MS,
  PresenceSession,
} from "./presence-session.ts";
import { resolveUpdateChannelConfig } from "../update/config.ts";
import { resolveUpdate } from "../update/resolver.ts";
import {
  buildRunReconcileArgs,
  downloadRunScript,
  encodeLicenseArg,
  executeRunReconcile,
  resolveRunScriptUrl,
} from "./run-reconcile.ts";

/** Chained replace pattern Sonar S5145 recognizes for log-injection sanitization. */
function stripLogInjection(text: string): string {
  return text.replaceAll("\n", "_").replaceAll("\r", "_").replaceAll("\t", "_");
}

function sanitizeForLog(value: unknown): string {
  if (value instanceof Error) return stripLogInjection(value.message);
  if (typeof value === "string") return stripLogInjection(value);
  try {
    return stripLogInjection(JSON.stringify(value) ?? String(value));
  } catch {
    return stripLogInjection(String(value));
  }
}

type DaemonMessage =
  | { type: "echo"; payload: unknown; at: string }
  | { type: "version"; commit: string; branch: string; at: string }
  | { type: "command"; id: string; command: string; at: string }
  | {
    type: "command-result";
    id: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    at: string;
  }
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
  };

export interface InstanceClientOptions {
  config?: InstanceConfig;
  httpClient?: Deno.HttpClient;
  /** Initial reconnect delay; doubles on failure up to {@link DEFAULT_MAX_BACKOFF_MS}. */
  reconnectDelayMs?: number;
  onMessage?: (message: DaemonMessage) => void;
}

const DEFAULT_INITIAL_BACKOFF_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
/** Co-located install wait: poll readiness on a fixed cadence before first connect. */
const INSTALL_READINESS_POLL_MS = 5_000;
/** Stale-check interval; daemon sends presence heartbeat every 60s. */
const INSTANCE_PING_MS = 15_000;
/** Allow two heartbeat cadences plus jitter before forcing reconnect. */
const INSTANCE_STALE_MS = PRESENCE_HEARTBEAT_MS * 2 + 30_000;
/** After a prior session, wait for the instance to come back after systemd restart. */
const INSTANCE_RESTART_WAIT_MS = 120_000;

const SERVER_ID_FILE = "server.id";
const SERVER_KEY_FILE = "server-key.json";
const KEY_ID_FILE = "server-key-id";
const DEFAULT_SERVER_ID_DIR = "/opt/turbopanel/platform/daemon/state";

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

function resolveServerIdDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_DAEMON_STATE_DIR?.trim();
  if (override) return stripTrailingSlash(override);

  if (isTruthyFlag(env.TURBOPANEL_SKIP_ORCHESTRATION)) {
    return stripTrailingSlash(Deno.cwd());
  }

  return DEFAULT_SERVER_ID_DIR;
}

function resolveServerIdPath(): string {
  return `${resolveServerIdDir()}/${SERVER_ID_FILE}`;
}

export function resolveServerKeyPath(): string {
  return `${resolveServerIdDir()}/${SERVER_KEY_FILE}`;
}

async function readMachineId(): Promise<string | undefined> {
  try {
    const id = await Deno.readTextFile("/etc/machine-id");
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
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
  #tokenManager: DaemonTokenManager | undefined;
  #apiClient: DaemonApiClient | undefined;
  #tokenServerId: string | undefined;
  #tokenKeyId: string | undefined;
  #forceEnrollPending = false;
  #presenceSession: PresenceSession | undefined;
  #updateInstallInProgress = false;

  constructor(options: InstanceClientOptions = {}) {
    this.#config = options.config ?? resolveInstanceConfig();
    this.#httpClient = options.httpClient;
    this.#initialBackoffMs = options.reconnectDelayMs ??
      DEFAULT_INITIAL_BACKOFF_MS;
    this.#maxBackoffMs = DEFAULT_MAX_BACKOFF_MS;
    this.#backoffMs = this.#initialBackoffMs;
    this.#onMessage = options.onMessage;
    // TODO(deferred): daemon-side SQLite monitoring store will subscribe to
    // sentinel.onTransition() and sentinel.buildHeartbeat() here.
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
        await delay(INSTALL_READINESS_POLL_MS);
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
    this.#presenceSession?.detach();
    this.#presenceSession = undefined;
    this.#tokenManager?.stop();
    this.#ws?.close();
    this.#ws = undefined;
  }

  send(message: DaemonMessage): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("instance websocket is not connected");
    }
    this.#ws.send(JSON.stringify(message));
  }

  async #runConnectLoop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#connectOnce();
      } catch (err) {
        const logConnectFailure = this.#hadStableSession ? logWarn : logDebug;
        logConnectFailure(
          "instance",
          "websocket connect failed:",
          sanitizeForLog(err),
        );
        this.#closeActiveSocket();
        this.#presenceSession?.detach();
        this.#increaseBackoff();
      }

      if (this.#stopped) break;
      logDebug(
        "instance",
        "reconnect scheduled in",
        this.#backoffMs,
        "ms via",
        sanitizeForLog(this.target),
      );
      await delay(this.#backoffMs);
    }
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

  async #connectOnce(): Promise<void> {
    await this.#waitForConnectPreconditions();

    // Do not close the active socket here: by the time #connectOnce() is called
    // from #runConnectLoop(), the previous socket has already closed naturally
    // (the loop awaits #connectOnce() which blocks until the 'close' event).
    // Calling #closeActiveSocket() here would kill a healthy connection on every
    // reconnect cycle, producing a perpetual ~2-second disconnect/reconnect storm.

    const stateDir = resolveServerIdDir();
    const [loadedKeyFile, loadedServerId, loadedKeyId, machineId] =
      await Promise.all([
        readDaemonKeyFile(),
        readServerId(),
        readKeyId(),
        readMachineId(),
      ]);
    const hostname = Deno.hostname();

    let keyFile = loadedKeyFile;
    let serverId = loadedServerId;
    let keyId = loadedKeyId;
    const needsEnrollment = this.#forceEnrollPending || keyFile === null ||
      !serverId || !keyId;
    if (needsEnrollment) {
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
        machineId,
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
    }

    if (keyFile === null || !serverId || !keyId) {
      throw new Error(
        "daemon identity incomplete after enrollment/auth bootstrap",
      );
    }

    if (
      !this.#tokenManager ||
      !this.#apiClient ||
      this.#tokenServerId !== serverId ||
      this.#tokenKeyId !== keyId
    ) {
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
        machineId,
        hostname,
        apiClient,
      });
      tokenManagerRef = tokenManager;
      this.#tokenManager = tokenManager;
      this.#apiClient = apiClient;
      this.#tokenServerId = serverId;
      this.#tokenKeyId = keyId;
    }

    const jwt = await this.#tokenManager.getToken();
    const ws = this.#newWebSocket(jwt);
    this.#ws = ws;
    let sessionRegistered = false;
    this.#ensurePresenceSession(serverId);

    await new Promise<void>((resolve, reject) => {
      const fail = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
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

    logDebug(
      "instance",
      "websocket connected via",
      sanitizeForLog(this.target),
    );

    sessionRegistered = true;
    this.#hadStableSession = true;
    this.#resetBackoff();
    this.#presenceSession?.attach(ws);

    let lastInboundAt = Date.now();
    const staleTimer = setInterval(() => {
      const lastAck = this.#presenceSession?.lastHeartbeatAckAt ?? lastInboundAt;
      if (Date.now() - lastAck > INSTANCE_STALE_MS) {
        logWarn(
          "instance",
          "no websocket traffic from instance; closing to reconnect",
        );
        try {
          ws.close();
        } catch {
          // Socket may already be gone.
        }
      }
    }, INSTANCE_PING_MS);

    ws.onmessage = (event) => {
      lastInboundAt = Date.now();
      const raw = typeof event.data === "string"
        ? event.data
        : String(event.data);

      let parsed: { type?: string } | null = null;
      try {
        parsed = JSON.parse(raw) as { type?: string };
      } catch {
        // handled below
      }

      if (parsed?.type === "heartbeat-ack") {
        this.#presenceSession?.handleHeartbeatAck();
        return;
      }

      const message = parseMessage(raw);
      if (!message) {
        logWarn("instance", "ignored non-JSON websocket message");
        return;
      }

      this.#onMessage?.(message);
      this.#handleMessage(message, ws);
    };

    ws.onclose = (event) => {
      clearInterval(staleTimer);
      if (event.code === 4401) {
        logWarn("instance", "authentication rejected");
      }
      if (sessionRegistered) {
        logInfo("instance", "websocket closed after registration");
      } else {
        logDebug("instance", "websocket closed before registration");
      }
      if (this.#ws === ws) this.#ws = undefined;
      this.#presenceSession?.detach();
    };

    const closeEvent = await new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (event) => resolve(event as CloseEvent), {
        once: true,
      });
    });
    clearInterval(staleTimer);
    if (closeEvent.code === 4401) {
      await this.#tokenManager?.refresh();
    }

    if (sessionRegistered) {
      this.#resetBackoff();
    } else {
      this.#increaseBackoff();
    }
  }

  #ensurePresenceSession(serverId: string): void {
    if (this.#presenceSession && this.#tokenServerId === serverId) {
      return;
    }

    this.#presenceSession?.detach();
    this.#presenceSession = new PresenceSession({ serverId });
  }

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
      case "command":
        this.#runCommand(message, ws).catch((err) => {
          logWarn(
            "instance",
            "command handler failed:",
            sanitizeForLog(err),
          );
        });
        break;
      case "addresses-request":
        this.#collectAddresses(message, ws);
        break;
      case "dev-sync-begin":
        this.#devSync.set(message.id, newDevSyncState(message.totalChunks));
        break;
      case "dev-sync-chunk": {
        const state = this.#devSync.get(message.id);
        if (state) state.chunks[message.index] = message.data;
        break;
      }
      case "dev-sync-end":
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
        this.#applyUpdate(message, ws).catch((err) => {
          logWarn("instance", "update handler failed:", sanitizeForLog(err));
        });
        break;
    }
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

    // Restart only after acking success, so the instance sees the result before
    // this process is replaced by the freshly-synced build.
    if (ok) await restartDaemonService();
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

  async #applyUpdate(
    message: Extract<DaemonMessage, { type: "update" }>,
    ws: WebSocket,
  ): Promise<void> {
    if (this.#updateInstallInProgress) {
      const busy: DaemonMessage = {
        type: "update-result",
        id: message.id,
        ok: false,
        error: "update already in progress",
        at: new Date().toISOString(),
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(busy));
      return;
    }

    this.#updateInstallInProgress = true;
    let ok = false;
    let shouldRestart = false;
    let error: string | undefined;
    try {
      let config = resolveUpdateChannelConfig(Deno.env.toObject());
      const msgChannel = message.channel?.trim();
      if (msgChannel) {
        try {
          config = resolveUpdateChannelConfig({
            ...Deno.env.toObject(),
            TURBOPANEL_UPDATE_CHANNEL: msgChannel,
          });
        } catch {
          // fall back to env default when message.channel is invalid
        }
      }

      const updateInfo = await resolveUpdate(config);

      if (getBuildInfo().commit === updateInfo.commit) {
        logInfo(
          "update",
          "already on current commit",
          sanitizeForLog(updateInfo.commit),
        );
        ok = true;
      } else {
        const credentials = await readLicenseCredentials();
        if (!credentials.licenseId || !credentials.licenseToken) {
          throw new Error(
            "license credentials missing; re-run the installer with --license",
          );
        }

        const env = Deno.env.toObject();
        const instanceUrl = env.TURBOPANEL_INSTANCE_URL?.trim();
        const instanceCaPath = env.TURBOPANEL_INSTANCE_CA?.trim();
        const insecureTls = env.TURBOPANEL_RELEASE_TLS_INSECURE === "1";
        const licenseArg = encodeLicenseArg(
          credentials.licenseId,
          credentials.licenseToken,
        );
        const runScriptUrl = resolveRunScriptUrl(this.#config);
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

        const script = await downloadRunScript(runScriptUrl, insecureTls);
        await executeRunReconcile({
          script,
          args: reconcileArgs,
          channel: config.channel,
        });
        ok = true;
        shouldRestart = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logError("update", "failed:", sanitizeForLog(error));
    } finally {
      if (!shouldRestart) {
        this.#updateInstallInProgress = false;
      }
    }

    const result: DaemonMessage = {
      type: "update-result",
      id: message.id,
      ok,
      error,
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));

    // Restart only after acking success, so the instance sees the result before
    // this process is replaced by the updated binary.
    if (ok && shouldRestart) await restartDaemonService();
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

  /**
   * Run a shell command requested by the instance and stream the result back.
   *
   * TEMPORARY: this executes arbitrary shell commands with the daemon's full
   * privileges and has no auth. It exists only for the dev-only developer panel.
   */
  async #runCommand(
    message: Extract<DaemonMessage, { type: "command" }>,
    ws: WebSocket,
  ): Promise<void> {
    logInfo("instance", "run command:", stripLogInjection(message.command));
    let result: Extract<DaemonMessage, { type: "command-result" }>;
    try {
      const command = new Deno.Command("sh", {
        args: ["-c", message.command],
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stdout, stderr } = await command.output();
      result = {
        type: "command-result",
        id: message.id,
        exitCode: code,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
        at: new Date().toISOString(),
      };
    } catch (err) {
      result = {
        type: "command-result",
        id: message.id,
        exitCode: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      };
    }

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

function isColocatedSocketMode(config: InstanceConfig): boolean {
  return config.kind === "socket";
}

/** Ask systemd to restart this daemon (used after a dev-sync swap). */
async function restartDaemonService(): Promise<void> {
  const unit = Deno.env.get("TURBOPANEL_SERVICE_NAME")?.trim() ||
    "turbopanel-daemon";
  try {
    const result = await new Deno.Command("systemctl", {
      args: ["restart", unit],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      const safeUnit = stripLogInjection(unit);
      const safeStderr = stripLogInjection(
        new TextDecoder().decode(result.stderr).trim() || "unknown error",
      );
      logWarn("dev-sync", "systemctl restart", safeUnit, "failed:", safeStderr);
    }
  } catch (err) {
    logWarn("dev-sync", "restart failed:", sanitizeForLog(err));
  }
}

export async function connectInstance(
  options: InstanceClientOptions = {},
): Promise<InstanceClient> {
  const initialBackoffMs = options.reconnectDelayMs ??
    DEFAULT_INITIAL_BACKOFF_MS;
  const config = options.config ?? resolveInstanceConfig();
  const httpClient = options.httpClient ??
    await createInstanceHttpClient(config, {
      caCertPath: Deno.env.get("TURBOPANEL_INSTANCE_CA")?.trim() || undefined,
    });

  const client = new InstanceClient({
    ...options,
    config,
    httpClient,
    reconnectDelayMs: initialBackoffMs,
  });

  const socketMode = isColocatedSocketMode(config);

  if (socketMode) {
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
      await delay(INSTALL_READINESS_POLL_MS);
    }
  } else {
    let waitingLogged = false;
    let readyLogged = false;
    let backoffMs = initialBackoffMs;

    while (true) {
      try {
        await client.fetchHealth();
        if (!readyLogged) {
          logInfo(
            "instance",
            "instance available via",
            sanitizeForLog(client.target),
          );
          readyLogged = true;
        }
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
        await delay(backoffMs);
        backoffMs = nextBackoffMs(backoffMs, DEFAULT_MAX_BACKOFF_MS);
      }
    }
  }

  client.start();
  return client;
}

export type { DaemonMessage };
export { readKeyId, writeKeyId };
