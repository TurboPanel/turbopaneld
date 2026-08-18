import { assertEquals } from "@std/assert";
import type {
  ContainerInspect,
  ContainerSummary,
  DockerEvent,
} from "../docker/client.ts";
import type { DockerMonitor, DockerMonitorChange } from "../docker/monitor.ts";
import type { MonitorDeliveryBundle } from "./delta.ts";
import type { MonitorTransitionPayload } from "./delta.ts";
import { createSentinel } from "./sentinel.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CONTAINER_ID = "abc123def456789012345678901234567890123456789012345678";

function makeSummary(id = CONTAINER_ID): ContainerSummary {
  return {
    Id: id,
    Names: [`/test-${id.slice(0, 12)}`],
    Image: "nginx:latest",
    State: "running",
    Status: "Up 1 minute",
    Ports: [],
  };
}

function makeInspect(
  id = CONTAINER_ID,
  status = "running",
): ContainerInspect {
  return {
    Id: id,
    Name: `/test-${id.slice(0, 12)}`,
    Image: "nginx:latest",
    State: {
      Status: status,
      Running: status === "running",
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: 1,
      ExitCode: 0,
    },
  };
}

class FakeDockerMonitor implements
  Pick<
    DockerMonitor,
    | "start"
    | "waitUntilReady"
    | "getContainers"
    | "getContainerInspect"
    | "subscribe"
  > {
  #containers: ContainerSummary[] = [];
  #inspects = new Map<string, ContainerInspect>();
  #listeners = new Set<(change: DockerMonitorChange) => void>();
  #readyResolve!: () => void;
  #ready = new Promise<void>((resolve) => {
    this.#readyResolve = resolve;
  });

  start(_signal: AbortSignal): void {}

  waitUntilReady(): Promise<void> {
    return this.#ready;
  }

  getContainers(): ContainerSummary[] {
    return this.#containers;
  }

  getContainerInspect(id: string): ContainerInspect | undefined {
    return this.#inspects.get(id);
  }

  subscribe(listener: (change: DockerMonitorChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  seed(summary: ContainerSummary, inspect: ContainerInspect): void {
    this.#containers = [summary];
    this.#inspects.set(summary.Id, inspect);
    this.#readyResolve();
  }

  markReady(): void {
    this.#readyResolve();
  }

  clearContainers(): void {
    this.#containers = [];
    this.#inspects.clear();
  }

  emitChange(change: DockerMonitorChange): void {
    if (change.removed) {
      this.#containers = this.#containers.filter((container) =>
        container.Id !== change.containerId
      );
      this.#inspects.delete(change.containerId);
    } else if (change.summary) {
      const index = this.#containers.findIndex((container) =>
        container.Id === change.containerId
      );
      if (index >= 0) this.#containers[index] = change.summary;
      else this.#containers.push(change.summary);
      if (change.inspect) {
        this.#inspects.set(change.containerId, change.inspect);
      }
    }

    for (const listener of this.#listeners) {
      listener(change);
    }
  }
}

test("sentinel bootstrap seeds tracked resources for sync payloads", async () => {
  const dockerMonitor = new FakeDockerMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
  });
  const controller = new AbortController();

  dockerMonitor.seed(makeSummary(), makeInspect());
  sentinel.start(controller.signal);
  await dockerMonitor.waitUntilReady();

  const bundle = await sentinel.buildSync();

  assertEquals(bundle.payload.resources?.length, 1);
  assertEquals(
    bundle.payload.resources?.[0]?.resourceKey,
    `container:${CONTAINER_ID.slice(0, 12)}`,
  );

  controller.abort();
  sentinel.stop();
});

test("sentinel emits offline transition bundle when a container is removed", async () => {
  const dockerMonitor = new FakeDockerMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
  });
  const controller = new AbortController();
  const transitions: MonitorDeliveryBundle<MonitorTransitionPayload>[] = [];

  sentinel.onTransition((bundle) => {
    transitions.push(bundle);
  });

  dockerMonitor.seed(makeSummary(), makeInspect());
  sentinel.start(controller.signal);
  await dockerMonitor.waitUntilReady();

  dockerMonitor.emitChange({
    containerId: CONTAINER_ID,
    summary: makeSummary(),
    inspect: makeInspect(),
    event: {
      Type: "container",
      Action: "destroy",
      Actor: { ID: CONTAINER_ID },
    } as DockerEvent,
    removed: true,
  });

  await waitFor(
    "removal transition",
    () => transitions.length > 0 ? transitions[0] : undefined,
  );

  assertEquals(transitions[0]?.payload.events[0]?.toStatus, "offline");
  assertEquals(
    transitions[0]?.payload.resources?.[0]?.status,
    "offline",
  );

  controller.abort();
  sentinel.stop();
});

