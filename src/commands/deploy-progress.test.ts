import { assert, assertEquals } from "@std/assert";
import {
  COMMAND_PROGRESS_MAX_BYTES,
  COMMAND_PROGRESS_MAX_DETAIL_CHARS,
  COMMAND_PROGRESS_MAX_STEPS,
  type CommandProgressMessage,
} from "../contracts/cell-messages.ts";
import {
  COMMAND_LOG_PHASES,
  createNoopCommandOutputSink,
} from "../logs/contracts.ts";
import type { AnsibleEvent } from "../orchestration/ansible-events.ts";
import {
  clampCommandProgress,
  createDeployStepReporter,
  createNoopDeployStepReporter,
  createPlaybookEventHandler,
  DEPLOY_PROGRESS_DETAIL_INTERVAL_MS,
  DEPLOY_PROGRESS_KEEPALIVE_MS,
  DEPLOY_PROGRESS_WAITING_BEAT_MS,
  type PlannedDeployStep,
  sendOverOpenSocket,
} from "./deploy-progress.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests (see deploy-environment.test.ts). */
const test = Deno.test.bind(Deno);

const PLAN: PlannedDeployStep[] = [
  { id: "install-docker", label: "Install Docker", state: "ready" },
  { id: "install-php:8.3", label: "Install PHP 8.3", state: "pending" },
  { id: "fetch", label: "Fetch the code", state: "pending" },
  { id: "build", label: "Build", state: "pending" },
  { id: "start", label: "Start the app", state: "pending" },
  { id: "health", label: "Check it answers", state: "pending" },
];

function harness(startMs = 1_000_000) {
  let nowMs = startMs;
  const sent: CommandProgressMessage[] = [];
  // Fake timers: the trailing flush fires when the harness advances past it.
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const reporter = createDeployStepReporter({
    id: "dispatch-1",
    commandId: "cmd-1",
    send: (message) => {
      sent.push(message);
      return true;
    },
    now: () => new Date(nowMs),
    setTimer: (fn, ms) => {
      const handle = nextTimer++;
      timers.set(handle, { at: nowMs + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  return {
    reporter,
    sent,
    timers,
    advance: (ms: number) => {
      nowMs += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at > nowMs) continue;
        timers.delete(handle);
        timer.fn();
      }
    },
    last: () => sent[sent.length - 1].progress,
    states: () =>
      Object.fromEntries(
        sent[sent.length - 1].progress.steps.map((s) => [s.id, s.state]),
      ),
  };
}

test("plan sends the whole payload with ready and pending steps", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  assertEquals(h.sent.length, 1);
  const message = h.sent[0];
  assertEquals(message.type, "command-progress");
  assertEquals(message.id, "dispatch-1");
  assertEquals(message.commandId, "cmd-1");
  assertEquals(message.progress.version, 1);
  assertEquals(message.progress.current, null);
  assertEquals(h.states(), {
    "install-docker": "ready",
    "install-php:8.3": "pending",
    fetch: "pending",
    build: "pending",
    start: "pending",
    health: "pending",
  });
});

test("start / done stamp times, set current and leave ready steps alone", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.start("install-docker");
  assertEquals(h.sent.length, 1, "a ready step is not restarted");
  h.reporter.start("install-php:8.3");
  assertEquals(h.last().current, "install-php:8.3");
  const running = h.last().steps.find((s) => s.id === "install-php:8.3");
  assertEquals(running?.state, "running");
  assertEquals(running?.startedAt, new Date(1_000_000).toISOString());
  h.advance(5_000);
  h.reporter.done("install-php:8.3");
  const done = h.last().steps.find((s) => s.id === "install-php:8.3");
  assertEquals(done?.state, "done");
  assertEquals(done?.finishedAt, new Date(1_005_000).toISOString());
  assertEquals(h.last().current, null);
  // Done is final for an explicit start: wrapping an idempotent ensure twice
  // does not reopen the step.
  h.reporter.start("install-php:8.3");
  assertEquals(h.states()["install-php:8.3"], "done");
});

test("starting the next step finishes the one running before it", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.start("fetch");
  h.reporter.start("build");
  assertEquals(h.states().fetch, "done");
  assertEquals(h.states().build, "running");
  assertEquals(h.last().current, "build");
});

