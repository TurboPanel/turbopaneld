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
import { logInfo, logWarn } from "../util/logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import { reportLiveReleaseLinks } from "../deploy/release/live-release-scan.ts";
import { guardHostingCaddySites } from "../deploy/ingress.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { applyBootHold } from "../managed/boot-hold.ts";
import { markHostCleanShutdown, recordHostBoot } from "../managed/host-boot.ts";
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
async function applyManagedBootHoldAtStart(): Promise<void> {
  const layout = resolveLayout(Deno.env.toObject());
  const kind = await recordHostBoot(layout);
  await applyBootHold(kind, { layout, run: runDocker });
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