test("sentinel emits transition bundle when a container status changes", async () => {
  const dockerMonitor = new FakeDockerMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
  });
  const controller = new AbortController();
  const transitions: MonitorDeliveryBundle<MonitorTransitionPayload>[] = [];

  sentinel.onTransition((bundle) => {
    transitions.push(bundle);
  });

  dockerMonitor.seed(makeSummary(), makeInspect());
  sentinel.start(controller.signal);
  await dockerMonitor.waitUntilReady();

  const unhealthyInspect = makeInspect(CONTAINER_ID, "running");
  unhealthyInspect.State.Health = { Status: "unhealthy" };

  dockerMonitor.emitChange({
    containerId: CONTAINER_ID,
    summary: makeSummary(),
    inspect: unhealthyInspect,
    event: {
      Type: "container",
      Action: "health_status",
      Actor: { ID: CONTAINER_ID },
    } as DockerEvent,
  });

  await waitFor(
    "status transition",
    () => transitions.length > 0 ? transitions[0] : undefined,
  );

  assertEquals(transitions[0]?.payload.events[0]?.toStatus, "unhealthy");

  controller.abort();
  sentinel.stop();
});

test("sentinel without dockerMonitor builds empty sync and heartbeat", async () => {
  const hostSummaryCollector = {
    collect: () => Promise.resolve({ uptimeSeconds: 12 }),
  };
  const sentinel = createSentinel({ hostSummaryCollector });
  const controller = new AbortController();
  sentinel.start(controller.signal);
  await sentinel.waitForReady();

  const sync = await sentinel.buildSync();
  assertEquals(sync.payload.resources?.length ?? 0, 0);
  assertEquals(sync.payload.instance.uptimeSeconds, 12);

  const heartbeat = await sentinel.buildHeartbeat();
  assertEquals(heartbeat.payload.resources, undefined);

  sentinel.registerPendingDelivery(sync.sequence, sync.resourcesAfter);
  sentinel.handleAck(sync.sequence);
  sentinel.confirmDelivery(heartbeat.sequence, heartbeat.resourcesAfter);

  await sentinel.resetForReconnect();
  controller.abort();
  sentinel.stop();
});

test("sentinel ignores no-op transitions and failed transition callbacks", async () => {
  const dockerMonitor = new FakeDockerMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
    hostSummaryCollector: {
      collect: () => Promise.resolve({}),
    },
  });
  const controller = new AbortController();
  let calls = 0;
  const unsubscribe = sentinel.onTransition(() => {
    calls += 1;
    throw new Error("callback boom");
  });

  dockerMonitor.seed(makeSummary(), makeInspect());
  sentinel.start(controller.signal);
  await sentinel.waitForReady();

  dockerMonitor.emitChange({
    containerId: CONTAINER_ID,
    summary: makeSummary(),
    inspect: makeInspect(),
    event: {
      Type: "container",
      Action: "update",
      Actor: { ID: CONTAINER_ID },
    } as DockerEvent,
  });
  assertEquals(calls, 0);

  unsubscribe();
  controller.abort();
  sentinel.stop();
});

test("sentinel becomes ready when docker bootstrap fails", async () => {
  class FailingBootstrapMonitor extends FakeDockerMonitor {
    override waitUntilReady(): Promise<void> {
      return Promise.reject(new Error("docker unavailable"));
    }
  }

  const dockerMonitor = new FailingBootstrapMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
  });
  const controller = new AbortController();
  sentinel.start(controller.signal);
  await sentinel.waitForReady();

  const sync = await sentinel.buildSync();
  assertEquals(sync.payload.resources?.length ?? 0, 0);

  controller.abort();
  sentinel.stop();
});

test("sentinel skips docker subscription when bootstrap aborts early", async () => {
  class AbortableBootstrapMonitor extends FakeDockerMonitor {
    #resolveReady!: () => void;
    readonly readyGate = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });

    override waitUntilReady(): Promise<void> {
      return this.readyGate;
    }

    releaseBootstrap(): void {
      this.#resolveReady();
    }
  }

  const dockerMonitor = new AbortableBootstrapMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
  });
  const controller = new AbortController();
  sentinel.start(controller.signal);
  controller.abort();
  dockerMonitor.releaseBootstrap();
  await sentinel.waitForReady();

  const sync = await sentinel.buildSync();
  assertEquals(sync.payload.resources?.length ?? 0, 0);
  sentinel.stop();
});

