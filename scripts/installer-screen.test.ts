/**
 * Pins the installer screen layer (scripts/lib/installer-screen.sh) through the
 * simulated install in scripts/installer-screen-demo.sh: the plain fallbacks,
 * truncation, color depth, cursor restore and POSIX sh compatibility.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = join(fromFileUrl(new URL(".", import.meta.url)), "..");
const DEMO = join(ROOT, "scripts", "installer-screen-demo.sh");
const LIB = join(ROOT, "scripts", "lib", "installer-screen.sh");

const ESC = String.fromCharCode(27);
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

interface Run {
  code: number;
  out: string;
}

async function haveShell(name: string): Promise<boolean> {
  try {
    const out = await new Deno.Command(name, {
      args: ["-c", "exit 0"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

async function run(
  shell: string[],
  args: string[],
  env: Record<string, string> = {},
): Promise<Run> {
  const [cmd, ...pre] = shell;
  const out = await new Deno.Command(cmd, {
    args: [...pre, ...args],
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, out: new TextDecoder().decode(out.stdout) };
}

const LIVE_ENV = {
  TERM: "xterm",
  LANG: "C.UTF-8",
  SCREEN_FORCE_TTY: "1",
  SCREEN_FIXED_CLOCK: "1",
};

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "installer-screen-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The screen as text: escape sequences and carriage returns removed. */
function visible(out: string): string[] {
  return out.replace(ANSI, "").replaceAll("\r", "").split("\n");
}

/** Runs a few lines of sh that source the library, as a driver script. */
function driver(dir: string, body: string): Promise<string> {
  const file = join(dir, "driver.sh");
  return Deno.writeTextFile(
    file,
    `. "${LIB}"\nscreen_init 9.9.9 canary panel 3 "${
      join(dir, "d.log")
    }"\n${body}\n`,
  ).then(() => file);
}

test("without a TTY the demo prints one plain line per event and no escape codes", async () => {
  await withTemp(async (dir) => {
    const r = await run(["dash"], [
      DEMO,
      "--mode",
      "daemon",
      "--fast",
      "--log",
      join(dir, "i.log"),
    ], { TERM: "xterm" });
    assertEquals(r.code, 0);
    assert(!r.out.includes(ESC), "no escape code in plain output");
    assert(!r.out.includes("\r"), "no carriage return in plain output");
    assertStringIncludes(
      r.out,
      "TurboPanel installer 1.8.2 (channel release, mode daemon)",
    );
    assertStringIncludes(r.out, "[1/8] Preflight ...");
    assertStringIncludes(r.out, "      - Checking host prerequisites");
    assert(
      /\[1\/8\] ok {3}Preflight: Debian 13, amd64, 4 CPU, 8 GiB RAM \(\d+s\)/
        .test(r.out),
    );
    assertStringIncludes(r.out, "== Server enrolled (");
    assertStringIncludes(r.out, "   Server: server-a.example.lan");
    assertStringIncludes(r.out, "   warning: Clock is 2.1 s off");
    assertStringIncludes(r.out, `log: ${join(dir, "i.log")}`);
    assert(r.out.indexOf("   Server:") < r.out.indexOf("   warning:"));
    assert(r.out.indexOf("   warning:") < r.out.lastIndexOf("log: "));
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "i.log")),
      "demo step:",
    );
  });
});

test("the control plane summary lists both URLs", async () => {
  await withTemp(async (dir) => {
    const r = await run(["dash"], [
      DEMO,
      "--mode",
      "panel",
      "--fast",
      "--log",
      join(dir, "i.log"),
    ], { TERM: "xterm" });
    assertEquals(r.code, 0);
    assertStringIncludes(r.out, "Public: https://192.0.2.10:8443");
    assertStringIncludes(r.out, "Private: https://10.0.0.5:8443");
    assertStringIncludes(r.out, "Postgres 18, Redis 8, RabbitMQ 4");
  });
});

test("NO_COLOR, TERM=dumb and an unset TERM force plain output even on a TTY", async () => {
  await withTemp(async (dir) => {
    for (
      const env of [
        { ...LIVE_ENV, NO_COLOR: "1" },
        { ...LIVE_ENV, TERM: "dumb" },
        { SCREEN_FORCE_TTY: "1" },
      ]
    ) {
      const r = await run(["dash"], [
        DEMO,
        "--fast",
        "--log",
        join(dir, "i.log"),
      ], env);
      assertEquals(r.code, 0);
      assert(!r.out.includes(ESC), JSON.stringify(env));
      assertStringIncludes(r.out, "[8/8] ok   Kernel:");
    }
  });
});

