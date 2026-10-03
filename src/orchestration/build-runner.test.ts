import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * `<install>/lib/tp-build-runner`, run for real (unprivileged) against a temp
 * work directory: the spec on stdin is the whole interface between the daemon
 * and a sandboxed build, so its parsing, environment and exit semantics are
 * pinned here.
 */
const RUNNER = join(DAEMON_ROOT, "orchestration/scripts/tp-build-runner");

type Spec = {
  cwd?: string;
  env?: [string, string][];
  run: string[];
};

function b64(value: string): string {
  return encodeBase64(new TextEncoder().encode(value));
}

function specText(spec: Spec): string {
  const lines = ["tp-build-spec 1"];
  if (spec.cwd !== undefined) lines.push(`cwd ${spec.cwd}`);
  for (const [name, value] of spec.env ?? []) {
    lines.push(`env ${name} ${b64(value)}`);
  }
  for (const command of spec.run) lines.push(`run ${b64(command)}`);
  lines.push("end", "");
  return lines.join("\n");
}

async function runRunner(
  work: string,
  stdin: string,
  args: string[] = [work],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command("sh", {
    args: [RUNNER, ...args],
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin", LEAK: "from-the-caller" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  // An oversized spec is refused before the runner reads all of it.
  await writer.write(new TextEncoder().encode(stdin)).then(
    () => writer.close(),
    () => undefined,
  );
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function withWork(fn: (work: string) => Promise<void>): Promise<void> {
  const work = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-build-runner-" }),
  );
  try {
    await Deno.mkdir(join(work, "app"));
    await fn(work);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

test("the runner runs each command in order, in cwd, from a clean environment", async () => {
  await withWork(async (work) => {
    const result = await runRunner(
      work,
      specText({
        cwd: "app",
        env: [
          ["GREETING", "two words\nand a line\n"],
          ["PATH", "/opt/node/bin:/usr/bin:/bin"],
          ["EMPTY", ""],
        ],
        run: [
          'printf "%s|" "$GREETING" "$PATH" "$HOME" "$TMPDIR" "${LEAK-unset}" "${EMPTY-unset}" "$(pwd)"',
          "echo second; echo to-stderr >&2",
        ],
      }),
    );
    assertEquals(result.code, 0, result.stderr);
    assertEquals(
      result.stdout,
      `two words\nand a line\n|/opt/node/bin:/usr/bin:/bin|${work}|/tmp|unset||${work}/app|second\n`,
    );
    assertEquals(result.stderr, "to-stderr\n");
  });
});

test("the runner reads the spec and gives tenant commands no stdin", async () => {
  await withWork(async (work) => {
    const result = await runRunner(
      work,
      specText({
        run: [
          "if read -r line; then echo got:$line; else echo stdin-empty; fi",
        ],
      }) + "trailing input a command must not see\n",
    );
    // Data after `end` is a malformed spec, not command input.
    assertEquals(result.code, 65, result.stderr);
    const clean = await runRunner(
      work,
      specText({
        run: [
          "if read -r line; then echo got:$line; else echo stdin-empty; fi",
        ],
      }),
    );
    assertEquals(clean.stdout, "stdin-empty\n");
  });
});

test("the first failing command ends the build with its own status", async () => {
  await withWork(async (work) => {
    const result = await runRunner(
      work,
      specText({ run: ["echo one", "exit 7", "echo never"] }),
    );
    assertEquals(result.code, 7);
    assertEquals(result.stdout, "one\n");
    assertStringIncludes(result.stderr, "step 2 of 3 failed (exit 7)");
  });
});

test("a missing pnpm gets a plain-words hint, other failures do not", async () => {
  await withWork(async (work) => {
    const missing = await runRunner(
      work,
      specText({ run: ["pnpm-not-here-xyz run build; exit 127"] }),
    );
    assertEquals(missing.code, 127);
    assertStringIncludes(
      missing.stderr,
      "hint: pnpm/yarn were not found on the build PATH",
    );
    assertStringIncludes(missing.stderr, "corepack pnpm");
    const other = await runRunner(
      work,
      specText({ run: ["pnpm_x=1; exit 127"] }),
    );
    assertEquals(other.code, 127);
    assert(other.stderr.includes("hint:"), "pnpm in the text still hints");
    const plain = await runRunner(work, specText({ run: ["exit 127"] }));
    assert(!plain.stderr.includes("hint:"));
    const seven = await runRunner(
      work,
      specText({ run: ["echo pnpm; exit 7"] }),
    );
    assert(!seven.stderr.includes("hint:"));
  });
});

test("the runner refuses a malformed spec before running anything", async () => {
  await withWork(async (work) => {
    await Deno.symlink("/", join(work, "up"));
    const ok = specText({ run: ["touch ran"] });
    const bad: string[] = [
      "",
      ok.replace("tp-build-spec 1", "tp-build-spec 2"),
      ok.replace("end\n", ""),
      ok.replace("end\n", "end\nrun ZWNobyBsYXRl\n"),
      ok.replace("end\n", "end now\n"),
      specText({ run: [] }),
      specText({ cwd: "../x", run: ["true"] }),
      specText({ cwd: "/tmp", run: ["true"] }),
      specText({ cwd: "app/../..", run: ["true"] }),
      specText({ cwd: "up", run: ["touch ran"] }),
      ok.replace("tp-build-spec 1\n", "tp-build-spec 1\ncwd app\ncwd app\n"),
      ok.replace("tp-build-spec 1\n", "tp-build-spec 1\nenv 1X YQ==\n"),
      ok.replace("tp-build-spec 1\n", "tp-build-spec 1\nenv A-B YQ==\n"),
      ok.replace("tp-build-spec 1\n", "tp-build-spec 1\nenv A not-base64!\n"),
      ok.replace("tp-build-spec 1\n", "tp-build-spec 1\nexec dHJ1ZQ==\n"),
      ok.replace("tp-build-spec 1\n", "tp-build-spec 1\nrun !!\n"),
      specText({ run: Array.from({ length: 65 }, () => "true") }),
      specText({ run: ["true"], env: [["BIG", "x".repeat(1024 * 1024)]] }),
    ];
    for (const spec of bad) {
      const result = await runRunner(work, spec);
      assertEquals(result.code, 65, `${spec.slice(0, 200)}\n${result.stderr}`);
      assertStringIncludes(result.stderr, "tp-build-runner: bad spec");
    }
    for (const where of [work, join(work, "app")]) {
      const ran = await Deno.stat(join(where, "ran")).catch(() => undefined);
      assertEquals(ran, undefined, "a command ran despite a bad spec");
    }
  });
});

test("the runner takes exactly one real, absolute work directory", async () => {
  await withWork(async (work) => {
    const spec = specText({ run: ["true"] });
    await Deno.symlink(join(work, "app"), join(work, "link"));
    for (
      const args of [
        [],
        [work, "extra"],
        ["relative"],
        [join(work, "missing")],
        [join(work, "link")],
      ]
    ) {
      const result = await runRunner(work, spec, args);
      assertEquals(result.code, 64, args.join(" "));
    }
    const ok = await runRunner(join(work, "app"), spec);
    assert(ok.code === 0, ok.stderr);
  });
});
