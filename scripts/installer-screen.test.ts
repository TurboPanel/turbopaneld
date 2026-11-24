/**
 * Pins the installer screen layer (scripts/lib/installer-screen.sh) through the
 * simulated install in scripts/installer-screen-demo.sh: the ledger layout
 * (done, now with three detail slots, next), the finish and failure screens,
 * the plain fallbacks, truncation, color depth, cursor restore and POSIX sh
 * compatibility. The text captures in scripts/installer-screen-frames/ are
 * compared with real output; UPDATE_FRAMES=1 rewrites them.
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
const FRAMES = join(ROOT, "scripts", "installer-screen-frames");

const ESC = String.fromCharCode(27);
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const ANSI_PARTS = new RegExp(`^${ESC}\\[([0-9;?]*)([A-Za-z])`);

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
  cwd?: string,
): Promise<Run> {
  const [cmd, ...pre] = shell;
  const out = await new Deno.Command(cmd, {
    args: [...pre, ...args],
    clearEnv: true,
    cwd,
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

/**
 * The screen as a terminal would show it at the end: cursor-up, carriage
 * return, erase-line and erase-below are applied, colors are dropped.
 */
function render(out: string): string[] {
  const rows: string[][] = [[]];
  let r = 0;
  let c = 0;
  const chars = [...out];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === ESC) {
      const rest = chars.slice(i, i + 40).join("");
      const m = ANSI_PARTS.exec(rest);
      if (m) {
        i += [...m[0]].length;
        const [, arg, cmd] = m;
        if (cmd === "A") r = Math.max(0, r - Number(arg || 1));
        else if (cmd === "K") rows[r] = [];
        else if (cmd === "J") {
          rows.length = r + 1;
          rows[r] = rows[r].slice(0, c);
        }
        continue;
      }
    }
    if (ch === "\n") {
      r++;
      c = 0;
      while (rows.length <= r) rows.push([]);
    } else if (ch === "\r") {
      c = 0;
    } else {
      while (rows[r].length < c) rows[r].push(" ");
      rows[r][c] = ch;
      c++;
    }
    i++;
  }
  const text = rows.map((row) => row.join("").trimEnd());
  while (text.length > 0 && text[text.length - 1] === "") text.pop();
  return text;
}

/** Runs a few lines of sh that source the library, as a driver script. */
function driver(
  dir: string,
  body: string,
  plan = "a b c",
  mode = "panel",
): Promise<string> {
  const file = join(dir, "driver.sh");
  return Deno.writeTextFile(
    file,
    `. "${LIB}"\nscreen_init 9.9.9 canary ${mode} "${
      join(dir, "d.log")
    }" ${plan}\n${body}\n`,
  ).then(() => file);
}

/** Row index of the "now" line in a rendered screen. */
function nowRow(rows: string[]): number {
  const at = rows.findIndex((l) => l.startsWith("  now   "));
  assert(at >= 0, `no now line in:\n${rows.join("\n")}`);
  return at;
}

const PLAIN_ENV = { TERM: "xterm" };