test("an empty NO_COLOR does not turn color off", async () => {
  await withTemp(async (dir) => {
    const r = await run(["dash"], [
      DEMO,
      "--fast",
      "--log",
      join(dir, "i.log"),
    ], { ...LIVE_ENV, NO_COLOR: "" });
    assertStringIncludes(r.out, HIDE);
  });
});

test("plain output is cut to the terminal width and never wrapped", async () => {
  await withTemp(async (dir) => {
    const long = "x".repeat(200);
    const file = await driver(
      dir,
      `screen_area_start "${long}"\nscreen_sub "${long}"\nscreen_area_done "${long}"\nscreen_finish`,
    );
    const r = await run(["dash"], [file], { TERM: "xterm", SCREEN_COLS: "60" });
    const lines = r.out.split("\n").filter((l) => l.length > 0);
    assert(lines.length > 4);
    for (const line of lines) {
      assert(line.length <= 59, `${line.length}: ${line}`);
    }
    assert(lines.some((l) => l.endsWith("...")));
  });
});

test("the live screen is cut to 60 columns, sub-lines and result lines included", async () => {
  await withTemp(async (dir) => {
    const long = "y".repeat(200);
    const file = await driver(
      dir,
      `screen_area_start "${long}"\nscreen_sub "${long}"\nscreen_area_done "${long}"\n` +
        `screen_area_start b\nscreen_sub "${long}"\nscreen_area_fail "${long}"\n` +
        `screen_summary "${long}"\nscreen_summary_item "${long}" "${long}"\n` +
        `screen_summary_warn "${long}"\nscreen_finish`,
    );
    const r = await run(["dash"], [file], { ...LIVE_ENV, SCREEN_COLS: "60" });
    const lines = visible(r.out);
    assert(lines.filter((l) => l.includes("yyyy")).length >= 6);
    for (const line of lines) {
      assert([...line].length <= 59, `${[...line].length}: ${line}`);
    }
  });
});

test("the live screen keeps finished areas as single check-mark lines", async () => {
  await withTemp(async (dir) => {
    const r = await run(
      ["dash"],
      [DEMO, "--fast", "--log", join(dir, "i.log")],
      {
        ...LIVE_ENV,
        SCREEN_COLS: "80",
      },
    );
    assertEquals(r.code, 0);
    assertStringIncludes(r.out, HIDE);
    assert(r.out.endsWith(SHOW), "cursor shown again at the very end");
    assertStringIncludes(r.out, `${ESC}[6A`);
    for (const line of visible(r.out)) assert([...line].length <= 79, line);
  });
});

test("brand colors: 24-bit with COLORTERM, the nearest 256-color index otherwise", async () => {
  await withTemp(async (dir) => {
    const args = [DEMO, "--fast", "--log", join(dir, "i.log")];
    for (const colorterm of ["truecolor", "24bit"]) {
      const r = await run(["dash"], args, {
        ...LIVE_ENV,
        COLORTERM: colorterm,
      });
      assertStringIncludes(r.out, `${ESC}[38;2;51;102;204m`);
      assertStringIncludes(r.out, `${ESC}[38;2;61;214;140m`);
      assert(!r.out.includes("38;5;"));
    }
    const r = await run(["dash"], args, LIVE_ENV);
    assertStringIncludes(r.out, `${ESC}[38;5;68m`);
    assertStringIncludes(r.out, `${ESC}[38;5;79m`);
    assert(!r.out.includes("38;2;"));
  });
});

test("a failed area collapses to a cross, a reason and the log path, and the cursor comes back", async () => {
  await withTemp(async (dir) => {
    const log = join(dir, "i.log");
    const r = await run(["dash"], [
      DEMO,
      "--mode",
      "panel",
      "--fail-at",
      "4",
      "--fast",
      "--log",
      log,
    ], LIVE_ENV);
    assertEquals(r.code, 1);
    assert(r.out.endsWith(`${ESC}[0m${SHOW}`), "cursor restored last");
    const lines = visible(r.out);
    assert(lines.some((l) => l.startsWith(" ✗ Runtimes ")));
    assert(lines.some((l) => l.includes("port 5432 is in use")));
    assert(lines.some((l) => l.trim() === `see ${log}`));
    assert(lines.some((l) => l.includes("3/8")));
    assert(!lines.some((l) => l.includes("Database")));
    assertStringIncludes(await Deno.readTextFile(log), "-- FAILED: Runtimes");
  });
});

