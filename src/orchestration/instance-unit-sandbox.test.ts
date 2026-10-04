import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";
import { DAEMON_DENY_NET } from "../permissions/daemon-permissions.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The instance unit's systemd sandbox (audit finding M12).
 *
 * Why the set is what it is. The instance runs as `tpctrl` and still execs
 * `sudo` (host-credential login: `sudo -n pamtester`; managed upgrades:
 * `sudo systemctl restart`; see `upgrade-sudoers.yml`), so:
 * - `NoNewPrivileges` must stay off: sudo is setuid and refuses to run under
 *   it. Everything else below is implemented by the service manager (mount
 *   namespace, seccomp applied while it is still root), so none of it needs
 *   NoNewPrivileges.
 * - `SystemCallFilter` and a positive `CapabilityBoundingSet` stay off:
 *   the root children of sudo need setuid/setgid/audit/resource caps and are
 *   not proven under a filter. The bounding set only *removes* capabilities
 *   nothing here uses.
 * - `MemoryDenyWriteExecute` cannot be used (V8 JIT).
 * - Only the compiled production instance is sandboxed: co-located dev runs
 *   from a source checkout under the dev user's home.
 *
 * `/tmp`: Deno 2.9.x extracts the embedded DuckDB addon to
 * `/tmp/deno-native-addons/` and checks FFI against the virtual
 * `/tmp/deno-compile-<binary>/…` path; both only need a writable /tmp, which
 * PrivateTmp provides (fresh per start).
 */
const TEMPLATE = join(
  DAEMON_ROOT,
  "orchestration/roles/instance-launch/templates/turbopanel-instance.service.j2",
);
const UPGRADE_SUDOERS = join(
  DAEMON_ROOT,
  "orchestration/roles/instance-launch/tasks/upgrade-sudoers.yml",
);

const RENDER_PY = String.raw`
import json, os, sys
import jinja2
from jinja2 import meta

def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("yes", "on", "1", "true", "y", "t")

req = json.load(sys.stdin)
env = jinja2.Environment(
    trim_blocks=True,
    lstrip_blocks=False,
    keep_trailing_newline=True,
    undefined=jinja2.StrictUndefined,
)
env.filters["bool"] = to_bool
env.filters["dirname"] = os.path.dirname
env.filters["basename"] = os.path.basename
source = open(req["path"]).read()
names = meta.find_undeclared_variables(env.parse(source))
values = {name: "/placeholder/" + name for name in names}
values.update(req["vars"])
sys.stdout.write(env.from_string(source).render(**values))
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
// CI installs the Ansible toolchain (and with it Jinja2) before the tests run;
// there a missing renderer is a broken gate, not a reason to skip.
const RENDER_REQUIRED = Deno.env.get("CI") === "true";

async function renderUnit(vars: Record<string, unknown>): Promise<string> {
  assert(JINJA_PYTHON, "no Python with jinja2 found to render the unit");
  const child = new Deno.Command(JINJA_PYTHON, {
    args: ["-c", RENDER_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({ path: TEMPLATE, vars })),
  );
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, `render failed: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout);
}

const PROD_VARS = {
  instance_user: "tpctrl",
  turbopanel_group: "tp",
  turbopanel_dev_user: "",
  turbopanel_instance_runtime: "deno",
  turbopanel_instance_run_mode: "compiled",
  turbopanel_ui_mode: "static",
  instance_service_name: "turbopanel-instance",
  turbopanel_instance_binary: "/opt/turbopanel/bin/turbopanel",
  turbopanel_run_dir: "/run/turbopanel",
  turbopanel_daemon_state_dir: "/var/lib/turbopanel",
  turbopanel_metrics_dir: "/var/lib/turbopanel/metrics",
  turbopanel_instance_runtime_dir: "/var/lib/turbopanel/instance/.local",
  turbopanel_instance_config_dir: "/var/lib/turbopanel/instance/.config",
  instance_log_dir: "/var/log/turbopanel/instance",
  turbopanel_duckdb_lib_dir: "/opt/turbopanel/lib",
};

/** `Key=Value` lines of a rendered unit, in order (comments and headers skipped). */
function directives(unit: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of unit.split("\n")) {
    const pair = /^([A-Z][A-Za-z0-9]*)=(.*)$/.exec(raw.trimEnd());
    if (!pair) continue;
    out.set(pair[1], [...(out.get(pair[1]) ?? []), pair[2]]);
  }
  return out;
}

function one(unit: Map<string, string[]>, key: string): string {
  const values = unit.get(key) ?? [];
  assertEquals(values.length, 1, `${key}= must appear exactly once`);
  return values[0];
}

const SANDBOX_DIRECTIVES = [
  "PrivateTmp",
  "PrivateDevices",
  "ProtectSystem",
  "ProtectHome",
  "ProtectKernelTunables",
  "ProtectKernelModules",
  "ProtectKernelLogs",
  "ProtectControlGroups",
  "ProtectClock",
  "ProtectHostname",
  "ReadWritePaths",
  "RestrictAddressFamilies",
  "RestrictNamespaces",
  "RestrictRealtime",
  "RestrictSUIDSGID",
  "LockPersonality",
  "CapabilityBoundingSet",
];

test({
  name: "a Python with jinja2 is available where the instance unit must render",
  ignore: !RENDER_REQUIRED,
  fn: () => {
    assert(JINJA_PYTHON, "CI must provide jinja2 for the unit template tests");
  },
});