test("without a TTY the demo prints one plain line per event and no escape codes", async () => {
  await withTemp(async (dir) => {
    const r = await run(["dash"], [
      DEMO,
      "--mode",
      "daemon",
      "--fast",
      "--log",
      join(dir, "i.log"),
    ], PLAIN_ENV);
    assertEquals(r.code, 0);
    assert(!r.out.includes(ESC), "no escape code in plain output");
    assert(!r.out.includes("\r"), "no carriage return in plain output");
    assertStringIncludes(
      r.out,
      "TurboPanel installer 1.8.2 (channel release, mode daemon)",
    );
    assertStringIncludes(r.out, "[1/8] preflight ...");
    assertStringIncludes(r.out, "      - prerequisites: checking");
    assert(
      /\[1\/8\] ok {3}preflight: Debian 13, amd64, 4 CPU, 8 GiB RAM \(\d+s\)/
        .test(r.out),
    );
    assertStringIncludes(r.out, "== Server enrolled (");
    assertStringIncludes(r.out, "   server: server-a.example.lan");
    assertStringIncludes(r.out, "   panel: panel.example.net");
    assertStringIncludes(r.out, "   warning: clock is 2.1 s off");
    assertStringIncludes(r.out, `log: ${join(dir, "i.log")}`);
    assert(r.out.indexOf("   server:") < r.out.indexOf("   warning:"));
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
    ], PLAIN_ENV);
    assertEquals(r.code, 0);
    assertStringIncludes(r.out, "== TurboPanel 1.8.2 is ready (");
    assertStringIncludes(r.out, "   public: https://192.0.2.10:8443");
    assertStringIncludes(r.out, "   private: https://10.0.0.5:8443");
    assertStringIncludes(r.out, "   warning: port 8443 is open");
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
      assertStringIncludes(r.out, "[8/8] ok   kernel:");
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
    const r = await run(["dash"], [file], { ...PLAIN_ENV, SCREEN_COLS: "60" });
    const lines = r.out.split("\n").filter((l) => l.length > 0);
    assert(lines.length > 4);
    for (const line of lines) {
      assert(line.length <= 59, `${line.length}: ${line}`);
    }
    assert(lines.some((l) => l.endsWith("...")));
  });
});

test("the live screen is cut to 60 columns in every state", async () => {
  await withTemp(async (dir) => {
    const long = "y".repeat(200);
    const plan = `"${long}" "${long}" ${long}z`;
    const ok = await driver(
      dir,
      `screen_area_start "${long}"\nscreen_sub "${long}"\nscreen_sub "${long}" "${long}"\n` +
        `screen_area_done "${long}"\nscreen_area_start "${long}"\nscreen_sub "k" "${long}"\n` +
        `screen_area_done\nscreen_summary "${long}"\nscreen_summary_item "${long}" "${long}"\n` +
        `screen_summary_item "https://192.0.2.10:8443" "${long}"\n` +
        `screen_summary_warn "${long}"\nscreen_finish`,
      plan,
    );
    const r = await run(["dash"], [ok], { ...LIVE_ENV, SCREEN_COLS: "60" });
    assert(visible(r.out).filter((l) => l.includes("yyyy")).length >= 6);
    for (const line of visible(r.out)) {
      assert([...line].length <= 59, `${[...line].length}: ${line}`);
    }
    const bad = await driver(
      dir,
      `screen_area_start "${long}"\nscreen_sub "${long}" "${long}"\n` +
        `screen_area_fail "${long}" "${long}"`,
      plan,
    );
    const f = await run(["dash"], [bad], { ...LIVE_ENV, SCREEN_COLS: "60" });
    assert(visible(f.out).filter((l) => l.includes("yyyy")).length >= 4);
    for (const line of visible(f.out)) {
      assert([...line].length <= 59, `${[...line].length}: ${line}`);
    }
  });
});

test("the live screen shows done, now and next, and the cursor comes back", async () => {
  await withTemp(async (dir) => {
    const r = await run(
      ["dash"],
      [DEMO, "--fast", "--log", join(dir, "i.log")],
      { ...LIVE_ENV, SCREEN_COLS: "80" },
    );
    assertEquals(r.code, 0);
    assertStringIncludes(r.out, HIDE);
    assert(r.out.endsWith(SHOW), "cursor shown again at the very end");
    assertStringIncludes(r.out, `${ESC}[6A`);
    for (const line of visible(r.out)) assert([...line].length <= 79, line);
    const text = visible(r.out).join("\n");
    assertStringIncludes(text, "  done  preflight · release · download");
    assertStringIncludes(text, "  now   runtimes");
    assertStringIncludes(
      text,
      "  next  ansible · services · enrolment · kernel",
    );
    for (const gone of ["━", "╭", "│", "✓", "3/8"]) {
      assert(!text.includes(gone), `no ${gone} in the ledger layout`);
    }
  });
});

