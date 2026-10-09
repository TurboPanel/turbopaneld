import {
  decideDockerMonitorAttach,
  dockerBinaryPresent,
  DockerClient,
  DockerMonitor,
} from "../docker/index.ts";
import { connectInstance } from "../instance/client.ts";
import { handleCommandDispatch } from "../commands/command-router.ts";
import { handleDrivetempEnable } from "../commands/drivetemp.ts";
import {
  handleFabricPathProbe,
  reinstallFabricForwardingIfEnabled,
  restoreFabricFromPersistedState,
} from "../commands/fabric.ts";
import { reinstallFirewallForwardingIfEnabled } from "../firewall/apply.ts";
import { recoverInterruptedRestores } from "../backups/copy-restore.ts";
import { reconcileSitePhpRuntimesAtBoot } from "../deploy/site/php-runtime-apply.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { reportLiveReleaseLinks } from "../deploy/release/live-release-scan.ts";
import { guardHostingCaddySites } from "../deploy/ingress.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { applyBootHold, BootHoldLocalRetry } from "../managed/boot-hold.ts";
import { DemotedMemberGuard } from "../managed/demoted-guard.ts";
import { ManagedEngineExitGuard } from "../managed/engine-exit-guard.ts";
import {
  classifyHostBootRecord,
  type HostBootKind,
  markHostCleanShutdown,
  recordHostBootPersist,
} from "../managed/host-boot.ts";
import { repairProxySqlFrontendAtBoot } from "../managed/proxysql-boot-repair.ts";
import { createSentinel, type SentinelOptions } from "../monitor/index.ts";
import type { ServiceRunState } from "../contracts/service-run-state.ts";
import { setServiceRunStateSource } from "../host/service-run-state.ts";
import { stopCrashLoopingContainer } from "../monitor/crash-loop-guard.ts";
import { fetchContainerLastLogLine } from "../monitor/service-run-state.ts";
import {
  initOrchestration,
  shouldConnectToInstance,
  shouldEnableDockerIntegration,
} from "../orchestration/setup.ts";
import {
  createMetricsCollector,
  stopHostStorageSamplers,
} from "../metrics/collector/index.ts";
import { collectTopology } from "../metrics/topology/topology.ts";
import { startTunnels } from "../tunnels/supervisor.ts";

/** Minimal Docker HTTP client surface used at daemon startup. */
export type DockerClientLike = {
  ping(): Promise<boolean>;
  close(): void;
};

/** Minimal Docker monitor surface used at daemon startup. */
export type DockerMonitorLike = {
  subscribeReachability(cb: (reachable: boolean) => void): void;
};

/** Minimal sentinel surface used at daemon startup. */
export type SentinelLike = {
  start(signal: AbortSignal): void;
  stop(): void;
  /** Per-service run state for the presence channel; absent on test doubles. */
  serviceRunStates?(): ServiceRunState[] | undefined;
};

// Global for shutdown cleanup: P1-2 fix boot-hold local retry timer.
let bootHoldRetry: { stop(): void } | undefined;
let demotedMemberGuard: { stop(): void } | undefined;
let engineExitGuard: { stop(): void } | undefined;

