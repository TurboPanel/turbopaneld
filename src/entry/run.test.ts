import { assertEquals } from "@std/assert";
import { applyManagedBootHoldAtStart } from "./run.ts";
import { readServiceRunStates } from "../host/service-run-state.ts";
import {
  type DaemonRunIo,
  type DockerClientLike,
  type DockerMonitorLike,
  runDaemon,
  type SentinelLike,
} from "./run.ts";

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
  firewallReinstalls: number;
  phpReconciles: number;
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
  let firewallReinstalls = 0;
  let phpReconciles = 0;
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
    applyManagedBootHold: () => Promise.resolve(),
    markCleanShutdown: () => Promise.resolve(),
    scanLiveReleases: () => Promise.resolve(),
    restoreFabricFromPersistedState: () => {
      fabricRestores += 1;
      return Promise.resolve();
    },
    reinstallFabricForwardingIfEnabled: () => {
      fabricReinstalls += 1;
      return Promise.resolve();
    },
    reinstallFirewallForwardingIfEnabled: () => {
      firewallReinstalls += 1;
      return Promise.resolve();
    },
    reconcileSitePhpRuntimes: () => {
      phpReconciles += 1;
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
    get firewallReinstalls() {
      return firewallReinstalls;
    },
    get phpReconciles() {
      return phpReconciles;
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
  assertEquals(stub.phpReconciles, 0);
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
  assertEquals(stub.phpReconciles, 1);
  assertEquals(stub.fabricReinstalls >= 1, true);
  assertEquals(stub.dockerCloses, 1);
  assertEquals(stub.instanceStops, 1);
  assertEquals(stub.exits, [0]);
});

test("runDaemon scans live releases in the background and only warns on failure", async () => {
  let scans = 0;
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    scanLiveReleases: () => {
      scans += 1;
      return Promise.reject(new Error("sudo: a password is required"));
    },
  });
  await runDaemon(stub.io);
  assertEquals(scans, 1);
  assertEquals(stub.exits, [0]);
  assertEquals(
    stub.warns.some((line) =>
      line.includes("live release link scan failed") &&
      line.includes("password is required")
    ),
    true,
  );
});

test("runDaemon holds primaries first and stamps a clean shutdown last", async () => {
  const order: string[] = [];
  const stub = stubIo({
    applyManagedBootHold: () => {
      order.push("hold");
      return Promise.resolve();
    },
    initOrchestration: () => {
      order.push("orchestration");
      return Promise.resolve(false);
    },
    markCleanShutdown: () => {
      order.push("clean");
      return Promise.resolve();
    },
    exit: () => {
      order.push("exit");
    },
  });
  await runDaemon(stub.io);
  assertEquals(order, ["hold", "orchestration", "clean", "exit"]);
});

test("runDaemon still starts when the boot hold check or the shutdown stamp fails", async () => {
  const stub = stubIo({
    applyManagedBootHold: () => Promise.reject(new Error("docker unreachable")),
    markCleanShutdown: () => Promise.reject(new Error("disk full")),
  });
  await runDaemon(stub.io);
  assertEquals(stub.exits, [0]);
  assertEquals(
    stub.warns.some((line) => line.includes("boot hold check failed")),
    true,
  );
  assertEquals(
    stub.warns.some((line) => line.includes("clean shutdown stamp failed")),
    true,
  );
});

test("runDaemon skips the live release scan without orchestration", async () => {
  let scans = 0;
  const stub = stubIo({
    scanLiveReleases: () => {
      scans += 1;
      return Promise.resolve();
    },
  });
  await runDaemon(stub.io);
  assertEquals(scans, 0);
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

test("runDaemon re-hangs the firewall chain at startup and every time Docker becomes reachable, beside the fabric one", async () => {
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
        cb(true);
      }
      return Promise.resolve();
    },
  });
  await runDaemon(stub.io);
  // one at startup, two for the two reachable callbacks (the unreachable one is ignored)
  assertEquals(stub.firewallReinstalls, 3);
  assertEquals(stub.firewallReinstalls, stub.fabricReinstalls);
});

