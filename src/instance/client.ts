import { restartDaemonService } from "./restart-daemon-service.ts";
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
  resolveInstanceUploadedTrustPath,
  resolveServerIdentityDir,
} from "./sockets.ts";
import {
  collectServerIps,
  readDefaultRouteInterfaces,
  type ServerReportedIp,
} from "../host/server-addresses.ts";
import {
  readRemoteFiles,
  resolveDefaultBranch,
} from "../deploy/release/read-remote-files.ts";
import { collectManagedLogs } from "../managed/logs.ts";
import { collectContainerLogs } from "../logs/container-tail.ts";
import type { SendCommandLogChunkFn } from "../logs/uploader.ts";
import {
  type DevSyncState,
  MANAGED_DEV_SYNC_REFUSED_REASON,
  newDevSyncState,
  resolveDevSyncSourceRoot,
} from "../dev-sync/resolve.ts";
import {
  type DevSyncApplyFn,
  getCheckoutDevSyncApply,
} from "../dev-sync/runtime.ts";
import { applyPublicUrls } from "./public-urls-apply.ts";
import { writeInstanceTunnelToken } from "../tunnels/supervisor.ts";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  sanitizeForLog,
} from "../util/logger.ts";
import { type DaemonKeyFile, loadDaemonKeyFile } from "../crypto/keys.ts";
import { readMachineKey } from "../host/machine-key.ts";
import { DaemonApiClient, DaemonApiError } from "./api-client.ts";
import {
  INSTANCE_VERSION_HEADER,
  type InstanceSupportStatus,
  instanceUnsupportedReason,
  MIN_SUPPORTED_INSTANCE_VERSION,
  resolveInstanceSupport,
} from "./version-wire.ts";
import {
  parseRehydrateDeploymentResults,
  rehydrateLocalDeployments,
} from "../deploy/rehydrate-deployments.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
import { syncHostDockerNetworking } from "../deploy/docker-networking-sync.ts";
import { runDockerSetup } from "../orchestration/ansible.ts";
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
import { collectMetricsCapabilities } from "../metrics/collector/capabilities.ts";
import type { MetricsScheduler } from "../metrics/scheduler.ts";
import { rebindMetricsScheduler } from "../metrics/scheduler.ts";
import { LiveLeaseManager } from "../metrics/live-leases.ts";
import { parseMetricsCapabilityPlan } from "../metrics/capability-plan.ts";
import {
  clearCapabilityPlan,
  writeCapabilityPlan,
} from "../metrics/collector/capability-plan-store.ts";
import {
  resolveHardwareProfile,
  writeHardwareProfile,
} from "../metrics/collector/sensors/overrides.ts";
import type { DrivetempEnableResult } from "../contracts/commands-contracts.ts";
import { resolveUpdateChannelConfig } from "../update/config.ts";
import type { UpdateInfo } from "../update/types.ts";
import {
  InsecureOverlayBaseError,
  MalformedManifestError,
  ManifestSignatureError,
  MissingChannelError,
  UnsupportedSchemaVersionError,
} from "../update/errors.ts";
import { resolveUpdate } from "../update/resolver.ts";
import {
  assertReleaseManifestUrl,
  assertUpdateDiskPreflight,
  buildRunReconcileArgs,
  ControlPlaneUpdateFailedError,
  downloadRunScript,
  encodeLicenseArg,
  executeInstanceUpdateReconcile,
  executeRunReconcile,
  reconcileNeedsRootHelper,
  resolveAutomaticUpdateTrust,
  resolveRunScriptUrl,
  restartControlPlaneUnits,
  UpdatePreflightError,
  UpdateTrustRepairError,
} from "./run-reconcile.ts";
import {
  clearActiveUpgradeContext,
  readActiveUpgradeContext,
  writeActiveUpgradeContext,
} from "./update-active-context.ts";
import {
  handleSelfUpdateAttachOutcome,
  readUpdateGuardArmed,
  readUpdateRollback,
} from "./update-guard.ts";
import { UpdateProgressReporter } from "./update-progress-reporter.ts";
import { resolvePinnedManifestUrl } from "../update/urls.ts";
import { installOriginNeedsInsecureTls } from "./install-tls.ts";
import { ManagedHaObserver } from "./ha-observe.ts";
import { AcmeIssuanceObserver } from "./acme-observe.ts";
import { InstanceAcmeRenewalScheduler } from "./instance-acme-renew.ts";
import { DAEMON_VERSION } from "../version.ts";
import { resolveDaemonCapabilities } from "./version-wire.ts";
import { TopologyReporter } from "./topology-reporter.ts";
import type { TopologySnapshot } from "../contracts/topology-types.ts";
import type {
  DaemonMessage,
  UpdateProgressStage,
} from "../contracts/cell-messages.ts";

/**
 * Secrets / transcript ports the command router needs. Structural twin of
 * `CommandRouterDeps` in `src/commands/command-router.ts` so this transport
 * module never imports handlers.
 */
export type CommandDispatchDeps = {
  decryptSecrets?: (ciphertexts: string[]) => Promise<(string | null)[]>;
  sendCommandLogChunk?: SendCommandLogChunkFn;
  rehydrateDeploymentSecrets?: (
    deployments: ReadonlyArray<{
      projectId: string;
      environmentId: string;
      generation?: number;
    }>,
  ) => Promise<
    Array<{
      projectId: string;
      environmentId: string;
      generation: number;
      secretPlan: unknown;
      variableMaterial: unknown;
    }>
  >;
};

export type CommandDispatchHandler = (
  message: Extract<DaemonMessage, { type: "command-dispatch" }>,
  ws: WebSocket,
  deps?: CommandDispatchDeps,
) => Promise<void>;

