import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  extractShellFunction,
  RUN_SH_PATH as runShPath,
} from "../testing/run-sh-manifest-verifier.ts";

/** Alias so Sonar sees real tests (see the other run.sh suites). */
const test = Deno.test.bind(Deno);

const LIB_PATH = join(
  fromFileUrl(new URL(".", import.meta.url)),
  "../../scripts/lib/installer-screen.sh",
);
const BEGIN = "# ---- installer-screen.sh (begin) ----\n";
const END = "# ---- installer-screen.sh (end) ----\n";

/** The screen block run.sh carries, and the lines of run.sh after it. */
async function embedded(): Promise<{ block: string; run: string }> {
  const run = await Deno.readTextFile(runShPath);
  const start = run.indexOf(BEGIN);
  const stop = run.indexOf(END);
  assert(start >= 0 && stop > start, "screen markers missing in run.sh");
  return { block: run.slice(start + BEGIN.length, stop), run };
}

test("run.sh carries the installer screen library unchanged", async () => {
  const lib = await Deno.readTextFile(LIB_PATH);
  const { block } = await embedded();
  // The library file starts with its interpreter line; run.sh has its own.
  assertEquals(block, lib.slice(lib.indexOf("\n") + 1));
});

const HELPERS = [
  "tp_ui_decide",
  "tp_ui",
  "tp_ui_area",
  "tp_ui_done",
  "tp_ui_sub",
  "tp_ui_neutral",
  "tp_ui_fail",
  "tp_rearm_traps",
  "tp_rearm_signal_traps",
  "tp_quiet_runtime_notes",
  "tp_quiet_runtime_notes_abort",
  "tp_ui_make_log",
  "tp_os_line",
  "tp_print_warn",
  "tp_exit_trap",
  "tp_ui_begin",
  "tp_ui_finish",
  "tp_print_step",
  "tp_print_ok",
  "tp_print_error",
  "tp_print_detail",
];

/** A script: the run.sh screen block and print helpers, then `body`. */
async function script(dir: string, body: string): Promise<string> {
  const { block, run } = await embedded();
  const funcs = HELPERS.map((n) => extractShellFunction(run, n)).join("\n\n");
  const vars = [
    "TP_UI_WANT=0",
    "TP_UI=0",
    'TP_UI_NOTES=""',
    "TP_UI_COLLECT=0",
    "TP_UI_LOG_READY=0",
    `TP_LOG="${join(dir, "logs", "install.log")}"`,
  ].join("\n");
  const file = join(dir, "t.sh");
  await Deno.writeTextFile(
    file,
    `set -eu\n${block}\n${vars}\n${funcs}\n${body}\n`,
  );
  return file;
}

async function runScript(file: string, env: Record<string, string>) {
  const out = await new Deno.Command("sh", {
    args: [file],
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    out: dec.decode(out.stdout),
    err: dec.decode(out.stderr),
  };
}

const PLAIN = { TERM: "xterm", NO_COLOR: "1" };
const LIVE = { TERM: "xterm", SCREEN_FORCE_TTY: "1", SCREEN_FIXED_CLOCK: "1" };

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "run-sh-screen-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("a finished install shows names and the summary, sends other output to the log and gives stdout back", async () => {
  await withTemp(async (dir) => {
    const file = await script(
      dir,
      [
        "tp_ui_begin panel 1.2.3",
        'tp_ui_area "Checking this server"',
        'echo "stray stdout"',
        'echo "stray stderr" >&2',
        'tp_print_step ">" "Probing"',
        'tp_print_ok "Deno 2.1 ready"',
        'tp_ui_done "Debian 13"',
        'tp_ui_area "Installing the control plane"',
        'TP_UI_URL="https://192.0.2.10:8443/install"',
        'TP_UI_NOTES="self-signed certificate\n"',
        'tp_ui_finish "Ready in" "installed"',
        'echo "after the screen"',
        'echo "after the screen (err)" >&2',
      ].join("\n"),
    );
    for (const env of [LIVE, PLAIN]) {
      const r = await runScript(file, env);
      assertEquals(r.code, 0, r.out + r.err);
      assertStringIncludes(r.out, "Checking this server");
      assertStringIncludes(r.out, "https://192.0.2.10:8443/install");
      assertStringIncludes(r.out, "self-signed certificate");
      assertStringIncludes(r.out, "after the screen");
      assertStringIncludes(r.err, "after the screen (err)");
      assert(!r.out.includes("stray stdout"), r.out);
      assert(!r.err.includes("stray stderr"), r.err);
      assert(!r.out.includes("Deno"), "a product name reached the screen");
      assert(!r.err.includes("Deno"));
    }
    const log = await Deno.readTextFile(join(dir, "logs", "install.log"));
    assertStringIncludes(log, "stray stdout");
    assertStringIncludes(log, "stray stderr");
    assertStringIncludes(log, "Deno 2.1 ready");
    const mode = (await Deno.stat(join(dir, "logs", "install.log"))).mode;
    assertEquals((mode ?? 0) & 0o777, 0o600);
  });
});

