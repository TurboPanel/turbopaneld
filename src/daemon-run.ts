import {
  decideDockerMonitorAttach,
  dockerBinaryPresent,
  DockerClient,
  DockerMonitor,
} from "./docker/index.ts";
import { connectInstance } from "./instance/client.ts";
import {
  reinstallFabricForwardingIfEnabled,
  restoreFabricFromPersistedState,
} from "./instance/commands/fabric.ts";
import { logInfo, logWarn } from "./logger.ts";
import { createSentinel, type SentinelOptions } from "./monitor/index.ts";
import {
  initOrchestration,
  shouldConnectToInstance,
  shouldEnableDockerIntegration,
} from "./orchestration/setup.ts";
import {
  createMetricsCollector,
  stopHostStorageSamplers,
} from "./metrics/collector/index.ts";
import { collectTopology } from "./metrics/topology/topology.ts";
import { startTunnels } from "./tunnels.ts";

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
};

export type DaemonRunIo = {
  initOrchestration?: () => Promise<boolean>;
  restoreFabricFromPersistedState?: () => Promise<void>;
  reinstallFabricForwardingIfEnabled?: () => Promise<void>;
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
  });
}

async function maybeAttachDocker(
  io: DaemonRunIo,
  reinstallFabric: () => Promise<void>,
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
    void reinstallFabric();
  });
  return { dockerClient, dockerMonitor };
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
  const reinstallFabric = io.reinstallFabricForwardingIfEnabled ??
    reinstallFabricForwardingIfEnabled;

  info("daemon", "starting up");

  const orchestrationReady =
    await (io.initOrchestration ?? initOrchestration)();

  if (orchestrationReady) {
    await (io.restoreFabricFromPersistedState ??
      restoreFabricFromPersistedState)();
    await reinstallFabric();
  }

  const abort = new AbortController();
  let shuttingDown = false;
  let dockerClient: DockerClientLike | undefined;
  const sentinelOptions: SentinelOptions = {};

  if (orchestrationReady) {
    const attached = await maybeAttachDocker(io, reinstallFabric);
    dockerClient = attached.dockerClient;
    if (attached.dockerMonitor && !io.createSentinel) {
      sentinelOptions.dockerMonitor = attached.dockerMonitor as DockerMonitor;
    }
  }

  const sentinel = (io.createSentinel ?? createSentinel)(sentinelOptions);
  // Future: daemon-side SQLite monitoring store will subscribe to
  // sentinel.onTransition() and sentinel.buildHeartbeat() here.
  sentinel.start(abort.signal);

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
      (io.stopHostStorageSamplers ?? stopHostStorageSamplers)();
      closeDockerClient(dockerClient);
      dockerClient = undefined;
      abort.abort();
    });
  }

  await new Promise<void>((resolve) => {
    abort.signal.addEventListener("abort", () => resolve());
  });

  info("daemon", "shut down");
  exitFn(0);
}