test("transcript phases drive fetch / build / start / health and reopen a repeated phase", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.phase(COMMAND_LOG_PHASES.PREPARE);
  assertEquals(h.sent.length, 1, "prepare is not a step");
  h.reporter.phase(COMMAND_LOG_PHASES.FETCH);
  h.reporter.phase(COMMAND_LOG_PHASES.BUILD);
  h.reporter.phase(COMMAND_LOG_PHASES.FETCH);
  assertEquals(h.states().fetch, "running", "second release fetch reopens");
  assertEquals(h.states().build, "done");
  h.reporter.phase(COMMAND_LOG_PHASES.COMPOSE_UP);
  h.reporter.phase(COMMAND_LOG_PHASES.HEALTH);
  assertEquals(h.states().start, "done");
  assertEquals(h.states().health, "running");
});

test("detail is throttled to one message per interval and rides the next transition", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.start("install-php:8.3");
  const before = h.sent.length;
  h.reporter.detail("install-php:8.3", "Install php8.3-fpm");
  assertEquals(h.sent.length, before, "inside the interval: stored only");
  h.advance(DEPLOY_PROGRESS_DETAIL_INTERVAL_MS);
  assertEquals(h.sent.length, before + 1, "flushed when the window ends");
  assertEquals(
    h.last().steps.find((s) => s.id === "install-php:8.3")?.detail,
    "Install php8.3-fpm",
  );
  h.advance(DEPLOY_PROGRESS_DETAIL_INTERVAL_MS);
  h.reporter.detail("install-php:8.3", "Enable php8.3-fpm");
  assertEquals(h.sent.length, before + 2, "interval elapsed: sent at once");
  h.advance(100);
  h.reporter.detail("install-php:8.3", "Restart php8.3-fpm");
  h.reporter.detail("install-php:8.3", "Restart php8.3-fpm");
  assertEquals(h.sent.length, before + 2, "throttled again, one timer armed");
  assertEquals(h.timers.size, 1);
  h.reporter.done("install-php:8.3");
  assertEquals(h.timers.size, 0, "the transition carries it; timer cleared");
  const finished = h.last().steps.find((s) => s.id === "install-php:8.3");
  assertEquals(finished?.detail, undefined, "a done step has no ticker");
  h.reporter.detail("fetch", "ignored: nothing running");
  assertEquals(h.sent.length, before + 3);
  assertEquals(h.timers.size, 0);
});

test("a long first task still gets its ticker: one trailing flush, no more", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.start("install-php:8.3");
  const before = h.sent.length;
  h.advance(500);
  h.reporter.detail("install-php:8.3", "Install php8.3-fpm (takes minutes)");
  h.advance(DEPLOY_PROGRESS_DETAIL_INTERVAL_MS - 500);
  assertEquals(h.sent.length, before + 1);
  h.advance(60_000);
  assertEquals(h.sent.length, before + 1, "nothing new to say, nothing sent");
  h.reporter.finish("failed");
  assertEquals(h.timers.size, 0);
});

test("detail for a step that is not running goes to the running step of the group", () => {
  const h = harness();
  h.reporter.plan([
    { id: "install-runtime:node-20", label: "Install Node 20", state: "ready" },
    {
      id: "install-runtime:node-22",
      label: "Install Node 22",
      state: "pending",
    },
    ...PLAN,
  ]);
  h.reporter.start(["install-runtime:node-20", "install-runtime:node-22"]);
  assertEquals(h.last().current, "install-runtime:node-22");
  h.advance(DEPLOY_PROGRESS_DETAIL_INTERVAL_MS);
  h.reporter.detail("install-runtime:node-20", "Download Node 22");
  const steps = h.last().steps;
  assertEquals(
    steps.find((s) => s.id === "install-runtime:node-20")?.detail,
    undefined,
  );
  assertEquals(
    steps.find((s) => s.id === "install-runtime:node-22")?.detail,
    "Download Node 22",
  );
});