test("an error turns the open area into a failure that names the log, with product words neutralised", async () => {
  await withTemp(async (dir) => {
    const file = await script(
      dir,
      [
        "tp_ui_begin daemon 'release channel'",
        'tp_ui_area "Preparing the installer"',
        'tp_print_error "Failed to install Deno runtime (Ansible said no)"',
        'tp_print_detail "Try again with a fresh command."',
        "exit 1",
      ].join("\n"),
    );
    for (const env of [LIVE, PLAIN]) {
      const r = await runScript(file, env);
      assertEquals(r.code, 1);
      const shown = r.out + r.err;
      assertStringIncludes(shown, "Failed to install script runtime");
      assertStringIncludes(shown, "installer said no");
      assertStringIncludes(shown, "install.log");
      assertStringIncludes(shown, "Try again with a fresh command.");
      assert(!/Deno|Ansible/.test(shown), shown);
    }
    const log = await Deno.readTextFile(join(dir, "logs", "install.log"));
    assertStringIncludes(log, "Failed to install Deno runtime");
  });
});

test("an interrupt after a quiet runtime step still stops the spinner and restores the cursor", async () => {
  await withTemp(async (dir) => {
    const tick = join(dir, "tick");
    const file = await script(
      dir,
      [
        "tp_ui_begin panel 1.2.3",
        'tp_ui_area "Installing the control plane"',
        "tp_quiet_runtime_notes true",
        "screen_busy_start",
        `echo "$_ss_tick" > '${tick}'`,
        "kill -INT $$",
        "sleep 1",
        "exit 0",
      ].join("\n"),
    );
    // Output goes to files and the run has a deadline, so a spinner left
    // running on a regression turns the test red instead of hanging it.
    const outFile = join(dir, "out.txt");
    const child = new Deno.Command("sh", {
      args: ["-c", `sh '${file}' >'${outFile}' 2>&1 </dev/null`],
      clearEnv: true,
      env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", ...LIVE },
      stdout: "null",
      stderr: "null",
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 20_000);
    const out = await child.status;
    clearTimeout(timer);
    const shown = await Deno.readTextFile(outFile);
    const pid = Number((await Deno.readTextFile(tick)).trim());
    const stop = () => {
      // Never leave a stray spinner behind, pass or fail.
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    let alive = true;
    try {
      Deno.kill(pid, "SIGCONT");
    } catch {
      alive = false;
    }
    stop();
    assertEquals(out.code, 130, shown);
    assertStringIncludes(shown, "\x1b[?25h", "the cursor was not restored");
    assert(pid > 0);
    assert(!alive, "the spinner keeps running after the interrupt");
  });
});

test("a problem that does not stop the install is a summary warning, not a failed area", async () => {
  await withTemp(async (dir) => {
    const file = await script(
      dir,
      [
        "tp_ui_begin panel 1",
        'tp_ui_area "Installing the control plane"',
        'tp_print_warn "Skipped the build label in /srv/runtime.env"',
        'tp_ui_finish "Ready in" "installed"',
      ].join("\n"),
    );
    const r = await runScript(file, PLAIN);
    assertEquals(r.code, 0, r.out + r.err);
    assertStringIncludes(r.out, "Skipped the build label");
    assert(!r.out.includes("failed"), r.out);
  });
});

test("the screen shows a neutral OS line and role names for tools, and leaves URLs and paths alone", async () => {
  await withTemp(async (dir) => {
    const same = [
      "https://dl.example.com/tar/ui.tar.gz",
      "https://tar.example.com:8443/install",
      "/opt/turbopanel/vendor/deno/bin/deno",
      "python3.13",
      "https://192.0.2.10:8443/install",
      "192.0.2.10:8443",
      "./bin/curl-wrapper",
      "https://deno.example.net/x/docker",
      "vendor/deno/bin",
      "redis:6379",
      "docker:2375",
      "(valkey:6379),",
    ];
    const file = await script(
      dir,
      [
        "ID=debian; VERSION_ID=13",
        'echo "OS=$(tp_os_line)"',
        'echo "S1=$(tp_ui_neutral "zstd is required to unpack it (apt install zstd); curl and openssl too, and Deno, Ansible.")"',
        `echo "Q1=$(tp_ui_neutral "docker, Deno and Ansible/Deno need a curl and 'tar' or \\"curl\\"")"`,
        'echo "W1=$(tp_ui_neutral "dockerd and docker-compose are missing")"',
        ...same.map((v, i) =>
          `echo "U${i}=$(tp_ui_neutral "Failed to download ${v} now")"`
        ),
      ].join("\n"),
    );
    const r = await runScript(file, PLAIN);
    assertEquals(r.code, 0, r.err);
    assertStringIncludes(r.out, "OS=Debian 13");
    const line = r.out.split("\n").find((l) => l.startsWith("S1=")) ?? "";
    assertEquals(
      line,
      "S1=archive tool is required to unpack it (install the missing tool; the log has the exact package); download tool and certificate tool too, and script runtime, installer.",
    );
    const quoted = r.out.split("\n").find((l) => l.startsWith("Q1=")) ?? "";
    assertEquals(
      quoted,
      "Q1=container engine, script runtime and installer/script runtime need a download tool and 'archive tool' or \"download tool\"",
    );
    const words = r.out.split("\n").find((l) => l.startsWith("W1=")) ?? "";
    assertEquals(
      words,
      "W1=container service and container tooling are missing",
    );
    same.forEach((v, i) =>
      assertStringIncludes(r.out, `U${i}=Failed to download ${v} now`)
    );
  });
});

test("an error with no open area still reaches the real stderr", async () => {
  await withTemp(async (dir) => {
    const file = await script(
      dir,
      "tp_ui_begin daemon x\ntp_print_error 'nothing open'\nexit 1",
    );
    const r = await runScript(file, PLAIN);
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "nothing open");
  });
});

test("the screen stays off, with the plain lines, when it is not asked for or the log cannot be made", async () => {
  await withTemp(async (dir) => {
    const off = await script(
      dir,
      'TP_UI_WANT=0\ntp_print_step ">" "Plain"\ntp_print_ok "Done"\ntp_print_error "Bad" 2>&1',
    );
    const r = await runScript(off, PLAIN);
    assertEquals(r.code, 0, r.err);
    assertStringIncludes(r.out, "> Plain");
    assertStringIncludes(r.out, "✓ Done");
    assertStringIncludes(r.out, "✗ Bad");

    await Deno.writeTextFile(join(dir, "logs"), "a file, not a folder");
    const noLog = await script(
      dir,
      'tp_ui_begin panel 1\ntp_print_ok "Still plain"\necho "TP_UI=$TP_UI"',
    );
    const r2 = await runScript(noLog, PLAIN);
    assertEquals(r2.code, 0, r2.err);
    assertStringIncludes(r2.out, "TP_UI=0");
    assertStringIncludes(r2.out, "✓ Still plain");
  });
});

test("an old log is kept as install.log.prev and a link in its place is not written through", async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(join(dir, "logs"));
    await Deno.writeTextFile(join(dir, "logs", "install.log"), "old run\n");
    const file = await script(
      dir,
      'tp_ui_begin daemon x\ntp_ui_area "A"\ntp_ui_finish "Done in" ok',
    );
    const r = await runScript(file, PLAIN);
    assertEquals(r.code, 0, r.err);
    assertEquals(
      await Deno.readTextFile(join(dir, "logs", "install.log.prev")),
      "old run\n",
    );
    const victim = join(dir, "victim");
    await Deno.writeTextFile(victim, "untouched\n");
    await Deno.remove(join(dir, "logs", "install.log"));
    await Deno.symlink(victim, join(dir, "logs", "install.log"));
    const r2 = await runScript(file, PLAIN);
    assertEquals(r2.code, 0, r2.err);
    assertEquals(await Deno.readTextFile(victim), "untouched\n");
  });
});