test("runDaemon does not touch the firewall when orchestration is not ready", async () => {
  const stub = stubIo();
  await runDaemon(stub.io);
  assertEquals(stub.firewallReinstalls, 0);
});

test("a failing fabric reinstall does not skip the firewall one", async () => {
  let firewall = 0;
  const stub = stubIo({
    initOrchestration: () => Promise.resolve(true),
    reinstallFabricForwardingIfEnabled: () =>
      Promise.reject(new Error("fabric went away")),
    reinstallFirewallForwardingIfEnabled: () => {
      firewall += 1;
      return Promise.resolve();
    },
  });
  let failure: unknown = null;
  try {
    await runDaemon(stub.io);
  } catch (err) {
    failure = err;
  }
  assertEquals(firewall, 1, "the firewall hook still ran");
  assertEquals((failure as Error | null)?.message, "fabric went away");
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

test("runDaemon feeds the sentinel's service run state to presence and clears it on shutdown", async () => {
  const services = [{
    serviceId: "svc-1",
    state: "running" as const,
    restartCount: 0,
    asOf: "2026-10-04T12:00:00.000Z",
  }];
  let seenWhileRunning: unknown;
  const stub = stubIo({
    createSentinel: () => ({
      start() {},
      stop() {},
      serviceRunStates: () => services,
    }),
    shouldConnectToInstance: () => true,
    connectInstance: () => {
      seenWhileRunning = readServiceRunStates();
      return Promise.resolve({ stop() {} });
    },
  });
  await runDaemon(stub.io);
  assertEquals(seenWhileRunning, services);
  assertEquals(readServiceRunStates(), undefined);
});

function bootHoldStartStub(holdResult: boolean | Error, classifyFails = false) {
  const order: string[] = [];
  return {
    order,
    deps: {
      classify: () => {
        order.push("classify");
        return classifyFails
          ? Promise.reject(new Error("unreadable"))
          : Promise.resolve("unclean" as const);
      },
      hold: () => {
        order.push("hold");
        return holdResult instanceof Error
          ? Promise.reject(holdResult)
          : Promise.resolve(holdResult);
      },
      persist: () => {
        order.push("persist");
        return Promise.resolve();
      },
      newRetry: (_layout: unknown, reapply?: () => Promise<boolean>) => ({
        start: () => order.push("retry-start"),
        stop: () => order.push("retry-stop"),
      }),
    },
  };
}

test("the boot record is persisted only after the holds were applied", async () => {
  const ok = bootHoldStartStub(true);
  await applyManagedBootHoldAtStart(ok.deps);
  assertEquals(ok.order, ["classify", "hold", "retry-start", "persist"]);
});

test("a failed hold starts the local retry and does not persist the boot record", async () => {
  const failed = bootHoldStartStub(false);
  await applyManagedBootHoldAtStart(failed.deps);
  assertEquals(failed.order, ["classify", "hold", "retry-start"]);
});

test("an unreadable boot record still holds, as an unclean boot", async () => {
  const stub = bootHoldStartStub(true, true);
  await applyManagedBootHoldAtStart(stub.deps);
  assertEquals(stub.order, ["classify", "hold", "retry-start", "persist"]);
});

test("a hold that throws still starts the retry with a reapply and skips persist", async () => {
  const stub = bootHoldStartStub(new Error("cannot list"));
  let reapply: (() => Promise<boolean>) | undefined;
  await applyManagedBootHoldAtStart({
    ...stub.deps,
    newRetry: (_l, r) => {
      reapply = r;
      return { start: () => stub.order.push("retry-start"), stop: () => {} };
    },
  });
  assertEquals(stub.order, ["classify", "hold", "retry-start"]);
  assertEquals(typeof reapply, "function");
});
