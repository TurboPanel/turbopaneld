import { assertEquals, assertMatch } from "@std/assert";
import type { AnsibleEvent } from "./ansible-events.ts";
import { InstallEventPresenter } from "./installer-tui.ts";
import { setActiveInstallPresenter } from "./install-presenter-context.ts";
import { InstallPresenter } from "./install-presenter.ts";
import { logInfo } from "../logger.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const STRUCTURED_LOG_LINE = /^\d{4}-\d{2}-\d{2}T.*\s(INFO|WARN|ERROR)\s+\S+/m;

const FORBIDDEN_TOKENS = [
  "ansible",
  "ansible-galaxy",
  "redis",
  "rabbitmq",
  "uv",
] as const;
const PACKAGE_LINE = /^\s*\+\s+\S+==\S+\s*$/m;

function captureWriteStream(
  stream: { writeSync: (data: Uint8Array) => number },
): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const original = stream.writeSync.bind(stream);
  stream.writeSync = (data: Uint8Array) => {
    chunks.push(decoder.decode(data));
    return data.byteLength;
  };
  return {
    text: () => chunks.join(""),
    restore: () => {
      stream.writeSync = original;
    },
  };
}

function assertNoForbiddenInstallerOutput(text: string, label: string): void {
  const lower = text.toLowerCase();
  for (const token of FORBIDDEN_TOKENS) {
    if (lower.includes(token)) {
      throw new Error(
        `${label}: forbidden token "${token}" in output:\n${text}`,
      );
    }
  }
  if (PACKAGE_LINE.test(text)) {
    throw new Error(`${label}: package pin line leaked into output:\n${text}`);
  }
}

const TASK_DURATION = { start: "2026-01-01T00:00:00Z" };

test("InstallPresenter non-TTY emits one sanitized status line per update", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const presenter = new InstallPresenter(false);

  presenter.beginStep("Installing cache");
  presenter.pushStatus("running cache-setup playbook");
  presenter.pushStatus("running cache-setup playbook");
  presenter.pushStatus("cache service started");
  presenter.completeStep(true, "cache ready");

  stdout.restore();
  const out = stdout.text();

  assertMatch(out, /▸ Installing cache/);
  assertEquals(
    (out.match(/running cache-setup playbook/g) ?? []).length,
    1,
    "duplicate status lines should be suppressed",
  );
  assertMatch(out, /cache service started/);
  assertMatch(out, /✓ cache ready/);
  assertNoForbiddenInstallerOutput(out, "non-TTY stdout");
});

test("InstallPresenter fail reveals buffered detail tail on stderr", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const stderr = captureWriteStream(Deno.stderr);
  const presenter = new InstallPresenter(false);

  presenter.beginStep("Provisioning platform services");
  presenter.pushStatus("orchestration › Ensure cache service desired state");
  presenter.pushDetail(
    "EACCES: permission denied while updating cache configuration",
  );
  presenter.pushStatus(
    "orchestration › Ensure cache service desired state: permission denied",
    {
      force: true,
    },
  );
  presenter.fail(
    "orchestration › Ensure cache service desired state: permission denied",
  );

  stdout.restore();
  stderr.restore();

  const err = stderr.text();
  assertMatch(
    err,
    /✗ orchestration › Ensure cache service desired state: permission denied/,
  );
  assertMatch(
    err,
    /EACCES: permission denied while updating cache configuration/,
  );
  assertNoForbiddenInstallerOutput(
    stdout.text() + err,
    "failure reveal output",
  );
});

