/**
 * Pins the installer screen layer (scripts/lib/installer-screen.sh) through the
 * simulated install in scripts/installer-screen-demo.sh: the compact header,
 * the check rows with the current area and its three detail slots, the
 * collapsed finish and the failure screen,
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

/** The screen as text: escape sequences removed; a cursor move starts a new line. */
function visible(out: string): string[] {
  return out.replace(/\x1b\[\d*[AB]/g, "\n").replace(ANSI, "").replaceAll(
    "\r",
    "",
  )
    .split("\n");
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
        else if (cmd === "B") {
          r += Number(arg || 1);
          while (rows.length <= r) rows.push([]);
        } else if (cmd === "K") rows[r] = [];
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
  plan = "Aa Bb Cc",
  mode = "panel",
): Promise<string> {
  const file = join(dir, "driver.sh");
  return Deno.writeTextFile(
    file,
    `. "${LIB}"\nscreen_init 1.8.2 canary ${mode} "${
      join(dir, "d.log")
    }" ${plan}\n${body}\n`,
  ).then(() => file);
}

/** Row index of the current area (spinner or cross, not a check row). */
function nowRow(rows: string[]): number {
  const at = rows.findIndex((l) => /^ {2}[^\s✓+] \S/.test(l) && !/→/.test(l));
  assert(at >= 0, `no current area row in:\n${rows.join("\n")}`);
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
    assertStringIncludes(r.out, "[1/8] Checking this server ...");
    assertStringIncludes(r.out, "      - prerequisites: checking");
    assert(
      /\[1\/8\] ok {3}Checking this server: Debian 13, 4 CPU, 8 GiB \(\d+s\)/
        .test(r.out),
    );
    assertStringIncludes(r.out, "== Enrolled in ");
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
    assertStringIncludes(r.out, "== Ready in ");
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
      assertStringIncludes(r.out, "[8/8] ok   Tuning the kernel:");
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

test("the live screen shows a one-line header, check rows and the current area, and the cursor comes back", async () => {
  await withTemp(async (dir) => {
    const r = await run(
      ["dash"],
      [DEMO, "--fast", "--log", join(dir, "i.log")],
      { ...LIVE_ENV, SCREEN_COLS: "80" },
    );
    assertEquals(r.code, 0);
    assertStringIncludes(r.out, HIDE);
    assert(r.out.endsWith(SHOW), "cursor shown again at the very end");
    for (const line of visible(r.out)) assert([...line].length <= 79, line);
    const text = visible(r.out).join("\n");
    assertStringIncludes(text, "  TurboPanel  1.8.2 · server");
    assertStringIncludes(
      text,
      "  ✓ Checking this server       Debian 13, 4 CPU, 8 GiB",
    );
    assertStringIncludes(
      text,
      "  ✓ Verifying the release      signature verified",
    );
    assertStringIncludes(text, "  ⠋ Installing the runtimes");
    for (const gone of ["▟█▙", "[T]", "╭", "│", "▄███▀", "next  ", "done  "]) {
      assert(!text.includes(gone), `no ${gone} in the compact layout`);
    }
    assert(
      !/\d+s\b/.test(text.split("Enrolled in")[0]),
      "no timers while running",
    );
    const mid = render(
      (await run(["dash"], [
        await driver(
          dir,
          "screen_area_start Aa\nscreen_area_done fact\nscreen_area_start Bb\nscreen_sub one\nkill -KILL $$",
        ),
      ], { ...LIVE_ENV, SCREEN_COLS: "80" })).out,
    );
    assertEquals(mid.slice(0, 5), [
      "",
      "  TurboPanel  1.8.2 · control plane",
      `  ${"█".repeat(10)}${"░".repeat(22)}  2/3  Bb`,
      "",
      "  ✓ Aa    fact",
    ]);
    assertEquals(mid.length, 7);
    assertEquals(mid[6], "      one");
    assert(/^ {2}\S Bb$/.test(mid[5]), "pending areas are not shown");
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
        [1, 2, 3].map((n) => (rows[at + n] ?? "").trim()),
        slots,
        `after ${i + 1} detail lines`,
      );
      assert(rows[at + 1].startsWith("      "), "details sit under the name");
    }
  });
});