test("a nested install keeps the enclosing step running and hands current back", () => {
  const h = harness();
  h.reporter.plan([
    {
      id: "install-build-tool",
      label: "Install the build tool",
      state: "pending",
    },
    ...PLAN,
  ]);
  h.reporter.phase(COMMAND_LOG_PHASES.BUILD);
  h.reporter.start("install-build-tool", { nested: true });
  assertEquals(h.states().build, "running");
  assertEquals(h.last().current, "install-build-tool");
  h.reporter.done("install-build-tool");
  assertEquals(h.last().current, "build");
  assertEquals(h.states().build, "running");
  // Restoring the phase afterwards changes nothing.
  const sentBefore = h.sent.length;
  h.reporter.phase(COMMAND_LOG_PHASES.BUILD);
  assertEquals(h.sent.length, sentBefore);

  const failing = harness();
  failing.reporter.plan([
    {
      id: "install-build-tool",
      label: "Install the build tool",
      state: "pending",
    },
    ...PLAN,
  ]);
  failing.reporter.phase(COMMAND_LOG_PHASES.BUILD);
  failing.reporter.start("install-build-tool", { nested: true });
  failing.reporter.fail("install-build-tool");
  assertEquals(failing.states()["install-build-tool"], "failed");
  assertEquals(failing.states().build, "pending", "the build never ran");
  failing.reporter.finish("failed");
  assertEquals(failing.states().build, "skipped");
});

test("promote and the deploy hooks belong to start, not build or health", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.phase(COMMAND_LOG_PHASES.BUILD);
  h.reporter.phase(COMMAND_LOG_PHASES.RELEASE_PROMOTE);
  assertEquals(h.states().build, "done");
  assertEquals(h.states().start, "running");
  h.reporter.phase(COMMAND_LOG_PHASES.PRE_DEPLOY);
  h.reporter.phase(COMMAND_LOG_PHASES.COMPOSE_UP);
  h.reporter.phase(COMMAND_LOG_PHASES.HEALTH);
  h.reporter.phase(COMMAND_LOG_PHASES.POST_DEPLOY);
  assertEquals(h.states().health, "done");
  assertEquals(h.states().start, "running");
  assertEquals(h.last().current, "start");
});

test("detail is capped and ignored for a step that is not running", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.start("fetch");
  h.advance(DEPLOY_PROGRESS_DETAIL_INTERVAL_MS);
  h.reporter.detail("fetch", "x".repeat(500));
  assertEquals(
    h.last().steps.find((s) => s.id === "fetch")?.detail?.length,
    COMMAND_PROGRESS_MAX_DETAIL_CHARS,
  );
});

test("finish on failure marks running failed and pending skipped", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.start("install-php:8.3");
  h.reporter.done("install-php:8.3");
  h.reporter.start("fetch");
  h.reporter.finish("failed");
  assertEquals(h.states(), {
    "install-docker": "ready",
    "install-php:8.3": "done",
    fetch: "failed",
    build: "skipped",
    start: "skipped",
    health: "skipped",
  });
  assertEquals(h.last().current, null);
});

test("finish on cancel marks the running step skipped; success leaves pending alone", () => {
  const cancelled = harness();
  cancelled.reporter.plan(PLAN);
  cancelled.reporter.start("build");
  cancelled.reporter.finish("cancelled");
  assertEquals(cancelled.states().build, "skipped");
  assertEquals(cancelled.states().health, "skipped");

  const ok = harness();
  ok.reporter.plan(PLAN);
  ok.reporter.start("health");
  const sentBefore = ok.sent.length;
  ok.reporter.finish("succeeded");
  assertEquals(ok.states().health, "done");
  assertEquals(ok.states().start, "pending");
  assertEquals(ok.sent.length, sentBefore + 1);
  // Nothing running, nothing pending to skip: no extra message.
  const empty = harness();
  empty.reporter.finish("failed");
  assertEquals(empty.sent.length, 0);
});

test("fail marks only the running steps and a group starts together", () => {
  const h = harness();
  h.reporter.plan([
    ...PLAN,
    {
      id: "install-web-server:apache",
      label: "Install Apache",
      state: "pending",
    },
  ]);
  h.reporter.start(["install-web-server:apache", "install-php:8.3"]);
  assertEquals(h.last().current, "install-web-server:apache");
  assertEquals(h.states()["install-php:8.3"], "running");
  h.advance(DEPLOY_PROGRESS_DETAIL_INTERVAL_MS);
  h.reporter.detail("install-php:8.3", "Install php8.3-fpm: apt failed");
  h.reporter.fail(["install-web-server:apache", "install-php:8.3", "fetch"]);
  assertEquals(h.states()["install-web-server:apache"], "failed");
  assertEquals(h.states()["install-php:8.3"], "failed");
  assertEquals(h.states().fetch, "pending");
  assertEquals(
    h.last().steps.find((s) => s.id === "install-php:8.3")?.detail,
    "Install php8.3-fpm: apt failed",
    "a failed step keeps the line that explains it",
  );
  // A ready step whose ensure still failed is not left ticked.
  h.reporter.fail("install-docker");
  assertEquals(h.states()["install-docker"], "failed");
  h.reporter.finish("failed");
  assertEquals(
    h.last().steps.find((s) => s.id === "install-php:8.3")?.detail,
    "Install php8.3-fpm: apt failed",
  );
});