test("plain output reports a failure with the log path and a non-zero exit", async () => {
  await withTemp(async (dir) => {
    const log = join(dir, "i.log");
    const r = await run(["dash"], [
      DEMO,
      "--fail-at",
      "2",
      "--fast",
      "--log",
      log,
    ], {
      TERM: "xterm",
    });
    assertEquals(r.code, 1);
    assertStringIncludes(r.out, "[2/8] FAIL Release: The release manifest");
    assertStringIncludes(r.out, `      see ${log}`);
    assertStringIncludes(r.out, "stopped at step 2/8");
  });
});

test("TERM and INT mid-area close the area as failed and restore the cursor", async () => {
  await withTemp(async (dir) => {
    for (
      const [sig, code] of [["TERM", 143], ["INT", 130], ["HUP", 129]] as const
    ) {
      const file = await driver(
        dir,
        `screen_area_start Working\nscreen_sub "doing a thing"\nkill -${sig} $$\nsleep 5`,
      );
      const r = await run(["dash"], [file], LIVE_ENV);
      assertEquals(r.code, code, sig);
      assert(r.out.endsWith(`${ESC}[0m${SHOW}`), sig);
      assert(
        visible(r.out).some((l) => l.startsWith(" ✗ Working ")),
        sig,
      );
    }
  });
});

test("an exit with an area still open restores the cursor", async () => {
  await withTemp(async (dir) => {
    const file = await driver(dir, "screen_area_start Working\nexit 7");
    const r = await run(["dash"], [file], LIVE_ENV);
    assertEquals(r.code, 7);
    assertStringIncludes(r.out, "stopped unexpectedly (exit 7)");
    assert(r.out.endsWith(SHOW));
  });
});

test("screen_run sends command output to the log and returns its status", async () => {
  await withTemp(async (dir) => {
    const file = await driver(
      dir,
      `screen_area_start Working\nscreen_run sh -c 'echo to-the-log; echo to-stderr >&2; exit 3'\n` +
        `echo "rc=$?" >&2\nscreen_area_done ok\nscreen_finish`,
    );
    for (const env of [LIVE_ENV, { TERM: "xterm" }]) {
      const r = await run(["dash"], [file], env);
      assert(!r.out.includes("to-the-log"));
      assert(!r.out.includes("to-stderr"));
    }
    const log = await Deno.readTextFile(join(dir, "d.log"));
    assertStringIncludes(log, "to-the-log");
    assertStringIncludes(log, "to-stderr");
  });
});

test("both files are valid POSIX sh and run under dash and busybox ash", async () => {
  const shells: string[][] = [];
  if (await haveShell("dash")) shells.push(["dash"]);
  if (await haveShell("busybox")) shells.push(["busybox", "ash"]);
  assert(shells.length > 0 || !(await haveShell("dash")), "a shell ran");
  await withTemp(async (dir) => {
    for (const shell of shells) {
      for (const file of [LIB, DEMO]) {
        const r = await run(shell, ["-n", file]);
        assertEquals(r.code, 0, `${shell.join(" ")} -n ${file}`);
      }
      for (const mode of ["daemon", "panel"]) {
        const live = await run(shell, [
          DEMO,
          "--mode",
          mode,
          "--fast",
          "--log",
          join(dir, "i.log"),
        ], LIVE_ENV);
        assertEquals(live.code, 0, `${shell.join(" ")} ${mode}`);
        assertStringIncludes(live.out, "8/8");
        const plain = await run(shell, [
          DEMO,
          "--mode",
          mode,
          "--fast",
          "--log",
          join(dir, "i.log"),
        ], { TERM: "xterm" });
        assertEquals(plain.code, 0, `${shell.join(" ")} ${mode} plain`);
        assert(!plain.out.includes(ESC));
      }
    }
  });
});

test("the library does not depend on bash or tput", async () => {
  const text = await Deno.readTextFile(LIB);
  const code = text.split("\n").filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  assert(!/\btput\b/.test(code));
  assert(
    !/\[\[|\$'|\bdeclare\b|\blocal\b|\bread -n\b|<<<|\$\{[A-Za-z_]+\/\//.test(
      code,
    ),
  );
  assert(!/^#!.*bash/.test(text));
});
