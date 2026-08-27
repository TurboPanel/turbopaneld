import { assertEquals } from "@std/assert";
import type {
  ContainerInspect,
  ContainerSummary,
  DockerClient,
  DockerEvent,
} from "./client.ts";
import { DockerMonitor, type DockerMonitorChange } from "./monitor.ts";
import { flushMicrotasks } from "../testing/fake-clock.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CONTAINER_ID = "abc123def456789012345678901234567890123456789012345678";
const NEW_CONTAINER_ID =
  "new1234567890123456789012345678901234567890123456789012";

function nestedDockerUnavailable(
  leafMessage = "No such file or directory",
): TypeError {
  const leaf = new Error(leafMessage);
  const mid = new Error("connect");
  mid.cause = leaf;
  const top = new TypeError("fetch failed");
  top.cause = mid;
  return top;
}

function makeStartEvent(id = CONTAINER_ID): DockerEvent {
  return {
    Type: "container",
    Action: "start",
    Actor: { ID: id },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  streamCalls = 0;
  streamError: Error | null = null;

  listContainers = async (_all: boolean): Promise<ContainerSummary[]> => {
    await Promise.resolve();
    return this.containers;
  };

  inspectContainer = async (id: string): Promise<ContainerInspect> => {
    await Promise.resolve();
    const inspect = this.inspects.get(id);
    if (!inspect) {
      throw new Error(`inspect container failed: HTTP 404`);
    }
    return inspect;
  };

  async *streamEvents(
    signal: AbortSignal,
  ): AsyncGenerator<DockerEvent> {
    this.streamCalls++;
    if (this.streamError) throw this.streamError;
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

async function withMonitor(
  client: MockDockerClient,
  fn: (monitor: DockerMonitor, controller: AbortController) => Promise<void>,
  reconcileIntervalMs = 60_000,
): Promise<void> {
  const monitor = createMonitor(client, reconcileIntervalMs);
  const controller = new AbortController();
  try {
    await fn(monitor, controller);
  } finally {
    controller.abort();
  }
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

test("reachability listeners fire when Docker returns after being unavailable", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  let listShouldFail = false;
  const originalList = client.listContainers;
  client.listContainers = async (all: boolean) => {
    if (listShouldFail) {
      throw new Error("Connection refused (os error 111)");
    }
    return await originalList(all);
  };

  const monitor = createMonitor(client, 50);
  const events: boolean[] = [];
  monitor.subscribeReachability((reachable) => {
    events.push(reachable);
  });

  const controller = new AbortController();
  monitor.start(controller.signal);
  await monitor.waitUntilReady();
  assertEquals(events, []);

  listShouldFail = true;
  await waitFor(
    "docker unavailable",
    () => events.includes(false) ? true : undefined,
  );

  listShouldFail = false;
  await waitFor(
    "docker reachable again",
    () => events.includes(true) ? true : undefined,
  );

  assertEquals(events[0], false);
  controller.abort();
});

test("start event refreshes inspect and reuses the tracked summary", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    const starts: DockerMonitorChange[] = [];
    monitor.subscribe((change) => {
      if (change.event?.Action === "start") starts.push(change);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    client.pushEvent(makeStartEvent());

    const change = await waitFor("start refresh", () => starts[0]);
    assertEquals(change.containerId, CONTAINER_ID);
    assertEquals(change.summary?.Id, CONTAINER_ID);
    assertEquals(change.inspect?.Id, CONTAINER_ID);
    assertEquals(change.removed, undefined);
  });
});

test("start event for an unknown container lists summaries after inspect", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    const starts: DockerMonitorChange[] = [];
    monitor.subscribe((change) => {
      if (change.event?.Action === "start") starts.push(change);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();

    client.containers = [makeSummary(), makeSummary(NEW_CONTAINER_ID)];
    client.inspects.set(NEW_CONTAINER_ID, makeInspect(NEW_CONTAINER_ID));
    client.pushEvent(makeStartEvent(NEW_CONTAINER_ID));

    const change = await waitFor("new container start", () => starts[0]);
    assertEquals(change.containerId, NEW_CONTAINER_ID);
    assertEquals(change.summary?.Id, NEW_CONTAINER_ID);
    assertEquals(
      monitor.getContainers().some((row) => row.Id === NEW_CONTAINER_ID),
      true,
    );
  });
});

test("list after a start event failing still notifies with inspect only", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    const starts: DockerMonitorChange[] = [];
    monitor.subscribe((change) => {
      if (change.event?.Action === "start") starts.push(change);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();

    client.inspects.set(NEW_CONTAINER_ID, makeInspect(NEW_CONTAINER_ID));
    client.listContainers = async () => {
      await Promise.resolve();
      throw new Error("list after event failed: HTTP 500");
    };
    client.pushEvent(makeStartEvent(NEW_CONTAINER_ID));

    const change = await waitFor("start with list failure", () => starts[0]);
    assertEquals(change.containerId, NEW_CONTAINER_ID);
    assertEquals(change.summary, undefined);
    assertEquals(change.inspect?.Id, NEW_CONTAINER_ID);
    assertEquals(
      monitor.getContainerInspect(NEW_CONTAINER_ID)?.Id,
      NEW_CONTAINER_ID,
    );
  });
});

