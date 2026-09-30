import { assert, assertEquals } from "@std/assert";
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
 * `<install>/lib/tp-backup-run`, rendered the way Ansible renders it and run
 * for real against a fake daemon, in every exec mode. The wrapper is the only
 * thing a backup timer's service may exec, so its argument check is the
 * boundary: exactly one lower-case UUID, or nothing runs.
 */
const TEMPLATES_DIR = join(
  DAEMON_ROOT,
  "orchestration/roles/daemon-launch/templates",
);

const RENDER_PY = `
import json, sys
import jinja2
req = json.load(sys.stdin)
env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(req["dir"]),
    trim_blocks=True,
    lstrip_blocks=False,
    keep_trailing_newline=True,
    undefined=jinja2.StrictUndefined,
)
sys.stdout.write(env.get_template("tp-backup-run.j2").render(**req["vars"]))
`;

async function hasJinja(python: string): Promise<boolean> {
  try {
    const { success } = await new Deno.Command(python, {
      args: ["-c", "import jinja2"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

async function findJinjaPython(): Promise<string | undefined> {
  const candidates = [
    Deno.env.get("TURBOPANEL_JINJA_PYTHON"),
    "/opt/turbopanel/vendor/ansible/current/bin/python3",
    "python3",
    "python",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const candidate of candidates) {
    if (await hasJinja(candidate)) return candidate;
  }
  return undefined;
}

const JINJA_PYTHON = await findJinjaPython();

async function render(vars: Record<string, unknown>): Promise<string> {
  assert(JINJA_PYTHON, "no Python with jinja2 found to render the wrapper");
  const child = new Deno.Command(JINJA_PYTHON, {
    args: ["-c", RENDER_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({ dir: TEMPLATES_DIR, vars })),
  );
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, `render failed: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout);
}

/** A stand-in daemon/deno binary: records its argv, run dir, DENO_DIR and cwd. */
const FAKE_BIN = `#!/bin/sh
{
  for arg in "$@"; do printf 'ARG=%s\\n' "$arg"; done
  printf 'RUN_DIR=%s\\n' "\${TURBOPANEL_RUN_DIR:-}"
  printf 'DENO_DIR=%s\\n' "\${DENO_DIR:-}"
  printf 'PWD=%s\\n' "$(pwd -P)"
} > "$FAKE_OUT"
`;

type Fixture = { tmp: string; wrapper: string; out: string; workdir: string };

async function withWrapper(
  mode: "native" | "js" | "source",
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-backup-run-wrapper-" }),
  );
  try {
    const fake = join(tmp, "fake-bin");
    await Deno.writeTextFile(fake, FAKE_BIN, { mode: 0o755 });
    const workdir = join(tmp, "checkout");
    await Deno.mkdir(workdir);
    const wrapper = join(tmp, "tp-backup-run");
    await Deno.writeTextFile(
      wrapper,
      await render({
        turbopanel_group: "tp",
        turbopanel_backup_run_bin: "/opt/turbopanel/lib/tp-backup-run",
        runtime_socket_dir: "/run/turbopanel",
        turbopanel_daemon_exec_mode: mode,
        turbopanel_daemon_bin: fake,
        turbopanel_daemon_deno_bin: fake,
        turbopanel_daemon_js: "/opt/turbopanel/bin/turbopaneld.js",
        turbopanel_daemon_state_dir: "/var/lib/turbopanel",
        turbopanel_daemon_workdir: workdir,
      }),
      { mode: 0o755 },
    );
    await fn({ tmp, wrapper, out: join(tmp, "out.txt"), workdir });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

async function runWrapper(
  fixture: Fixture,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string; record: string[] | null }> {
  const { code, stderr } = await new Deno.Command("sh", {
    args: [fixture.wrapper, ...args],
    env: { FAKE_OUT: fixture.out, ...env },
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  }).output();
  let record: string[] | null = null;
  try {
    record = (await Deno.readTextFile(fixture.out)).trimEnd().split("\n");
    await Deno.remove(fixture.out);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return { code, stderr: new TextDecoder().decode(stderr), record };
}

const POLICY_ID = "0192f1de-7c3b-7e4a-9f10-3a5b6c7d8e9f";

test({
  name:
    "tp-backup-run refuses anything but exactly one lower-case UUID, and runs nothing",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    await withWrapper("native", async (fixture) => {
      const refused: string[][] = [
        [],
        [POLICY_ID, POLICY_ID],
        [POLICY_ID.toUpperCase()],
        [`${POLICY_ID}0`],
        [POLICY_ID.slice(1)],
        ["------------------------------------"],
        ["../../etc/passwd"],
        [`${POLICY_ID.slice(0, -1)};`],
        [""],
      ];
      for (const args of refused) {
        const { code, record } = await runWrapper(fixture, args);
        assertEquals(code, 2, `args ${JSON.stringify(args)}`);
        assertEquals(
          record,
          null,
          `args ${JSON.stringify(args)} ran the daemon`,
        );
      }
    });
  },
});

test({
  name:
    "tp-backup-run execs the native binary's backup-run verb with the daemon's run dir",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    await withWrapper("native", async (fixture) => {
      const { code, record } = await runWrapper(fixture, [POLICY_ID]);
      assertEquals(code, 0);
      assert(record);
      assertEquals(record.filter((l) => l.startsWith("ARG=")), [
        "ARG=backup-run",
        `ARG=${POLICY_ID}`,
      ]);
      assert(record.includes("RUN_DIR=/run/turbopanel"));
      // An explicit run dir from the unit's environment wins.
      const custom = await runWrapper(fixture, [POLICY_ID], {
        TURBOPANEL_RUN_DIR: "/run/custom",
      });
      assert(custom.record?.includes("RUN_DIR=/run/custom"));
    });
  },
});

test({
  name:
    "tp-backup-run runs the JS bundle under the scoped grants with the daemon's DENO_DIR",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    await withWrapper("js", async (fixture) => {
      const { code, record } = await runWrapper(fixture, [POLICY_ID]);
      assertEquals(code, 0);
      assert(record);
      const args = record.filter((l) => l.startsWith("ARG=")).map((l) =>
        l.slice(4)
      );
      assertEquals(args.slice(0, 2), ["run", "--quiet"]);
      assertEquals(args.slice(-3), [
        "/opt/turbopanel/bin/turbopaneld.js",
        "backup-run",
        POLICY_ID,
      ]);
      assert(!args.includes("--allow-all") && !args.includes("--allow-read"));
      assert(record.includes("DENO_DIR=/var/lib/turbopanel/deno-cache"));
    });
  },
});

test({
  name: "tp-backup-run runs main.ts from the checkout in source mode",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    await withWrapper("source", async (fixture) => {
      const { code, record } = await runWrapper(fixture, [POLICY_ID]);
      assertEquals(code, 0);
      assert(record);
      const args = record.filter((l) => l.startsWith("ARG=")).map((l) =>
        l.slice(4)
      );
      assertEquals(args.slice(-3), ["main.ts", "backup-run", POLICY_ID]);
      assert(record.includes(`PWD=${fixture.workdir}`));
    });
  },
});