test("detail lines with a value line up, and a known key updates in place", async () => {
  await withTemp(async (dir) => {
    const file = await driver(
      dir,
      'screen_area_start runtimes\nscreen_sub "database" installing\nscreen_sub "cache" waiting\n' +
        'screen_sub "message queue" waiting\nscreen_sub "database" ready\nscreen_sub "cache" "pulling image"\nkill -KILL $$',
    );
    const r = await run(["dash"], [file], { ...LIVE_ENV, SCREEN_COLS: "80" });
    const rows = render(r.out);
    const at = nowRow(rows);
    assertEquals(rows.slice(at + 1, at + 4), [
      "      database        ready",
      "      cache           pulling image",
      "      message queue   waiting",
    ]);
  });
});

test("the finish collapses the check rows to one short row, then the ready line, URLs, warning and log", async () => {
  await withTemp(async (dir) => {
    const log = join(dir, "install.log");
    const r = await run(
      ["dash"],
      [DEMO, "--mode", "panel", "--fast", "--log", log],
      { ...LIVE_ENV, SCREEN_COLS: "80" },
    );
    assertEquals(r.code, 0);
    assertEquals(render(r.out), [
      "",
      "  TurboPanel  1.8.2 · control plane",
      `  ${"█".repeat(32)}  8/8`,
      "",
      "  ✓ 8 steps done",
      "",
      "  Ready in 1m 12s",
      "",
      "  → https://192.0.2.10:8443   public",
      "  → https://10.0.0.5:8443     private",
      "",
      "  ! port 8443 is open to the internet",
      `  log  ${log}`,
    ]);
    const narrow = render(
      (await run(
        ["dash"],
        [DEMO, "--mode", "panel", "--fast", "--log", log],
        { ...LIVE_ENV, SCREEN_COLS: "60" },
      )).out,
    );
    assert(narrow.includes("  ✓ 8 steps done"));
    assert(!narrow.some((l) => l.includes("Checking this server")));
    const d = await run(
      ["dash"],
      [DEMO, "--mode", "daemon", "--fast", "--log", log],
      { ...LIVE_ENV, SCREEN_COLS: "80" },
    );
    const daemon = render(d.out);
    assert(daemon.includes("  Enrolled in 1m 12s"));
    assert(daemon.includes("  → server-a.example.lan   server"));
    assert(daemon.includes("  → panel.example.net      panel"));
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
      }"\nscreen_init 1.8.2 canary panel "${
        join(dir, "d.log")
      }" Aa\nscreen_area_start Aa\necho 72 > "${
        join(dir, "t")
      }"\nscreen_summary "Ready in"\nscreen_finish\n`,
    );
    const r = await run(["dash"], [file], {
      ...LIVE_ENV,
      SCREEN_FIXED_CLOCK: "",
    });
    assert(render(r.out).includes("  Ready in 1m 12s"));
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
    assertEquals(rows[at], "  ✗ Installing data services");
    assertEquals(
      rows[2],
      `  ${"█".repeat(12)}${"░".repeat(20)}  4/8  Installing data services`,
    );
    assertStringIncludes(r.out, `${ESC}[38;5;210m${"█".repeat(12)}`);
    assertEquals(rows.slice(at - 3, at), [
      "  ✓ Checking this server        Debian 13, 4 CPU, 8 GiB",
      "  ✓ Verifying the release       signature verified",
      "  ✓ Downloading TurboPanel      control plane 1.8.2, web app 1.8.2",
    ]);
    assertEquals(rows.slice(at + 1), [
      "      database        starting",
      "      cache           waiting",
      "      message queue   waiting",
      "",
      "  The TurboPanel database did not start: port 5432 is in use",
      `  log  ${log}`,
      "  try  stop whatever listens on port 5432, then run the installer again",
    ]);
    assert(!rows.some((l) => l.includes("Ready in")));
    assertStringIncludes(
      await Deno.readTextFile(log),
      "-- FAILED: Installing data services",
    );
  });
});