test("event without a container id is ignored", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    const afterReady: DockerMonitorChange[] = [];
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    monitor.subscribe((change) => afterReady.push(change));

    client.pushEvent({
      Type: "container",
      Action: "start",
      Actor: { ID: "" },
    });
    client.pushEvent({
      Type: "container",
      Action: "die",
    } as DockerEvent);

    await flushMicrotasks();
    assertEquals(afterReady, []);
    assertEquals(monitor.getContainers().length, 1);
  });
});

test("destroy of an untracked container does not notify", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    const removed: DockerMonitorChange[] = [];
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    monitor.subscribe((change) => {
      if (change.removed) removed.push(change);
    });

    client.pushEvent(makeDestroyEvent(NEW_CONTAINER_ID));
    await flushMicrotasks();
    assertEquals(removed, []);
    assertEquals(monitor.getContainers().length, 1);
  });
});

test("non-404 inspect error during event refresh leaves the container tracked", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    let removed = false;
    monitor.subscribe((change) => {
      if (change.removed) removed = true;
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();

    let inspectFailed = false;
    client.inspectContainer = async () => {
      await Promise.resolve();
      inspectFailed = true;
      throw new Error("inspect container failed: HTTP 500");
    };
    client.pushEvent(makeStartEvent());
    await waitFor("event inspect 500", () => inspectFailed ? true : undefined);
    await flushMicrotasks();

    assertEquals(removed, false);
    assertEquals(monitor.getContainers().length, 1);
    assertEquals(monitor.getContainerInspect(CONTAINER_ID)?.Id, CONTAINER_ID);
  });
});

test("aborted signal skips event-refresh removal after inspect fails", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());
  const inspectGate = deferred<never>();

  await withMonitor(client, async (monitor, controller) => {
    let removed = false;
    monitor.subscribe((change) => {
      if (change.removed) removed = true;
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();

    client.inspectContainer = () => inspectGate.promise;
    client.pushEvent(makeStartEvent());
    await flushMicrotasks();
    controller.abort();
    inspectGate.reject(new Error("inspect container failed: HTTP 404"));
    await flushMicrotasks();

    assertEquals(removed, false);
    assertEquals(monitor.getContainers().length, 1);
  });
});

test("events stream reconnects after a healthy stream ends", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());
  client.streamEvents = async function* (signal: AbortSignal) {
    client.streamCalls++;
    if (client.streamCalls === 1) {
      yield makeStartEvent();
      return;
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  await withMonitor(client, async (monitor, controller) => {
    const starts: DockerMonitorChange[] = [];
    monitor.subscribe((change) => {
      if (change.event?.Action === "start") starts.push(change);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    await waitFor("start before reconnect", () => starts[0]);
    await waitFor(
      "events stream reconnect",
      () => client.streamCalls >= 2 ? true : undefined,
      3_000,
    );
  });
});

test("events stream error that is not a missing socket is logged and retried", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());
  client.streamError = new Error("events protocol error");

  await withMonitor(client, async (monitor, controller) => {
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    await waitFor(
      "events stream retry",
      () => client.streamCalls >= 2 ? true : undefined,
      3_000,
    );
  });
});

test("nested fetch cause is classified as Docker unavailable", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());
  client.listContainers = async () => {
    await Promise.resolve();
    throw nestedDockerUnavailable("client error (Connect)");
  };

  await withMonitor(client, async (monitor, controller) => {
    const events: boolean[] = [];
    monitor.subscribeReachability((reachable) => {
      events.push(reachable);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    await waitFor(
      "nested-cause unavailable",
      () => events.includes(false) ? true : undefined,
    );
    assertEquals(monitor.getContainers().length, 0);
  });
});

test("non-unavailable reconcile error does not flip reachability", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    const events: boolean[] = [];
    monitor.subscribeReachability((reachable) => {
      events.push(reachable);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    assertEquals(events, []);

    client.listContainers = async () => {
      await Promise.resolve();
      throw new Error("permission denied");
    };

    await new Promise((resolve) => setTimeout(resolve, 120));
    assertEquals(events, []);
  }, 50);
});