export type DaemonRunIo = {
  initOrchestration?: () => Promise<boolean>;
  restoreFabricFromPersistedState?: () => Promise<void>;
  /** Boot-time live-release link scan; defaults to {@link scanLiveReleases}. */
  scanLiveReleases?: () => Promise<void>;
  /** Set aside hosting Caddy snippets it cannot load; defaults to {@link guardHostingSites}. */
  guardHostingCaddySites?: () => Promise<void>;
  /** Hold HA primaries after an unclean host restart; defaults to {@link applyManagedBootHoldAtStart}. */
  applyManagedBootHold?: () => Promise<void>;
  /** Stamp a clean shutdown for the next start; defaults to {@link markCleanShutdown}. */
  markCleanShutdown?: () => Promise<void>;
  /** Boot-time ProxySQL frontend repair; defaults to {@link repairProxySqlFrontendAtBoot}. */
  repairProxySqlFrontend?: () => Promise<unknown>;
  reinstallFabricForwardingIfEnabled?: () => Promise<void>;
  reinstallFirewallForwardingIfEnabled?: () => Promise<void>;
  /** Start any per-site PHP runtime that is installed but not running. */
  reconcileSitePhpRuntimes?: () => Promise<void>;
  /** Start containers a restore stopped before the daemon died. */
  recoverInterruptedRestores?: () => Promise<unknown>;
  shouldEnableDockerIntegration?: () => boolean;
  shouldConnectToInstance?: () => boolean;
  createDockerClient?: () => DockerClientLike;
  dockerBinaryPresent?: () => Promise<boolean>;
  decideDockerMonitorAttach?: typeof decideDockerMonitorAttach;
  createDockerMonitor?: (client: DockerClientLike) => DockerMonitorLike;
  createSentinel?: (opts: SentinelOptions) => SentinelLike;
  startTunnels?: (signal: AbortSignal) => Promise<void>;
  connectInstance?: (opts: {
    metricsCollectorFactory: () => unknown;
    collectTopologyFn: () => unknown;
  }) => Promise<{ stop(): void }>;
  createMetricsCollector?: () => unknown;
  collectTopology?: () => unknown;
  /**
   * Stop the host-storage samplers (the directory-usage walker and the Docker
   * `/system/df` poller) on shutdown. They are started lazily by
   * `createMetricsCollector`'s default deps and own intervals of their own, so
   * something has to clear them or the process will not exit.
   */
  stopHostStorageSamplers?: () => void;
  addSignalListener?: (signal: Deno.Signal, handler: () => void) => void;
  exit?: (code: number) => void;
  logInfo?: typeof logInfo;
  logWarn?: typeof logWarn;
};

function closeDockerClient(client: DockerClientLike | undefined): void {
  if (!client) return;
  try {
    client.close();
  } catch {
    // Probe HttpClient may already be closed.
  }
}

async function connectControlPlane(
  io: DaemonRunIo,
): Promise<{ stop(): void }> {
  const connect = io.connectInstance;
  if (connect) {
    return await connect({
      metricsCollectorFactory: () =>
        io.createMetricsCollector?.() ?? createMetricsCollector(),
      collectTopologyFn: () => io.collectTopology?.() ?? collectTopology(),
    });
  }
  return await connectInstance({
    metricsCollectorFactory: () => createMetricsCollector(),
    collectTopologyFn: () => collectTopology(),
    handleCommandDispatch,
    handleFabricPathProbe,
    handleDrivetempEnable,
  });
}

async function maybeAttachDocker(
  io: DaemonRunIo,
  reinstallForwardingJumps: () => Promise<void>,
): Promise<{
  dockerClient?: DockerClientLike;
  dockerMonitor?: DockerMonitorLike;
}> {
  if (!(io.shouldEnableDockerIntegration ?? shouldEnableDockerIntegration)()) {
    return {};
  }

  const dockerClient = (io.createDockerClient ?? (() => new DockerClient()))();
  const decision = (io.decideDockerMonitorAttach ?? decideDockerMonitorAttach)({
    socketReachable: await dockerClient.ping(),
    dockerBinaryPresent:
      await (io.dockerBinaryPresent ?? dockerBinaryPresent)(),
  });
  if (!decision.attach) {
    (io.logInfo ?? logInfo)(
      "docker",
      "Docker not installed yet — skipping monitor until converge installs it",
    );
    closeDockerClient(dockerClient);
    return {};
  }

  if (decision.warnSocketDown) {
    (io.logWarn ?? logWarn)(
      "docker",
      "Docker socket not reachable yet — monitor will retry on each poll",
    );
  }
  const dockerMonitor = (io.createDockerMonitor ??
    ((client) => new DockerMonitor(client as DockerClient)))(dockerClient);
  dockerMonitor.subscribeReachability((reachable) => {
    if (!reachable) return;
    void reinstallForwardingJumps();
  });
  return { dockerClient, dockerMonitor };
}

/**
 * Check every live release for links that leave it or reach into `shared/`
 * (`live-release-scan.ts`), logging each finding.
 */
async function scanLiveReleases(): Promise<void> {
  await reportLiveReleaseLinks(resolveLayout(Deno.env.toObject()), {
    warn: (message) => logWarn("release", message),
  });
}

/**
 * Set aside any hosting Caddy snippet already on disk that Caddy cannot load
 * (`ingress.ts`), so a stale one does not keep ingress from starting.
 */
async function guardHostingSites(): Promise<void> {
  await guardHostingCaddySites(resolveLayout(Deno.env.toObject()));
}

/**
 * Compare this boot with the last one and, after a restart that was not a
 * clean shutdown, hold every HA primary on this host until the control plane
 * confirms it is still the primary (`managed/boot-hold.ts`).
 */