test("the progress bar is 32 cells, fills by finished areas and redraws in place", async () => {
  await withTemp(async (dir) => {
    const bar = async (body: string, extra: Record<string, string> = {}) =>
      render(
        (await run(["dash"], [await driver(dir, body, "A B C D")], {
          ...LIVE_ENV,
          SCREEN_COLS: "80",
          ...extra,
        })).out,
      );
    const start = await bar("kill -KILL $$");
    assertEquals(start.slice(0, 2), [
      "",
      "  TurboPanel  1.8.2 · control plane",
    ]);
    assertEquals(start[2], `  ${"░".repeat(32)}  0/4`);
    const first = await bar("screen_area_start A\nkill -KILL $$");
    assertEquals(first[2], `  ${"░".repeat(32)}  1/4  A`);
    const mid = await bar(
      "screen_area_start A\nscreen_area_done\nscreen_area_start B\nscreen_area_done\nscreen_area_start C\nkill -KILL $$",
    );
    assertEquals(mid[2], `  ${"█".repeat(16)}${"░".repeat(16)}  3/4  C`);
    assertEquals(mid.length, 7, "the bar redraws in place, no extra rows");
    const done = await bar(
      "for a in A B C D; do screen_area_start $a; screen_area_done; done\nscreen_summary Ready\nscreen_finish",
    );
    assertEquals(done[2], `  ${"█".repeat(32)}  4/4`);
    const failed = await bar(
      "screen_area_start A\nscreen_area_done\nscreen_area_start B\nscreen_area_fail why",
    );
    assertEquals(failed[2], `  ${"█".repeat(8)}${"░".repeat(24)}  2/4  B`);
    const ascii = await bar(
      "screen_area_start A\nscreen_area_done\nkill -KILL $$",
      {
        SCREEN_UNICODE: "0",
      },
    );
    assertEquals(ascii[2], `  ${"#".repeat(8)}${"-".repeat(24)}  1/4  A`);
    const narrow = await bar(
      "screen_area_start A\nkill -KILL $$",
      { SCREEN_COLS: "40" },
    );
    assert([...narrow[2]].length <= 39, "the bar shrinks on a narrow screen");
    assert(!narrow[2].includes("█".repeat(32)));
    const raw = (await run(["dash"], [
      await driver(
        dir,
        "screen_area_start A\nscreen_area_done\nscreen_summary Ready\nscreen_finish",
        "A",
      ),
    ], { ...LIVE_ENV, COLORTERM: "truecolor", SCREEN_COLS: "80" })).out;
    assertStringIncludes(raw, `${ESC}[38;2;61;214;140m${"█".repeat(32)}`);
    assertStringIncludes(raw, `${ESC}[38;2;51;102;204m`);
  });
});

test("plain output never prints a progress bar", async () => {
  await withTemp(async (dir) => {
    const r = await run(
      ["dash"],
      [DEMO, "--mode", "panel", "--fast", "--log", join(dir, "i.log")],
      PLAIN_ENV,
    );
    assertEquals(r.code, 0);
    for (const bar of ["█", "░", "━", "─", "####", "----"]) {
      assert(!r.out.includes(bar), `no ${bar} in plain output`);
    }
    assertStringIncludes(r.out, "[3/8] Downloading TurboPanel ...");
  });
});