test("the payload stays inside the wire caps", () => {
  const steps: PlannedDeployStep[] = [];
  for (let i = 0; i < COMMAND_PROGRESS_MAX_STEPS + 5; i += 1) {
    steps.push({
      id: `install-web-server:${"x".repeat(80)}${i}`,
      label: "L".repeat(100),
      state: "pending",
    });
  }
  const h = harness();
  h.reporter.plan(steps);
  assertEquals(h.last().steps.length, COMMAND_PROGRESS_MAX_STEPS);
  assert(h.last().steps.every((s) => s.id.length <= 64));
  assert(h.last().steps.every((s) => s.label.length <= 60));

  // Every step finished with timestamps and a full ticker: over the cap
  // before trimming, under it after.
  const stamp = new Date(0).toISOString();
  const fat = {
    version: 1 as const,
    current: h.last().steps[0].id,
    updatedAt: stamp,
    steps: h.last().steps.map((s, i) => ({
      ...s,
      state: i === 0 ? "running" as const : "done" as const,
      startedAt: stamp,
      finishedAt: stamp,
      detail: "d".repeat(COMMAND_PROGRESS_MAX_DETAIL_CHARS),
    })),
  };
  const fatBytes = new TextEncoder().encode(JSON.stringify(fat)).byteLength;
  assert(fatBytes > COMMAND_PROGRESS_MAX_BYTES, `fixture is ${fatBytes} bytes`);
  const clamped = clampCommandProgress(fat);
  const bytes = new TextEncoder().encode(JSON.stringify(clamped)).byteLength;
  assert(bytes <= COMMAND_PROGRESS_MAX_BYTES, `${bytes} bytes`);
  assertEquals(clamped.current, fat.current);
  assertEquals(
    clamped.steps[0].detail?.length,
    COMMAND_PROGRESS_MAX_DETAIL_CHARS,
  );
  assertEquals(clamped.steps[1].detail, undefined);
});

test("a send that throws never reaches the deploy", () => {
  const reporter = createDeployStepReporter({
    id: "d",
    commandId: "c",
    send: () => {
      throw new Error("socket closed");
    },
  });
  reporter.plan(PLAN);
  reporter.start("fetch");
  assertEquals(reporter.snapshot().current, "fetch");
});

test("the no-op reporter is disabled and inert", () => {
  const reporter = createNoopDeployStepReporter();
  assertEquals(reporter.enabled, false);
  reporter.plan(PLAN);
  reporter.start("fetch");
  assertEquals(reporter.snapshot().steps, []);
});

function taskStart(name: string): AnsibleEvent {
  return {
    _event: "v2_playbook_on_task_start",
    _timestamp: "t",
    task: { name, id: "1", path: "p", duration: { start: "s" } },
    hosts: {},
  };
}

test("playbook events become transcript lines and the step's ticker", () => {
  const lines: string[] = [];
  const sink = {
    ...createNoopCommandOutputSink(),
    onLine: (stream: string, message: string) => {
      lines.push(`${stream}:${message}`);
    },
  };
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.start("install-php:8.3");
  const handler = createPlaybookEventHandler(
    sink,
    h.reporter,
    "install-php:8.3",
  );
  h.advance(DEPLOY_PROGRESS_DETAIL_INTERVAL_MS);
  handler(taskStart("Install php8.3-fpm"));
  handler({
    _event: "v2_runner_on_ok",
    _timestamp: "t",
    task: {
      name: "Install php8.3-fpm",
      id: "1",
      path: "p",
      duration: { start: "s" },
    },
    hosts: { localhost: { changed: true } },
  });
  handler({
    _event: "v2_runner_on_failed",
    _timestamp: "t",
    task: {
      name: "Enable php8.3-fpm",
      id: "2",
      path: "p",
      duration: { start: "s" },
    },
    hosts: { localhost: { failed: true, msg: "unit not found" } },
  });
  assertEquals(lines.length, 2, "task start + failure, never ok/raw output");
  assertEquals(lines[0], "stdout:Install php8.3-fpm");
  assert(lines[1].startsWith("stderr:"));
  assert(lines[1].includes("unit not found"));
  assertEquals(
    h.last().steps.find((s) => s.id === "install-php:8.3")?.detail,
    "Install php8.3-fpm",
  );
});