test({
  name: "production compiled instance unit carries the systemd sandbox",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    const unit = directives(await renderUnit(PROD_VARS));
    assertEquals(one(unit, "PrivateTmp"), "yes");
    assertEquals(one(unit, "PrivateDevices"), "yes");
    assertEquals(one(unit, "ProtectSystem"), "strict");
    assertEquals(one(unit, "ProtectHome"), "yes");
    for (
      const key of [
        "ProtectKernelTunables",
        "ProtectKernelModules",
        "ProtectKernelLogs",
        "ProtectControlGroups",
        "ProtectClock",
        "ProtectHostname",
        "RestrictNamespaces",
        "RestrictRealtime",
        "RestrictSUIDSGID",
        "LockPersonality",
      ]
    ) {
      assertEquals(one(unit, key), "yes", `${key}=yes`);
    }
    assertEquals(
      one(unit, "RestrictAddressFamilies").split(" ").toSorted(),
      ["AF_INET", "AF_INET6", "AF_NETLINK", "AF_UNIX"],
    );
  },
});

test({
  name:
    "ReadWritePaths covers exactly what the compiled instance writes (socket dir, state, metrics, logs) plus sudo/PAM state",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    const unit = directives(await renderUnit(PROD_VARS));
    const paths = one(unit, "ReadWritePaths").split(" ");
    // Every entry is optional ("-"): a path that does not exist yet must not
    // stop the unit from starting.
    assert(paths.every((path) => path.startsWith("-/")), paths.join(" "));
    const bare = paths.map((path) => path.slice(1));
    for (
      const needed of [
        "/run/turbopanel",
        "/var/lib/turbopanel",
        "/var/lib/turbopanel/metrics",
        "/var/log/turbopanel/instance",
      ]
    ) {
      assert(bare.includes(needed), `ReadWritePaths must include ${needed}`);
    }
    for (const sudoState of ["/run/sudo", "/run/faillock", "/var/lib/sudo"]) {
      assert(bare.includes(sudoState), `${sudoState} (sudo/PAM state)`);
    }
    // Nothing under /etc, /opt, /usr or a home directory is ever writable.
    for (const path of bare) {
      assert(
        !/^\/(etc|opt|usr|home|root|srv|boot)(\/|$)/.test(path),
        `${path} must not be writable`,
      );
    }
  },
});

test({
  name:
    "the sandbox leaves sudo working: no NoNewPrivileges, no syscall filter, no W^X, and the bounding set only removes",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    const unit = directives(await renderUnit(PROD_VARS));
    for (
      const forbidden of [
        "NoNewPrivileges",
        "MemoryDenyWriteExecute",
        "SystemCallFilter",
        "AmbientCapabilities",
        "DynamicUser",
      ]
    ) {
      assertEquals(
        unit.get(forbidden),
        undefined,
        `${forbidden}= would break sudo, V8 or the tpctrl identity`,
      );
    }
    const bounding = one(unit, "CapabilityBoundingSet");
    assert(bounding.startsWith("~"), "bounding set must be a deny-list");
    const removed = bounding.slice(1).split(" ");
    // What sudo and its root children (pamtester, systemctl) need, plus
    // privileged ports for anything the instance might bind.
    for (
      const needed of [
        "CAP_SETUID",
        "CAP_SETGID",
        "CAP_AUDIT_WRITE",
        "CAP_SYS_RESOURCE",
        "CAP_DAC_OVERRIDE",
        "CAP_DAC_READ_SEARCH",
        "CAP_CHOWN",
        "CAP_FOWNER",
        "CAP_SYS_ADMIN",
        "CAP_NET_BIND_SERVICE",
        "CAP_KILL",
      ]
    ) {
      assert(!removed.includes(needed), `${needed} must stay available`);
    }
    assert(removed.length >= 5, "the deny-list must actually remove something");
  },
});

test({
  name:
    "NoNewPrivileges stays off for as long as the upgrade path and host login use sudo",
  fn: async () => {
    const sudoers = await Deno.readTextFile(UPGRADE_SUDOERS);
    assert(
      sudoers.includes("NOPASSWD: /usr/bin/pamtester") &&
        sudoers.includes("NOPASSWD: /usr/bin/systemctl restart"),
      "the instance is still granted sudo for pamtester and service restarts",
    );
    const template = await Deno.readTextFile(TEMPLATE);
    assert(
      !/^NoNewPrivileges=/m.test(template),
      "NoNewPrivileges= breaks the sudo grants above; move them behind the daemon first",
    );
  },
});

test({
  name:
    "dev, source-mode and workers instance units get no sandbox (source checkout lives in $HOME)",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    const variants: Record<string, Record<string, unknown>> = {
      "co-located dev, compiled": {
        ...PROD_VARS,
        turbopanel_dev_user: "dev",
        instance_user: "dev",
      },
      "source mode": { ...PROD_VARS, turbopanel_instance_run_mode: "source" },
      "workers": { ...PROD_VARS, turbopanel_instance_runtime: "workers" },
    };
    for (const [label, vars] of Object.entries(variants)) {
      const unit = directives(await renderUnit(vars));
      for (const key of SANDBOX_DIRECTIVES) {
        assertEquals(
          unit.get(key),
          undefined,
          `${label}: ${key}= must be absent`,
        );
      }
    }
  },
});

test({
  name:
    "source-mode deno-run ExecStart denies the cloud metadata endpoints like the daemon",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    const unit = directives(
      await renderUnit({
        ...PROD_VARS,
        turbopanel_instance_run_mode: "source",
      }),
    );
    const exec = one(unit, "ExecStart");
    assert(/(^|\s)--allow-net(\s|$)/.test(exec), "outbound net stays open");
    assert(
      exec.includes(` --deny-net=${DAEMON_DENY_NET.join(",")} `),
      "deno-run ExecStart must carry the daemon's metadata deny list",
    );
  },
});

test({
  name: "the instance unit keeps its prompt-kill stop timeout",
  fn: async () => {
    const template = await Deno.readTextFile(TEMPLATE);
    assert(/^TimeoutStopSec=10$/m.test(template));
  },
});