test("InstallEventPresenter simulated stream scrubs vendor vocabulary", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const stderr = captureWriteStream(Deno.stderr);
  const presenter = new InstallPresenter(false);
  const events = new InstallEventPresenter(presenter);
  setActiveInstallPresenter(presenter);

  presenter.beginStep("Starting platform services");
  events.beginStep();

  const stream: AnsibleEvent[] = [
    {
      _event: "v2_playbook_on_play_start",
      _timestamp: "2026-01-01T00:00:00Z",
      play: {
        name: "TurboPanel cache setup",
        id: "play-cache",
        path: "",
        duration: TASK_DURATION,
      },
      tasks: [],
    },
    {
      _event: "v2_playbook_on_task_start",
      _timestamp: "2026-01-01T00:00:01Z",
      task: {
        name: "redis : Install cache into runtimes directory",
        id: "task-1",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: {},
    },
    {
      _event: "v2_runner_on_ok",
      _timestamp: "2026-01-01T00:00:02Z",
      task: {
        name: "rabbitmq : Ensure queue container is running and ready",
        id: "task-2",
        path: "",
        duration: TASK_DURATION,
      },
      hosts: { localhost: { changed: true } },
    },
    {
      _event: "v2_playbook_on_stats",
      _timestamp: "2026-01-01T00:00:03Z",
      stats: { localhost: { ok: 12, changed: 3, failed: 0, unreachable: 0 } },
      custom_stats: {},
      global_custom_stats: {},
    },
  ];

  for (const event of stream) {
    events.onEvent(event);
  }

  events.onRawLine("stderr", " + ansible-core==2.17.0");
  events.onRawLine("stdout", "Resolved 42 packages in 1.2s");
  events.onRawLine(
    "stderr",
    "Using CPython 3.12.7 interpreter at: /usr/bin/python3",
  );

  presenter.completeStep(true, "Platform services ready");

  setActiveInstallPresenter(null);
  presenter.dispose();
  stdout.restore();
  stderr.restore();

  const combined = stdout.text() + stderr.text();
  assertMatch(combined, /TurboPanel cache setup/);
  assertMatch(combined, /orchestration applied \(12 steps, 3 changes\)/);
  assertNoForbiddenInstallerOutput(combined, "simulated event stream");
});

test("InstallPresenter drops bootstrap noise from raw CPython, uv, and galaxy lines", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const presenter = new InstallPresenter(false);
  setActiveInstallPresenter(presenter);

  presenter.beginStep("Bootstrapping orchestration");
  presenter.pushStatus("Using CPython 3.12.7 interpreter at: /usr/bin/python3");
  presenter.pushStatus("uv 0.11.21 already installed");
  presenter.pushStatus(
    "installing galaxy collections from orchestration/galaxy.yml",
  );
  presenter.pushStatus("meaningful progress update");
  presenter.completeStep(true, "orchestration ready");

  setActiveInstallPresenter(null);
  presenter.dispose();
  stdout.restore();

  const out = stdout.text();
  assertMatch(out, /▸ Bootstrapping orchestration/);
  assertMatch(out, /meaningful progress update/);
  assertMatch(out, /✓ orchestration ready/);
  assertEquals(out.includes("Using runtime"), false, out);
  assertEquals(out.includes("runtime 0.11.21 already installed"), false, out);
  assertEquals(
    out.includes("installing orchestration collections from"),
    false,
    out,
  );
  assertNoForbiddenInstallerOutput(out, "bootstrap noise drop");
});

test("logInfo routes bootstrap noise through presenter without leaking sanitized forms", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const presenter = new InstallPresenter(false);
  setActiveInstallPresenter(presenter);

  presenter.beginStep("Bootstrapping runtimes");
  logInfo("python", "Using CPython 3.12.7 interpreter at: /usr/bin/python3");
  logInfo("uv", "uv 0.11.21 already installed");
  logInfo(
    "ansible-galaxy",
    "installing galaxy collections from orchestration/galaxy.yml",
  );
  logInfo("orchestration", "platform services configured");
  presenter.completeStep(true, "bootstrap complete");

  setActiveInstallPresenter(null);
  presenter.dispose();
  stdout.restore();

  const out = stdout.text();
  assertMatch(out, /platform services configured/);
  assertMatch(out, /✓ bootstrap complete/);
  assertEquals(out.includes("Using runtime"), false, out);
  assertEquals(out.includes("runtime 0.11.21 already installed"), false, out);
  assertEquals(
    out.includes("installing orchestration collections from"),
    false,
    out,
  );
  assertEquals(
    STRUCTURED_LOG_LINE.test(out),
    false,
    "structured log leaked:\n" + out,
  );
  assertNoForbiddenInstallerOutput(out, "logger bootstrap noise");
});

test("installer success path emits only presenter output without trailing structured log", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const presenter = new InstallPresenter(false);
  setActiveInstallPresenter(presenter);

  presenter.beginStep("Running daemon provisioning…");
  presenter.completeStep(true, "TurboPanel daemon provisioning complete");
  presenter.dispose();
  setActiveInstallPresenter(null);

  stdout.restore();
  const out = stdout.text();

  assertMatch(out, /▸ Running daemon provisioning/);
  assertMatch(out, /✓ TurboPanel daemon provisioning complete/);
  assertEquals(
    STRUCTURED_LOG_LINE.test(out),
    false,
    "structured log leaked:\n" + out,
  );
});

test("InstallPresenter TTY mode renders spinner and status window", async () => {
  const stdout = captureWriteStream(Deno.stdout);
  const presenter = new InstallPresenter(true);

  presenter.beginStep("Installing cache");
  presenter.pushStatus("cache service started");
  presenter.pushStatus("queue service started");
  await new Promise((resolve) => setTimeout(resolve, 150));
  presenter.completeStep(true, "cache ready");
  presenter.dispose();

  stdout.restore();
  const out = stdout.text();
  assertMatch(out, /▸/);
  assertMatch(out, /cache service started/);
  assertMatch(out, /cache ready/);
});

