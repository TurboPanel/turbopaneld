import { assertEquals } from "@std/assert";
import {
  AnsibleRunSummaryCollector,
  formatAnsibleEventLog,
  formatPlaybookRecap,
  sanitizeAnsibleSummaryText,
} from "./ansible-events.ts";
import { setActiveInstallPresenter } from "./install-presenter-context.ts";
import { InstallPresenter } from "./install-presenter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TASK_DURATION = { start: "2026-01-01T00:00:00Z" };

test("formatPlaybookRecap aggregates host stats", () => {
  assertEquals(
    formatPlaybookRecap({
      localhost: { ok: 3, changed: 1, failed: 0, unreachable: 0 },
    }),
    "ok=3 changed=1 failed=0 unreachable=0",
  );
});

test("AnsibleRunSummaryCollector builds recap and first failure", () => {
  const collector = new AnsibleRunSummaryCollector();

  collector.handleEvent({
    _event: "v2_runner_on_failed",
    _timestamp: "2026-01-01T00:00:00Z",
    task: { name: "Set hostname", id: "1", path: "", duration: { start: "" } },
    hosts: { localhost: { msg: "permission denied" } },
  });
  collector.handleEvent({
    _event: "v2_runner_on_failed",
    _timestamp: "2026-01-01T00:00:01Z",
    task: { name: "Later task", id: "2", path: "", duration: { start: "" } },
    hosts: { localhost: { msg: "ignored" } },
  });
  collector.handleEvent({
    _event: "v2_playbook_on_stats",
    _timestamp: "2026-01-01T00:00:02Z",
    stats: { localhost: { ok: 1, changed: 0, failed: 1, unreachable: 0 } },
    custom_stats: {},
    global_custom_stats: {},
  });

  assertEquals(
    collector.build(),
    "ok=1 changed=0 failed=1 unreachable=0; Set hostname: permission denied",
  );
});

test("sanitizeAnsibleSummaryText strips control characters and caps length", () => {
  const long = "a".repeat(600);
  assertEquals(sanitizeAnsibleSummaryText(long).length, 500);
  assertEquals(
    sanitizeAnsibleSummaryText("line1\nline2\t tab"),
    "line1 line2 tab",
  );
});

test("formatAnsibleEventLog preserves vendor detail when presenter is inactive", () => {
  setActiveInstallPresenter(null);

  const line = formatAnsibleEventLog({
    _event: "v2_playbook_on_task_start",
    _timestamp: "2026-01-01T00:00:00Z",
    task: {
      name: "Ensure Redis service desired state",
      id: "1",
      path: "",
      duration: TASK_DURATION,
    },
    hosts: {},
  });

  assertEquals(line?.component, "ansible");
  assertEquals(line?.message, "[task] Ensure Redis service desired state");
});

test("formatAnsibleEventLog relabels component and sanitizes when presenter is active", () => {
  const presenter = new InstallPresenter(false);
  setActiveInstallPresenter(presenter);
  try {
    const line = formatAnsibleEventLog({
      _event: "v2_runner_on_failed",
      _timestamp: "2026-01-01T00:00:00Z",
      task: {
        name: "rabbitmq : Start RabbitMQ broker",
        id: "1",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: { localhost: { msg: "ansible-playbook could not reach redis" } },
    });

    assertEquals(line?.component, "orchestration");
    assertEquals(
      line?.message,
      "[failed] queue : Start queue broker: orchestration-playbook could not reach cache",
    );
    assertEquals(line?.level, "ERROR");
  } finally {
    presenter.dispose();
    setActiveInstallPresenter(null);
  }
});

test("formatAnsibleEventLog sanitizes play and recap lines for installers", () => {
  const presenter = new InstallPresenter(false);
  setActiveInstallPresenter(presenter);
  try {
    const play = formatAnsibleEventLog({
      _event: "v2_playbook_on_play_start",
      _timestamp: "2026-01-01T00:00:00Z",
      play: {
        name: "TurboPanel Redis setup",
        id: "play",
        path: "",
        duration: TASK_DURATION,
      },
      tasks: [],
    });
    assertEquals(play?.message, "[play] TurboPanel cache setup");

    const recap = formatAnsibleEventLog({
      _event: "v2_playbook_on_stats",
      _timestamp: "2026-01-01T00:00:01Z",
      stats: { localhost: { ok: 2, changed: 1, failed: 0, unreachable: 0 } },
      custom_stats: {},
      global_custom_stats: {},
    });
    assertEquals(
      recap?.message,
      "[recap] ok=2 changed=1 failed=0 unreachable=0",
    );
  } finally {
    presenter.dispose();
    setActiveInstallPresenter(null);
  }
});
