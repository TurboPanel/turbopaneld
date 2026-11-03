import { assertEquals } from "@std/assert";
import type {
  DaemonMessage,
  DevHostJob,
  DevHostStatus,
} from "../contracts/cell-messages.ts";
import {
  DAEMON_WIRE_FEATURES,
  DEV_HOST_FEATURE,
  MIN_SUPPORTED_INSTANCE_VERSION,
} from "../instance/version-wire.ts";
import { fakeRun } from "../testing/dev-host-fixture.ts";
import { devHostEnabled, resolveDevHostPaths } from "./config.ts";
import { DevHostJobRunner } from "./job.ts";
import { DevHostStatusCollector } from "./status.ts";
import {
  answerDevHostAction,
  boundStatus,
  DevHostService,
  startDevHostIfEnabled,
} from "./wire.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const NOW = Date.parse("2026-11-03T12:00:00.000Z");

test("dev-host-v1 is advertised and moved no floor", () => {
  assertEquals(DEV_HOST_FEATURE, "dev-host-v1");
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(DEV_HOST_FEATURE),
    true,
  );
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("the feature is on only for a development install with TURBOPANEL_DEV_INSTANCE=1", () => {
  assertEquals(
    devHostEnabled({ TURBOPANEL_DEV_INSTANCE: "1" }, "development"),
    true,
  );
  assertEquals(
    devHostEnabled({ TURBOPANEL_DEV_INSTANCE: "1" }, "production"),
    false,
  );
  assertEquals(devHostEnabled({}, "development"), false);
  assertEquals(
    devHostEnabled({ TURBOPANEL_DEV_INSTANCE: "yes" }, "development"),
    false,
  );
  assertEquals(startDevHostIfEnabled({}), null);
});

test("an action without a development host is answered not_development", async () => {
  assertEquals(
    await answerDevHostAction(undefined, {
      type: "dev-host-action",
      id: "a1",
      action: "update",
    }, () => NOW),
    {
      type: "dev-host-action-result",
      id: "a1",
      ok: false,
      error: "not_development",
      at: "2026-11-03T12:00:00.000Z",
    },
  );
});

test("a malformed action gets no answer and starts nothing", async () => {
  let started = 0;
  const port = {
    start: () => {
      started += 1;
      return Promise.resolve({ ok: true as const, jobId: "j" });
    },
  };
  assertEquals(
    await answerDevHostAction(port, { id: "a", action: "reset" as never }),
    null,
  );
  assertEquals(await answerDevHostAction(port, { action: "update" }), null);
  assertEquals(started, 0);
});

test("an action is answered with the job id, or job_running", async () => {
  const ok = await answerDevHostAction(
    {
      start: (action) => Promise.resolve({ ok: true, jobId: `job-${action}` }),
    },
    { id: "a2", action: "restart" },
    () => NOW,
  );
  assertEquals(ok, {
    type: "dev-host-action-result",
    id: "a2",
    ok: true,
    jobId: "job-restart",
    at: "2026-11-03T12:00:00.000Z",
  });
  const busy = await answerDevHostAction(
    {
      start: () => Promise.resolve({ ok: false, error: "job_running" }),
    },
    { id: "a3", action: "update" },
    () => NOW,
  );
  assertEquals(busy?.ok, false);
  assertEquals(busy?.error, "job_running");
  const thrown = await answerDevHostAction(
    {
      start: () => Promise.reject(new Error("disk full")),
    },
    { id: "a4", action: "update" },
    () => NOW,
  );
  assertEquals(thrown?.ok, false);
  assertEquals(thrown?.error, "start_failed");
});

async function withService(
  fn: (ctx: {
    service: DevHostService;
    written: DevHostStatus[];
    tickers: Array<() => void>;
    statusFile: string;
  }) => Promise<void>,
  options: { writeStatus?: boolean } = {},
): Promise<void> {
  const stateDir = await Deno.makeTempDir();
  try {
    const paths = resolveDevHostPaths({
      TURBOPANEL_DEV_ROOT: stateDir,
      TURBOPANEL_DAEMON_STATE_DIR: stateDir,
    });
    const run = fakeRun([]);
    const collector = new DevHostStatusCollector({
      paths,
      parts: [],
      run,
      daemonCommit: null,
    });
    const jobs = new DevHostJobRunner({ paths, parts: [], run, collector });
    const written: DevHostStatus[] = [];
    const tickers: Array<() => void> = [];
    const service = new DevHostService({
      collector,
      jobs,
      paths,
      nowMs: () => NOW,
      ...(options.writeStatus === false ? {} : {
        writeStatus: (status) => {
          written.push(status);
          return Promise.resolve();
        },
      }),
      every: (fn) => {
        tickers.push(fn);
        return () => {
          tickers.length = 0;
        };
      },
    });
    await fn({ service, written, tickers, statusFile: paths.statusFile });
    service.stop();
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

test("status goes out only to a control plane that lists dev-host-v1", async () => {
  await withService(async ({ service, written }) => {
    await service.run();
    assertEquals(written.length, 1);
    const sent: DaemonMessage[] = [];
    let supports = false;
    service.attach({
      send: (m) => {
        sent.push(m);
        return true;
      },
      peerSupports: () => supports,
    });
    assertEquals(sent.length, 0);
    supports = true;
    service.peerFeaturesChanged();
    assertEquals(sent, [{
      type: "dev-host-status",
      status: { parts: [], lastFetchAt: null, job: null },
      at: "2026-11-03T12:00:00.000Z",
    }]);
    // A tick sends again; a detached link gets nothing.
    await service.tick();
    assertEquals(sent.length, 2);
    service.detach();
    await service.tick();
    assertEquals(sent.length, 2);
  });
});

test("the minute timer ticks and stop cancels it; a job change goes out at once", async () => {
  await withService(async ({ service, written, tickers }) => {
    await service.run();
    assertEquals(tickers.length, 1);
    tickers[0]();
    await service.tick();
    assertEquals(written.length >= 2, true);
    const sent: DaemonMessage[] = [];
    service.attach({
      send: (m) => {
        sent.push(m);
        return true;
      },
      peerSupports: () => true,
    });
    const job: DevHostJob = {
      id: "j",
      action: "restart",
      state: "running",
      step: "restart-control-plane",
      steps: [{ name: "restart-control-plane", state: "running" }],
      startedAt: "2026-11-03T12:00:00.000Z",
      endedAt: null,
      logTail: [],
    };
    service.jobChanged(job);
    const last = sent.at(-1) as Extract<
      DaemonMessage,
      { type: "dev-host-status" }
    >;
    assertEquals(last.status.job, job);
    service.stop();
    assertEquals(tickers.length, 0);
  });
});

test("the status is mirrored to status.json", async () => {
  await withService(async ({ service, statusFile }) => {
    await service.run();
    const onDisk = JSON.parse(await Deno.readTextFile(statusFile));
    assertEquals(onDisk, {
      parts: [],
      lastFetchAt: null,
      job: null,
      writtenAt: "2026-11-03T12:00:00.000Z",
    });
  }, { writeStatus: false });
});

test("the control plane commit from the attach frame is kept only when it is text", async () => {
  await withService(({ service }) => {
    service.setControlPlaneCommit("a".repeat(40));
    assertEquals(service.controlPlaneCommit(), "a".repeat(40));
    service.setControlPlaneCommit(42);
    assertEquals(service.controlPlaneCommit(), null);
    return Promise.resolve();
  });
});

test("an oversized status is cut under the control plane's cap", () => {
  const part = {
    name: "control-plane" as const,
    unit: "turbopanel-instance",
    branch: "trunk",
    onTrunk: true,
    headCommit: "a".repeat(40),
    runningCommit: null,
    behindBy: 0,
    dirty: {
      files: 50,
      blocking: true,
      kinds: Array.from({ length: 50 }, (_, i) => ({
        path: `${"p".repeat(1000)}${i}`,
        kind: "content" as const,
      })),
    },
    restartNeeded: false,
    setupNeeded: {},
    active: true,
  };
  const small: DevHostStatus = { parts: [], lastFetchAt: null, job: null };
  assertEquals(boundStatus(small), small);
  const big: DevHostStatus = {
    parts: [part, { ...part, name: "daemon" }],
    lastFetchAt: null,
    job: null,
  };
  const cut = boundStatus(big);
  assertEquals(cut.parts.map((p) => p.dirty.kinds.length), [10, 10]);
  assertEquals(cut.parts.map((p) => p.dirty.files), [50, 50]);
  assertEquals(
    new TextEncoder().encode(JSON.stringify(cut)).length < 64 * 1024,
    true,
  );
});