test("detail lines start in the first slot, fill downward and scroll only on the fourth", async () => {
  await withTemp(async (dir) => {
    const expected = [
      ["line 1", "", ""],
      ["line 1", "line 2", ""],
      ["line 1", "line 2", "line 3"],
      ["line 2", "line 3", "line 4"],
      ["line 3", "line 4", "line 5"],
    ];
    for (const [i, slots] of expected.entries()) {
      const subs = Array.from(
        { length: i + 1 },
        (_, n) => `screen_sub "line ${n + 1}"`,
      ).join("\n");
      const file = await driver(
        dir,
        `screen_area_start Working\n${subs}\nkill -KILL $$`,
      );
      const r = await run(["dash"], [file], {
        ...LIVE_ENV,
        SCREEN_COLS: "80",
      });
      const rows = render(r.out);
      const at = nowRow(rows);
      assertEquals(
        [1, 2, 3].map((n) => rows[at + n].trim()),
        slots,
        `after ${i + 1} detail lines`,
      );
      assert(rows[at + 1] === "" || rows[at + 1].startsWith("          "));
      assertEquals(rows[at + 4].trim().startsWith("next"), true);
    }
  });
});

test("detail lines with a value line up, and a known key updates in place", async () => {
  await withTemp(async (dir) => {
    const file = await driver(
      dir,
      'screen_area_start runtimes\nscreen_sub "postgres 18" installing\nscreen_sub "redis 8" waiting\n' +
        'screen_sub "rabbitmq 4" waiting\nscreen_sub "postgres 18" ready\nscreen_sub "redis 8" "pulling image"\nkill -KILL $$',
    );
    const r = await run(["dash"], [file], { ...LIVE_ENV, SCREEN_COLS: "80" });
    const rows = render(r.out);
    const at = nowRow(rows);
    assertEquals(rows.slice(at + 1, at + 4), [
      "          postgres 18   ready",
      "          redis 8       pulling image",
      "          rabbitmq 4    waiting",
    ]);
  });
});

test("when done overflows the newest names stay and a count stands in for the older ones", async () => {
  await withTemp(async (dir) => {
    const names = [
      "preflight",
      "release",
      "download",
      "runtimes",
      "ansible",
      "database",
      "services",
      "health",
    ];
    const body = names.slice(0, 7).map((n) =>
      `screen_area_start ${n}\nscreen_area_done`
    ).join("\n");
    const file = await driver(
      dir,
      `${body}\nscreen_area_start health\nkill -KILL $$`,
      names.join(" "),
    );
    const wide = render(
      (await run(["dash"], [file], { ...LIVE_ENV, SCREEN_COLS: "80" })).out,
    );
    const narrow = render(
      (await run(["dash"], [file], { ...LIVE_ENV, SCREEN_COLS: "60" })).out,
    );
    for (const [rows, cols] of [[wide, 80], [narrow, 60]] as const) {
      const done = rows.find((l) => l.startsWith("  done  "));
      assert(done !== undefined);
      assert([...done].length <= cols - 1, done);
      const m = /^ {2}done {2}\+(\d+) · (.*?) +0s$/.exec(done);
      assert(m, `a count is shown at ${cols} columns: ${done}`);
      const older = Number(m[1]);
      assertEquals(m[2].split(" · "), names.slice(older, 7));
      assert(older >= 1 && !done.includes("preflight"));
    }
    assert(
      render(
        (await run(["dash"], [file], { ...LIVE_ENV, SCREEN_COLS: "120" })).out,
      ).some((l) => l.includes("done  preflight · release")),
    );
  });
});

test("the finish replaces the body with the ready header, the URLs, the warning and the log path", async () => {
  await withTemp(async (dir) => {
    const log = join(dir, "install.log");
    const r = await run(
      ["dash"],
      [DEMO, "--mode", "panel", "--fast", "--log", log],
      { ...LIVE_ENV, SCREEN_COLS: "80" },
    );
    assertEquals(r.code, 0);
    const rows = render(r.out);
    assertEquals(rows.slice(7), [
      "  https://192.0.2.10:8443   public",
      "  https://10.0.0.5:8443     private",
      "",
      "  ! port 8443 is open to the internet",
      `  log  ${log}`,
    ]);
    assertStringIncludes(rows[3], "TurboPanel 1.8.2 is ready  0s");
    assert(rows[2].includes("▀"), "the logo block is the header");
    assert(!rows.some((l) => /^ {2}(done|now|next) /.test(l)));
    const d = await run(
      ["dash"],
      [DEMO, "--mode", "daemon", "--fast", "--log", log],
      { ...LIVE_ENV, SCREEN_COLS: "80" },
    );
    const daemon = render(d.out);
    assertStringIncludes(daemon[3], "Server enrolled  0s");
    assertEquals(daemon.slice(7, 9), [
      "  server-a.example.lan   server",
      "  panel.example.net      panel",
    ]);
    assert(!daemon.some((l) => l.includes("https://")));
  });
});