export type FabricPathProbeHandler = (
  message: Extract<DaemonMessage, { type: "fabric-paths-request" }>,
) => Promise<
  Extract<DaemonMessage, { type: "fabric-paths-result" }>["paths"]
>;

export type DrivetempEnableHandler = (
  payload: Record<string, never>,
  daemonReceivedAt: string,
) => Promise<DrivetempEnableResult>;

export type CommandPorts = {
  handleCommandDispatch?: CommandDispatchHandler;
  handleFabricPathProbe?: FabricPathProbeHandler;
  handleDrivetempEnable?: DrivetempEnableHandler;
};

let commandPorts: CommandPorts = {};

/**
 * Composition-root / test registration for command handlers. `entry/run.ts`
 * injects the real implementations so this file never imports `src/commands/`.
 */
export function registerCommandPorts(ports: CommandPorts): () => void {
  const previous = commandPorts;
  commandPorts = { ...previous, ...ports };
  return () => {
    commandPorts = previous;
  };
}

export interface InstanceClientOptions {
  config?: InstanceConfig;
  httpClient?: Deno.HttpClient;
  /** Initial reconnect delay; clamped to [DEFAULT_INITIAL_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS]. */
  reconnectDelayMs?: number;
  onMessage?: (message: DaemonMessage) => void;
  /** When set, enables host metrics on the daemon WebSocket. */
  metricsCollectorFactory?: () => MetricsCollector;
  /** When set, enables `topology-report` emission on the daemon WebSocket (see `TopologyReporter`). */
  collectTopologyFn?: () => Promise<TopologySnapshot>;
  /**
   * Checkout-sync unpack implementation. Production compile never supplies this;
   * source `main.ts` registers it via `enableCheckoutDevSync`.
   */
  applyDevSyncTarball?: DevSyncApplyFn;
  /**
   * Command-router callback. Production `entry/run.ts` supplies
   * `handleCommandDispatch`; tests use {@link registerCommandPorts}.
   */
  handleCommandDispatch?: CommandDispatchHandler;
  handleFabricPathProbe?: FabricPathProbeHandler;
  handleDrivetempEnable?: DrivetempEnableHandler;
}

export const DEFAULT_INITIAL_BACKOFF_MS = 2_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
export const PARKED_BACKOFF_MIN_MS = 5 * 60_000;
export const PARKED_BACKOFF_MAX_MS = 60 * 60_000;
/**
 * Re-check cadence while no license credentials exist on disk yet. Cheap (two
 * file reads) and short on purpose: on a self-hosted control-plane host the
 * co-located daemon starts before the install wizard has issued its license,
 * and the servers list polls every 2 s while that seat is Initializing.
 */
export const AWAITING_LICENSE_POLL_MS = 5_000;
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

/**
 * Why the connect loop is parked (no reconnect backoff, periodic re-check):
 * `permanent` — the control plane rejected enrollment/auth; `tls-trust` — the
 * platform CA does not validate the control plane; `awaiting-license` — no
 * license credentials on disk yet (install wizard / installer still to run).
 */