test("inspect failure during reconcile still tracks the summary", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];

  await withMonitor(client, async (monitor, controller) => {
    const changes: DockerMonitorChange[] = [];
    monitor.subscribe((change) => {
      changes.push(change);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();

    assertEquals(monitor.getContainers().length, 1);
    assertEquals(monitor.getContainerInspect(CONTAINER_ID), undefined);
    assertEquals(changes[0]?.containerId, CONTAINER_ID);
    assertEquals(changes[0]?.inspect, undefined);
  });
});

test("abort during list skips inspect and finishes reconcile", async () => {
  const client = new MockDockerClient();
  const listGate = deferred<ContainerSummary[]>();
  client.listContainers = () => listGate.promise;
  client.inspects.set(CONTAINER_ID, makeInspect());

  let inspectCalls = 0;
  const originalInspect = client.inspectContainer;
  client.inspectContainer = async (id: string) => {
    inspectCalls++;
    return await originalInspect(id);
  };

  await withMonitor(client, async (monitor, controller) => {
    monitor.start(controller.signal);
    await flushMicrotasks();
    controller.abort();
    listGate.resolve([makeSummary()]);
    await monitor.waitUntilReady();
    assertEquals(inspectCalls, 0);
    assertEquals(monitor.getContainers().length, 1);
  });
});

test("abort while the events stream is mid-event stops handling further events", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());
  const afterAbort = deferred<void>();
  client.streamEvents = async function* (signal: AbortSignal) {
    client.streamCalls++;
    yield makeStartEvent();
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    afterAbort.resolve();
    yield makeStartEvent(NEW_CONTAINER_ID);
  };

  await withMonitor(client, async (monitor, controller) => {
    const starts: string[] = [];
    monitor.subscribe((change) => {
      if (change.event?.Action === "start") starts.push(change.containerId);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    await waitFor("first streamed start", () => starts[0]);
    controller.abort();
    await afterAbort.promise;
    await flushMicrotasks();
    assertEquals(starts, [CONTAINER_ID]);
  });
});

test("poll fallback backs off when reconcile keeps failing", async () => {
  const client = new MockDockerClient();
  client.streamError = new Error("Connection refused (os error 111)");
  let listCalls = 0;
  client.listContainers = async () => {
    listCalls++;
    await Promise.resolve();
    throw new Error("Connection refused (os error 111)");
  };

  const monitor = new DockerMonitor(
    client as unknown as DockerClient,
    40,
    40,
  );
  const controller = new AbortController();
  try {
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    await waitFor(
      "repeated poll-fallback reconcile",
      () => listCalls >= 3 ? true : undefined,
      3_000,
    );
  } finally {
    controller.abort();
  }
});

test("throwing change listeners do not block later subscribers", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    const seen: string[] = [];
    monitor.subscribe(() => {
      throw new Error("listener boom");
    });
    monitor.subscribe((change) => {
      seen.push(change.containerId);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    assertEquals(seen, [CONTAINER_ID]);
  });
});

test("throwing reachability listeners do not block later subscribers", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  let listShouldFail = false;
  const originalList = client.listContainers;
  client.listContainers = async (all: boolean) => {
    if (listShouldFail) {
      throw new Error("Connection refused (os error 111)");
    }
    return await originalList(all);
  };

  await withMonitor(client, async (monitor, controller) => {
    const events: boolean[] = [];
    monitor.subscribeReachability(() => {
      throw new Error("reachability boom");
    });
    monitor.subscribeReachability((reachable) => {
      events.push(reachable);
    });
    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    listShouldFail = true;
    await waitFor(
      "reachability after throwing listener",
      () => events.includes(false) ? true : undefined,
    );
  }, 50);
});

test("unsubscribe stops change and reachability delivery", async () => {
  const client = new MockDockerClient();
  client.containers = [makeSummary()];
  client.inspects.set(CONTAINER_ID, makeInspect());

  await withMonitor(client, async (monitor, controller) => {
    const changes: DockerMonitorChange[] = [];
    const reach: boolean[] = [];
    const stopChanges = monitor.subscribe((change) => {
      changes.push(change);
    });
    const stopReach = monitor.subscribeReachability((reachable) => {
      reach.push(reachable);
    });

    monitor.start(controller.signal);
    await monitor.waitUntilReady();
    stopChanges();
    stopReach();

    const afterUnsub = changes.length;
    client.pushEvent(makeDestroyEvent());
    await waitFor(
      "destroy applied after unsubscribe",
      () => monitor.getContainers().length === 0 ? true : undefined,
    );
    assertEquals(changes.length, afterUnsub);

    client.listContainers = async () => {
      await Promise.resolve();
      throw new Error("Connection refused (os error 111)");
    };
    await new Promise((resolve) => setTimeout(resolve, 120));
    assertEquals(reach, []);
  }, 50);
});