test("sentinel ignores docker changes after the parent signal aborts", async () => {
  const dockerMonitor = new FakeDockerMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
  });
  const controller = new AbortController();
  const transitions: MonitorDeliveryBundle<MonitorTransitionPayload>[] = [];
  sentinel.onTransition((bundle) => transitions.push(bundle));

  dockerMonitor.seed(makeSummary(), makeInspect());
  sentinel.start(controller.signal);
  await sentinel.waitForReady();
  controller.abort();

  dockerMonitor.emitChange({
    containerId: CONTAINER_ID,
    summary: makeSummary(),
    inspect: makeInspect(CONTAINER_ID, "exited"),
    event: {
      Type: "container",
      Action: "die",
      Actor: { ID: CONTAINER_ID },
    } as DockerEvent,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(transitions.length, 0);
  sentinel.stop();
});

test("sentinel logs when container collection throws during change handling", async () => {
  class ThrowingListMonitor extends FakeDockerMonitor {
    override getContainers(): ContainerSummary[] {
      throw new Error("collect failed");
    }
  }

  const dockerMonitor = new ThrowingListMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
  });
  const controller = new AbortController();
  const transitions: MonitorDeliveryBundle<MonitorTransitionPayload>[] = [];
  sentinel.onTransition((bundle) => transitions.push(bundle));

  dockerMonitor.seed(makeSummary(), makeInspect());
  sentinel.start(controller.signal);
  await sentinel.waitForReady();

  dockerMonitor.emitChange({
    containerId: CONTAINER_ID,
    summary: makeSummary(),
    inspect: makeInspect(),
    event: {
      Type: "container",
      Action: "die",
      Actor: { ID: CONTAINER_ID },
    } as DockerEvent,
    removed: true,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(transitions.length, 0);
  controller.abort();
  sentinel.stop();
});

test("sentinel tolerates throwing transition callbacks on real transitions", async () => {
  const dockerMonitor = new FakeDockerMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
  });
  const controller = new AbortController();
  let calls = 0;
  sentinel.onTransition(() => {
    calls += 1;
    throw new Error("callback boom");
  });

  dockerMonitor.seed(makeSummary(), makeInspect());
  sentinel.start(controller.signal);
  await sentinel.waitForReady();

  dockerMonitor.emitChange({
    containerId: CONTAINER_ID,
    summary: makeSummary(),
    inspect: makeInspect(),
    event: {
      Type: "container",
      Action: "destroy",
      Actor: { ID: CONTAINER_ID },
    } as DockerEvent,
    removed: true,
  });

  await waitFor("callback invoked", () => calls > 0 ? calls : undefined);
  assertEquals(calls, 1);

  controller.abort();
  sentinel.stop();
});

test("sentinel removal without prior baseline still emits offline", async () => {
  const dockerMonitor = new FakeDockerMonitor();
  const sentinel = createSentinel({
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
    hostSummaryCollector: {
      collect: () => Promise.resolve({}),
    },
  });
  const controller = new AbortController();
  const transitions: MonitorDeliveryBundle<MonitorTransitionPayload>[] = [];
  sentinel.onTransition((bundle) => transitions.push(bundle));

  dockerMonitor.markReady();
  sentinel.start(controller.signal);
  await sentinel.waitForReady();

  dockerMonitor.emitChange({
    containerId: CONTAINER_ID,
    summary: undefined,
    inspect: undefined,
    event: {
      Type: "container",
      Action: "destroy",
      Actor: { ID: CONTAINER_ID },
    } as DockerEvent,
    removed: true,
  });
  assertEquals(transitions.length, 0);

  dockerMonitor.emitChange({
    containerId: CONTAINER_ID,
    summary: makeSummary(),
    inspect: makeInspect(),
    event: {
      Type: "container",
      Action: "destroy",
      Actor: { ID: CONTAINER_ID },
    } as DockerEvent,
    removed: true,
  });
  await waitFor(
    "offline from change payload",
    () => transitions.length > 0 ? transitions[0] : undefined,
  );
  assertEquals(transitions[0]?.payload.events[0]?.toStatus, "offline");

  controller.abort();
  sentinel.stop();
});

async function waitFor<T>(
  label: string,
  predicate: () => T | Promise<T>,
  timeoutMs = 2_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value !== undefined && value !== null && value !== false) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
