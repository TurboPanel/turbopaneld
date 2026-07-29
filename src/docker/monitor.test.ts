import type {
  ContainerInspect,
  ContainerSummary,
  DockerClient,
  DockerEvent,
} from "./client.ts";
import { DockerMonitor, type DockerMonitorChange } from "./monitor.ts";

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

function makeDestroyEvent(id = CONTAINER_ID): DockerEvent {
  return {
    Type: "container",
    Action: "destroy",
    Actor: { ID: id },
  };
}

class MockDockerClient implements
  Pick<
    DockerClient,
    "listContainers" | "inspectContainer" | "streamEvents"
  > {
  containers: ContainerSummary[] = [];
  inspects = new Map<string, ContainerInspect>();
  #eventQueue: DockerEvent[] = [];
  #eventWaiters: Array<(event: DockerEvent) => void> = [];
  streamEnded = false;

  listContainers = async (_all: boolean): Promise<ContainerSummary[]> => {
    return this.containers;
  };

  inspectContainer = async (id: string): Promise<ContainerInspect> => {
    const inspect = this.inspects.get(id);
    if (!inspect) {
      throw new Error(`inspect container failed: HTTP 404`);
    }
    return inspect;
  };

  async *streamEvents(
    signal: AbortSignal,
  ): AsyncGenerator<DockerEvent> {
    while (!signal.aborted && !this.streamEnded) {
      if (this.#eventQueue.length > 0) {
        yield this.#eventQueue.shift()!;
        continue;
      }

      const event = await new Promise<DockerEvent | null>((resolve) => {
        if (signal.aborted) {
          resolve(null);
          return;
        }

        const onAbort = () => resolve(null);
        signal.addEventListener("abort", onAbort, { once: true });
        this.#eventWaiters.push((next) => {
          signal.removeEventListener("abort", onAbort);
          resolve(next);
        });
      });

      if (!event || signal.aborted) return;
      yield event;
    }
  }

  pushEvent(event: DockerEvent): void {
    const waiter = this.#eventWaiters.shift();
    if (waiter) waiter(event);
    else this.#eventQueue.push(event);
  }
}

function createMonitor(
  client: MockDockerClient,
  reconcileIntervalMs = 50,
): DockerMonitor {
  return new DockerMonitor(
    client as unknown as DockerClient,
    50,
    reconcileIntervalMs,
  );
}

async function waitFor<T>(
  label: string,
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("reconcile bootstrap seeds tracked containers and notifies listeners", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  const monitor = createMonitor(client);
  const controller = new AbortController();
  const changes: Array<{ containerId: string; removed?: boolean }> = [];

  monitor.subscribe((change) => {
    changes.push({
      containerId: change.containerId,
      removed: change.removed,
    });
  });

  monitor.start(controller.signal);
  await monitor.waitUntilReady();

  assertEquals(monitor.getContainers().length, 1);
  assertEquals(
    changes.some((change) =>
      change.containerId === CONTAINER_ID && !change.removed
    ),
    true,
  );

  controller.abort();
});

test("destroy event removes container and emits removed change", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  const monitor = createMonitor(client);
  const controller = new AbortController();
  const removed: DockerMonitorChange[] = [];

  monitor.subscribe((change) => {
    if (change.removed) removed.push(change);
  });

  monitor.start(controller.signal);
  await monitor.waitUntilReady();
  client.pushEvent(makeDestroyEvent());

  await waitFor(
    "destroy removal",
    () => removed.length > 0 ? removed[0] : undefined,
  );

  assertEquals(monitor.getContainers().length, 0);
  assertEquals(monitor.getContainerInspect(CONTAINER_ID), undefined);
  assertEquals(removed[0]?.containerId, CONTAINER_ID);
  assertEquals(removed[0]?.removed, true);

  controller.abort();
});

test("remove event removes container and emits removed change", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  const monitor = createMonitor(client);
  const controller = new AbortController();
  let removed = false;

  monitor.subscribe((change) => {
    if (change.removed) removed = true;
  });

  monitor.start(controller.signal);
  await monitor.waitUntilReady();
  client.pushEvent({
    Type: "container",
    Action: "remove",
    Actor: { ID: CONTAINER_ID },
  });

  await waitFor("remove removal", () => removed ? true : undefined);
  assertEquals(monitor.getContainers().length, 0);

  controller.abort();
});

test("inspect 404 during event refresh falls back to removal", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  const monitor = createMonitor(client);
  const controller = new AbortController();
  let removed = false;

  monitor.subscribe((change) => {
    if (change.removed) removed = true;
  });

  monitor.start(controller.signal);
  await monitor.waitUntilReady();

  client.inspects.delete(CONTAINER_ID);
  client.pushEvent({
    Type: "container",
    Action: "die",
    Actor: { ID: CONTAINER_ID },
  });

  await waitFor("404 removal", () => removed ? true : undefined);
  assertEquals(monitor.getContainers().length, 0);

  controller.abort();
});

test("reconcile loop recovers containers missed by the events stream", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());
  client.streamEnded = true;

  const monitor = createMonitor(client, 50);
  const controller = new AbortController();
  const seen = new Set<string>();

  monitor.subscribe((change) => {
    if (!change.removed) seen.add(change.containerId);
  });

  monitor.start(controller.signal);
  await monitor.waitUntilReady();

  const missedId = "missed1234567890123456789012345678901234567890123456789012";
  client.containers = [makeSummary(), makeSummary(missedId)];
  client.inspects.set(missedId, makeInspect(missedId));

  await waitFor(
    "reconcile recovery",
    () => seen.has(missedId) ? true : undefined,
    3_000,
  );

  assertEquals(seen.has(missedId), true);

  controller.abort();
});

test("a permanently failing events stream never leaks more than one poll-fallback loop", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  // Simulate a Docker-less host: every connection attempt fails immediately.
  // deno-lint-ignore require-yield
  client.streamEvents = async function* (
    _signal: AbortSignal,
  ): AsyncGenerator<DockerEvent> {
    throw new Error("Connection refused (os error 111)");
  };

  // Hold each reconcile call open long enough that a second, leaked poll
  // loop's own tick would provably overlap with this one's in-flight call.
  const HOLD_MS = 30;
  let activeCalls = 0;
  let maxConcurrentCalls = 0;
  const originalListContainers = client.listContainers;
  client.listContainers = async (all: boolean) => {
    activeCalls++;
    maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
    try {
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      return await originalListContainers(all);
    } finally {
      activeCalls--;
    }
  };

  // pollIntervalMs/reconcileIntervalMs = 40ms: the events loop's fixed 1s
  // initial backoff means a second failed connect attempt (and, pre-fix, a
  // second spawned poll loop) lands well within this window.
  const monitor = new DockerMonitor(
    client as unknown as DockerClient,
    40,
    40,
  );
  const controller = new AbortController();

  monitor.start(controller.signal);
  await monitor.waitUntilReady();

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  controller.abort();

  assertEquals(maxConcurrentCalls, 1);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)} but got ${String(actual)}`);
  }
}