type ParkedKind = "permanent" | "tls-trust" | "awaiting-license";

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
  #dockerNetworkingSyncInFlight = false;
  #didCompleteDockerNetworkingSync = false;
  #parked = false;
  #parkedReason: string | undefined;
  #parkedKind: ParkedKind | undefined;
  #parkedBackoffMs = PARKED_BACKOFF_MIN_MS;
  /** Latest control-plane semver from a REST header or the attach `version` frame. */
  #instanceVersion: string | undefined;
  /**
   * Features from the latest attach `version` frame. Empty when the frame
   * omits `features` — default closed.
   */
  #peerFeatures: readonly string[] = [];
  /** Last unsupported version we already logged, so reconnects do not repeat it. */
  #loggedUnsupportedInstanceVersion: string | undefined;
  #licenseStamp: string | undefined;
  #idlePresence: IdlePresence | undefined;
  #haObserver: ManagedHaObserver | undefined;
  #acmeObserver: AcmeIssuanceObserver | undefined;
  /** Panel certificate renewal. Independent of `#acmeObserver`. */
  #instanceAcmeRenewal: InstanceAcmeRenewalScheduler | undefined;
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
  readonly #collectTopologyFn?: () => Promise<TopologySnapshot>;
  /** Created lazily once `#collectTopologyFn` is set; lives across reconnects (unlike `#liveLeases`). */
  #topologyReporter: TopologyReporter | undefined;
  readonly #applyDevSyncTarball?: DevSyncApplyFn;
  readonly #handleCommandDispatch?: CommandDispatchHandler;
  readonly #handleFabricPathProbe?: FabricPathProbeHandler;
  readonly #handleDrivetempEnable?: DrivetempEnableHandler;
  #updateInstallInProgress = false;
  #instanceUpdateInProgress = false;
  #pendingInstanceUpdateResult: DaemonMessage | null = null;
  readonly #updateProgress = new UpdateProgressReporter({
    layout: (() => {
      try {
        return resolveLayout(Deno.env.toObject());
      } catch {
        return resolveLayout();
      }
    })(),
  });
  #updateProgressWs: WebSocket | undefined;
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
    this.#collectTopologyFn = options.collectTopologyFn;
    this.#handleCommandDispatch = options.handleCommandDispatch;
    this.#handleFabricPathProbe = options.handleFabricPathProbe;
    this.#handleDrivetempEnable = options.handleDrivetempEnable;
  }

  get config(): InstanceConfig {
    return this.#config;
  }

  get target(): string {
    return describeInstance(this.#config);
  }

  /**
   * Observed control-plane version and the floor verdict. `unknown` when the
   * current peer has not reported a semver, including when a later response
   * or attach frame omits one. That is a flag, not a refusal, and the socket
   * stays up either way.
   */
  get connectionState(): {
    instanceVersion: string | null;
    instanceSupport: InstanceSupportStatus;
    minSupportedInstanceVersion: string;
    peerFeatures: readonly string[];
  } {
    const support = resolveInstanceSupport(this.#instanceVersion);
    return {
      instanceVersion: support.version,
      instanceSupport: support.status,
      minSupportedInstanceVersion: MIN_SUPPORTED_INSTANCE_VERSION,
      peerFeatures: this.#peerFeatures,
    };
  }

  /**
   * True when the attached control plane advertised `feature`. Closed when
   * the attach frame omitted `features`.
   */
  instanceSupports(feature: string): boolean {
    return this.#peerFeatures.includes(feature);
  }

  async #wireUpdateProgress(
    ws: WebSocket,
    progressId: string,
    options: { upgradeId?: string; targetCommit?: string } = {},
  ): Promise<void> {
    this.#updateProgressWs = ws;
    this.#updateProgress.setContext({
      progressId,
      upgradeId: options.upgradeId,
      canSend: () =>
        this.instanceSupports("update-progress-v1") &&
        ws.readyState === WebSocket.OPEN,
      send: (message) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(message));
        return true;
      },
    });
    await writeActiveUpgradeContext({
      progressId,
      upgradeId: options.upgradeId,
      targetCommit: options.targetCommit,
    });
  }

  #reportUpdateStage(
    stage: UpdateProgressStage,
    options: {
      upgradeId?: string;
      detail?: string;
      errorCode?: string;
      unit?: "daemon" | "instance";
    } = {},
  ): void {
    const { unit, ...rest } = options;
    this.#updateProgress.reportStage(unit ?? "daemon", stage, rest);
  }

  async #afterAttachVersion(ws: WebSocket): Promise<void> {
    const pending = this.#pendingInstanceUpdateResult;
    if (pending && ws.readyState === WebSocket.OPEN) {
      this.#pendingInstanceUpdateResult = null;
      ws.send(JSON.stringify({ ...pending, at: new Date().toISOString() }));
    }
    this.#updateProgressWs = ws;
    this.#updateProgress.setContext({
      canSend: () =>
        this.instanceSupports("update-progress-v1") &&
        ws.readyState === WebSocket.OPEN,
      send: (message) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(message));
        return true;
      },
    });
    await this.#updateProgress.flushOnAttach();
    const armed = await readUpdateGuardArmed();
    const rollback = await readUpdateRollback();
    let active = await readActiveUpgradeContext();
    if (active && !armed && !rollback && !this.#updateInstallInProgress) {
      await clearActiveUpgradeContext();
      active = null;
    }
    if (
      active?.targetCommit &&
      armed &&
      active.targetCommit !== armed.targetCommit
    ) {
      await clearActiveUpgradeContext();
      active = null;
    }
    if (active) {
      this.#updateProgress.setContext({
        progressId: active.progressId,
        upgradeId: active.upgradeId,
      });
    }
    const commit = clientTestHooks.getBuildInfo().commit;
    await handleSelfUpdateAttachOutcome({
      currentCommit: commit,
      reportStage: (stage, detail) => {
        this.#reportUpdateStage(stage, {
          upgradeId: active?.upgradeId,
          errorCode: detail?.errorCode,
          detail: detail?.detail,
        });
        if (stage === "done" || stage === "rolled-back") {
          void clearActiveUpgradeContext();
        }
      },
    });
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

  #noteInstanceVersion(reported: string | undefined | null): void {
    const trimmed = reported?.trim() ?? "";
    if (!trimmed) {
      this.#instanceVersion = undefined;
      this.#loggedUnsupportedInstanceVersion = undefined;
      return;
    }
    this.#instanceVersion = trimmed;
    const support = resolveInstanceSupport(trimmed);
    if (support.status !== "unsupported") {
      this.#loggedUnsupportedInstanceVersion = undefined;
      return;
    }
    if (this.#loggedUnsupportedInstanceVersion === support.version) return;
    this.#loggedUnsupportedInstanceVersion = support.version ?? undefined;
    logWarn("instance", instanceUnsupportedReason(support));
  }

  #noteInstanceVersionHeader(response: Response): void {
    this.#noteInstanceVersion(response.headers.get(INSTANCE_VERSION_HEADER));
  }

  /** Attach-frame advertisement. A missing or non-array field is closed. */
  #notePeerFeatures(features: unknown): void {
    if (!Array.isArray(features)) {
      this.#peerFeatures = [];
      return;
    }
    const accepted: string[] = [];
    for (const entry of features) {
      if (typeof entry === "string") accepted.push(entry);
    }
    this.#peerFeatures = accepted;
  }

  #apiClientVersionHook(): {
    onInstanceVersion: (version: string | null) => void;
  } {
    return {
      onInstanceVersion: (version) => this.#noteInstanceVersion(version),
    };
  }

  async fetchHealth(): Promise<{ ok: boolean }> {
    const response = await fetch(
      instanceUrl(this.#config, "/api/health"),
      this.#fetchInit(),
    );
    this.#noteInstanceVersionHeader(response);
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

    this.#noteInstanceVersionHeader(response);
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
    this.#noteInstanceVersionHeader(response);
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
    this.#noteInstanceVersionHeader(response);
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
    this.#ensureInstanceAcmeRenewal();
    this.#instanceAcmeRenewal?.start();
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
    this.#acmeObserver?.detach();
    this.#acmeObserver = undefined;
    this.#instanceAcmeRenewal?.stop();
    this.#instanceAcmeRenewal = undefined;
    this.#metricsScheduler?.detach();
    this.#liveLeases?.dispose();
    this.#liveLeases = undefined;
    this.#metricsScheduler = undefined;
    this.#metricsSchedulerServerId = undefined;
    this.#topologyReporter?.detach();
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
    this.#acmeObserver?.detach();
    this.#metricsScheduler?.detach();
    const classified = classifyConnectFailure(err);
    if (classified.kind === "permanent") {
      await this.#enterParkedState(classified.reason, "permanent");
    } else if (classified.kind === "tls-trust") {
      await this.#enterParkedState(classified.reason, "tls-trust");
    } else if (classified.kind === "awaiting-license") {
      await this.#enterParkedState(classified.reason, "awaiting-license");
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
    kind: ParkedKind = "permanent",
  ): Promise<void> {
    this.#parked = true;
    this.#parkedReason = reason;
    this.#parkedKind = kind;
    this.#forceEnrollPending = false;
    this.#licenseStamp = await this.#readLicenseStamp();
    if (kind === "awaiting-license") {
      // Expected on every fresh self-hosted install: not an error, and never
      // the hour-long permanent-park backoff.
      logInfo(
        "instance",
        `awaiting license credentials in ${this.#serverIdentityDir()} (self-hosted: finish the install wizard; managed server: re-run the installer with TURBOPANEL_LICENSE); re-checking every ${AWAITING_LICENSE_POLL_MS} ms`,
      );
      return;
    }
    if (kind === "tls-trust") {
      const caPath = resolveInstanceCaPath() ?? "(none)";
      const uploadedTrust = resolveInstanceUploadedTrustPath() ?? "(none)";
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
        `tls-trust: control plane certificate is not trusted (host=${
          sanitizeForLog(this.target)
        } platformCa=${caPath} fingerprint=${fingerprint} uploadedTrust=${uploadedTrust}); parked — re-run the installer so it can store the private issuer for an uploaded certificate, or pass --instance-ca for a Platform CA leaf. Bootstrap insecure TLS is not runtime trust`,
      );
      return;
    }
    logError(
      "instance",
      `daemon control-plane permanently rejected enrollment (${reason}); parked — install a fresh registration key (Add Server) or point TURBOPANEL_INSTANCE_URL at the correct control plane, then the daemon auto-recovers`,
    );
  }

  #nextParkedDelayMs(): number {
    if (this.#parkedKind === "awaiting-license") {
      return AWAITING_LICENSE_POLL_MS;
    }
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
    if (kind === "awaiting-license") {
      logInfo("instance", "license credentials found; enrolling");
      return;
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
      ...this.#apiClientVersionHook(),
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
        ...this.#apiClientVersionHook(),
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
      ...this.#apiClientVersionHook(),
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
    this.#ensureTopologyReporter();

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
    this.#ensureAcmeObserver();
    this.#acmeObserver?.attach();
    this.#instanceAcmeRenewal?.flush();
    this.#metricsScheduler?.attach((sample) =>
      this.#apiClient?.sendHostMetrics(sample) ?? Promise.resolve()
    );
    this.#topologyReporter?.attach((report) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(
        { type: "topology-report", ...report } satisfies DaemonMessage,
      ));
    });
    this.#rehydrateDeploymentSecretsAfterConnect();
    this.#syncDockerNetworkingAfterConnect();

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
      this.#peerFeatures = [];
      this.#idlePresence?.detach();
      this.#haObserver?.detach();
      this.#acmeObserver?.detach();
      this.#metricsScheduler?.detach();
      this.#topologyReporter?.detach();
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

  #ensureAcmeObserver(): void {
    if (this.#acmeObserver) return;
    this.#acmeObserver = new AcmeIssuanceObserver({
      send: (message) => {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
        this.#ws.send(JSON.stringify(message));
      },
    });
  }

  #ensureInstanceAcmeRenewal(): void {
    if (this.#instanceAcmeRenewal) return;
    this.#instanceAcmeRenewal = new InstanceAcmeRenewalScheduler({
      send: (message) => {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
        this.#ws.send(JSON.stringify(message));
        return true;
      },
    });
  }

  /** Survives reconnects (unlike `#liveLeases`) — a new session just re-attaches it to the new socket. */
  #ensureTopologyReporter(): void {
    if (!this.#collectTopologyFn || this.#topologyReporter) return;
    this.#topologyReporter = new TopologyReporter({
      collectTopology: this.#collectTopologyFn,
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
      schedulerOptions: {},
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

  /**
   * Best-effort, once per daemon session: pull the org's Docker host
   * addressing and merge it into `daemon.json` when it changed. Not tied to
   * `environment.deploy` — the pools must reach hosts that never deploy a
   * tenant workload, and applying them restarts dockerd.
   */
  #syncDockerNetworkingAfterConnect(): void {
    if (
      this.#dockerNetworkingSyncInFlight ||
      this.#didCompleteDockerNetworkingSync ||
      !this.#apiClient
    ) {
      return;
    }
    this.#dockerNetworkingSyncInFlight = true;
    const apiClient = this.#apiClient;
    clientTestHooks.syncHostDockerNetworking({
      layout: resolveLayout(Deno.env.toObject()),
      fetch: () => apiClient.fetchHostDockerNetworking(),
      apply: (descriptor, { clearAddressing }) =>
        clientTestHooks.runDockerSetup({
          addressPools: descriptor.addressPools,
          defaultBridgeCidr: descriptor.defaultBridgeCidr,
          clearAddressing,
        }),
    }).then((outcome) => {
      this.#didCompleteDockerNetworkingSync = true;
      if (outcome !== "unchanged") {
        logInfo("instance", `docker host addressing ${outcome}`);
      }
    }).catch((err) => {
      logWarn(
        "instance",
        "docker host addressing sync failed:",
        sanitizeForLog(err),
      );
    }).finally(() => {
      this.#dockerNetworkingSyncInFlight = false;
    });
  }

  // Identity is established locally (enrollment + server.id) and confirmed via
  // verified JWT `sub` in DaemonTokenManager — no socket message adopts serverId.
  #handleMessage(message: DaemonMessage, ws: WebSocket): void {
    switch (message.type) {
      case "version":
        // `commit` / `branch` stay informational — the daemon never
        // self-updates. `instanceVersion` is the control plane's semver for
        // the floor check. A frame that omits it is the current peer: clear
        // the last observation so a downgrade or pre-field control plane
        // resolves to unknown.
        this.#noteInstanceVersion(message.instanceVersion);
        this.#notePeerFeatures(message.features);
        void this.#afterAttachVersion(ws);
        break;
      case "echo":
        this.#echoMessage(message, ws);
        break;
      case "command-dispatch": {
        const dispatch = this.#resolveCommandDispatch();
        if (!dispatch) {
          logWarn("instance", "command-dispatch handler not registered");
          break;
        }
        this.#runSocketHandler(
          "command-dispatch",
          dispatch(message, ws, this.#commandRouterDeps()),
        );
        break;
      }
      case "addresses-request":
        this.#collectAddresses(message, ws);
        break;
      case "managed-logs-request":
        this.#collectManagedLogs(message, ws);
        break;
      case "metrics-live-start":
        this.#applyLiveLeaseStart(message, ws);
        break;
      case "metrics-live-stop":
        this.#applyLiveLeaseStop(message, ws);
        break;
      case "metrics-capabilities-request":
        this.#collectMetricsCapabilities(message, ws);
        break;
      case "topology-overrides-update":
        this.#applyTopologyOverridesUpdate(message, ws);
        break;
      case "capability-plan-update":
        this.#applyCapabilityPlanUpdate(message, ws);
        break;
      case "capability-plan-clear":
        this.#applyCapabilityPlanClear(message, ws);
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
      case "instance-update":
        this.#runSocketHandler(
          "instance-update",
          this.#applyInstanceUpdate(message, ws),
        );
        break;
      case "update-progress":
        break;
      default:
        logWarn(
          "instance",
          `ignored unknown websocket message type ${
            String((message as { type?: unknown }).type)
          }`,
        );
        break;
    }
  }

  #runSocketHandler(label: string, work: Promise<void>): void {
    void work.catch((err) => {
      logWarn("instance", `${label} handler failed:`, sanitizeForLog(err));
    });
  }

  #commandRouterDeps(): CommandDispatchDeps | undefined {
    const apiClient = this.#apiClient;
    if (!apiClient) return undefined;
    return {
      decryptSecrets: (ciphertexts) => apiClient.decryptSecrets(ciphertexts),
      rehydrateDeploymentSecrets: (deployments) =>
        apiClient.rehydrateDeploymentSecrets(deployments),
      sendCommandLogChunk: (params) => apiClient.sendCommandLogChunk(params),
    };
  }

  #resolveCommandDispatch(): CommandDispatchHandler | undefined {
    return this.#handleCommandDispatch ??
      clientTestHooks.handleCommandDispatch ??
      commandPorts.handleCommandDispatch;
  }

  #resolveFabricPathProbe(): FabricPathProbeHandler | undefined {
    return this.#handleFabricPathProbe ??
      clientTestHooks.handleFabricPathProbe ??
      commandPorts.handleFabricPathProbe;
  }

  #resolveDrivetempEnable(): DrivetempEnableHandler | undefined {
    return this.#handleDrivetempEnable ??
      clientTestHooks.handleDrivetempEnable ??
      commandPorts.handleDrivetempEnable;
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
      const capable = resolveDaemonCapabilities(DAEMON_VERSION)[
        "instance-cert-sources-per-hostname"
      ] === true;
      const hostnames = capable && message.hostnames ? message.hostnames : null;
      if (!hostnames) {
        logInfo(
          "public-urls",
          "instance-cert-sources: public-urls-update degrading to the flat urls list",
        );
      }
      await clientTestHooks.applyPublicUrls(
        hostnames ?? message.urls.map((host) => ({
          host,
          source: "platform-ca" as const,
        })),
        hostnames ? { instanceAcme: message.instanceAcme } : {},
      );
      ok = true;
      await this.#instanceAcmeRenewal?.check();
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
    options: {
      verified: UpdateInfo;
      manifestUrl?: string;
      upgradeId?: string;
    },
  ): Promise<boolean> {
    const env = Deno.env.toObject();
    const updateInfo = options.verified;
    const currentCommit = clientTestHooks.getBuildInfo().commit;
    if (currentCommit === updateInfo.commit) {
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

    const instanceUrl = env.TURBOPANEL_INSTANCE_URL?.trim();
    const instanceCaPath = resolveInstanceCaPath(env);
    const uploadedTrustPath = resolveInstanceUploadedTrustPath(env);
    const dlBase = env.TURBOPANEL_DL_BASE?.trim();
    const runScriptUrl = resolveRunScriptUrl(this.#config, { dlBase });
    // Automatic updates never relax TLS: public trust, the Platform CA, or
    // the private uploaded issuer — otherwise a trust-repair error (no
    // `curl -k`, and the operator release-insecure override is not consulted).
    const trust = resolveAutomaticUpdateTrust({
      runScriptUrl,
      instanceCaPath,
      uploadedTrustPath,
      originNeedsInsecureTls: installOriginNeedsInsecureTls,
    });
    const scriptCaPath = trust.kind === "public-tls" ? undefined : trust.caPath;
    // `--instance-ca` is only the Platform CA file. The uploaded issuer is
    // a different path and must not be copied onto instance-ca.pem.
    const reconcileCaPath = trust.kind === "platform-ca"
      ? trust.caPath
      : undefined;
    const licenseArg = encodeLicenseArg(
      credentials.licenseId,
      credentials.licenseToken,
    );
    const reconcileArgs = buildRunReconcileArgs({
      licenseArg,
      instanceUrl,
      instanceCaPath: reconcileCaPath,
      insecureTls: false,
      dlBase,
    });

    logInfo(
      "update",
      `reconciling via run.sh (${trust.kind})`,
      sanitizeForLog(runScriptUrl),
    );

    // Managed hosts hand the validated flags to the root helper, which
    // fetches run.sh itself; only a development host pipes a body through
    // `sudo sh -s`.
    const script = reconcileNeedsRootHelper()
      ? undefined
      : await clientTestHooks.downloadRunScript(runScriptUrl, {
        insecureTls: false,
        caPath: scriptCaPath,
      });
    const hostPin = resolvePinnedManifestUrl(env, "daemon");
    const manifestForReconcile = hostPin
      ? undefined
      : updateInfo.manifestUrl?.trim() || options.manifestUrl?.trim();
    this.#reportUpdateStage("preparing", { upgradeId: options.upgradeId });
    await clientTestHooks.executeRunReconcile({
      script,
      args: reconcileArgs,
      channel: config.channel,
      manifestUrl: manifestForReconcile,
      onStage: (stage) => {
        this.#reportUpdateStage(stage, { upgradeId: options.upgradeId });
      },
    });
    return true;
  }

  #classifyUpdateFailure(err: unknown): { error: string; errorCode?: string } {
    if (err instanceof UpdatePreflightError) {
      return { error: err.message, errorCode: err.code };
    }
    if (err instanceof UpdateTrustRepairError) {
      return {
        error: `preflight_trust: ${err.message}`,
        errorCode: "preflight_trust",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (
      err instanceof MalformedManifestError ||
      err instanceof MissingChannelError ||
      err instanceof ManifestSignatureError ||
      err instanceof UnsupportedSchemaVersionError ||
      err instanceof InsecureOverlayBaseError
    ) {
      return {
        error: `preflight_manifest: ${message}`,
        errorCode: "preflight_manifest",
      };
    }
    return { error: message };
  }

  #sendUpdateResult(
    ws: WebSocket,
    id: string,
    ok: boolean,
    error?: string,
    extra: { errorCode?: string; upgradeId?: string } = {},
  ): void {
    const result: DaemonMessage = {
      type: "update-result",
      id,
      ok,
      error,
      at: new Date().toISOString(),
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
      ...(extra.upgradeId ? { upgradeId: extra.upgradeId } : {}),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  #sendRejectedInProgressUpdate(
    ws: WebSocket,
    message: Extract<DaemonMessage, { type: "update" }>,
  ): void {
    const upgradeId = message.upgradeId?.trim() || undefined;
    const error = "preflight_in_progress: update already in progress";
    if (
      this.instanceSupports("update-progress-v1") &&
      ws.readyState === WebSocket.OPEN
    ) {
      const progress: DaemonMessage = {
        type: "update-progress",
        id: message.id,
        unit: "daemon",
        stage: "failed",
        at: new Date().toISOString(),
        errorCode: "preflight_in_progress",
        detail: "update already in progress",
        ...(upgradeId ? { upgradeId } : {}),
      };
      ws.send(JSON.stringify(progress));
    }
    this.#sendUpdateResult(ws, message.id, false, error, {
      errorCode: "preflight_in_progress",
      upgradeId,
    });
  }

  async #applyUpdate(
    message: Extract<DaemonMessage, { type: "update" }>,
    ws: WebSocket,
  ): Promise<void> {
    // Long-running reconcile + restart runs here; the instance queues the request
    // and returns immediately — this path is decoupled from that HTTP lifecycle.
    if (this.#updateInstallInProgress) {
      this.#sendRejectedInProgressUpdate(ws, message);
      return;
    }

    this.#updateInstallInProgress = true;
    const upgradeId = message.upgradeId?.trim() || undefined;
    const targetCommit = message.targetCommit?.trim() || undefined;
    await this.#wireUpdateProgress(ws, message.id, { upgradeId, targetCommit });
    let ok = false;
    let shouldRestart = false;
    let error: string | undefined;
    let errorCode: string | undefined;
    try {
      await clientTestHooks.assertUpdateDiskPreflight();

      const config = this.#resolveUpdateConfigForMessage(message);
      const env = Deno.env.toObject();
      const messageManifest = resolvePinnedManifestUrl(env, "daemon")
        ? undefined
        : message.manifestUrl?.trim() || undefined;
      if (messageManifest) {
        assertReleaseManifestUrl("daemon", messageManifest, "manifestUrl");
      }
      const resolveEnv = messageManifest
        ? { ...env, TURBOPANEL_MANIFEST_URL: messageManifest }
        : env;

      const verified = await clientTestHooks.resolveUpdate(config, resolveEnv);
      if (targetCommit && verified.commit !== targetCommit) {
        throw new UpdatePreflightError(
          "preflight_manifest",
          `signed manifest commit ${verified.commit} does not match targetCommit ${targetCommit}`,
        );
      }
      await this.#wireUpdateProgress(ws, message.id, {
        upgradeId,
        targetCommit: verified.commit,
      });

      const runScriptUrl = resolveRunScriptUrl(this.#config, {
        dlBase: env.TURBOPANEL_DL_BASE?.trim(),
      });
      const instanceCaPath = resolveInstanceCaPath(env);
      const uploadedTrustPath = resolveInstanceUploadedTrustPath(env);
      resolveAutomaticUpdateTrust({
        runScriptUrl,
        instanceCaPath,
        uploadedTrustPath,
        originNeedsInsecureTls: installOriginNeedsInsecureTls,
      });

      shouldRestart = await this.#reconcileToLatestUpdate(config, {
        verified,
        manifestUrl: messageManifest,
        upgradeId,
      });
      ok = true;
    } catch (err) {
      const classified = this.#classifyUpdateFailure(err);
      error = classified.error;
      errorCode = classified.errorCode;
      this.#reportUpdateStage("failed", {
        upgradeId,
        errorCode: classified.errorCode,
        detail: error,
      });
      logError("update", "failed:", sanitizeForLog(error));
    }

    if (ok && shouldRestart) {
      this.#reportUpdateStage("restarting", { upgradeId });
      await this.#updateProgress.flush();
      await new Promise((resolve) =>
        setTimeout(resolve, clientTestHooks.updateResultHandoffDelayMs)
      );
      const restarted = await clientTestHooks.restartDaemonService();
      if (!restarted) {
        ok = false;
        error = "daemon restart failed after reconcile";
        errorCode = "restart_failed";
        this.#reportUpdateStage("failed", {
          upgradeId,
          errorCode,
          detail: error,
        });
        logWarn(
          "update",
          "reconcile succeeded but systemd restart failed; daemon may still be on old code",
        );
      }
    } else if (ok && !shouldRestart) {
      this.#reportUpdateStage("done", { upgradeId });
    }

    await this.#updateProgress.flush();
    if (!ok || !shouldRestart) {
      await clearActiveUpgradeContext();
    }
    this.#sendUpdateResult(ws, message.id, ok, error, { errorCode, upgradeId });

    this.#updateInstallInProgress = false;
  }

  #sendInstanceUpdateResult(
    ws: WebSocket,
    id: string,
    ok: boolean,
    error?: string,
    extra: { errorCode?: string; upgradeId?: string } = {},
  ): void {
    const result: DaemonMessage = {
      type: "instance-update-result",
      id,
      ok,
      error,
      at: new Date().toISOString(),
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
      ...(extra.upgradeId ? { upgradeId: extra.upgradeId } : {}),
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result));
      return;
    }
    this.#pendingInstanceUpdateResult = result;
  }

  async #applyInstanceUpdate(
    message: Extract<DaemonMessage, { type: "instance-update" }>,
    ws: WebSocket,
  ): Promise<void> {
    if (this.#instanceUpdateInProgress) {
      const upgradeId = message.upgradeId?.trim() || undefined;
      const error =
        "preflight_in_progress: control-plane update already in progress";
      if (
        this.instanceSupports("update-progress-v1") &&
        ws.readyState === WebSocket.OPEN
      ) {
        const progress: DaemonMessage = {
          type: "update-progress",
          id: message.id,
          unit: "instance",
          stage: "failed",
          at: new Date().toISOString(),
          errorCode: "preflight_in_progress",
          detail: "control-plane update already in progress",
          ...(upgradeId ? { upgradeId } : {}),
        };
        ws.send(JSON.stringify(progress));
      }
      this.#sendInstanceUpdateResult(ws, message.id, false, error, {
        errorCode: "preflight_in_progress",
        upgradeId,
      });
      return;
    }

    this.#instanceUpdateInProgress = true;
    const upgradeId = message.upgradeId?.trim() || undefined;
    let ok = false;
    let error: string | undefined;
    let errorCode: string | undefined;
    try {
      const env = Deno.env.toObject();
      const channel = message.channel?.trim() ||
        resolveUpdateChannelConfig(env).channel;
      // An env pin holds a package. A panel click must not replace it with
      // the floating channel URL. The message supplies the pin only when
      // the host has none.
      const messageInstancePin = message.manifestUrl?.trim() || undefined;
      const messageUiPin = message.uiManifestUrl?.trim() || undefined;
      if (messageInstancePin) {
        assertReleaseManifestUrl("instance", messageInstancePin, "manifestUrl");
      }
      if (messageUiPin) {
        assertReleaseManifestUrl("ui", messageUiPin, "uiManifestUrl");
      }
      const instancePin = resolvePinnedManifestUrl(env, "instance") ||
        messageInstancePin;
      const uiPin = resolvePinnedManifestUrl(env, "ui") || messageUiPin;
      await this.#wireUpdateProgress(ws, message.id, {
        upgradeId,
        targetCommit: message.targetCommit?.trim() || undefined,
      });
      await clientTestHooks.executeInstanceUpdateReconcile({
        channel,
        ...(instancePin ? { manifestUrl: instancePin } : {}),
        ...(uiPin ? { uiManifestUrl: uiPin } : {}),
        ...(message.targetVersion
          ? { targetVersion: message.targetVersion }
          : {}),
        ...(message.targetCommit ? { targetCommit: message.targetCommit } : {}),
        ...(upgradeId ? { upgradeId } : {}),
        onStage: (stage) => {
          this.#reportUpdateStage(stage, { unit: "instance", upgradeId });
        },
      });
      ok = true;
    } catch (err) {
      const classified = this.#classifyControlPlaneUpdateFailure(err);
      error = classified.error;
      errorCode = classified.errorCode;
      const stage = err instanceof ControlPlaneUpdateFailedError
        ? err.stage
        : "failed";
      this.#reportUpdateStage(stage, {
        unit: "instance",
        upgradeId,
        errorCode,
        detail: error,
      });
      logError("update", "control-plane update failed:", sanitizeForLog(error));
    }

    await this.#updateProgress.flush();
    this.#sendInstanceUpdateResult(ws, message.id, ok, error, {
      errorCode,
      upgradeId,
    });
    this.#instanceUpdateInProgress = false;
  }

  #classifyControlPlaneUpdateFailure(
    err: unknown,
  ): { error: string; errorCode?: string } {
    if (err instanceof ControlPlaneUpdateFailedError) {
      return { error: err.message, errorCode: err.code };
    }
    if (err instanceof UpdatePreflightError) {
      return { error: err.message, errorCode: err.code };
    }
    if (
      err instanceof MalformedManifestError ||
      err instanceof MissingChannelError ||
      err instanceof ManifestSignatureError ||
      err instanceof UnsupportedSchemaVersionError ||
      err instanceof InsecureOverlayBaseError
    ) {
      const message = err.message;
      return {
        error: `preflight_manifest: ${message}`,
        errorCode: "preflight_manifest",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
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
    let capabilities: Record<string, unknown> | undefined;
    let error: string | undefined;
    try {
      capabilities = await clientTestHooks
        .collectMetricsCapabilities() as Record<string, unknown>;
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
      ok: error === undefined,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(error === undefined ? {} : { error }),
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

  #applyTopologyOverridesUpdate(
    message: Extract<
      DaemonMessage,
      { type: "topology-overrides-update" }
    >,
    ws: WebSocket,
  ): void {
    void this.#applyTopologyOverridesUpdateAsync(message, ws);
  }

  async #applyTopologyOverridesUpdateAsync(
    message: Extract<
      DaemonMessage,
      { type: "topology-overrides-update" }
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

      // A pushed nicSlot*/hostingFilesystemId override can reassign a slot
      // without changing any identity set — only the resolved SlotMapping
      // reflects that (see `../metrics/topology/generation.ts`). Force a
      // recompute now rather than waiting for the next scheduled tick.
      void this.#topologyReporter?.reportNow();

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
          const enable = this.#resolveDrivetempEnable();
          if (enable) {
            drivetemp = await enable(
              {},
              new Date().toISOString(),
            );
          }
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
      type: "topology-overrides-update-result",
      id: message.id,
      ok,
      ...(error === undefined ? {} : { error }),
      ...(drivetemp === undefined ? {} : { drivetemp }),
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  #applyCapabilityPlanUpdate(
    message: Extract<
      DaemonMessage,
      { type: "capability-plan-update" }
    >,
    ws: WebSocket,
  ): void {
    void this.#applyCapabilityPlanUpdateAsync(message, ws);
  }

  async #applyCapabilityPlanUpdateAsync(
    message: Extract<
      DaemonMessage,
      { type: "capability-plan-update" }
    >,
    ws: WebSocket,
  ): Promise<void> {
    let ok = false;
    let error: string | undefined;
    try {
      const plan = parseMetricsCapabilityPlan(message.plan);
      if (!plan) {
        throw new TypeError("invalid capability plan");
      }
      if (
        typeof message.generation !== "number" ||
        !Number.isInteger(message.generation) ||
        message.generation < 0
      ) {
        throw new TypeError("invalid capability plan generation");
      }
      await writeCapabilityPlan(
        resolveLayout(Deno.env.toObject()).daemonStateDir,
        plan,
        message.generation,
      );
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn(
        "instance",
        "capability plan update failed:",
        sanitizeForLog(err),
      );
    }

    const result: DaemonMessage = {
      type: "capability-plan-update-result",
      id: message.id,
      ok,
      ...(error === undefined ? {} : { error }),
      at: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
  }

  #applyCapabilityPlanClear(
    message: Extract<
      DaemonMessage,
      { type: "capability-plan-clear" }
    >,
    ws: WebSocket,
  ): void {
    void this.#applyCapabilityPlanClearAsync(message, ws);
  }

  async #applyCapabilityPlanClearAsync(
    message: Extract<
      DaemonMessage,
      { type: "capability-plan-clear" }
    >,
    ws: WebSocket,
  ): Promise<void> {
    let ok = false;
    let error: string | undefined;
    try {
      await clearCapabilityPlan(
        resolveLayout(Deno.env.toObject()).daemonStateDir,
      );
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logWarn(
        "instance",
        "capability plan clear failed:",
        sanitizeForLog(err),
      );
    }

    const result: DaemonMessage = {
      type: "capability-plan-clear-result",
      id: message.id,
      ok,
      ...(error === undefined ? {} : { error }),
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
      const probe = this.#resolveFabricPathProbe();
      if (!probe) {
        throw new Error("fabric path probe handler not registered");
      }
      paths = await probe(message);
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
  assertUpdateDiskPreflight: typeof assertUpdateDiskPreflight;
  executeInstanceUpdateReconcile: typeof executeInstanceUpdateReconcile;
  restartControlPlaneUnits: typeof restartControlPlaneUnits;
  collectServerIps: typeof collectServerIps;
  collectMetricsCapabilities: typeof collectMetricsCapabilities;
  handleCommandDispatch?: CommandDispatchHandler;
  handleFabricPathProbe?: FabricPathProbeHandler;
  handleDrivetempEnable?: DrivetempEnableHandler;
  writeInstanceTunnelToken: typeof writeInstanceTunnelToken;
  applyPublicUrls: typeof applyPublicUrls;
  rehydrateLocalDeployments: typeof rehydrateLocalDeployments;
  syncHostDockerNetworking: typeof syncHostDockerNetworking;
  runDockerSetup: typeof runDockerSetup;
  /** Override UPDATE_RESULT_HANDOFF_DELAY_MS for host-free update tests. */
  updateResultHandoffDelayMs: number;
};

let clientTestHooks: ClientTestHooks = {
  restartDaemonService,
  resolveUpdate,
  getBuildInfo,
  downloadRunScript,
  executeRunReconcile,
  assertUpdateDiskPreflight,
  executeInstanceUpdateReconcile,
  restartControlPlaneUnits,
  collectServerIps,
  collectMetricsCapabilities,
  writeInstanceTunnelToken,
  applyPublicUrls,
  rehydrateLocalDeployments,
  syncHostDockerNetworking,
  runDockerSetup,
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
