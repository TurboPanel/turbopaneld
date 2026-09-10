import { assertEquals } from "@std/assert";
import {
  type DaemonRunIo,
  type DockerClientLike,
  type DockerMonitorLike,
  runDaemon,
  type SentinelLike,
} from "./daemon-run.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type SignalHandler = () => void;

function stubIo(overrides: Partial<DaemonRunIo> = {}): {
  io: DaemonRunIo;
  logs: string[];
  warns: string[];
  exits: number[];
  fabricRestores: number;
  fabricReinstalls: number;
  instanceStops: number;
  sentinelStops: number;
  dockerCloses: number;
  reachability: Array<(reachable: boolean) => void>;
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const exits: number[] = [];
  let fabricRestores = 0;
  let fabricReinstalls = 0;
  let instanceStops = 0;
  let sentinelStops = 0;
  let dockerCloses = 0;
  const reachability: Array<(reachable: boolean) => void> = [];
  const handlers: Partial<Record<Deno.Signal, SignalHandler>> = {};

  const dockerClient: DockerClientLike = {
    ping: () => Promise.resolve(true),
    close: () => {
      dockerCloses += 1;
    },
  };
  const dockerMonitor: DockerMonitorLike = {
    subscribeReachability: (cb) => {
      reachability.push(cb);
    },
  };
  const sentinel: SentinelLike = {
    start() {},
    stop() {
      sentinelStops += 1;
    },
  };

  const io: DaemonRunIo = {
    logInfo: (component, ...parts) => {
      logs.push(`${component} ${parts.join(" ")}`);
    },
    logWarn: (component, ...parts) => {
      warns.push(`${component} ${parts.join(" ")}`);
    },
    exit: (code) => {
      exits.push(code);
    },
    addSignalListener: (signal, handler) => {
      handlers[signal] = handler;
      if (signal === "SIGTERM") queueMicrotask(handler);
    },
    initOrchestration: () => Promise.resolve(false),
    restoreFabricFromPersistedState: () => {
      fabricRestores += 1;
      return Promise.resolve();
    },
    reinstallFabricForwardingIfEnabled: () => {
      fabricReinstalls += 1;
      return Promise.resolve();
    },
    shouldEnableDockerIntegration: () => false,
    shouldConnectToInstance: () => false,
    createDockerClient: () => dockerClient,
    dockerBinaryPresent: () => Promise.resolve(false),
    createDockerMonitor: () => dockerMonitor,
    createSentinel: () => sentinel,
    startTunnels: () => Promise.resolve(),
    connectInstance: () =>
      Promise.resolve({
        stop() {
          instanceStops += 1;
        },
      }),
    createMetricsCollector: () => {
      throw new TypeError("metrics collector should stay unused");
    },
    collectTopology: () => {
      throw new TypeError("topology collector should stay unused");
    },
    ...overrides,
  };

  return {
    io,
    logs,
    warns,
    exits,
    get fabricRestores() {
      return fabricRestores;
    },
    get fabricReinstalls() {
      return fabricReinstalls;
    },
    get instanceStops() {
      return instanceStops;
    },
    get sentinelStops() {
      return sentinelStops;
    },
    get dockerCloses() {
      return dockerCloses;
    },
    reachability,
  };
}

test("runDaemon skips fabric, docker, and instance when orchestration is not ready", async () => {
  const stub = stubIo();
  await runDaemon(stub.io);
  assertEquals(stub.fabricRestores, 0);
  assertEquals(stub.fabricReinstalls, 0);
  assertEquals(stub.dockerCloses, 0);
  assertEquals(stub.instanceStops, 0);
  assertEquals(stub.sentinelStops, 1);
  assertEquals(stub.exits, [0]);
  assertEquals(
    stub.logs.some((line) => line.includes("connection deferred")),
    true,
  );
  assertEquals(stub.logs.at(-1), "daemon shut down");
});

test("runDaemon restores fabric and attaches Docker when the socket is up", async () => {
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    shouldEnableDockerIntegration: () => true,
    dockerBinaryPresent: () => Promise.resolve(true),
    createMetricsCollector: () => ({}) as never,
    collectTopology: () => ({}) as never,
    shouldConnectToInstance: () => true,
  });
  await runDaemon(stub.io);
  assertEquals(stub.fabricRestores, 1);
  assertEquals(stub.fabricReinstalls >= 1, true);
  assertEquals(stub.dockerCloses, 1);
  assertEquals(stub.instanceStops, 1);
  assertEquals(stub.exits, [0]);
});

test("runDaemon warns when Docker is present but the socket is down", async () => {
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    shouldEnableDockerIntegration: () => true,
    dockerBinaryPresent: () => Promise.resolve(true),
    createDockerClient: () => ({
      ping: () => Promise.resolve(false),
      close: () => {},
    }),
  });
  await runDaemon(stub.io);
  assertEquals(
    stub.warns.some((line) => line.includes("socket not reachable")),
    true,
  );
});

test("runDaemon skips the Docker monitor when Docker is not installed", async () => {
  let closed = 0;
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    shouldEnableDockerIntegration: () => true,
    dockerBinaryPresent: () => Promise.resolve(false),
    createDockerClient: () => ({
      ping: () => Promise.resolve(false),
      close: () => {
        closed += 1;
      },
    }),
  });
  await runDaemon(stub.io);
  assertEquals(closed, 1);
  assertEquals(
    stub.logs.some((line) => line.includes("Docker not installed yet")),
    true,
  );
});