test("sendOverOpenSocket sends only on an open socket", () => {
  const frames: string[] = [];
  const open = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      frames.push(data);
    },
  };
  const closed = { ...open, readyState: WebSocket.CLOSED };
  const message = { type: "echo", payload: 1, at: "t" } as const;
  assertEquals(sendOverOpenSocket(closed, message), false);
  assertEquals(sendOverOpenSocket(open, message), true);
  assertEquals(JSON.parse(frames[0]).type, "echo");
});

test("running reports when the deploy starts and when it waits for the host", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  assertEquals(h.last().runningSince, undefined);
  h.reporter.running(true);
  assertEquals(h.last().runningSince, new Date(1_000_000).toISOString());
  const count = h.sent.length;
  h.reporter.running(true);
  assertEquals(h.sent.length, count);
  h.advance(5000);
  h.reporter.running(false);
  assertEquals(h.last().runningSince, null);
  h.advance(5000);
  h.reporter.running(true);
  assertEquals(h.last().runningSince, new Date(1_010_000).toISOString());
});

test("a first running(false) reports the deploy as waiting", () => {
  const h = harness();
  h.reporter.running(false);
  assertEquals(h.last().runningSince, null);
  const count = h.sent.length;
  h.reporter.running(false);
  assertEquals(h.sent.length, count);
});

test("a deploy that waits for the host says so again every minute until it runs or ends", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.running(false);
  const afterWait = h.sent.length;
  h.advance(DEPLOY_PROGRESS_WAITING_BEAT_MS);
  assertEquals(h.sent.length, afterWait + 1);
  assertEquals(h.last().runningSince, null);
  h.advance(DEPLOY_PROGRESS_WAITING_BEAT_MS);
  assertEquals(h.sent.length, afterWait + 2);
  h.reporter.running(true);
  const afterRun = h.sent.length;
  h.advance(DEPLOY_PROGRESS_WAITING_BEAT_MS * 3);
  assertEquals(h.sent.length, afterRun);
  assertEquals(h.timers.size, 0);
});

test("finishing a deploy that is still waiting stops the repeat", () => {
  const h = harness();
  h.reporter.plan(PLAN);
  h.reporter.running(false);
  h.reporter.finish("cancelled");
  const count = h.sent.length;
  h.advance(DEPLOY_PROGRESS_WAITING_BEAT_MS * 2);
  assertEquals(h.sent.length, count);
});

test("a running deploy repeats its payload as a keepalive until it finishes", () => {
  let enabled = true;
  const seen: string[] = [];
  const reporter = createDeployStepReporter({
    id: "dispatch-ka",
    commandId: "cmd-ka",
    send: (message) => {
      seen.push(message.progress.updatedAt);
      return true;
    },
    now: () => new Date(2_000_000 + seen.length),
    setTimer: (fn, ms) => {
      timersKa.push({ fn, ms });
      return timersKa.length;
    },
    clearTimer: () => {},
    keepalive: () => enabled,
    onSnapshot: (progress) => snapshots.push(progress.steps.length),
  });
  const timersKa: Array<{ fn: () => void; ms: number }> = [];
  const snapshots: number[] = [];
  reporter.plan(PLAN);
  reporter.running(true);
  const before = seen.length;
  assertEquals(timersKa.at(-1)?.ms, DEPLOY_PROGRESS_KEEPALIVE_MS);
  timersKa.shift()?.fn();
  assertEquals(seen.length, before + 1);
  enabled = false; // an older control plane: no repeats
  timersKa.shift()?.fn();
  assertEquals(seen.length, before + 1);
  assertEquals(snapshots.length, seen.length);
  const timersAtFinish = timersKa.length;
  reporter.finish("succeeded");
  assertEquals(timersAtFinish >= 1, true);
});