export type BootHoldStartDeps = {
  classify: (layout: LayoutPaths) => Promise<HostBootKind>;
  hold: (kind: HostBootKind, layout: LayoutPaths) => Promise<boolean>;
  persist: (layout: LayoutPaths) => Promise<void>;
  newRetry: (
    layout: LayoutPaths,
    reapply?: () => Promise<boolean>,
  ) => { start(): void; stop(): void };
};

export async function applyManagedBootHoldAtStart(
  deps: Partial<BootHoldStartDeps> = {},
): Promise<void> {
  const layout = resolveLayout(Deno.env.toObject());
  const hold = deps.hold ??
    ((k, l) => applyBootHold(k, { layout: l, run: runDocker }));
  const persist = deps.persist ?? recordHostBootPersist;
  // P1-1 fix: classify before holding, hold before persisting the record.
  // If the daemon crashes between hold and persist, the next start reads the
  // old record, sees a new boot id, and holds again.
  let kind: HostBootKind;
  try {
    kind = await (deps.classify ?? classifyHostBootRecord)(layout);
  } catch (err) {
    // Fail closed: an unreadable boot record is treated as an unclean boot.
    logWarn("managed", "boot classify failed, holding:", sanitizeForLog(err));
    kind = "unclean";
  }
  let holdSucceeded = false;
  let listingFailed = false;
  try {
    holdSucceeded = await hold(kind, layout);
  } catch (err) {
    // The members could not be listed: no hold was taken. The retry below
    // tries again every few seconds until the list works.
    listingFailed = true;
    logWarn("managed", "boot hold failed, retrying:", sanitizeForLog(err));
  }
  const reapply = listingFailed
    ? async () => {
      const done = await hold(kind, layout);
      if (done) await persist(layout);
      return done;
    }
    : undefined;
  // Always start the local retry (P1-2 fix): it keeps trying every stop that
  // failed, re-stops held engines for a minute (Docker's restart policy may
  // start them after our stop), and does not depend on the control plane.
  const retry = (deps.newRetry ??
    ((l, r) => new BootHoldLocalRetry(l, runDocker, { reapply: r })))(
      layout,
      reapply,
    );
  retry.start();
  // Stored globally for shutdown cleanup (below).
  bootHoldRetry = retry;
  demotedMemberGuard?.stop();
  engineExitGuard?.stop();
  const demotedGuard = new DemotedMemberGuard({
    layout,
    run: runDocker,
  });
  demotedGuard.start();
  demotedMemberGuard = demotedGuard;
  const exitGuard = new ManagedEngineExitGuard({
    layout,
    run: runDocker,
  });
  exitGuard.start();
  engineExitGuard = exitGuard;
  // Only persist the record after every hold is applied.
  if (holdSucceeded) {
    await persist(layout);
  }
}

/** Test seam: drop timers started by {@link applyManagedBootHoldAtStart}. */
export function stopManagedRuntimeGuardsForTests(): void {
  bootHoldRetry?.stop();
  demotedMemberGuard?.stop();
  engineExitGuard?.stop();
  bootHoldRetry = undefined;
  demotedMemberGuard = undefined;
  engineExitGuard = undefined;
}

async function markCleanShutdown(): Promise<void> {
  await markHostCleanShutdown(resolveLayout(Deno.env.toObject()));
}