test("InstallPresenter TTY mode re-renders when status window overflows", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const presenter = new InstallPresenter(true);

  presenter.beginStep("Rolling status");
  for (let i = 1; i <= 6; i++) {
    presenter.pushStatus(`progress line ${i}`);
  }
  presenter.completeStep(true, "done");
  presenter.dispose();

  stdout.restore();
  const out = stdout.text();
  assertMatch(out, /progress line 6/);
  assertMatch(out, /progress line 2/);
});

test("InstallPresenter TTY fail writes colored outcome to stderr", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const stderr = captureWriteStream(Deno.stderr);
  const presenter = new InstallPresenter(true);

  presenter.beginStep("Provisioning");
  presenter.pushDetail("root cause detail");
  presenter.fail("provisioning failed");

  stdout.restore();
  stderr.restore();
  assertMatch(stderr.text(), /provisioning failed/);
  assertMatch(stderr.text(), /root cause detail/);
});

test("InstallPresenter inactive push and fail paths are no-ops or direct", () => {
  const stderr = captureWriteStream(Deno.stderr);
  const presenter = new InstallPresenter(false);

  presenter.pushDetail("ignored detail");
  presenter.pushStatus("ignored status");
  presenter.completeStep(true, "ignored complete");
  presenter.fail("standalone failure");

  stderr.restore();
  assertMatch(stderr.text(), /✗ standalone failure/);
});

test("InstallPresenter drops empty sanitized push lines and caps detail tail", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const stderr = captureWriteStream(Deno.stderr);
  const presenter = new InstallPresenter(false);

  presenter.beginStep("Detail overflow");
  presenter.pushDetail("   ");
  presenter.pushStatus("\n\t");
  for (let i = 0; i < 90; i++) {
    presenter.pushDetail(`detail line ${i}`);
  }
  presenter.fail("overflow failed");

  stdout.restore();
  stderr.restore();
  const err = stderr.text();
  assertMatch(err, /overflow failed/);
  // Oldest detail lines are dropped once DETAIL_TAIL_MAX (80) is exceeded.
  assertEquals(err.includes("detail line 0"), false);
  assertMatch(err, /detail line 89/);
});

test("InstallPresenter TTY beginStep installs SIGINT handler once", () => {
  const added: Array<() => void> = [];
  const originalAdd = Deno.addSignalListener;
  const originalRemove = Deno.removeSignalListener;
  const originalExit = Deno.exit;
  let exitCode: number | undefined;

  Deno.addSignalListener = ((signal, handler) => {
    if (signal !== "SIGINT") {
      originalAdd.call(Deno, signal, handler);
      return;
    }
    added.push(handler as () => void);
  }) as typeof Deno.addSignalListener;
  Deno.removeSignalListener = ((signal, handler) => {
    if (signal !== "SIGINT") {
      originalRemove.call(Deno, signal, handler);
    }
  }) as typeof Deno.removeSignalListener;
  Deno.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("Deno.exit stub");
  }) as typeof Deno.exit;

  const stdout = captureWriteStream(Deno.stdout);
  try {
    const presenter = new InstallPresenter(true);
    presenter.beginStep("SIGINT step");
    presenter.beginStep("SIGINT step again");
    assertEquals(added.length, 1);

    try {
      added[0]!();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "Deno.exit stub") {
        throw err;
      }
    }
    assertEquals(exitCode, 130);
    presenter.dispose();
  } finally {
    stdout.restore();
    Deno.addSignalListener = originalAdd;
    Deno.removeSignalListener = originalRemove;
    Deno.exit = originalExit;
  }
});

test("InstallPresenter fail with empty detail tail skips stderr tail", () => {
  const stderr = captureWriteStream(Deno.stderr);
  const presenter = new InstallPresenter(false);

  presenter.beginStep("Step");
  presenter.fail("failed without tail");

  stderr.restore();
  const err = stderr.text();
  assertMatch(err, /✗ failed without tail/);
  assertEquals(err.trim().split("\n").length, 1);
});

test("InstallPresenter TTY success uses colored checkmark", () => {
  const stdout = captureWriteStream(Deno.stdout);
  const presenter = new InstallPresenter(true);

  presenter.beginStep("Step");
  presenter.completeStep(true, "ok");
  presenter.dispose();

  stdout.restore();
  assertMatch(stdout.text(), /ok/);
});
