import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * Owner decision: every component follows the channel it was installed from;
 * only the installer (run.sh) picks it, and `release` is its default. The
 * update flow re-renders runtime.env through instance-launch without passing a
 * channel (instance-launch-only for a stale Caddyfile, a converge), and the
 * template's bare `default('release')` moved a canary host to release on its
 * first update (canary, 2026-10-01). These tests render the real role
 * expression and template with Jinja2.
 */

/** Sonar typescript:S2187 only recognizes `test()`, not `Deno.test()`. */
const test = Deno.test.bind(Deno);

const ROLE = join(DAEMON_ROOT, "orchestration/roles/instance-launch");
const TASKS = join(ROLE, "tasks/main.yml");
const DENO_ENV = join(ROLE, "templates/instance-deno.env.j2");
const WORKERS_ENV = join(ROLE, "templates/instance-workers.env.j2");
const INSTALL_PLAY = join(
  DAEMON_ROOT,
  "orchestration/playbooks/instance-install.yml",
);

const FACT = "turbopanel_installed_update_channel";

/** The Ansible filters these templates use, as Jinja2 filters. */
const RENDER_PY = String.raw`
import base64, json, re, sys
import jinja2

def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("yes", "on", "1", "true", "y", "t")

env = jinja2.Environment(keep_trailing_newline=True, trim_blocks=True, undefined=jinja2.StrictUndefined)
env.filters["bool"] = to_bool
env.filters["b64decode"] = lambda s: base64.b64decode(s).decode()
env.filters["regex_findall"] = lambda s, pattern: re.findall(pattern, s)
req = json.load(sys.stdin)
sys.stdout.write(env.from_string(req["source"]).render(**req["vars"]))
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
// CI installs the Ansible toolchain (and with it Jinja2) before the tests run.
const RENDER_REQUIRED = Deno.env.get("CI") === "true";

async function render(
  source: string,
  vars: Record<string, unknown>,
): Promise<string> {
  assert(JINJA_PYTHON, "no Python with jinja2 found");
  const child = new Deno.Command(JINJA_PYTHON, {
    args: ["-c", RENDER_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({ source, vars })),
  );
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, `render failed: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout);
}

/** The folded (`>-`) value of the role's set_fact for {@link FACT}. */
async function channelFactExpression(): Promise<string> {
  const lines = (await Deno.readTextFile(TASKS)).split("\n");
  const start = lines.findIndex((line) => line.trim() === `${FACT}: >-`);
  assert(start >= 0, `${FACT} set_fact not found in ${TASKS}`);
  const indent = lines[start].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.search(/\S/) <= indent) break;
    body.push(line.trim());
  }
  return body.join(" ");
}

async function installedChannel(runtimeEnv: string): Promise<string> {
  return await render(await channelFactExpression(), {
    _instance_runtime_env_raw: { content: encodeBase64(runtimeEnv) },
  });
}

function channelLine(rendered: string): string | undefined {
  return rendered.split("\n").find((line) =>
    line.startsWith("TURBOPANEL_UPDATE_CHANNEL=")
  );
}

test({
  name: "a Python with jinja2 is available for the runtime env channel tests",
  ignore: !RENDER_REQUIRED,
  fn: () => {
    assert(JINJA_PYTHON, "CI must provide jinja2 for the template tests");
  },
});

test({
  name: "instance-launch reads the channel already in runtime.env",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    const canary = [
      "TURBOPANEL_SERVER_METRICS_RETENTION_DAYS=90",
      "TURBOPANEL_UPDATE_CHANNEL=canary",
      "TURBOPANEL_BUILD_LABEL=0.1.7-canary.56",
      "",
    ].join("\n");
    assertEquals(await installedChannel(canary), "canary");
    assertEquals(
      await installedChannel("TURBOPANEL_UPDATE_CHANNEL=rc \n"),
      "rc",
    );
    assertEquals(
      await installedChannel("TURBOPANEL_SERVER_METRICS_RETENTION_DAYS=90\n"),
      "",
    );
    assertEquals(
      await installedChannel("# TURBOPANEL_UPDATE_CHANNEL=canary\n"),
      "",
    );
  },
});

for (const template of [DENO_ENV, WORKERS_ENV]) {
  const name = template.split("/").at(-1);
  const base = {
    turbopanel_pg_password: "pw",
    postgres_user: "u",
    postgres_port: 5432,
    postgres_db: "d",
  };

  test({
    name:
      `${name}: a render with no channel passed keeps the installed channel`,
    ignore: !JINJA_PYTHON,
    fn: async () => {
      const source = await Deno.readTextFile(template);
      assertEquals(
        channelLine(await render(source, { ...base, [FACT]: "canary" })),
        "TURBOPANEL_UPDATE_CHANNEL=canary",
      );
    },
  });

  test({
    name: `${name}: the installer's channel wins; nothing at all means release`,
    ignore: !JINJA_PYTHON,
    fn: async () => {
      const source = await Deno.readTextFile(template);
      assertEquals(
        channelLine(
          await render(source, {
            ...base,
            [FACT]: "canary",
            turbopanel_update_channel: "release",
          }),
        ),
        "TURBOPANEL_UPDATE_CHANNEL=release",
      );
      assertEquals(
        channelLine(await render(source, { ...base, [FACT]: "" })),
        "TURBOPANEL_UPDATE_CHANNEL=release",
      );
      assertEquals(
        channelLine(await render(source, base)),
        "TURBOPANEL_UPDATE_CHANNEL=release",
      );
    },
  });
}

test("instance-install sets no play-level channel that would hide the installed one", async () => {
  const play = await Deno.readTextFile(INSTALL_PLAY);
  const sets = play.split("\n").some((line) =>
    line.trimStart().startsWith("turbopanel_update_channel:")
  );
  assertEquals(sets, false);
});