/** Run `work`; a failure is only logged, never allowed to stop startup or exit. */
async function bestEffort(
  warn: typeof logWarn,
  what: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (err) {
    warn(
      "managed",
      `${what} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Long-running daemon loop. `main.ts` / `prod-main.ts` call this after CLI
 * verbs. Tests inject {@link DaemonRunIo} so startup branches stay isolated.
 */
export async function runDaemon(io: DaemonRunIo = {}): Promise<void> {
  const info = io.logInfo ?? logInfo;
  const exitFn = io.exit ?? ((code: number) => {
    Deno.exit(code);
  });
  const addSignal = io.addSignalListener ??
    ((signal: Deno.Signal, handler: () => void) => {
      Deno.addSignalListener(signal, handler);
    });
  const reinstallFabricJump = io.reinstallFabricForwardingIfEnabled ??
    reinstallFabricForwardingIfEnabled;
  const reinstallFirewallJump = io.reinstallFirewallForwardingIfEnabled ??
    reinstallFirewallForwardingIfEnabled;
  // dockerd rebuilds DOCKER-USER whenever it restarts, so both chains hung off
  // it (the fabric's TP-FORWARD and the firewall's TP-FWD) are put back
  // together, at startup and on every Docker reachability change.
  const reinstallForwardingJumps = async (): Promise<void> => {
    try {
      await reinstallFabricJump();
    } finally {
      await reinstallFirewallJump();
    }
  };

  info("daemon", "starting up");

  // First, before anything slow: a stale primary must not keep serving.
  await bestEffort(
    io.logWarn ?? logWarn,
    "boot hold check",
    io.applyManagedBootHold ?? applyManagedBootHoldAtStart,
  );

  const orchestrationReady =
    await (io.initOrchestration ?? initOrchestration)();

  if (orchestrationReady) {
    await (io.restoreFabricFromPersistedState ??
      restoreFabricFromPersistedState)();
    await reinstallForwardingJumps();
    await (io.reconcileSitePhpRuntimes ?? reconcileSitePhpRuntimesAtBoot)();
  }
  if (orchestrationReady) {
    (io.recoverInterruptedRestores ?? (() => recoverInterruptedRestores()))()
      .catch((err) => {
        (io.logWarn ?? logWarn)(
          "backup",
          "restore recovery failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
  }
  // In the background: a slow tree walk must not hold up the connection, and
  // a failure is only ever reported.
  if (orchestrationReady) {
    (io.scanLiveReleases ?? scanLiveReleases)().catch((err) => {
      (io.logWarn ?? logWarn)(
        "release",
        "live release link scan failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  // Also in the background, and only ever reported on.
  if (orchestrationReady) {
    (io.guardHostingCaddySites ?? guardHostingSites)().catch((err) => {
      (io.logWarn ?? logWarn)(
        "deploy",
        "hosting Caddy snippet check failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  // In the background: it may wait minutes for the datacenter address, and a
  // failure is only ever reported.
  if (orchestrationReady) {
    (io.repairProxySqlFrontend ??
      (() =>
        repairProxySqlFrontendAtBoot(resolveLayout(Deno.env.toObject()))))()
      .catch((err) => {
        (io.logWarn ?? logWarn)(
          "managed",
          "ProxySQL frontend boot repair failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  const abort = new AbortController();
  let shuttingDown = false;
  let dockerClient: DockerClientLike | undefined;
  const sentinelOptions: SentinelOptions = {};

  if (orchestrationReady) {
    const attached = await maybeAttachDocker(io, reinstallForwardingJumps);
    dockerClient = attached.dockerClient;
    if (attached.dockerMonitor && !io.createSentinel) {
      sentinelOptions.dockerMonitor = attached.dockerMonitor as DockerMonitor;
      sentinelOptions.fetchLastLogLine = fetchContainerLastLogLine;
      sentinelOptions.stopContainer = stopCrashLoopingContainer;
    }
  }

  const sentinel = (io.createSentinel ?? createSentinel)(sentinelOptions);
  // Future: daemon-side SQLite monitoring store will subscribe to
  // sentinel.onTransition() and sentinel.buildHeartbeat() here.
  sentinel.start(abort.signal);
  // Per-service run state rides hello / heartbeat presence (host/service-run-state.ts).
  setServiceRunStateSource(() => sentinel.serviceRunStates?.());

  await (io.startTunnels ?? startTunnels)(abort.signal);

  const instanceHandle = { stop() {} };
  let instance: { stop(): void } = instanceHandle;

  if ((io.shouldConnectToInstance ?? shouldConnectToInstance)()) {
    instance = await connectControlPlane(io);
  } else {
    info(
      "instance",
      "connection deferred until development environment opt-in (TURBOPANEL_DEV_INSTANCE)",
    );
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    addSignal(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      info("daemon", "shutting down");
      instance.stop();
      sentinel.stop();
      setServiceRunStateSource(undefined);
      (io.stopHostStorageSamplers ?? stopHostStorageSamplers)();
      // P1-2 cleanup: stop local retry timer so the process can exit.
      bootHoldRetry?.stop();
      demotedMemberGuard?.stop();
      closeDockerClient(dockerClient);
      dockerClient = undefined;
      abort.abort();
    });
  }

  await new Promise<void>((resolve) => {
    abort.signal.addEventListener("abort", () => resolve());
  });

  await bestEffort(
    io.logWarn ?? logWarn,
    "clean shutdown stamp",
    io.markCleanShutdown ?? markCleanShutdown,
  );

  info("daemon", "shut down");
  exitFn(0);
}
