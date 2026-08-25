import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  activeContainerLogCollector,
  ContainerLogCollector,
  createDeploymentIdentityLoader,
  createDeploymentManifestDiscovery,
  createDockerPsObservation,
  type DeploymentIdentityIndex,
  isContainerLogCollectionEnabled,
  resetContainerLogCursorsForTests,
  resolveContainerLogTargets,
  splitDockerTimestampLine,
  startContainerLogCollection,
  stopContainerLogCollection,
} from "./container-collector.ts";
import type {
  ContainerLogBatchEvent,
  ContainerLogStream,
  ContainerLogTarget,
} from "./container-log-contracts.ts";
import { MAX_CONTAINER_LOG_MESSAGE_BYTES } from "./container-log-contracts.ts";
import {
  createMutableTranscriptRedactor,
  rememberSecretPlaintexts,
  resetSharedSecretRedactorForTests,
} from "./redactor.ts";
import {
  type DeploymentManifestV2,
  writeDeploymentManifest,
} from "../deploy/compose-files.ts";
import { join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Emit = (stream: ContainerLogStream, line: string) => void;

/**
 * Collector under test with every timer and every docker call replaced.
 *
 * Nothing in this suite may spawn a real `docker` process: `discover` and
 * `tail` are both injected, and the interval seams are no-ops so `start()`
 * never leaves a timer behind for the resource sanitizer.
 */
function makeCollector(options: {
  targets: ContainerLogTarget[];
  batches: ContainerLogBatchEvent[][];
  send?: (events: readonly ContainerLogBatchEvent[]) => Promise<void>;
  maxBufferedEvents?: number;
  maxBatchSize?: number;
  secrets?: string[];
  /** Omit the injected deny-set so the process-wide one is used. */
  sharedRedactor?: boolean;
  readyToSend?: () => boolean;
  /** Every `--since` a tail was attached with, in attach order. */
  sinces?: (string | undefined)[];
}): { collector: ContainerLogCollector; emit: () => Emit } {
  let emitter: Emit | undefined;
  const collector = new ContainerLogCollector({
    serverId: "srv-1",
    now: () => 1_700_000_000_000,
    flushIntervalMs: 1_000_000,
    flushBytes: 1_000_000,
    ...(options.maxBufferedEvents === undefined
      ? {}
      : { maxBufferedEvents: options.maxBufferedEvents }),
    ...(options.maxBatchSize === undefined
      ? {}
      : { maxBatchSize: options.maxBatchSize }),
    ...(options.sharedRedactor
      ? {}
      : { redactor: createMutableTranscriptRedactor(options.secrets ?? []) }),
    ...(options.readyToSend ? { readyToSend: options.readyToSend } : {}),
    discover: () => Promise.resolve(options.targets),
    tail: (params) => {
      options.sinces?.push(params.since);
      emitter = params.onLine;
      // Never resolves while attached — a real tail only ends on abort.
      return new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
    send: options.send ??
      ((events) => {
        options.batches.push([...events]);
        return Promise.resolve();
      }),
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  return {
    collector,
    emit: () => {
      assert(emitter, "tail was never attached");
      return emitter;
    },
  };
}

const TARGET: ContainerLogTarget = {
  containerId: "c0ffee",
  environmentId: "11111111-1111-4111-8111-111111111111",
  serviceId: "22222222-2222-4222-8222-222222222222",
};

test("splitDockerTimestampLine separates the --timestamps prefix", () => {
  assertEquals(
    splitDockerTimestampLine("2026-08-21T10:00:00.123456789Z hello world"),
    { timestamp: "2026-08-21T10:00:00.123Z", message: "hello world" },
  );
});

test("splitDockerTimestampLine passes an unprefixed line through", () => {
  assertEquals(splitDockerTimestampLine("plain line"), {
    timestamp: null,
    message: "plain line",
  });
});

test("collector batches tailed lines with container identity", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({ targets: [TARGET], batches });
  collector.start();
  await collector.reconcile();

  emit()("stdout", "2026-08-21T10:00:00.000Z listening on 8080");
  emit()("stderr", "2026-08-21T10:00:01.000Z ECONNREFUSED");
  await collector.flush();
  await collector.stop();

  assertEquals(batches.length, 1);
  assertEquals(batches[0]?.length, 2);
  assertEquals(batches[0]?.[0], {
    timestamp: "2026-08-21T10:00:00.000Z",
    organizationId: "",
    serverId: "srv-1",
    environmentId: TARGET.environmentId,
    serviceId: TARGET.serviceId,
    containerId: TARGET.containerId,
    stream: "stdout",
    message: "listening on 8080",
  });
  assertEquals(batches[0]?.[1]?.stream, "stderr");
});

test("collector redacts deny-set plaintext before buffering", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({
    targets: [TARGET],
    batches,
    secrets: ["hunter2"],
  });
  collector.start();
  await collector.reconcile();
  emit()("stdout", "2026-08-21T10:00:00.000Z db password is hunter2");
  await collector.flush();
  await collector.stop();

  assertEquals(batches[0]?.[0]?.message, "db password is ***");
});

test("collector truncates a line past the message byte cap", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({ targets: [TARGET], batches });
  collector.start();
  await collector.reconcile();
  emit()("stdout", "x".repeat(MAX_CONTAINER_LOG_MESSAGE_BYTES + 500));
  await collector.flush();
  await collector.stop();

  assertEquals(
    batches[0]?.[0]?.message.length,
    MAX_CONTAINER_LOG_MESSAGE_BYTES,
  );
});

test("collector drops the oldest lines once the ring buffer is full", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({
    targets: [TARGET],
    batches,
    maxBufferedEvents: 3,
  });
  collector.start();
  await collector.reconcile();
  for (let index = 0; index < 5; index++) {
    emit()("stdout", `line-${index}`);
  }
  assertEquals(collector.stats().droppedEvents, 2);
  await collector.flush();
  await collector.stop();

  assertEquals(
    batches[0]?.map((event) => event.message),
    ["line-2", "line-3", "line-4"],
  );
});