test("the total time shows as minutes and seconds past a minute", async () => {
  await withTemp(async (dir) => {
    const file = join(dir, "clock.sh");
    await Deno.writeTextFile(
      file,
      `. "${LIB}"\n_ss_now() { cat "${join(dir, "t")}"; }\necho 0 > "${
        join(dir, "t")
      }"\nscreen_init 9.9.9 canary panel "${
        join(dir, "d.log")
      }" a\nscreen_area_start a\necho 72 > "${
        join(dir, "t")
      }"\nscreen_summary "TurboPanel 9.9.9 is ready"\nscreen_finish\n`,
    );
    const r = await run(["dash"], [file], LIVE_ENV);
    assertStringIncludes(render(r.out)[3], "is ready  1m 12s");
  });
});

test("brand colors: 24-bit with COLORTERM, the nearest 256-color index otherwise", async () => {
  await withTemp(async (dir) => {
    const args = [
      DEMO,
      "--mode",
      "panel",
      "--fast",
      "--log",
      join(dir, "i.log"),
    ];
    for (const colorterm of ["truecolor", "24bit"]) {
      const r = await run(["dash"], args, {
        ...LIVE_ENV,
        COLORTERM: colorterm,
      });
      assertStringIncludes(r.out, `${ESC}[38;2;51;102;204m`);
      assertStringIncludes(r.out, `${ESC}[38;2;61;214;140m`);
      assertStringIncludes(r.out, `${ESC}[38;2;134;168;255m`);
      assertStringIncludes(r.out, `${ESC}[38;2;242;184;75m`);
      assert(!r.out.includes("38;5;"));
    }
    const r = await run(["dash"], args, LIVE_ENV);
    assertStringIncludes(r.out, `${ESC}[38;5;68m`);
    assertStringIncludes(r.out, `${ESC}[38;5;79m`);
    assert(!r.out.includes("38;2;"));
    const bad = await run(["dash"], [...args, "--fail-at", "2"], {
      ...LIVE_ENV,
      COLORTERM: "truecolor",
    });
    assertStringIncludes(bad.out, `${ESC}[38;2;255;122;122m`);
  });
});

test("a failed area turns red, keeps its detail lines, and shows the reason, the log and a next step", async () => {
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
    ], { ...LIVE_ENV, SCREEN_COLS: "80" });
    assertEquals(r.code, 1);
    assert(r.out.endsWith(`${ESC}[0m${SHOW}`), "cursor restored last");
    assertStringIncludes(r.out, `${ESC}[38;5;210m`);
    const rows = render(r.out);
    const at = nowRow(rows);
    assert(rows[at].includes("runtimes") && rows[at].endsWith("✗"));
    assertEquals(
      rows[at - 1].startsWith("  done  preflight · release · download"),
      true,
    );
    assertEquals(rows.slice(at + 1, at + 4), [
      "          postgres 18   starting",
      "          redis 8       waiting",
      "          rabbitmq 4    waiting",
    ]);
    assertEquals(
      rows[at + 4],
      "  next  ansible · database · services · health",
    );
    assertEquals(rows.slice(at + 5), [
      "",
      "  fail  Postgres 18 did not start: port 5432 is in use",
      `  log   ${log}`,
      "  try   stop whatever listens on port 5432, then run the installer again",
    ]);
    assert(!rows.some((l) => l.includes("is ready")));
    assertStringIncludes(await Deno.readTextFile(log), "-- FAILED: runtimes");
  });
});