test("the screen is wanted only for a real install", async () => {
  const { run } = await embedded();
  const fn = extractShellFunction(run, "tp_ui_decide");
  const cases: [string, boolean][] = [
    ["", true],
    ["PROGRESS_MARKERS=true", false],
    ["NO_START=true", false],
    ["SKIP_DAEMON_PACKAGE=true", false],
    ["DAEMON_ONLY=true", false],
    ["TURBOPANEL_INSTALL_VERBOSE=1", false],
  ];
  for (const [setup, want] of cases) {
    const out = await new Deno.Command("sh", {
      args: ["-eu", "-c", `${fn}\n${setup}\ntp_ui_decide\necho $TP_UI_WANT`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      new TextDecoder().decode(out.stdout).trim(),
      want ? "1" : "0",
      setup,
    );
  }
});

test("run.sh wires the screen into the install and keeps the kernel step after it", async () => {
  const { run } = await embedded();
  for (
    const area of [
      "Checking this server",
      "Verifying the release",
      "Downloading TurboPanel",
      "Preparing the installer",
      "Installing the control plane",
      "Configuring this server",
      "Enrolling this server",
    ]
  ) {
    assertStringIncludes(run, `tp_ui_area "${area}"`);
  }
  assertStringIncludes(run, 'if [ "$TP_ENROLL_CONFIRMED" = 1 ]; then');
  assert(
    run.indexOf("! tp_ui_make_log; then") < run.indexOf("\ntp_print_header\n"),
    "the log is made before the header so the plain fallback keeps it",
  );
  const finish = run.lastIndexOf('tp_ui_finish "Enrolled in"');
  assert(finish > 0);
  assert(run.indexOf("tp_kernel_features_step", finish) > finish);
});

test("the screen helpers copy their positional parameters before use", async () => {
  const text = await Deno.readTextFile(
    new URL("../../scripts/run.sh", import.meta.url),
  );
  for (
    const name of [
      "tp_ui_area",
      "tp_ui_done",
      "tp_ui_sub",
      "tp_ui_neutral",
      "tp_ui_fail",
    ]
  ) {
    const m = text.match(
      new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`, "m"),
    );
    assertEquals(m !== null, true, name);
    const lines = (m?.[1] ?? "").split("\n");
    const first = lines.find((l) => /^\s+\w+=\$/.test(l)) ?? "";
    assertEquals(/\$\{?1/.test(first), true, `${name} copies $1 first`);
    const rest = lines.slice(lines.indexOf(first) + 1).join("\n");
    assertEquals(
      /\$\{?1/.test(rest.replace(/awk '[\s\S]*$/, "")),
      false,
      `${name} reuses $1`,
    );
  }
});
