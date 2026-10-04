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
 * The daemon's systemd units, rendered the way Ansible renders them.
 *
 * `ansible.builtin.template` uses `trim_blocks=True`: the newline right after a
 * block tag is removed. A `{% endif %}` closing an inline condition at the end
 * of a directive line therefore glued the next directive onto it, and every
 * installed turbopaneld.service read
 * `After=network-online.targetWants=network-online.targetOnFailure=turbopaneld-update-guard.service`
 * — no Wants=, and no OnFailure=, so the update-guard rollback never fired.
 */
const TEMPLATES_DIR = join(
  DAEMON_ROOT,
  "orchestration/roles/daemon-launch/templates",
);
const DAEMON_UNIT = "turbopaneld.service.j2";
const GUARD_UNIT = "turbopaneld-update-guard.service.j2";
const GUARD_TIMER = "turbopaneld-update-guard.timer.j2";

/**
 * Ansible's `bool` filter semantics, and the environment it renders with
 * (trim_blocks on, lstrip_blocks off, undefined variables are errors).
 */
const RENDER_PY = `
import json, sys
import jinja2

def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("yes", "on", "1", "true", "y", "t")

req = json.load(sys.stdin)
env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(req["dir"]),
    trim_blocks=True,
    lstrip_blocks=False,
    keep_trailing_newline=True,
    undefined=jinja2.StrictUndefined,
)
env.filters["bool"] = to_bool
out = {name: env.get_template(name).render(**req["vars"]) for name in req["templates"]}
json.dump(out, sys.stdout)
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

/** A Python with Jinja2: the vendored Ansible's, or CI's pip-installed toolchain. */
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
// CI installs the Ansible toolchain (and with it Jinja2) before the tests run;
// there a missing renderer is a broken gate, not a reason to skip.
const RENDER_REQUIRED = Deno.env.get("CI") === "true";

async function render(
  vars: Record<string, unknown>,
  templates: string[],
): Promise<Record<string, string>> {
  assert(JINJA_PYTHON, "no Python with jinja2 found to render the units");
  const child = new Deno.Command(JINJA_PYTHON, {
    args: ["-c", RENDER_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ dir: TEMPLATES_DIR, templates, vars }),
    ),
  );
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, `render failed: ${new TextDecoder().decode(stderr)}`);
  return JSON.parse(new TextDecoder().decode(stdout));
}

const BASE_VARS = {
  turbopanel_user: "tp",
  turbopanel_group: "tp",
  turbopanel_daemon_workdir: "/opt/turbopanel",
  turbopanel_service_name: "turbopaneld",
  turbopanel_daemon_env_file: "/etc/turbopanel/daemon.env",
  runtime_socket_dir: "/run/turbopanel",
  turbopanel_orchestration_dir: "/opt/turbopanel/share/orchestration",
  turbopanel_daemon_bin: "/opt/turbopanel/bin/turbopaneld",
  turbopanel_daemon_state_dir: "/var/lib/turbopanel",
  turbopanel_daemon_deno_bin: "/opt/turbopanel/vendor/deno/current/deno",
  turbopanel_daemon_js: "/opt/turbopanel/bin/turbopaneld.js",
  turbopanel_install_root: "/opt/turbopanel",
  daemon_log_dir: "/var/log/turbopanel",
};

type Variant = {
  name: string;
  vars: Record<string, unknown>;
  afterInstance: boolean;
};

const VARIANTS: Variant[] = [];
for (const mode of ["native", "js", "source"]) {
  for (const afterInstance of [true, false]) {
    for (const envFile of ["/etc/turbopanel/daemon.env", ""]) {
      VARIANTS.push({
        name: `${mode}, ${
          afterInstance ? "co-located (after instance)" : "remote"
        }, ${envFile ? "env file" : "no env file"}`,
        afterInstance,
        vars: {
          ...BASE_VARS,
          turbopanel_daemon_exec_mode: mode,
          // Ansible passes these as strings from vars files as often as bools.
          turbopanel_after_instance_service: afterInstance ? "true" : false,
          turbopanel_daemon_env_file: envFile,
        },
      });
    }
  }
}

type Unit = Map<string, Map<string, string[]>>;

/**
 * Strict systemd unit parser: every non-blank, non-comment line is a
 * `[Section]` header or `Key=Value` with a directive-shaped key. A value that
 * itself contains `Directive=` is the glued-lines bug.
 */
function parseUnit(text: string): Unit {
  const unit: Unit = new Map();
  let section: Map<string, string[]> | undefined;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header) {
      section = new Map();
      unit.set(header[1], section);
      continue;
    }
    const pair = /^([A-Z][A-Za-z0-9]*)=(.*)$/.exec(line);
    assert(pair, `line ${index + 1} is not Key=Value: ${JSON.stringify(line)}`);
    assert(section, `line ${index + 1} precedes any [Section]`);
    const [, key, value] = pair;
    assert(
      !/[a-z0-9.]([A-Z][A-Za-z]+)=/.test(value),
      `line ${index + 1}: ${key}= swallowed another directive: ${
        JSON.stringify(line)
      }`,
    );
    section.set(key, [...(section.get(key) ?? []), value]);
  }
  return unit;
}

function only(unit: Unit, section: string, key: string): string {
  const values = unit.get(section)?.get(key) ?? [];
  assertEquals(
    values.length,
    1,
    `[${section}] ${key}= must appear exactly once`,
  );
  return values[0];
}

test({
  name:
    "no daemon-launch template ends a content line with a block tag (trim_blocks eats the newline)",
  fn: async () => {
    for (const name of [DAEMON_UNIT, GUARD_UNIT, GUARD_TIMER]) {
      const source = await Deno.readTextFile(join(TEMPLATES_DIR, name));
      for (const [index, line] of source.split("\n").entries()) {
        const trapped = /\S.*\{%-?[^%]*-?%\}\s*$/.test(line) &&
          !/^\s*\{%/.test(line);
        assert(
          !trapped,
          `${name}:${index + 1} ends a directive with a block tag: ${line}`,
        );
      }
    }
  },
});

test({
  name: "a Python with jinja2 is available where the render tests must run",
  ignore: !RENDER_REQUIRED,
  fn: () => {
    assert(
      JINJA_PYTHON,
      "CI must provide jinja2 (the Ansible toolchain) for the unit render tests",
    );
  },
});

for (const variant of VARIANTS) {
  test({
    name:
      `turbopaneld.service renders one directive per line — ${variant.name}`,
    ignore: !JINJA_PYTHON,
    fn: async () => {
      const rendered = await render(variant.vars, [
        DAEMON_UNIT,
        GUARD_UNIT,
        GUARD_TIMER,
      ]);
      const unit = parseUnit(rendered[DAEMON_UNIT]);

      const expectedOrder = variant.afterInstance
        ? "network-online.target turbopanel-instance.service"
        : "network-online.target";
      // docker.service is ordering only: stop before Docker at shutdown.
      assertEquals(
        only(unit, "Unit", "After"),
        expectedOrder.replace(
          "network-online.target",
          "network-online.target docker.service",
        ),
      );
      assertEquals(only(unit, "Unit", "Wants"), expectedOrder);
      assertEquals(
        only(unit, "Unit", "OnFailure"),
        "turbopaneld-update-guard.service",
      );
      assertEquals(only(unit, "Unit", "StartLimitBurst"), "5");
      assert(
        only(unit, "Service", "ExecStart").startsWith(
          "/usr/bin/flock -n /run/turbopanel/daemon.lock ",
        ),
      );
      assertEquals(only(unit, "Install", "WantedBy"), "multi-user.target");
      const envFiles = unit.get("Service")?.get("EnvironmentFile") ?? [];
      assertEquals(
        envFiles,
        variant.vars.turbopanel_daemon_env_file
          ? ["-/etc/turbopanel/daemon.env"]
          : [],
      );

      // The unit OnFailure= names is rendered by the same role, and parses.
      const guard = parseUnit(rendered[GUARD_UNIT]);
      assertEquals(only(guard, "Service", "Type"), "oneshot");
      assertEquals(
        only(guard, "Service", "ExecStart"),
        "/opt/turbopanel/lib/tp-update-guard",
      );
      const timer = parseUnit(rendered[GUARD_TIMER]);
      assertEquals(
        only(timer, "Timer", "Unit"),
        "turbopaneld-update-guard.service",
      );
    },
  });
}