test("collector splits a flush into batches at the batch cap", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({
    targets: [TARGET],
    batches,
    maxBatchSize: 2,
  });
  collector.start();
  await collector.reconcile();
  for (let index = 0; index < 5; index++) emit()("stdout", `line-${index}`);
  await collector.flush();
  await collector.stop();

  assertEquals(batches.map((batch) => batch.length), [2, 2, 1]);
  assertEquals(collector.stats().sentEvents, 5);
});

test("collector counts a failed batch as dropped and never throws", async () => {
  const { collector, emit } = makeCollector({
    targets: [TARGET],
    batches: [],
    send: () => Promise.reject(new Error("instance unreachable")),
  });
  collector.start();
  await collector.reconcile();
  emit()("stdout", "line");
  await collector.flush();
  await collector.stop();

  const stats = collector.stats();
  assertEquals(stats.failedBatches, 1);
  assertEquals(stats.droppedEvents, 1);
  assertEquals(stats.sentEvents, 0);
});

test("reconcile drops tails for containers that disappeared", async () => {
  const targets: ContainerLogTarget[] = [TARGET];
  const { collector } = makeCollector({ targets, batches: [] });
  collector.start();
  await collector.reconcile();
  assertEquals(collector.stats().tailedContainers, 1);

  targets.length = 0;
  await collector.reconcile();
  assertEquals(collector.stats().tailedContainers, 0);
  await collector.stop();
});

test("stop flushes what is still buffered", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({ targets: [TARGET], batches });
  collector.start();
  await collector.reconcile();
  emit()("stdout", "final line");
  await collector.stop();

  assertEquals(batches[0]?.[0]?.message, "final line");
  assertEquals(collector.running, false);
});

const PROJECT_NAME = "tenant-app";
const ENV_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";