test("runDaemon ignores a close error when skipping Docker", async () => {
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    shouldEnableDockerIntegration: () => true,
    dockerBinaryPresent: () => Promise.resolve(false),
    createDockerClient: () => ({
      ping: () => Promise.resolve(false),
      close: () => {
        throw new TypeError("already closed");
      },
    }),
  });
  await runDaemon(stub.io);
  assertEquals(stub.exits, [0]);
});

test("runDaemon reinstalls fabric when Docker becomes reachable", async () => {
  const reachability: Array<(reachable: boolean) => void> = [];
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    shouldEnableDockerIntegration: () => true,
    dockerBinaryPresent: () => Promise.resolve(true),
    createDockerMonitor: () => ({
      subscribeReachability: (cb) => {
        reachability.push(cb);
      },
    }),
    startTunnels: () => {
      for (const cb of reachability) {
        cb(false);
        cb(true);
      }
      return Promise.resolve();
    },
  });
  await runDaemon(stub.io);
  assertEquals(stub.fabricReinstalls >= 2, true);
});

test("runDaemon passes the Docker monitor into the default sentinel", async () => {
  let monitorStarts = 0;
  const dockerMonitor: DockerMonitorLike & {
    start(signal: AbortSignal): void;
    waitUntilReady(): Promise<void>;
    getContainers(): unknown[];
    getContainerInspect(): undefined;
    subscribe(): () => void;
  } = {
    subscribeReachability: () => {},
    start() {
      monitorStarts += 1;
    },
    waitUntilReady: () => Promise.resolve(),
    getContainers: () => [],
    getContainerInspect: () => undefined,
    subscribe: () => () => {},
  };
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    shouldEnableDockerIntegration: () => true,
    dockerBinaryPresent: () => Promise.resolve(true),
    createDockerMonitor: () => dockerMonitor,
    createSentinel: undefined,
  });
  await runDaemon(stub.io);
  assertEquals(monitorStarts >= 1, true);
  assertEquals(stub.exits, [0]);
});

test("runDaemon uses default Docker monitor construction", async () => {
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    shouldEnableDockerIntegration: () => true,
    dockerBinaryPresent: () => Promise.resolve(true),
    createDockerMonitor: undefined,
  });
  await runDaemon(stub.io);
  assertEquals(stub.exits, [0]);
});

test("runDaemon connect path uses injected metric factories", async () => {
  let metricsCalls = 0;
  let topologyCalls = 0;
  const stub = stubIo({
    shouldConnectToInstance: () => true,
    createMetricsCollector: () => {
      metricsCalls += 1;
      return { kind: "metrics" };
    },
    collectTopology: () => {
      topologyCalls += 1;
      return { kind: "topology" };
    },
    connectInstance: (opts) => {
      const metrics = opts.metricsCollectorFactory() as { kind: string };
      const topology = opts.collectTopologyFn() as { kind: string };
      assertEquals(metrics.kind, "metrics");
      assertEquals(topology.kind, "topology");
      return Promise.resolve({ stop() {} });
    },
  });
  await runDaemon(stub.io);
  assertEquals(metricsCalls, 1);
  assertEquals(topologyCalls, 1);
});

test("runDaemon connect path falls back to default metric factories", async () => {
  let usedDefaults = false;
  const stub = stubIo({
    shouldConnectToInstance: () => true,
    createMetricsCollector: undefined,
    collectTopology: undefined,
    connectInstance: (opts) => {
      // Invoke the collector factory (construction only) but do not call
      // collectTopologyFn — the production default persists boot-generation
      // under daemonStateDir (`/var/lib/turbopanel` here) and would leak an
      // unhandled PermissionDenied on CI hosts that cannot mkdir that path.
      const metrics = opts.metricsCollectorFactory();
      usedDefaults = metrics !== undefined &&
        typeof opts.collectTopologyFn === "function";
      return Promise.resolve({ stop() {} });
    },
  });
  await runDaemon(stub.io);
  assertEquals(usedDefaults, true);
});

test("runDaemon writes startup logs through the default logger", async () => {
  const stub = stubIo({ logInfo: undefined });
  await runDaemon(stub.io);
  assertEquals(stub.exits, [0]);
});

test("runDaemon ignores a second shutdown signal and close errors", async () => {
  const handlers: SignalHandler[] = [];
  let closes = 0;
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    shouldEnableDockerIntegration: () => true,
    dockerBinaryPresent: () => Promise.resolve(true),
    createDockerClient: () => ({
      ping: () => Promise.resolve(true),
      close: () => {
        closes += 1;
        throw new TypeError("already closed");
      },
    }),
    addSignalListener: (_signal, handler) => {
      handlers.push(handler);
      if (handlers.length === 2) {
        queueMicrotask(() => {
          handlers[1]!();
          handlers[1]!();
          handlers[0]!();
        });
      }
    },
  });
  await runDaemon(stub.io);
  assertEquals(closes, 1);
  assertEquals(stub.exits, [0]);
});
