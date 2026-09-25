import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const uninstallPath = join(here, "uninstall.sh");

// uninstall.sh runs its root check and main flow at top level, so these tests
// never source it. They lift the named functions and constants out of the real
// file and run them in a throwaway sh as the current (non-root) user, against
// temp directories only.
const SUPPORT_FUNCTIONS = [
  "tp_log_line",
  "tp_print_step",
  "tp_print_ok",
  "tp_print_error",
  "tp_print_warn",
  "tp_say",
  "tp_record_fail",
  "tp_record_benign_fail",
  "tp_record_skip",
  "tp_run",
  "tp_has_tool",
  "tp_file_add",
  "tp_ws_add",
  "tp_normalize_path",
  "tp_resolve_parent_path",
  "tp_path_in_owned_tree",
  "tp_path_is_safe",
  "tp_note_custom_kept",
];

const CONSTANTS = [
  "TP_SYSTEMD_DIRS",
  "TP_LEGACY_SHELL_RC_NEEDLE",
  "TP_OWNED_TREES",
  "TP_AUTOREMOVE_PROTECTED",
  "TP_PURGE_BASE_PACKAGES",
];

function extractFunction(source: string, name: string): string | null {
  const needle = `\n${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) return null;
  const end = source.indexOf("\n}\n", start + 1);
  if (end < 0) throw new TypeError(`unclosed ${name} in uninstall.sh`);
  return source.slice(start + 1, end + 2);
}

function extractConstant(source: string, name: string): string | null {
  const match = source.match(new RegExp(`^${name}=.*$`, "m"));
  return match ? match[0] : null;
}

type ShResult = { code: number; stdout: string; stderr: string };

async function runUninstallSh(
  functions: string[],
  body: string,
  env: Record<string, string> = {},
): Promise<ShResult> {
  const source = await Deno.readTextFile(uninstallPath);
  const parts: string[] = [];
  for (const name of CONSTANTS) {
    const line = extractConstant(source, name);
    if (line) parts.push(line);
  }
  // A helper missing from an older script is left undefined, so the calling
  // test fails on behaviour rather than on the harness.
  for (const name of [...SUPPORT_FUNCTIONS, ...functions]) {
    const fn = extractFunction(source, name);
    if (fn) parts.push(fn);
  }
  const tmp = await Deno.makeTempDir({ prefix: "tp-uninstall-test-" });
  parts.push(
    `TP_TMP=${tmp}`,
    `TP_LOG_FILE=${tmp}/log`,
    "DRY_RUN=false",
    "TP_FAIL_COUNT=0",
    "TP_BENIGN_FAIL_COUNT=0",
    "TP_ACTION=purge",
    body,
  );
  const out = await new Deno.Command("sh", {
    args: ["-c", parts.join("\n")],
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

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

const RC_WITH_TURBOPANEL = [
  "alias ll='ls -l'",
  'export PATH="/opt/turbopanel/bin:$PATH"',
  "",
].join("\n");

test("a planted .bak symlink is never written through when a startup file is stripped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-rc-" });
  const home = join(dir, "home");
  await Deno.mkdir(home);
  const rc = join(home, ".bashrc");
  const victim = join(dir, "victim");
  await Deno.writeTextFile(rc, RC_WITH_TURBOPANEL);
  await Deno.writeTextFile(victim, "ORIGINAL\n");
  await Deno.symlink(victim, `${rc}.turbopanel-uninstall.bak`);

  const result = await runUninstallSh(
    ["tp_shell_rc_matches", "tp_strip_rc_as_owner", "tp_strip_one_rc"],
    `tp_strip_one_rc "$RC"`,
    { RC: rc, PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
  );

  assertEquals(
    await Deno.readTextFile(victim),
    "ORIGINAL\n",
    `the backup was written through the planted symlink\n${result.stderr}`,
  );
  const stripped = await Deno.readTextFile(rc);
  assert(!stripped.includes("/opt/turbopanel/"), stripped);
  assertStringIncludes(stripped, "alias ll='ls -l'");
  const backups: string[] = [];
  for await (const entry of Deno.readDir(home)) {
    if (
      entry.isFile && entry.name.startsWith(".bashrc.turbopanel-uninstall.bak")
    ) {
      backups.push(await Deno.readTextFile(join(home, entry.name)));
    }
  }
  assertEquals(backups, [RC_WITH_TURBOPANEL]);
});

test("a startup file that is itself a symlink is left alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-rc-" });
  const home = join(dir, "home");
  await Deno.mkdir(home);
  const victim = join(dir, "victim");
  await Deno.writeTextFile(victim, RC_WITH_TURBOPANEL);
  const rc = join(home, ".bashrc");
  await Deno.symlink(victim, rc);

  await runUninstallSh(
    ["tp_shell_rc_matches", "tp_strip_rc_as_owner", "tp_strip_one_rc"],
    `tp_strip_one_rc "$RC"`,
    { RC: rc, PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
  );

  assertEquals(await Deno.readTextFile(victim), RC_WITH_TURBOPANEL);
  assertEquals(await exists(`${rc}.turbopanel-uninstall.bak`), false);
});

test("principal homes are not scanned for startup files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-homes-" });
  const principals = join(dir, "srv", "users");
  const passwd = join(dir, "passwd");
  await Deno.writeTextFile(
    passwd,
    [
      "root:x:0:0:root:/root:/bin/bash",
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
      `alice:x:1000:1000:Alice:${dir}/home/alice:/bin/bash`,
      `bob:x:15001:15001::${principals}/bob:/bin/bash`,
      `carol:x:15002:15002::${principals}:/bin/bash`,
      "",
    ].join("\n"),
  );

  const result = await runUninstallSh(
    ["tp_list_shell_homes"],
    `tp_list_shell_homes "$PASSWD"`,
    { PASSWD: passwd, TP_PRINCIPAL_HOME_ROOTS: principals },
  );

  const homes = result.stdout.trim().split("\n").map((line) =>
    line.split("\t")[0]
  );
  assertEquals(homes, ["/root", `${dir}/home/alice`], result.stderr);
});

const REFUSED_PATHS = [
  "",
  "relative/path",
  "/",
  "/run",
  "/var",
  "/var/lib",
  "/var/lib/postgresql",
  "/./etc",
  "/etc",
  "/etc/passwd",
  "/usr/local",
  "/home",
  "/home/alice",
  "/srv",
  "/opt",
  "/opt/turbopanel/../../etc",
  "/opt/turbopanel/./x",
  "/opt/turbopanel-other",
  "/tmp",
];

const OWNED_PATHS = [
  "/opt/turbopanel",
  "/opt/turbopanel/vendor/deno",
  "/etc/turbopanel",
  "/etc/ssh/turbopanel",
  "/var/lib/turbopanel",
  "/var/lib/turbopanel/state",
  "/var/log/turbopanel",
  "/run/turbopanel",
  "/backup",
  "/backup/managed-1",
  "/srv/users",
  "/srv/users/bob",
  "/tmp/turbopanel-ansible",
  "/root/.ansible",
  "/var/lib/docker",
  "/etc/docker",
  "/etc/systemd/system/turbopaneld.service.d",
];

test("tp_path_is_safe refuses every path outside TurboPanel's own trees", async () => {
  const body = REFUSED_PATHS.map((p) =>
    `if tp_path_is_safe '${p}'; then printf 'ACCEPTED %s\\n' '${p}'; fi`
  ).join("\n");
  const result = await runUninstallSh([], body);
  assertEquals(result.stdout, "", result.stderr);
});

test("tp_path_is_safe accepts the trees TurboPanel creates", async () => {
  const body = OWNED_PATHS.map((p) =>
    `tp_path_is_safe '${p}' || printf 'REFUSED %s\\n' '${p}'`
  ).join("\n");
  const result = await runUninstallSh([], body);
  assertEquals(result.stdout, "", result.stderr);
});

test("a symlink inside an owned tree is followed before the allowlist check", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-owned-" });
  const owned = join(dir, "owned");
  await Deno.mkdir(owned);
  await Deno.mkdir(join(owned, "data"));
  await Deno.symlink("/etc", join(owned, "link"));

  const result = await runUninstallSh(
    [],
    [
      `TP_OWNED_TREES="$TP_OWNED_TREES ${owned}"`,
      `tp_path_is_safe '${owned}/link/passwd' && echo 'ACCEPTED escape'`,
      `tp_path_is_safe '${owned}/link/ssh/sshd_config' && echo 'ACCEPTED nested escape'`,
      `tp_path_is_safe '${owned}/data' || echo 'REFUSED data'`,
      `tp_path_is_safe '${owned}/link' || echo 'REFUSED link itself'`,
    ].join("\n"),
  );

  assertEquals(result.stdout, "", result.stderr);
});

test("a discovered folder outside TurboPanel's trees is listed as kept, never used", async () => {
  const result = await runUninstallSh(
    ["tp_discover_add"],
    [
      "tp_discover_add backup /etc explicit",
      "tp_discover_add principal /var/lib explicit",
      "tp_discover_add principal /home explicit",
      "tp_discover_add state /var/lib/turbopanel explicit",
      'printf "backup=%s\\n" "$TP_BACKUP_DIRS"',
      'printf "principal=%s\\n" "$TP_PRINCIPAL_HOME_ROOTS"',
      'printf "state=%s\\n" "$TP_STATE_DIRS"',
      'cat "$TP_TMP/custom.kept"',
    ].join("\n"),
  );

  const lines = result.stdout.trim().split("\n");
  assertEquals(lines.slice(0, 3), [
    "backup=",
    "principal=",
    "state=/var/lib/turbopanel",
  ], result.stderr);
  const kept = lines.slice(3).join("\n");
  assertStringIncludes(kept, "/etc");
  assertStringIncludes(kept, "/var/lib");
  assertStringIncludes(kept, "/home");
});

test("the purge marker clears when every recorded failure is benign", async () => {
  const result = await runUninstallSh(
    ["tp_resume_clearable"],
    [
      "tp_resume_clearable && echo 'clean:clear'",
      "tp_record_fail 'apt-get update'; tp_record_benign_fail",
      "tp_resume_clearable && echo 'benign:clear'",
      "tp_record_fail 'remove /var/lib/turbopanel'",
      "tp_resume_clearable || echo 'hard:keep'",
    ].join("\n"),
  );
  assertEquals(
    result.stdout.trim().split("\n"),
    ["clean:clear", "benign:clear", "hard:keep"],
    result.stderr,
  );
});

test("an unknown Docker data root is a benign failure and a custom one is kept, not deleted", async () => {
  const unknown = await runUninstallSh(
    ["tp_purge_docker_data_root"],
    [
      "TP_DOCKER_DATA_ROOT_STATUS=unknown",
      "TP_DOCKER_DATA_ROOT=",
      "tp_purge_docker_data_root",
      'echo "fail=$TP_FAIL_COUNT benign=$TP_BENIGN_FAIL_COUNT"',
    ].join("\n"),
  );
  assertStringIncludes(unknown.stdout, "fail=1 benign=1");

  const dir = await Deno.makeTempDir({ prefix: "tp-docker-root-" });
  const custom = await runUninstallSh(
    [
      "tp_purge_docker_data_root",
      "tp_safe_rm_tree",
      "tp_path_present",
      "tp_is_mountpoint",
      "tp_empty_retained_mount",
    ],
    [
      "TP_DOCKER_DATA_ROOT_STATUS=custom",
      `TP_DOCKER_DATA_ROOT='${dir}'`,
      "tp_purge_docker_data_root",
      'echo "fail=$TP_FAIL_COUNT"',
      'cat "$TP_TMP/custom.kept"',
    ].join("\n"),
  );
  assertEquals(
    await exists(dir),
    true,
    "a custom Docker data root was deleted",
  );
  assertStringIncludes(custom.stdout, "fail=0");
  assertStringIncludes(custom.stdout, dir);
});

test("shared packages are kept: ca-certificates, openssl, git, gnupg, iptables", async () => {
  const shared = ["ca-certificates", "openssl", "git", "gnupg", "iptables"];
  const result = await runUninstallSh(
    ["tp_purge_note_kept", "tp_consider_apt_package"],
    [
      "tp_pkg_installed() { return 0; }",
      "tp_pkg_protect_reason() { return 1; }",
      ': > "$TP_TMP/apt.candidates"',
      ...shared.map((p) => `tp_consider_apt_package ${p}`),
      "tp_consider_apt_package unzip",
      'echo "--candidates"',
      'cat "$TP_TMP/apt.candidates"',
      'echo "--kept"',
      'cat "$TP_TMP/kept-packages" 2>/dev/null || true',
    ].join("\n"),
  );
  const [candidates, kept] = result.stdout.split("--kept");
  for (const pkg of shared) {
    assert(
      !candidates.includes(`\n${pkg}\n`),
      `${pkg} is a purge candidate\n${result.stdout}`,
    );
    assertStringIncludes(kept, pkg);
  }
  assertStringIncludes(candidates, "unzip");
});

test("the remove-only confirmation warns that no inbound firewall remains", async () => {
  const result = await runUninstallSh(
    ["tp_print_choice_table", "tp_print_firewall_gone_warning"],
    [
      "TP_ACTION=remove",
      "TP_DOCKER_DATA_ROOT_STATUS=default",
      "tp_print_choice_table 2>&1",
    ].join("\n"),
  );
  assertStringIncludes(result.stdout.toLowerCase(), "no inbound firewall");
});