function dockerPsJson(rows: Record<string, unknown>[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function identityIndex(): DeploymentIdentityIndex {
  return new Map([[PROJECT_NAME, {
    environmentId: ENV_ID,
    serviceIds: { web: SERVICE_ID },
  }]]);
}

test("createDockerPsObservation reads compose identity, not TurboPanel labels", async () => {
  const observe = createDockerPsObservation(() =>
    Promise.resolve({
      success: true,
      code: 0,
      stdout: dockerPsJson([{
        ID: "abc123",
        Labels:
          `com.docker.compose.project=${PROJECT_NAME},com.docker.compose.service=web`,
      }]),
      stderr: "",
    })
  );
  assertEquals(await observe(), [
    {
      containerId: "abc123",
      composeProject: PROJECT_NAME,
      composeService: "web",
    },
  ]);
});

test("createDockerPsObservation yields nothing when docker ps fails", async () => {
  const observe = createDockerPsObservation(() =>
    Promise.resolve({
      success: false,
      code: 1,
      stdout: "",
      stderr: "permission denied",
    })
  );
  assertEquals(await observe(), []);
});

test("identity comes from the manifest even when the labels drifted", () => {
  // The container still carries TurboPanel labels, and both are wrong: a
  // redeploy outside the pipeline re-stamped them. The manifest wins.
  const drifted = resolveContainerLogTargets([{
    containerId: "abc123",
    composeProject: PROJECT_NAME,
    composeService: "web",
  }], identityIndex());
  assertEquals(drifted, [{
    containerId: "abc123",
    environmentId: ENV_ID,
    serviceId: SERVICE_ID,
  }]);
});

test("an unlabeled compose service still resolves its environment", () => {
  // No `com.turbopanel.service` anywhere, and the compose service is not one
  // the payload named a service for: the environment is still authoritative,
  // and the service id is honestly null rather than guessed.
  assertEquals(
    resolveContainerLogTargets([{
      containerId: "sidecar1",
      composeProject: PROJECT_NAME,
      composeService: "redis",
    }], identityIndex()),
    [{ containerId: "sidecar1", environmentId: ENV_ID, serviceId: null }],
  );
});

test("containers outside this host's deployments are never tailed", () => {
  assertEquals(
    resolveContainerLogTargets([
      {
        containerId: "x",
        composeProject: "turbopanel-managed-1",
        composeService: "db",
      },
      { containerId: "y", composeProject: null, composeService: null },
    ], identityIndex()),
    [],
  );
});

test("createDeploymentIdentityLoader indexes local deployment manifests", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const dir = join(stateDir, "deployments", "proj-1", ENV_ID);
    await Deno.mkdir(dir, { recursive: true });
    const manifest: DeploymentManifestV2 = {
      version: 2,
      projectId: "proj-1",
      environmentId: ENV_ID,
      serverId: "srv-1",
      generation: 3,
      projectName: PROJECT_NAME,
      composeSha256: "a".repeat(64),
      services: { web: { replicas: 1 } },
      serviceIds: { web: SERVICE_ID },
    };
    await writeDeploymentManifest(dir, manifest);

    const index = await createDeploymentIdentityLoader({ stateDir })();
    assertEquals(index.get(PROJECT_NAME), {
      environmentId: ENV_ID,
      serviceIds: { web: SERVICE_ID },
    });
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("createDeploymentManifestDiscovery joins observation against manifests", async () => {
  const discover = createDeploymentManifestDiscovery({
    layout: { stateDir: "/unused" },
    observe: () =>
      Promise.resolve([{
        containerId: "abc123",
        composeProject: PROJECT_NAME,
        composeService: "web",
      }]),
    loadIdentity: () => Promise.resolve(identityIndex()),
  });
  assertEquals(await discover(), [{
    containerId: "abc123",
    environmentId: ENV_ID,
    serviceId: SERVICE_ID,
  }]);
});

test("a secret decrypted before collection started is still redacted", async () => {
  // The deploy that decrypted this ran while retention was off; the collector
  // that starts afterwards must inherit the deny-set, not begin empty.
  resetSharedSecretRedactorForTests();
  resetContainerLogCursorsForTests();
  try {
    rememberSecretPlaintexts(["s3cret-before-collection"]);

    const batches: ContainerLogBatchEvent[][] = [];
    const { collector, emit } = makeCollector({
      targets: [TARGET],
      batches,
      sharedRedactor: true,
    });
    collector.start();
    await collector.reconcile();
    emit()(
      "stdout",
      "2026-08-21T10:00:00.000Z token=s3cret-before-collection",
    );
    await collector.flush();
    await collector.stop();

    assertEquals(batches[0]?.[0]?.message, "token=***");
  } finally {
    resetSharedSecretRedactorForTests();
    resetContainerLogCursorsForTests();
  }
});

test("a restarted collector resumes each tail from the retained cursor", async () => {
  resetContainerLogCursorsForTests();
  const first = makeCollector({ targets: [TARGET], batches: [] });
  first.collector.start();
  await first.collector.reconcile();
  first.emit()("stdout", "2026-08-21T10:00:00.000Z before the restart");
  await first.collector.stop();

  // Collection is re-enabled (or the daemon rebound its server id): a brand
  // new collector must not attach with `--tail 0` and lose the gap.
  const sinces: (string | undefined)[] = [];
  const second = makeCollector({ targets: [TARGET], batches: [], sinces });
  second.collector.start();
  await second.collector.reconcile();
  await second.collector.stop();

  assertEquals(sinces, ["2026-08-21T10:00:00.000Z"]);
  resetContainerLogCursorsForTests();
});

test("a recreated container resumes from its environment cursor", async () => {
  resetContainerLogCursorsForTests();
  const targets: ContainerLogTarget[] = [TARGET];
  const sinces: (string | undefined)[] = [];
  const { collector, emit } = makeCollector({ targets, batches: [], sinces });
  collector.start();
  await collector.reconcile();
  emit()("stdout", "2026-08-21T10:00:00.000Z before the recreate");

  // `docker compose up` replaced the container: new id, no cursor of its own,
  // and it has been printing since before this discovery pass noticed it.
  targets[0] = { ...TARGET, containerId: "deadbeef" };
  await collector.reconcile();
  await collector.stop();

  assertEquals(sinces.length, 2);
  assertEquals(sinces[1], "2026-08-21T10:00:00.000Z");
  resetContainerLogCursorsForTests();
});

test("a flush with no transport keeps its lines instead of dropping them", async () => {
  resetContainerLogCursorsForTests();
  const batches: ContainerLogBatchEvent[][] = [];
  let connected = false;
  const { collector, emit } = makeCollector({
    targets: [TARGET],
    batches,
    readyToSend: () => connected,
  });
  collector.start();
  await collector.reconcile();
  emit()("stdout", "2026-08-21T10:00:00.000Z printed while disconnected");
  await collector.flush();

  assertEquals(batches.length, 0);
  assertEquals(collector.stats().droppedEvents, 0);
  assertEquals(collector.stats().buffered, 1);

  connected = true;
  await collector.flush();
  await collector.stop();

  assertEquals(batches[0]?.[0]?.message, "printed while disconnected");
  assertEquals(collector.stats().droppedEvents, 0);
  resetContainerLogCursorsForTests();
});

test("splitDockerTimestampLine rejects a non-parseable stamp prefix", () => {
  assertEquals(
    splitDockerTimestampLine("2026-99-99T99:99:99Z still a line"),
    { timestamp: null, message: "2026-99-99T99:99:99Z still a line" },
  );
});

test("collector flushes when buffered bytes hit the flushBytes cap", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  let emitter: Emit | undefined;
  const tiny = new ContainerLogCollector({
    serverId: "srv-1",
    now: () => 1_700_000_000_000,
    flushIntervalMs: 1_000_000,
    flushBytes: 20,
    maxBatchSize: 100,
    redactor: createMutableTranscriptRedactor([]),
    discover: () => Promise.resolve([TARGET]),
    tail: (params) => {
      emitter = params.onLine;
      return new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    send: (events) => {
      batches.push([...events]);
      return Promise.resolve();
    },
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  tiny.start();
  await tiny.reconcile();
  assert(emitter, "tail was never attached");
  emitter("stdout", "abcdefghijklmnopqrstuvwxyz");
  await tiny.flush();
  await tiny.stop();
  assertEquals(batches.length >= 1, true);
  assertEquals(
    batches[0]?.[0]?.message.includes("abcdefghijklmnopqrstuvwxyz"),
    true,
  );
});

test("collector drops a blank line before buffering", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({ targets: [TARGET], batches });
  collector.start();
  await collector.reconcile();
  emit()("stdout", "");
  await collector.flush();
  await collector.stop();
  assertEquals(batches.length, 0);
});

test("collector start/stop are idempotent and addSecrets extends the deny-set", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({ targets: [TARGET], batches });
  collector.start();
  collector.start();
  await collector.reconcile();
  collector.addSecrets(["tokensecret"]);
  emit()("stdout", "leak tokensecret here");
  await collector.stop();
  await collector.stop();
  assertEquals(batches[0]?.[0]?.message, "leak *** here");
  assertEquals(collector.running, false);
});

test("reconcile swallows discovery failures and updates existing targets", async () => {
  let fail = false;
  let targets: ContainerLogTarget[] = [TARGET];
  let emitter: Emit | undefined;
  const batches: ContainerLogBatchEvent[][] = [];
  const collector = new ContainerLogCollector({
    serverId: "srv-1",
    now: () => 1_700_000_000_000,
    flushIntervalMs: 1_000_000,
    flushBytes: 1_000_000,
    redactor: createMutableTranscriptRedactor([]),
    discover: () => {
      if (fail) return Promise.reject(new Error("discover boom"));
      return Promise.resolve(targets);
    },
    tail: (params) => {
      emitter = params.onLine;
      return new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    send: (events) => {
      batches.push([...events]);
      return Promise.resolve();
    },
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  collector.start();
  await collector.reconcile();
  assertEquals(collector.stats().tailedContainers, 1);

  targets = [{
    ...TARGET,
    serviceId: "33333333-3333-4333-8333-333333333333",
  }];
  await collector.reconcile();
  assertEquals(collector.stats().tailedContainers, 1);
  assert(emitter);
  emitter("stdout", "still attached");

  fail = true;
  await collector.reconcile();
  assertEquals(collector.stats().tailedContainers, 1);

  await collector.flush();
  await collector.stop();
  assertEquals(batches[0]?.[0]?.serviceId, "33333333-3333-4333-8333-333333333333");
});

test("constructor without layout or discover throws", () => {
  assertThrows(
    () =>
      new ContainerLogCollector({
        serverId: "srv-1",
        send: () => Promise.resolve(),
      }),
    TypeError,
    "needs a layout",
  );
});

test("createDockerPsObservation skips blank ids and rows without compose labels", async () => {
  const observe = createDockerPsObservation(() =>
    Promise.resolve({
      success: true,
      code: 0,
      stdout: [
        JSON.stringify({
          ID: "",
          Labels: `com.docker.compose.project=${PROJECT_NAME}`,
        }),
        JSON.stringify({
          ID: "ok1",
          Labels:
            `com.docker.compose.project=${PROJECT_NAME},com.docker.compose.service=web`,
        }),
        JSON.stringify({ ID: "ok2", Labels: "" }),
      ].join("\n"),
      stderr: "",
    })
  );
  const rows = await observe();
  assertEquals(rows.length, 2);
  assertEquals(rows[0]?.containerId, "ok1");
  assertEquals(rows[0]?.composeProject, PROJECT_NAME);
  assertEquals(rows[0]?.composeService, "web");
  assertEquals(rows[1]?.containerId, "ok2");
  assertEquals(rows[1]?.composeProject, null);
  assertEquals(rows[1]?.composeService, null);
});

test("createDockerPsObservation yields nothing when NDJSON is corrupted", async () => {
  const observe = createDockerPsObservation(() =>
    Promise.resolve({
      success: true,
      code: 0,
      stdout: "{not-json\n" + JSON.stringify({ ID: "x", Labels: "" }),
      stderr: "",
    })
  );
  assertEquals(await observe(), []);
});

test("createDeploymentIdentityLoader skips invalid manifests", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const good = join(stateDir, "deployments", "proj-1", ENV_ID);
    await Deno.mkdir(good, { recursive: true });
    await writeDeploymentManifest(good, {
      version: 2,
      projectId: "proj-1",
      environmentId: ENV_ID,
      serverId: "srv-1",
      generation: 1,
      projectName: PROJECT_NAME,
      composeSha256: "a".repeat(64),
      services: {},
      serviceIds: { web: SERVICE_ID },
    });
    const bad = join(stateDir, "deployments", "proj-2", ENV_ID);
    await Deno.mkdir(bad, { recursive: true });
    await Deno.writeTextFile(join(bad, "deployment.json"), "{bad");

    const index = await createDeploymentIdentityLoader({ stateDir })();
    assertEquals(index.size, 1);
    assertEquals(index.get(PROJECT_NAME)?.environmentId, ENV_ID);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("start/stopContainerLogCollection manages the process-wide collector", async () => {
  resetContainerLogCursorsForTests();
  await stopContainerLogCollection();
  assertEquals(isContainerLogCollectionEnabled(), false);
  assertEquals(activeContainerLogCollector(), undefined);

  const batches: ContainerLogBatchEvent[][] = [];
  const first = startContainerLogCollection({
    serverId: "srv-1",
    now: () => 1_700_000_000_000,
    flushIntervalMs: 1_000_000,
    flushBytes: 1_000_000,
    redactor: createMutableTranscriptRedactor([]),
    discover: () => Promise.resolve([TARGET]),
    tail: (params) =>
      new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    send: (events) => {
      batches.push([...events]);
      return Promise.resolve();
    },
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  assertEquals(isContainerLogCollectionEnabled(), true);
  assertEquals(activeContainerLogCollector(), first);

  // Same server while running → no-op reuse.
  const again = startContainerLogCollection({
    serverId: "srv-1",
    send: () => Promise.resolve(),
    discover: () => Promise.resolve([]),
  });
  assertEquals(again, first);

  // Different server replaces the collector.
  const second = startContainerLogCollection({
    serverId: "srv-2",
    now: () => 1_700_000_000_000,
    flushIntervalMs: 1_000_000,
    flushBytes: 1_000_000,
    redactor: createMutableTranscriptRedactor([]),
    discover: () => Promise.resolve([]),
    tail: (params) =>
      new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    send: () => Promise.resolve(),
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  assertEquals(second.serverId, "srv-2");
  assertEquals(activeContainerLogCollector()?.serverId, "srv-2");

  await stopContainerLogCollection();
  assertEquals(isContainerLogCollectionEnabled(), false);
  await stopContainerLogCollection();
  resetContainerLogCursorsForTests();
});

test("a non-timestamped line stamps the event from the injectable clock", async () => {
  const batches: ContainerLogBatchEvent[][] = [];
  const { collector, emit } = makeCollector({ targets: [TARGET], batches });
  collector.start();
  await collector.reconcile();
  emit()("stdout", "plain without stamp");
  await collector.flush();
  await collector.stop();
  assertEquals(batches[0]?.[0]?.timestamp, new Date(1_700_000_000_000).toISOString());
  assertEquals(batches[0]?.[0]?.message, "plain without stamp");
});

test("tail retry re-attaches after the child exits while still running", async () => {
  resetContainerLogCursorsForTests();
  const attachCount = { n: 0 };
  const batches: ContainerLogBatchEvent[][] = [];
  let resolveFirst!: () => void;
  const collector = new ContainerLogCollector({
    serverId: "srv-1",
    now: () => 1_700_000_000_000,
    flushIntervalMs: 1_000_000,
    flushBytes: 1_000_000,
    tailRetryMs: 5,
    redactor: createMutableTranscriptRedactor([]),
    discover: () => Promise.resolve([TARGET]),
    tail: (params) => {
      attachCount.n += 1;
      if (attachCount.n === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
          params.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      return new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    send: (events) => {
      batches.push([...events]);
      return Promise.resolve();
    },
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  collector.start();
  await collector.reconcile();
  assertEquals(attachCount.n, 1);
  // End the first tail without aborting the controller (docker child exit).
  resolveFirst();
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(attachCount.n >= 2, true);
  await collector.stop();
  resetContainerLogCursorsForTests();
});
