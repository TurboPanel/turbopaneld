import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * What `daemon.env` holds after each run of run.sh, across the reruns a host
 * really sees: a fresh enrolment, the daemon's own managed updates (which
 * pass `--manifest-url`), and the co-located `--daemon-only` refresh on a
 * self-hosted control-plane host, with and without a license or a pin.
 *
 * Each step runs run.sh's own vars-file code (the `{ printf … } > vars`
 * blocks, not a copy) and renders `daemon.env` from
 * roles/daemon-config/templates/dotenv.j2 with Ansible's precedence: role
 * defaults, then the playbook's `vars:`, then the vars file (`-e @file`).
 */
const here = dirname(fromFileUrl(import.meta.url));
const repo = join(here, "../..");
const RUN_SH = join(repo, "scripts/run.sh");
const ORCHESTRATION = join(repo, "orchestration");

const CANARY_PIN =
  "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest-0.1.1-canary.20260927-193059-fc561fc.json";
const HOST_URL = "https://panel.example.com";

// --- run.sh's vars-file blocks ----------------------------------------------

/** The `{ … } > "$var"` group in `source` that contains `marker`. */
function varsBlock(source: string, marker: string, target: string): string {
  const at = source.indexOf(marker);
  assert(at >= 0, `run.sh no longer has ${marker}`);
  const open = [...source.slice(0, at).matchAll(/\n[ \t]*\{\n/g)].at(-1);
  const close = `} > "${target}"`;
  const end = source.indexOf(close, at);
  assert(open !== undefined && end > at, `no vars block around ${marker}`);
  return source.slice(open.index + 1, end + close.length);
}

function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  assert(start >= 0, `run.sh no longer defines ${name}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start + 1, end + 2);
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

async function sh(
  script: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("sh", {
    args: ["-c", script],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** The layout run.sh's blocks read, as shell assignments. */
function layoutAssignments(root: string): string {
  const vars: Record<string, string> = {
    INSTALL_ROOT: join(root, "opt/turbopanel"),
    RUNTIMES_DIR: join(root, "opt/turbopanel/vendor"),
    ORCHESTRATION_DIR: join(root, "opt/turbopanel/share/orchestration"),
    CONFIG_DIR: join(root, "etc/turbopanel"),
    STATE_DIR: join(root, "var/lib/turbopanel"),
    ENV_FILE: join(root, "etc/turbopanel/daemon.env"),
    CA_PATH: join(root, "etc/turbopanel/instance-ca.pem"),
    DENO_BIN: join(root, "opt/turbopanel/vendor/deno/current/deno"),
    DAEMON_EXEC_MODE: "native",
    TP_EXEC_MODE_NATIVE: "native",
    NO_START: "true",
  };
  return Object.entries(vars).map(([k, v]) => `${k}=${quote(v)}`).join("\n");
}

const STUBS = `
tp_daemon_binary_path() { printf '%s/bin/turbopaneld' "$INSTALL_ROOT"; }
tp_daemon_js_fallback_path() { printf '%s/bin/turbopaneld.js' "$INSTALL_ROOT"; }
tp_print_step() { :; }
tp_print_ok() { :; }
tp_print_error() { printf '%s\\n' "$1" >&2; }
`;

type RunOptions = {
  channel?: string;
  manifestUrl?: string;
  license?: string;
};

/** The vars file run.sh hands daemon-install.yml on a remote managed node. */
async function remoteInstallVars(
  root: string,
  options: RunOptions,
): Promise<string> {
  const source = await Deno.readTextFile(RUN_SH);
  const block = varsBlock(
    source,
    "printf 'turbopanel_instance_url: %s\\n' \"$HOST_URL\"",
    "$VARS_FILE",
  );
  const script = [
    "set -eu",
    STUBS,
    layoutAssignments(root),
    `HOST_URL=${quote(HOST_URL)}`,
    `MANIFEST_URL=${quote(options.manifestUrl ?? "")}`,
    "INSTANCE_MANIFEST_URL=''",
    "UI_MANIFEST_URL=''",
    "DL_BASE=''",
    "TUNNEL_TOKEN=''",
    options.channel === undefined
      ? "unset TURBOPANEL_UPDATE_CHANNEL"
      : `TURBOPANEL_UPDATE_CHANNEL=${quote(options.channel)}`,
    'VARS_FILE="$(mktemp)"',
    block,
    'cat "$VARS_FILE"; rm -f "$VARS_FILE"',
  ].join("\n");
  const result = await sh(script);
  assertEquals(result.code, 0, result.stderr);
  return result.stdout;
}

/** The vars file run.sh hands instance-install.yml (a control-plane install). */
async function instanceInstallVars(
  root: string,
  options: RunOptions,
): Promise<string> {
  const source = await Deno.readTextFile(RUN_SH);
  const block = varsBlock(
    source,
    "printf 'instance_start: %s\\n'",
    "$_vars",
  );
  const script = [
    "set -eu",
    STUBS,
    layoutAssignments(root),
    options.channel === undefined
      ? "unset TURBOPANEL_UPDATE_CHANNEL"
      : `TURBOPANEL_UPDATE_CHANNEL=${quote(options.channel)}`,
    '_vars="$(mktemp)"',
    block,
    'cat "$_vars"; rm -f "$_vars"',
  ].join("\n");
  const result = await sh(script);
  assertEquals(result.code, 0, result.stderr);
  return result.stdout;
}

/**
 * The vars file `tp_run_colocated_daemon_refresh` hands
 * daemon-colocated-refresh.yml, reading the host's current daemon.env.
 */
async function colocatedRefreshVars(
  root: string,
  options: RunOptions,
): Promise<string> {
  const source = await Deno.readTextFile(RUN_SH);
  const captured = join(root, "captured-vars.yml");
  const installer = join(root, "opt/turbopanel/bin/turbopaneld");
  await Deno.mkdir(dirname(installer), { recursive: true });
  await Deno.writeTextFile(
    installer,
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = --vars-file ]; then cp "$2" ${
      quote(captured)
    }; fi\n  shift\ndone\n`,
  );
  await Deno.chmod(installer, 0o755);
  const script = [
    "set -eu",
    shellFunction(source, "tp_daemon_env_value"),
    shellFunction(source, "tp_run_colocated_daemon_refresh"),
    STUBS,
    layoutAssignments(root),
    `MANIFEST_URL=${quote(options.manifestUrl ?? "")}`,
    options.channel === undefined
      ? "unset TURBOPANEL_UPDATE_CHANNEL"
      : `TURBOPANEL_UPDATE_CHANNEL=${quote(options.channel)}`,
    // Its scratch cleanup names shared paths; keep the test to its own tree.
    "rm() { :; }",
    "tp_run_colocated_daemon_refresh",
  ].join("\n");
  const result = await sh(script, {
    HOME: root,
    PATH: "/usr/bin:/bin",
    TMPDIR: root,
  });
  assertEquals(result.code, 0, result.stderr);
  return await Deno.readTextFile(captured);
}