test("plain output reports a failure with the log path, a next step and a non-zero exit", async () => {
  await withTemp(async (dir) => {
    const log = join(dir, "i.log");
    const r = await run(["dash"], [
      DEMO,
      "--fail-at",
      "2",
      "--fast",
      "--log",
      log,
    ], PLAIN_ENV);
    assertEquals(r.code, 1);
    assertStringIncludes(r.out, "[2/8] FAIL release: The release manifest");
    assertStringIncludes(r.out, `      see ${log}`);
    assertStringIncludes(r.out, "      next: check the clock");
    assertStringIncludes(r.out, "stopped at step 2/8");
  });
});

test("TERM, INT and HUP mid-area close the area as failed and restore the cursor", async () => {
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
      const rows = render(r.out);
      assert(rows[nowRow(rows)].endsWith("✗"), sig);
      assert(rows.some((l) => l.includes("doing a thing")), sig);
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
    for (const env of [LIVE_ENV, PLAIN_ENV]) {
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
        assert(
          render(live.out).some((l) => l.startsWith("  log  ")),
          `${shell.join(" ")} ${mode} finish`,
        );
        const plain = await run(shell, [
          DEMO,
          "--mode",
          mode,
          "--fast",
          "--log",
          join(dir, "i.log"),
        ], PLAIN_ENV);
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

/** A frozen mid-install screen: the driver kills itself so the output stops. */
async function frozen(
  dir: string,
  cols: string,
  done: string[],
  now: string,
  subs: string[][],
): Promise<string> {
  const names = [
    "preflight",
    "release",
    "download",
    "runtimes",
    "ansible",
    "database",
    "services",
    "health",
  ];
  const body = [
    ...done.map((n) => `screen_area_start ${n}\nscreen_area_done`),
    `screen_area_start ${now}`,
    ...subs.map(([k, v]) => `screen_sub "${k}" "${v}"`),
    "kill -KILL $$",
  ].join("\n");
  const file = await driver(dir, body, names.join(" "));
  const r = await run(
    ["dash"],
    [file],
    { ...LIVE_ENV, SCREEN_COLS: cols },
    dir,
  );
  return render(r.out).join("\n") + "\n";
}

test("the text captures in installer-screen-frames match the real output", async () => {
  await withTemp(async (dir) => {
    const log = ["--log", "install.log"];
    const demo = async (
      cols: string,
      args: string[],
      env: Record<string, string> = LIVE_ENV,
    ): Promise<string> => {
      const r = await run(["dash"], [DEMO, ...args, "--fast", ...log], {
        ...env,
        SCREEN_COLS: cols,
      }, dir);
      const text = env.SCREEN_FORCE_TTY ? render(r.out) : r.out.split("\n");
      return text.join("\n").replace(/\n+$/, "") + "\n";
    };
    const frames: Record<string, string> = {
      "panel-running.txt": await frozen(
        dir,
        "80",
        ["preflight", "release", "download"],
        "runtimes",
        [
          ["postgres 18", "installing"],
          ["redis 8", "waiting"],
          ["rabbitmq 4", "waiting"],
          ["postgres 18", "ready"],
          ["redis 8", "pulling image"],
        ],
      ),
      "panel-running-60-columns.txt": await frozen(
        dir,
        "60",
        ["preflight", "release", "download", "runtimes", "ansible", "database"],
        "services",
        [
          ["control plane", "ready"],
          ["caddy", "starting"],
          ["daemon", "waiting"],
        ],
      ),
      "panel-done.txt": await demo("80", ["--mode", "panel"]),
      "daemon-done.txt": await demo("80", ["--mode", "daemon"]),
      "panel-failed.txt": await demo("80", [
        "--mode",
        "panel",
        "--fail-at",
        "4",
      ]),
      "plain-output.txt": await demo("0", ["--mode", "panel"], {
        ...PLAIN_ENV,
        SCREEN_FIXED_CLOCK: "1",
      }),
    };
    for (const [name, text] of Object.entries(frames)) {
      const file = join(FRAMES, name);
      if (Deno.env.get("UPDATE_FRAMES") === "1") {
        await Deno.writeTextFile(file, text);
      }
      assertEquals(text, await Deno.readTextFile(file), name);
    }
  });
});
