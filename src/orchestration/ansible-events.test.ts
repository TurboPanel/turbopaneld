import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  AnsibleRunSummaryCollector,
  formatAnsibleEventLog,
  formatPlaybookRecap,
  logAnsibleEvent,
  parseAnsibleJsonlLine,
  runPlaybookStreaming,
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

test("parseAnsibleJsonlLine rejects blank, non-object, and incomplete lines", () => {
  assertEquals(parseAnsibleJsonlLine("   "), null);
  assertEquals(parseAnsibleJsonlLine("not-json"), null);
  assertEquals(parseAnsibleJsonlLine("42"), null);
  assertEquals(parseAnsibleJsonlLine("null"), null);
  assertEquals(
    parseAnsibleJsonlLine('{"_event":"v2_runner_on_ok"}'),
    null,
  );
  const ok = parseAnsibleJsonlLine(
    '{"_event":"v2_runner_on_ok","_timestamp":"2026-01-01T00:00:00Z","task":{"name":"t","id":"1","path":"","duration":{"start":""}},"hosts":{}}',
  );
  assertEquals(ok?._event, "v2_runner_on_ok");
});

test("formatAnsibleEventLog maps ok, changed, skipped, and unknown events", () => {
  setActiveInstallPresenter(null);
  const ok = formatAnsibleEventLog({
    _event: "v2_runner_on_ok",
    _timestamp: "2026-01-01T00:00:00Z",
    task: {
      name: "Noop",
      id: "1",
      path: "",
      duration: TASK_DURATION,
    },
    hosts: { localhost: { changed: false } },
  });
  assertEquals(ok?.level, "DEBUG");
  assertEquals(ok?.message, "[ok] Noop");

  const changed = formatAnsibleEventLog({
    _event: "v2_runner_on_ok",
    _timestamp: "2026-01-01T00:00:00Z",
    task: {
      name: "Write file",
      id: "2",
      path: "",
      duration: TASK_DURATION,
    },
    hosts: { localhost: { changed: true } },
  });
  assertEquals(changed?.level, "INFO");
  assertEquals(changed?.message, "[changed] Write file");

  const skipped = formatAnsibleEventLog({
    _event: "v2_runner_on_skipped",
    _timestamp: "2026-01-01T00:00:00Z",
    task: {
      name: "Optional",
      id: "3",
      path: "",
      duration: TASK_DURATION,
    },
    hosts: {},
  });
  assertEquals(skipped?.level, "DEBUG");
  assertEquals(skipped?.message, "[skipped] Optional");

  assertEquals(
    formatAnsibleEventLog({
      _event: "v2_playbook_on_notify",
      _timestamp: "2026-01-01T00:00:00Z",
    } as never),
    null,
  );
});

test("logAnsibleEvent covers DEBUG, ERROR, and unknown early return", () => {
  setActiveInstallPresenter(null);
  logAnsibleEvent({
    _event: "v2_runner_on_ok",
    _timestamp: "2026-01-01T00:00:00Z",
    task: {
      name: "Debug ok",
      id: "1",
      path: "",
      duration: TASK_DURATION,
    },
    hosts: { localhost: {} },
  });
  logAnsibleEvent({
    _event: "v2_runner_on_failed",
    _timestamp: "2026-01-01T00:00:00Z",
    task: {
      name: "Boom",
      id: "2",
      path: "",
      duration: TASK_DURATION,
    },
    hosts: { localhost: { msg: "nope" } },
  });
  logAnsibleEvent({
    _event: "v2_playbook_on_notify",
    _timestamp: "2026-01-01T00:00:00Z",
  } as never);
});

test("runPlaybookStreaming quiet raw lines and non-quiet logging", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-ansible-events-stream-" });
  const bin = join(root, "ansible-playbook");
  await Deno.writeTextFile(
    bin,
    `#!/bin/sh
printf '%s\\n' '' 'not-json-line' '{"_event":"v2_runner_on_ok","_timestamp":"2026-01-01T00:00:00Z","task":{"name":"T","id":"1","path":"","duration":{"start":""}},"hosts":{"localhost":{}}}'
printf '%s\\n' '' 'stderr-noise' >&2
exit 0
`,
  );
  await Deno.chmod(bin, 0o755);

  const raw: Array<{ stream: string; line: string }> = [];
  const events: string[] = [];
  await runPlaybookStreaming(bin, ["play.yml"], {
    quiet: true,
    onEvent: (event) => events.push(event._event),
    onRawLine: (stream, line) => raw.push({ stream, line }),
  });
  assertEquals(events, ["v2_runner_on_ok"]);
  assertEquals(raw, [
    { stream: "stdout", line: "not-json-line" },
    { stream: "stderr", line: "stderr-noise" },
  ]);

  await runPlaybookStreaming(bin, ["play.yml"], { quiet: false });

  await Deno.writeTextFile(bin, "#!/bin/sh\necho fail >&2\nexit 1\n");
  await Deno.chmod(bin, 0o755);
  await assertRejects(
    () => runPlaybookStreaming(bin, ["play.yml"], { quiet: true }),
    Error,
    "orchestration failed",
  );

  await Deno.remove(root, { recursive: true });
});

test("formatPlaybookRecap treats missing host counters as zero", () => {
  assertEquals(
    formatPlaybookRecap({ localhost: {} }),
    "ok=0 changed=0 failed=0 unreachable=0",
  );
});

test("AnsibleRunSummaryCollector records unreachable tasks and empty builds", () => {
  const empty = new AnsibleRunSummaryCollector();
  assertEquals(empty.build(), "");

  const collector = new AnsibleRunSummaryCollector();
  collector.handleEvent({
    _event: "v2_runner_on_unreachable",
    _timestamp: "2026-01-01T00:00:00Z",
    task: { name: undefined as unknown as string, id: "1", path: "", duration: { start: "" } },
    hosts: { localhost: {} },
  });
  assertEquals(collector.build(), "task: unknown error");
});

test("formatAnsibleEventLog falls back when a failed host has no msg", () => {
  setActiveInstallPresenter(null);
  const line = formatAnsibleEventLog({
    _event: "v2_runner_on_failed",
    _timestamp: "2026-01-01T00:00:00Z",
    task: {
      name: "Ping",
      id: "1",
      path: "",
      duration: TASK_DURATION,
    },
    hosts: { localhost: {} },
  });
  assertEquals(line?.level, "ERROR");
  assertEquals(line?.message, "[failed] Ping: unknown error");
});

test("logAnsibleEvent covers INFO play-start lines", () => {
  setActiveInstallPresenter(null);
  logAnsibleEvent({
    _event: "v2_playbook_on_play_start",
    _timestamp: "2026-01-01T00:00:00Z",
    play: {
      name: "Setup cache",
      id: "play",
      path: "",
      duration: TASK_DURATION,
    },
    tasks: [],
  });
});

test("runPlaybookStreaming non-quiet failure includes the binary name", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-ansible-events-fail-" });
  const bin = join(root, "ansible-playbook");
  await Deno.writeTextFile(bin, "#!/bin/sh\necho fail >&2\nexit 9\n");
  await Deno.chmod(bin, 0o755);
  try {
    await assertRejects(
      () => runPlaybookStreaming(bin, ["play.yml"], { quiet: false }),
      Error,
      "ansible-playbook failed (exit 9)",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