// --- daemon.env rendering ---------------------------------------------------

/**
 * Ansible's precedence for the daemon-config role's `dotenv.j2`: role
 * defaults < the play's `vars:` < `-e @vars-file`, with templated values
 * resolved against the merged set.
 */
const RENDER_PY = String.raw`
import json, os, sys
import jinja2, yaml

def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("yes", "on", "1", "true", "y", "t")

req = json.load(sys.stdin)
env = jinja2.Environment(trim_blocks=True, keep_trailing_newline=True,
                         undefined=jinja2.StrictUndefined)
env.filters["bool"] = to_bool
merged = {}
merged.update(yaml.safe_load(open(req["defaults"])) or {})
merged.update(yaml.safe_load(open(req["playbook"]))[0].get("vars") or {})
merged.update(yaml.safe_load(req["extra"]) or {})
for _ in range(5):
    for key, value in list(merged.items()):
        if isinstance(value, str) and "{{" in value:
            merged[key] = env.from_string(value).render(**merged)
template = env.from_string(open(req["template"]).read())
print(template.render(**merged), end="")
`;

async function findYamlJinjaPython(): Promise<string | undefined> {
  const candidates = [
    Deno.env.get("TURBOPANEL_JINJA_PYTHON"),
    "/opt/turbopanel/vendor/ansible/current/bin/python3",
    "python3",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const candidate of candidates) {
    try {
      const { success } = await new Deno.Command(candidate, {
        args: ["-c", "import jinja2, yaml"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (success) return candidate;
    } catch {
      // not installed
    }
  }
  return undefined;
}

const PYTHON = await findYamlJinjaPython();
const RENDER_REQUIRED = Deno.env.get("CI") === "true";

type Playbook =
  | "daemon-install.yml"
  | "instance-install.yml"
  | "daemon-colocated-refresh.yml";

async function renderDaemonEnv(
  playbook: Playbook,
  extra: string,
): Promise<Map<string, string>> {
  assert(PYTHON, "no Python with jinja2 and PyYAML to render daemon.env");
  const child = new Deno.Command(PYTHON, {
    args: ["-c", RENDER_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({
      defaults: join(ORCHESTRATION, "roles/daemon-config/defaults/main.yml"),
      playbook: join(ORCHESTRATION, "playbooks", playbook),
      template: join(ORCHESTRATION, "roles/daemon-config/templates/dotenv.j2"),
      extra,
    })),
  );
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, `render failed: ${new TextDecoder().decode(stderr)}`);
  const values = new Map<string, string>();
  for (const line of new TextDecoder().decode(stdout).split("\n")) {
    if (line.trim() === "") continue;
    const eq = line.indexOf("=");
    assert(eq > 0, `daemon.env line is not KEY=value: ${line}`);
    const key = line.slice(0, eq);
    assert(!values.has(key), `daemon.env sets ${key} twice`);
    values.set(key, line.slice(eq + 1));
  }
  return values;
}

async function writeEnv(root: string, values: Map<string, string>) {
  const path = join(root, "etc/turbopanel/daemon.env");
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    [...values].map(([k, v]) => `${k}=${v}\n`).join(""),
  );
}

/** Keys every daemon.env carries; anything else must be asked for. */
const BASE_KEYS = [
  "TURBOPANEL_RUNTIMES_DIR",
  "TURBOPANEL_ORCHESTRATION_DIR",
  "TURBOPANEL_CONFIG_DIR",
  "TURBOPANEL_STATE_DIR",
  "TURBOPANEL_DAEMON_STATE_DIR",
  "TURBOPANEL_SERVICE_NAME",
  "TURBOPANEL_UPDATE_CHANNEL",
];

function assertKeys(values: Map<string, string>, extra: string[]) {
  assertEquals([...values.keys()].sort(), [...BASE_KEYS, ...extra].sort());
}

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "tp-daemon-env-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// --- the reruns -------------------------------------------------------------

test({
  name:
    "a Python with jinja2 and PyYAML is available where daemon.env must render",
  ignore: !RENDER_REQUIRED,
  fn: () => {
    assert(PYTHON, "CI must provide jinja2 + PyYAML (the Ansible toolchain)");
  },
});

test({
  name:
    "remote node: enrol on canary, then the daemon's own updates keep the channel",
  ignore: !PYTHON,
  fn: () =>
    withRoot(async (root) => {
      const enrolled = await renderDaemonEnv(
        "daemon-install.yml",
        await remoteInstallVars(root, { channel: "canary" }),
      );
      assertKeys(enrolled, ["TURBOPANEL_INSTANCE_URL"]);
      assertEquals(enrolled.get("TURBOPANEL_UPDATE_CHANNEL"), "canary");
      assertEquals(enrolled.get("TURBOPANEL_INSTANCE_URL"), HOST_URL);

      // tp-orchestrate update: the daemon always names its channel.
      const updatedAgain = await renderDaemonEnv(
        "daemon-install.yml",
        await remoteInstallVars(root, { channel: "canary" }),
      );
      assertEquals(updatedAgain, enrolled);
    }),
});

test({
  name:
    "remote node: a managed update's --manifest-url is written to daemon.env as a pin (KNOWN BUG, see turbopanel#51)",
  ignore: !PYTHON,
  fn: () =>
    withRoot(async (root) => {
      const updated = await renderDaemonEnv(
        "daemon-install.yml",
        await remoteInstallVars(root, {
          channel: "canary",
          manifestUrl: CANARY_PIN,
        }),
      );
      assertEquals(updated.get("TURBOPANEL_UPDATE_CHANNEL"), "canary");
      // The daemon hands run.sh the exact build it resolved; run.sh keeps it
      // as a pin, and the next update re-sends the pin it reads back. When
      // this is fixed the pin is gone: flip this to assert its absence.
      assertEquals(
        updated.get("TURBOPANEL_MANIFEST_URL"),
        CANARY_PIN,
        "fixed? assert there is no TURBOPANEL_MANIFEST_URL here instead",
      );

      // A later update without the pin clears it again.
      const next = await renderDaemonEnv(
        "daemon-install.yml",
        await remoteInstallVars(root, { channel: "canary" }),
      );
      assertKeys(next, ["TURBOPANEL_INSTANCE_URL"]);
      assertEquals(next.get("TURBOPANEL_UPDATE_CHANNEL"), "canary");
    }),
});

test({
  name:
    "self-hosted: --daemon-only refreshes keep socket mode and the install's channel",
  ignore: !PYTHON,
  fn: () =>
    withRoot(async (root) => {
      const installed = await renderDaemonEnv(
        "instance-install.yml",
        await instanceInstallVars(root, { channel: "canary" }),
      );
      assertKeys(installed, []);
      assertEquals(installed.get("TURBOPANEL_UPDATE_CHANNEL"), "canary");
      await writeEnv(root, installed);

      // No channel named (a hand-run refresh): daemon.env's channel holds.
      const refreshed = await renderDaemonEnv(
        "daemon-colocated-refresh.yml",
        await colocatedRefreshVars(root, {}),
      );
      assertEquals(refreshed, installed);
      await writeEnv(root, refreshed);

      // The daemon's own update names the channel; nothing else changes.
      const updated = await renderDaemonEnv(
        "daemon-colocated-refresh.yml",
        await colocatedRefreshVars(root, { channel: "canary" }),
      );
      assertEquals(updated, installed);
      await writeEnv(root, updated);

      // A pinned refresh pins (the operator asked); the next plain one clears.
      const pinned = await renderDaemonEnv(
        "daemon-colocated-refresh.yml",
        await colocatedRefreshVars(root, { manifestUrl: CANARY_PIN }),
      );
      assertKeys(pinned, ["TURBOPANEL_MANIFEST_URL"]);
      assertEquals(pinned.get("TURBOPANEL_UPDATE_CHANNEL"), "canary");
      await writeEnv(root, pinned);
      const unpinned = await renderDaemonEnv(
        "daemon-colocated-refresh.yml",
        await colocatedRefreshVars(root, {}),
      );
      assertEquals(unpinned, installed);
    }),
});

test({
  name:
    "self-hosted: an instance install with no channel defaults to release, and a refresh keeps it",
  ignore: !PYTHON,
  fn: () =>
    withRoot(async (root) => {
      const installed = await renderDaemonEnv(
        "instance-install.yml",
        await instanceInstallVars(root, {}),
      );
      assertEquals(installed.get("TURBOPANEL_UPDATE_CHANNEL"), "release");
      await writeEnv(root, installed);
      const refreshed = await renderDaemonEnv(
        "daemon-colocated-refresh.yml",
        await colocatedRefreshVars(root, {}),
      );
      assertEquals(refreshed.get("TURBOPANEL_UPDATE_CHANNEL"), "release");
    }),
});

// --- run.sh's argument gate for --daemon-only -------------------------------

/**
 * Runs the real run.sh as a non-root user with a `sudo` that always fails:
 * argument checks run first, so a run that gets as far as the privilege
 * check accepted its arguments.
 */
async function argumentGate(
  root: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  const bin = join(root, "fakebin");
  await Deno.mkdir(bin, { recursive: true });
  await Deno.writeTextFile(join(bin, "sudo"), "#!/bin/sh\nexit 1\n");
  await Deno.chmod(join(bin, "sudo"), 0o755);
  const out = await new Deno.Command("sh", {
    args: [RUN_SH, ...args],
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      INSTALL_ROOT: join(root, "opt/turbopanel"),
      ENV_FILE: join(root, "etc/turbopanel/daemon.env"),
      TURBOPANEL_STATE_DIR: join(root, "var/lib/turbopanel"),
      ...env,
    },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

const PRIVILEGE_STEP = "sudo validation failed";

test({
  name:
    "--daemon-only on a self-hosted control-plane host needs no license or pin",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withRoot(async (root) => {
      if (Deno.uid() === 0) return; // root skips the privilege step entirely
      await Deno.mkdir(join(root, "opt/turbopanel/bin"), { recursive: true });
      await Deno.writeTextFile(join(root, "opt/turbopanel/bin/turbopanel"), "");
      await Deno.mkdir(join(root, "etc/turbopanel"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "etc/turbopanel/daemon.env"),
        "TURBOPANEL_UPDATE_CHANNEL=canary\n",
      );
      const output = await argumentGate(root, ["--daemon-only"], {});
      assertStringIncludes(output, PRIVILEGE_STEP);
    }),
});

test({
  name: "--daemon-only on a remote node still needs a pin and a license",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withRoot(async (root) => {
      if (Deno.uid() === 0) return;
      await Deno.mkdir(join(root, "etc/turbopanel"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "etc/turbopanel/daemon.env"),
        `TURBOPANEL_INSTANCE_URL=${HOST_URL}\nTURBOPANEL_UPDATE_CHANNEL=canary\n`,
      );
      const noPin = await argumentGate(root, ["--daemon-only"], {});
      assertStringIncludes(
        noPin,
        "--daemon-only requires a pinned https manifest",
      );
      const noLicense = await argumentGate(root, [
        "--daemon-only",
        "--manifest-url",
        CANARY_PIN,
      ], {});
      assertStringIncludes(noLicense, "--daemon-only needs TURBOPANEL_LICENSE");
    }),
});