test("the finish collapses any number of finished areas to one short row", async () => {
  await withTemp(async (dir) => {
    const finish = async (count: number, cols: string) => {
      const names = Array.from({ length: count }, (_, i) => `Step number ${i}`);
      const body = names.map((n) =>
        `screen_area_start "${n}"\nscreen_area_done`
      )
        .join("\n") + "\nscreen_summary Ready\nscreen_finish";
      const plan = names.map((n) => `"${n}"`).join(" ");
      const rows = render(
        (await run(["dash"], [await driver(dir, body, plan)], {
          ...LIVE_ENV,
          SCREEN_COLS: cols,
        })).out,
      );
      return rows.filter((l) => l.startsWith("  ✓"));
    };
    assertEquals(await finish(1, "80"), ["  ✓ 1 step done"]);
    assertEquals(await finish(3, "80"), ["  ✓ 3 steps done"]);
    assertEquals(await finish(12, "60"), ["  ✓ 12 steps done"]);
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
    assertStringIncludes(
      r.out,
      "[2/8] FAIL Verifying the release: The release manifest",
    );
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
      assert(rows[nowRow(rows)].startsWith("  ✗ "), sig);
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
  done: string[][],
  now: string,
  subs: string[][],
): Promise<string> {
  const names = [
    "Checking this server",
    "Verifying the release",
    "Downloading TurboPanel",
    "Installing data services",
    "Configuring the instance",
    "Preparing the database",
    "Starting services",
    "Checking health",
  ];
  const body = [
    ...done.map(([n, fact]) =>
      `screen_area_start "${n}"\nscreen_area_done "${fact}"`
    ),
    `screen_area_start "${now}"`,
    ...subs.map(([k, v]) => `screen_sub "${k}" "${v}"`),
    "kill -KILL $$",
  ].join("\n");
  const file = await driver(dir, body, names.map((n) => `"${n}"`).join(" "));
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
        [
          ["Checking this server", "Debian 13, 4 CPU, 8 GiB"],
          ["Verifying the release", "signature verified"],
          ["Downloading TurboPanel", "control plane 1.8.2, web app 1.8.2"],
        ],
        "Installing data services",
        [
          ["database", "installing"],
          ["cache", "waiting"],
          ["message queue", "waiting"],
          ["database", "ready"],
          ["cache", "pulling image"],
        ],
      ),
      "panel-running-60-columns.txt": await frozen(
        dir,
        "60",
        [
          ["Checking this server", "Debian 13, 4 CPU, 8 GiB"],
          ["Verifying the release", "signature verified"],
          ["Downloading TurboPanel", "control plane 1.8.2, web app 1.8.2"],
          ["Installing data services", "database, cache, message queue"],
          ["Configuring the instance", "63 tasks, 0 failed"],
          ["Preparing the database", "schema is up to date"],
        ],
        "Starting services",
        [
          ["control plane", "ready"],
          ["web gateway", "starting"],
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

test("no vendor or third-party product name appears in the demo output or any frame", async () => {
  const banned =
    /postgres|redis|rabbit|ansible|caddy|docker|\bdeno\b|\bnode\b|\buv\b|nginx|apache|systemd/i;
  await withTemp(async (dir) => {
    for (const mode of ["panel", "daemon"]) {
      for (const fail of ["0", "1", "2", "3", "4", "5", "6", "7", "8"]) {
        for (const env of [LIVE_ENV, PLAIN_ENV]) {
          const r = await run(["dash"], [
            DEMO,
            "--mode",
            mode,
            "--fail-at",
            fail,
            "--fast",
            "--log",
            join(dir, "i.log"),
          ], env);
          const shown = render(r.out).join("\n") + r.out;
          const hit = banned.exec(shown);
          assert(!hit, `${mode} fail-at ${fail}: "${hit?.[0]}" is on screen`);
        }
      }
    }
    for await (const f of Deno.readDir(FRAMES)) {
      const hit = banned.exec(await Deno.readTextFile(join(FRAMES, f.name)));
      assert(!hit, `${f.name}: "${hit?.[0]}" is in a frame`);
    }
  });
});
