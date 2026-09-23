import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const helperPath = join(here, "../../orchestration/scripts/tp-orchestrate");

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) throw new TypeError(`missing ${name} in tp-orchestrate`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new TypeError(`unclosed ${name} in tp-orchestrate`);
  return source.slice(start, end + 2);
}

/**
 * Stand up a fake install root (`<root>/share/orchestration/{playbooks,…}`,
 * `<root>/vendor/ansible/current/bin/ansible-playbook`) whose
 * ansible-playbook records its argv and environment, then drive the helper's
 * `playbook` verb with the root and scratch checks stubbed out (they need
 * uid 0 — the sudoers rule, not this test, guarantees that).
 */
async function runPlaybookVerb(
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  const source = await Deno.readTextFile(helperPath);
  const root = await Deno.makeTempDir({ prefix: "tp-orchestrate-" });
  try {
    const orch = join(root, "share", "orchestration");
    await Deno.mkdir(join(orch, "playbooks"), { recursive: true });
    await Deno.mkdir(join(orch, "roles"), { recursive: true });
    await Deno.writeTextFile(join(orch, "ansible.cfg"), "[defaults]\n");
    await Deno.writeTextFile(
      join(orch, "playbooks", "daemon-converge.yml"),
      "---\n",
    );
    await Deno.writeTextFile(join(root, "outside.yml"), "---\n");
    await Deno.symlink(
      join(root, "outside.yml"),
      join(orch, "playbooks", "linked.yml"),
    );
    const bin = join(root, "vendor", "ansible", "current", "bin");
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(
      join(bin, "ansible-playbook"),
      [
        "#!/bin/sh",
        "printf 'ARGV'; for a in \"$@\"; do printf ' [%s]' \"$a\"; done; printf '\\n'",
        'printf \'ENV ANSIBLE_CONFIG=%s ANSIBLE_ROLES_PATH=%s ANSIBLE_HOME=%s\\n\' "$ANSIBLE_CONFIG" "$ANSIBLE_ROLES_PATH" "$ANSIBLE_HOME"',
        "printf 'CWD %s\\n' \"$(pwd -P)\"",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const script = [
      "set -eu",
      "tp_die() { printf 'tp-orchestrate: %s\\n' \"$1\" >&2; exit 1; }",
      `ORCH_DIR="${orch}"`,
      `INSTALL_ROOT="${root}"`,
      `VENDOR_DIR="${root}/vendor"`,
      `PLAYBOOKS_DIR="${orch}/playbooks"`,
      `GALAXY_ROLES_DIR="${root}/vendor/ansible/galaxy-roles"`,
      `ANSIBLE_PLAYBOOK_BIN="${bin}/ansible-playbook"`,
      `ROOT_SCRATCH="${root}/scratch"`,
      'tp_require_root_scratch() { mkdir -p "$ROOT_SCRATCH"; }',
      extractShellFunction(source, "tp_export_runtime_env"),
      extractShellFunction(source, "tp_valid_extra_var"),
      extractShellFunction(source, "tp_verb_playbook"),
      'tp_verb_playbook "$@"',
    ].join("\n");
    const out = await new Deno.Command("sh", {
      args: ["-c", script, "sh", ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("tp-orchestrate runs a shipped playbook by basename with fixed inventory, env and cwd", async () => {
  const result = await runPlaybookVerb([
    "-i",
    "localhost,",
    "-c",
    "local",
    "-e",
    "turbopanel_after_instance_service=true",
    "-e",
    "postgres_expose_port=5432",
    // The daemon passes its absolute constant; only the basename survives.
    "/opt/turbopanel/share/orchestration/playbooks/daemon-converge.yml",
  ]);
  assertEquals(result.status, 0, result.stderr);
  const argv = result.stdout.split("\n").find((l) => l.startsWith("ARGV")) ??
    "";
  assertStringIncludes(argv, "[-i] [localhost,] [-c] [local]");
  assertStringIncludes(argv, "[-e] [turbopanel_after_instance_service=true]");
  assertStringIncludes(argv, "[-e] [postgres_expose_port=5432]");
  assertStringIncludes(
    argv,
    "share/orchestration/playbooks/daemon-converge.yml]",
  );
  assertEquals(argv.includes("/opt/turbopanel/"), false);
  const env = result.stdout.split("\n").find((l) => l.startsWith("ENV")) ?? "";
  assertStringIncludes(env, "share/orchestration/ansible.cfg");
  assertStringIncludes(env, "ANSIBLE_HOME=");
  assertStringIncludes(env, "/scratch/home");
});

test("tp-orchestrate refuses playbooks outside the shipped tree, symlinks and traversal", async () => {
  for (
    const [name, needle] of [
      ["/etc/evil.yml", "no such shipped playbook"],
      ["../outside.yml", "no such shipped playbook"],
      ["linked.yml", "symlinked"],
      ["daemon-converge.yaml", ".yml file name"],
    ] as const
  ) {
    const result = await runPlaybookVerb([
      "-i",
      "localhost,",
      "-c",
      "local",
      name,
    ]);
    assertEquals(result.status, 1, name);
    assertStringIncludes(result.stderr, needle);
  }
});

test("tp-orchestrate refuses anything but key=value extra-vars and the fixed local inventory", async () => {
  const base = ["-i", "localhost,", "-c", "local"];
  const cases: Array<[string[], string]> = [
    [[...base, "-e", '{"a":1}', "daemon-converge.yml"], "key=value only"],
    [
      [...base, "-e", "@/tmp/vars.yml", "daemon-converge.yml"],
      "key=value only",
    ],
    [[...base, "-e", "Turbo=1", "daemon-converge.yml"], "key=value only"],
    [[...base, "--become", "daemon-converge.yml"], "refusing option"],
    [[...base, "-vvv", "daemon-converge.yml"], "refusing option"],
    [["-i", "evil,", "-c", "local", "daemon-converge.yml"], "localhost,"],
    [["-i", "localhost,", "-c", "ssh", "daemon-converge.yml"], "-c local"],
    [["-c", "local", "daemon-converge.yml"], "missing -i"],
    [[...base], "missing playbook"],
    [[...base, "daemon-converge.yml", "daemon-converge.yml"], "exactly one"],
  ];
  for (const [args, needle] of cases) {
    const result = await runPlaybookVerb(args);
    assertEquals(result.status, 1, args.join(" "));
    assertStringIncludes(result.stderr, needle);
  }
});

test("tp-orchestrate insists on root and a root-owned scratch directory", async () => {
  const source = await Deno.readTextFile(helperPath);
  assertStringIncludes(source, '[ "$(id -u)" = "0" ] || tp_die');
  const scratch = extractShellFunction(source, "tp_require_root_scratch");
  assertStringIncludes(scratch, "is a symlink; refusing");
  assertStringIncludes(scratch, "is not root-owned; refusing");
  // Ansible's temp and home never point at a daemon-writable directory.
  const env = extractShellFunction(source, "tp_export_runtime_env");
  assertStringIncludes(env, 'ANSIBLE_HOME="$ROOT_SCRATCH/home"');
  assertStringIncludes(env, 'ANSIBLE_LOCAL_TEMP="$ROOT_SCRATCH/local-tmp"');
  assertEquals(env.includes("uv/cache"), false);
});

// --- update verb: root-pinned origin ---------------------------------------

/**
 * Drive `update` with a fake `curl` (records its argv, writes a run.sh that
 * echoes its own argv) against an optional root-pinned origin file.
 */
async function runUpdateVerb(
  args: string[],
  pin: string | null,
  verb: "tp_verb_update" | "tp_verb_update_instance" = "tp_verb_update",
): Promise<{ status: number; stdout: string; stderr: string }> {
  const source = await Deno.readTextFile(helperPath);
  const root = await Deno.makeTempDir({ prefix: "tp-orchestrate-update-" });
  try {
    await Deno.mkdir(join(root, "lib"), { recursive: true });
    if (pin !== null) {
      await Deno.writeTextFile(join(root, "lib", "update-origin"), pin);
    }
    const fakeCurl = [
      "curl() {",
      "  printf 'CURL'; for a in \"$@\"; do printf ' [%s]' \"$a\"; done; printf '\\n'",
      '  _out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && _out="$2"; shift; done',
      "  cat > \"$_out\" <<'FAKE'",
      "#!/bin/sh",
      "printf 'RUNSH'; for a in \"$@\"; do printf ' [%s]' \"$a\"; done; printf '\\n'",
      "FAKE",
      "}",
    ].join("\n");
    const script = [
      "set -eu",
      "tp_die() { printf 'tp-orchestrate: %s\\n' \"$1\" >&2; exit 1; }",
      `INSTALL_ROOT="${root}"`,
      `ROOT_SCRATCH="${root}/scratch"`,
      `UPDATE_ORIGIN_PIN="${root}/lib/update-origin"`,
      'CANONICAL_INSTANCE_CA="/etc/turbopanel/instance-ca.pem"',
      'CDN_RUN_SCRIPT="https://turbopanel.sh"',
      'MANIFEST_URL_PREFIX_CDN="https://dl.trbp.nl/channels/"',
      'MANIFEST_URL_PREFIX_GITHUB="https://github.com/TurboPanel/turbopaneld/releases/download/"',
      'MANIFEST_URL_PREFIX_GITHUB_INSTANCE="https://github.com/TurboPanel/turbopanel/releases/download/"',
      'MANIFEST_URL_PREFIX_GITHUB_UI="https://github.com/TurboPanel/ui/releases/download/"',
      'tp_require_root_scratch() { mkdir -p "$ROOT_SCRATCH"; }',
      // The pin ownership check needs uid 0; the file is ours here.
      'stat() { if [ "$1" = -c ] && [ "$2" = %u ]; then echo 0; else command stat "$@"; fi; }',
      fakeCurl,
      extractShellFunction(source, "tp_valid_url"),
      extractShellFunction(source, "tp_pin_field"),
      extractShellFunction(source, "tp_read_update_origin_pin"),
      extractShellFunction(source, "tp_manifest_url_allowed"),
      extractShellFunction(source, "tp_ui_manifest_url_allowed"),
      extractShellFunction(source, "tp_fetch_pinned_run_script"),
      extractShellFunction(source, "tp_verb_update"),
      extractShellFunction(source, "tp_verb_update_instance"),
      `${verb} "$@"`,
    ].join("\n");
    const out = await new Deno.Command("sh", {
      args: ["-c", script, "sh", ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const PUBLIC_PIN = "host=https://panel.example.com\ndl_base=\ninstance_ca=\n";
const OVERLAY_PIN =
  "host=https://huey.lan:8443\ndl_base=https://huey.lan:8443/downloads\ninstance_ca=/etc/turbopanel/instance-ca.pem\n";

test("tp-orchestrate update fetches run.sh from the CDN for a public control plane and passes the pinned host", async () => {
  const result = await runUpdateVerb(
    ["--license", "abc", "--channel", "release", "--no-start"],
    PUBLIC_PIN,
  );
  assertEquals(result.status, 0, result.stderr);
  assertStringIncludes(result.stdout, "[https://turbopanel.sh]");
  assertStringIncludes(
    result.stdout,
    "RUNSH [--license] [abc] [--host] [https://panel.example.com] [--channel] [release] [--no-start]",
  );
  assertEquals(result.stdout.includes("[-k]"), false);
});

test("tp-orchestrate update refuses without a root-pinned origin", async () => {
  const result = await runUpdateVerb(["--license", "abc", "--no-start"], null);
  assertEquals(result.status, 1);
  assertStringIncludes(result.stderr, "update origin pin missing");
});

test("tp-orchestrate update refuses origins that differ from the pin", async () => {
  const cases: Array<[string[], string]> = [
    [["--host", "https://attacker.example"], "enrolled with"],
    [
      ["--dl-base", "https://attacker.example/dl"],
      "not installed from an overlay",
    ],
    [
      ["--instance-ca", "/etc/turbopanel/instance-ca.pem"],
      "no Platform CA is pinned",
    ],
    [
      ["--instance-ca", "/tmp/evil.pem"],
      "must be /etc/turbopanel/instance-ca.pem",
    ],
    [["--insecure-tls"], "refusing update flag --insecure-tls"],
    [
      ["--manifest-url", "https://attacker.example/manifest.json"],
      "not a TurboPanel release rail",
    ],
    [["--channel", "nightly"], "refusing --channel"],
  ];
  for (const [extra, needle] of cases) {
    const result = await runUpdateVerb(
      ["--license", "abc", ...extra, "--no-start"],
      PUBLIC_PIN,
    );
    assertEquals(result.status, 1, extra.join(" "));
    assertStringIncludes(result.stderr, needle);
  }
});

test("tp-orchestrate update uses the pinned overlay host with the pinned Platform CA, never -k", async () => {
  const result = await runUpdateVerb(
    [
      "--license",
      "abc",
      "--host",
      "https://huey.lan:8443",
      "--dl-base",
      "https://huey.lan:8443/downloads",
      "--no-start",
    ],
    OVERLAY_PIN,
  );
  // The pinned CA file does not exist on this test host: fail closed.
  assertEquals(result.status, 1);
  assertStringIncludes(result.stderr, "Platform CA missing");
  assertEquals(result.stdout.includes("[-k]"), false);
});

test("tp-orchestrate update accepts the release rails as manifest pins", async () => {
  for (
    const url of [
      "https://dl.trbp.nl/channels/trunk/manifest.json",
      "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0/manifest.json",
      "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.0/manifest.json",
      "https://github.com/TurboPanel/ui/releases/download/v0.1.0/manifest.json",
    ]
  ) {
    const result = await runUpdateVerb(
      ["--license", "abc", "--manifest-url", url, "--no-start"],
      PUBLIC_PIN,
    );
    assertEquals(result.status, 0, result.stderr);
    assertStringIncludes(result.stdout, `[--manifest-url] [${url}]`);
  }
});

test("tp-orchestrate update-instance reconciles run.sh --instance without daemon enrolment flags", async () => {
  const result = await runUpdateVerb(
    ["--channel", "release", "--no-start"],
    PUBLIC_PIN,
    "tp_verb_update_instance",
  );
  assertEquals(result.status, 0, result.stderr);
  assertStringIncludes(result.stdout, "[https://turbopanel.sh]");
  assertStringIncludes(
    result.stdout,
    "RUNSH [--instance] [--channel] [release] [--no-start]",
  );
  assertEquals(result.stdout.includes("[--license]"), false);
  assertEquals(result.stdout.includes("[--host]"), false);
  assertEquals(result.stdout.includes("[--dl-base]"), false);
  assertEquals(result.stdout.includes("[--instance-ca]"), false);
  assertEquals(result.stdout.includes("[-k]"), false);
});

test("tp-orchestrate update-instance maps a control-plane pin onto --instance-manifest-url", async () => {
  const url =
    "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json";
  const result = await runUpdateVerb(
    ["--channel", "rc", "--manifest-url", url, "--no-start"],
    PUBLIC_PIN,
    "tp_verb_update_instance",
  );
  assertEquals(result.status, 0, result.stderr);
  assertStringIncludes(
    result.stdout,
    `RUNSH [--instance] [--channel] [rc] [--instance-manifest-url] [${url}] [--no-start]`,
  );
  assertEquals(result.stdout.includes("[--manifest-url]"), false);
});

test("tp-orchestrate update-instance forwards a UI pin and refuses other rails", async () => {
  const instanceUrl =
    "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json";
  const uiUrl =
    "https://github.com/TurboPanel/ui/releases/download/v0.1.1/manifest.json";
  const result = await runUpdateVerb(
    [
      "--channel",
      "release",
      "--manifest-url",
      instanceUrl,
      "--ui-manifest-url",
      uiUrl,
      "--no-start",
    ],
    PUBLIC_PIN,
    "tp_verb_update_instance",
  );
  assertEquals(result.status, 0, result.stderr);
  assertStringIncludes(
    result.stdout,
    `RUNSH [--instance] [--channel] [release] [--instance-manifest-url] [${instanceUrl}] [--ui-manifest-url] [${uiUrl}] [--no-start]`,
  );

  for (
    const refused of [
      "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
      "https://dl.trbp.nl/channels/release/manifest.json",
    ]
  ) {
    const denied = await runUpdateVerb(
      [
        "--channel",
        "release",
        "--ui-manifest-url",
        refused,
        "--no-start",
      ],
      PUBLIC_PIN,
      "tp_verb_update_instance",
    );
    assertEquals(denied.status, 1, refused);
    assertStringIncludes(denied.stderr, "not the UI release rail");
  }
});

test("tp-orchestrate update-instance refuses trunk, missing flags, and daemon enrolment flags", async () => {
  const cases: Array<[string[], string]> = [
    [["--no-start"], "update-instance requires --channel"],
    [["--channel", "release"], "requires --no-start"],
    [
      ["--channel", "trunk", "--no-start"],
      "--instance needs --channel canary, rc or release",
    ],
    [["--channel", "nightly", "--no-start"], "refusing --channel"],
    [
      ["--channel", "release", "--license", "abc", "--no-start"],
      "refusing update-instance flag --license",
    ],
    [
      ["--channel", "release", "--insecure-tls", "--no-start"],
      "refusing update-instance flag --insecure-tls",
    ],
    [
      [
        "--channel",
        "release",
        "--manifest-url",
        "https://attacker.example/manifest.json",
        "--no-start",
      ],
      "not a TurboPanel release rail",
    ],
  ];
  for (const [args, needle] of cases) {
    const result = await runUpdateVerb(
      args,
      PUBLIC_PIN,
      "tp_verb_update_instance",
    );
    assertEquals(result.status, 1, args.join(" "));
    assertStringIncludes(result.stderr, needle);
  }
  const missing = await runUpdateVerb(
    ["--channel", "release", "--no-start"],
    null,
    "tp_verb_update_instance",
  );
  assertEquals(missing.status, 1);
  assertStringIncludes(missing.stderr, "update origin pin missing");
});
