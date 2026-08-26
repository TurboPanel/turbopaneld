import { assertEquals, assertStringIncludes } from "@std/assert";
import type { AnsibleEvent } from "./ansible-events.ts";
import { InstallEventPresenter } from "./installer-tui.ts";
import { InstallPresenter } from "./install-presenter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TASK_DURATION = { start: "2026-01-01T00:00:00Z" };

function capturePresenterLines(
  fn: (presenter: InstallPresenter, events: InstallEventPresenter) => void,
): string[] {
  const presenter = new InstallPresenter(false);
  const events = new InstallEventPresenter(presenter);
  const lines: string[] = [];
  const original = presenter.pushStatus.bind(presenter);
  presenter.pushStatus = (line, opts) => {
    lines.push(line);
    original(line, opts);
  };
  try {
    fn(presenter, events);
  } finally {
    presenter.dispose();
  }
  return lines;
}

test("InstallEventPresenter surfaces changed ok tasks with a tilde prefix", () => {
  const lines = capturePresenterLines((_presenter, events) => {
    const event: AnsibleEvent = {
      _event: "v2_runner_on_ok",
      _timestamp: "2026-01-01T00:00:02Z",
      task: {
        name: "redis : install package",
        id: "task-1",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: { localhost: { changed: true } },
    };
    events.onEvent(event);
  });
  assertEquals(lines.some((line) => line.startsWith("~ ")), true);
});

test("InstallEventPresenter surfaces skipped tasks with a dash prefix", () => {
  const lines = capturePresenterLines((_presenter, events) => {
    const event: AnsibleEvent = {
      _event: "v2_runner_on_skipped",
      _timestamp: "2026-01-01T00:00:02Z",
      task: {
        name: "rabbitmq : configure",
        id: "task-2",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: { localhost: { skipped: true } },
    };
    events.onEvent(event);
  });
  assertEquals(lines.some((line) => line.startsWith("– ")), true);
});

test("InstallEventPresenter captures failure detail from unreachable tasks", () => {
  let failureDetail: string | null = null;
  capturePresenterLines((_presenter, events) => {
    const event: AnsibleEvent = {
      _event: "v2_runner_on_unreachable",
      _timestamp: "2026-01-01T00:00:02Z",
      task: {
        name: "ansible : ping",
        id: "task-3",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: { localhost: { msg: "connection refused" } },
    };
    events.onEvent(event);
    failureDetail = events.failureDetail;
  });
  if (failureDetail === null) {
    throw new TypeError("expected failure detail after unreachable task");
  }
  assertStringIncludes(failureDetail, "connection refused");
});

test("InstallEventPresenter summarizes playbook stats recap", () => {
  const lines = capturePresenterLines((_presenter, events) => {
    const event: AnsibleEvent = {
      _event: "v2_playbook_on_stats",
      _timestamp: "2026-01-01T00:00:03Z",
      stats: {
        localhost: { ok: 3, changed: 1, failures: 0, unreachable: 0 },
      },
      custom_stats: {},
      global_custom_stats: {},
    };
    events.onEvent(event);
  });
  assertEquals(
    lines.some((line) =>
      line.includes("orchestration applied (3 steps, 1 changes)")
    ),
    true,
  );
});

test("InstallEventPresenter beginStep clears prior failure detail", () => {
  let failureDetail: string | null = "stale";
  capturePresenterLines((_presenter, events) => {
    events.beginStep();
    failureDetail = events.failureDetail;
  });
  assertEquals(failureDetail, null);
});

test("InstallEventPresenter uses a generic play name when the play is unnamed", () => {
  const lines = capturePresenterLines((_presenter, events) => {
    events.onEvent({
      _event: "v2_playbook_on_play_start",
      _timestamp: "2026-01-01T00:00:00Z",
      play: { name: "   ", id: "play", path: "", duration: TASK_DURATION },
      tasks: [],
    });
  });
  assertEquals(lines.some((line) => line.includes("play")), true);
});

test("InstallEventPresenter ignores unchanged ok tasks and labels colon-less names", () => {
  const lines = capturePresenterLines((_presenter, events) => {
    events.onEvent({
      _event: "v2_runner_on_ok",
      _timestamp: "2026-01-01T00:00:02Z",
      task: {
        name: "cache : already present",
        id: "task-ok",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: { localhost: { changed: false } },
    });
    events.onEvent({
      _event: "v2_playbook_on_task_start",
      _timestamp: "2026-01-01T00:00:02Z",
      task: {
        name: "install package",
        id: "task-anon",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: {},
    });
  });
  assertEquals(lines.some((line) => line.startsWith("~ ")), false);
  assertEquals(lines.some((line) => line.includes("install package")), true);
});

test("InstallEventPresenter falls back when a failed host has no msg", () => {
  let failureDetail: string | null = null;
  capturePresenterLines((_presenter, events) => {
    events.onEvent({
      _event: "v2_runner_on_failed",
      _timestamp: "2026-01-01T00:00:02Z",
      task: {
        name: "orchestration : ping",
        id: "task-fail",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: { localhost: {} },
    });
    failureDetail = events.failureDetail;
  });
  if (failureDetail === null) {
    throw new TypeError("expected failure detail after failed task");
  }
  assertStringIncludes(failureDetail, "task failed");
});

test("InstallEventPresenter summarizes a failing recap and captures raw lines", () => {
  const lines = capturePresenterLines((_presenter, events) => {
    events.onRawLine("stderr", "   ");
    events.onRawLine("stderr", "ansible-playbook could not reach redis");
    events.onEvent({
      _event: "v2_playbook_on_stats",
      _timestamp: "2026-01-01T00:00:03Z",
      stats: {
        localhost: { ok: 2, changed: 0, failures: 1, unreachable: 0 },
      },
      custom_stats: {},
      global_custom_stats: {},
    });
  });
  assertEquals(
    lines.some((line) =>
      line.includes("orchestration failed (1 failure, 2 steps, 0 changes)")
    ),
    true,
  );
  assertEquals(
    lines.some((line) => line.includes("ansible-playbook could not reach redis")),
    true,
  );
});
