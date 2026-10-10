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
const purgePath = join(here, "purge.sh");

// purge.sh runs its root check and main flow at top level, so these tests
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
  "TP_DOCKER_PACKAGES",
  "TP_OTHER_UNITS",
  "TP_PRINCIPAL_ID_MIN",
  "TP_PRINCIPAL_ID_MAX",
];

function extractFunction(source: string, name: string): string | null {
  const needle = `\n${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) return null;
  const end = source.indexOf("\n}\n", start + 1);
  if (end < 0) throw new TypeError(`unclosed ${name} in purge.sh`);
  return source.slice(start + 1, end + 2);
}

function extractConstant(source: string, name: string): string | null {
  const match = source.match(new RegExp(`^${name}=.*$`, "m"));
  return match ? match[0] : null;
}

type ShResult = { code: number; stdout: string; stderr: string };

async function runPurgeSh(
  functions: string[],
  body: string,
  env: Record<string, string> = {},
): Promise<ShResult> {
  const source = await Deno.readTextFile(purgePath);
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
  const tmp = await Deno.makeTempDir({ prefix: "tp-purge-test-" });
  parts.push(
    `TP_TMP=${tmp}`,
    `TP_LOG_FILE=${tmp}/log`,
    "DRY_RUN=false",
    "TP_FAIL_COUNT=0",
    "TP_BENIGN_FAIL_COUNT=0",
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
  await Deno.symlink(victim, `${rc}.turbopanel-purge.bak`);

  const result = await runPurgeSh(
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
      entry.isFile && entry.name.startsWith(".bashrc.turbopanel-purge.bak")
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

  await runPurgeSh(
    ["tp_shell_rc_matches", "tp_strip_rc_as_owner", "tp_strip_one_rc"],
    `tp_strip_one_rc "$RC"`,
    { RC: rc, PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
  );

  assertEquals(await Deno.readTextFile(victim), RC_WITH_TURBOPANEL);
  assertEquals(await exists(`${rc}.turbopanel-purge.bak`), false);
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

  const result = await runPurgeSh(
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
  "/var/lib/turbopanel-build",
  "/var/lib/turbopanel-build/work/b1",
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
  const result = await runPurgeSh([], body);
  assertEquals(result.stdout, "", result.stderr);
});

test("tp_path_is_safe accepts the trees TurboPanel creates", async () => {
  const body = OWNED_PATHS.map((p) =>
    `tp_path_is_safe '${p}' || printf 'REFUSED %s\\n' '${p}'`
  ).join("\n");
  const result = await runPurgeSh([], body);
  assertEquals(result.stdout, "", result.stderr);
});

test("a symlink inside an owned tree is followed before the allowlist check", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-owned-" });
  const owned = join(dir, "owned");
  await Deno.mkdir(owned);
  await Deno.mkdir(join(owned, "data"));
  await Deno.symlink("/etc", join(owned, "link"));

  const result = await runPurgeSh(
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
  const result = await runPurgeSh(
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
  const result = await runPurgeSh(
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
  const unknown = await runPurgeSh(
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
  const custom = await runPurgeSh(
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

const REAL_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";

// A fake apt-get earlier on PATH: `-s purge <pkgs>` prints a simulation that
// removes the requested packages plus whatever FAKE_APT_EXTRA names; any real
// (non-simulated) call is recorded in $FAKE_APT_LOG and does nothing.
async function fakeAptBin(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-fake-apt-" });
  const script = [
    "#!/bin/sh",
    'case " $* " in',
    '  *" -s "*)',
    '    for a in "$@"; do',
    '      case $a in -*|purge|remove) ;; *) echo "Purg $a [1.0]" ;; esac',
    "    done",
    '    for e in $FAKE_APT_EXTRA; do echo "Purg $e [1.0]"; done',
    "    exit 0 ;;",
    "esac",
    'echo "$*" >> "$FAKE_APT_LOG"',
    "",
  ].join("\n");
  await Deno.writeTextFile(join(dir, "apt-get"), script, { mode: 0o755 });
  return dir;
}

// A fake dpkg-query earlier on PATH that prints the given package names. Not a
// shell function: dash rejects a hyphen in a function name.
async function fakeDpkgBin(packages: string[]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-fake-dpkg-" });
  const script = ["#!/bin/sh", ...packages.map((p) => `echo ${p}`), ""].join(
    "\n",
  );
  await Deno.writeTextFile(join(dir, "dpkg-query"), script, { mode: 0o755 });
  return dir;
}

const PACKAGE_FUNCTIONS = [
  "tp_purge_guarded_packages",
  "tp_choose_purge_packages",
  "tp_classify_removal",
  "tp_apt_simulate_file",
  "tp_apt_parse_removed",
  "tp_sim_write_extras",
  "tp_file_words",
  "tp_choose_note_sim",
  "tp_purge_note_kept",
  "tp_run_listed_packages",
];

test("no package is a purge candidate without TurboPanel's own sury evidence", async () => {
  const bin = await fakeDpkgBin(["php8.3-cli", "php8.3-fpm"]);
  const result = await runPurgeSh(
    ["tp_collect_purge_candidates", "tp_sury_evidence", "tp_pkg_installed"],
    [
      // Everything below is installed, but nothing shows TurboPanel's PHP role ran.
      "tp_pkg_installed() { return 0; }",
      "tp_sury_evidence() { return 1; }",
      "tp_collect_purge_candidates",
      'echo "candidates=[$(cat "$TP_TMP/apt.candidates")]"',
    ].join("\n"),
    { PATH: `${bin}:${REAL_PATH}` },
  );
  assertStringIncludes(result.stdout, "candidates=[]");
});

test("with sury evidence only phpN.N packages and the sury keyring are candidates, never a generic package", async () => {
  // What dpkg-query returns for the 'php[0-9]*.[0-9]*-*' glob.
  const bin = await fakeDpkgBin(["php8.3-cli", "php8.3-fpm", "php8.3-common"]);
  const result = await runPurgeSh(
    ["tp_collect_purge_candidates", "tp_file_add"],
    [
      "tp_pkg_installed() { return 0; }",
      "tp_sury_evidence() { return 0; }",
      "tp_collect_purge_candidates",
      'cat "$TP_TMP/apt.candidates"',
    ].join("\n"),
    { PATH: `${bin}:${REAL_PATH}` },
  );
  const candidates = result.stdout.trim().split("\n").sort();
  assertEquals(candidates, [
    "debsuryorg-archive-keyring",
    "php8.3-cli",
    "php8.3-common",
    "php8.3-fpm",
  ], result.stderr);
  for (
    const generic of [
      "curl",
      "git",
      "acl",
      "gnupg",
      "iptables",
      "openssl",
      "wireguard-tools",
      "build-essential",
      "sudo",
      "systemd-timesyncd",
      "ca-certificates",
    ]
  ) {
    assert(!candidates.includes(generic), `${generic} is a purge candidate`);
  }
});

test("a package whose purge would drag others along is kept and reported, not purged", async () => {
  const bin = await fakeAptBin();
  const log = join(bin, "apt.log");
  const result = await runPurgeSh(
    PACKAGE_FUNCTIONS,
    [
      "DRY_RUN=true",
      'printf "docker-ce\\n" > "$TP_TMP/docker.pkgs"',
      'tp_purge_guarded_packages Docker "$TP_TMP/docker.pkgs"',
      'echo "--final"; cat "$TP_TMP/apt.final"',
      'echo "--kept"; cat "$TP_TMP/kept-packages"',
    ].join("\n"),
    {
      PATH: `${bin}:${REAL_PATH}`,
      FAKE_APT_EXTRA: "podman",
      FAKE_APT_LOG: log,
    },
  );
  const [finalList, kept] = result.stdout.split("--final")[1].split("--kept");
  assertEquals(
    finalList.trim(),
    "",
    `docker-ce would have been purged\n${result.stdout}`,
  );
  assertStringIncludes(kept, "docker-ce");
  assertStringIncludes(kept, "podman");
  assertEquals(await exists(log), false, "a real apt-get purge ran");
});

test("a package whose purge removes only the listed packages is purged", async () => {
  const bin = await fakeAptBin();
  const result = await runPurgeSh(
    PACKAGE_FUNCTIONS,
    [
      "DRY_RUN=true",
      'printf "docker-ce\\ndocker-ce-cli\\n" > "$TP_TMP/docker.pkgs"',
      'tp_purge_guarded_packages Docker "$TP_TMP/docker.pkgs"',
      'echo "--final"; cat "$TP_TMP/apt.final"',
    ].join("\n"),
    { PATH: `${bin}:${REAL_PATH}`, FAKE_APT_LOG: join(bin, "apt.log") },
  );
  assertStringIncludes(
    result.stdout,
    "apt-get purge -y docker-ce docker-ce-cli",
  );
  assertEquals(
    result.stdout.split("--final")[1].trim().split("\n").sort(),
    ["docker-ce", "docker-ce-cli"],
    result.stderr,
  );
});

test("the script never autoremoves, never marks packages manual, and purges only through the guard", async () => {
  const source = await Deno.readTextFile(purgePath);
  const code = source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert(!/apt-get[^\n]*autoremove/.test(code), "apt-get autoremove is back");
  assert(!/apt-mark/.test(code), "apt-mark is back");
  assert(!/TP_PURGE_BASE_PACKAGES|TP_PURGE_APACHE_PACKAGES/.test(code));
  const purgeCalls = code.match(/apt-get purge/g) ?? [];
  assertEquals(
    purgeCalls.length,
    1,
    "apt-get purge must appear once, inside tp_purge_guarded_packages",
  );
  const guarded = extractFunction(source, "tp_purge_guarded_packages") ?? "";
  assertStringIncludes(guarded, "apt-get purge");
});

test("there is no keep-anything mode: no menu, no remove-only path, one typed confirmation", async () => {
  const source = await Deno.readTextFile(purgePath);
  assert(!/tp_menu|TP_ACTION|remove-\$\{TP_CODE\}/.test(source));
  const confirm = extractFunction(source, "tp_confirm") ?? "";
  assertStringIncludes(
    confirm,
    '_cf_expected="purge ${TP_HOSTNAME} ${TP_CODE}"',
  );
  assertStringIncludes(confirm, "type the line below exactly");
});

test("the purge scope warns that no inbound firewall remains and that other packages stay", async () => {
  const result = await runPurgeSh(
    ["tp_print_purge_scope", "tp_print_firewall_gone_warning"],
    [
      "TP_DOCKER_DATA_ROOT_STATUS=default",
      "tp_print_purge_scope 2>&1",
    ].join("\n"),
  );
  assertStringIncludes(result.stdout.toLowerCase(), "no inbound firewall");
  assertStringIncludes(result.stdout, "does not remove any other package");
});

async function stubSystemctl(active: string, enabled: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-stub-" });
  await Deno.writeTextFile(
    join(dir, "systemctl"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  show) echo loaded ;;",
      `  is-active) echo ${active}; exit 3 ;;`,
      `  is-enabled) echo ${enabled}; exit 1 ;;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return dir;
}

async function wgPresent(active: string, enabled: string): Promise<string> {
  const stub = await stubSystemctl(active, enabled);
  const empty = await Deno.makeTempDir({ prefix: "tp-purge-units-" });
  const result = await runPurgeSh(
    ["tp_unit_present", "tp_wg_tp0_present"],
    `TP_SYSTEMD_DIRS=${empty}\n` +
      "if tp_unit_present wg-quick@tp0.service; then echo present; else echo absent; fi",
    { PATH: `${stub}:${Deno.env.get("PATH") ?? ""}` },
  );
  return result.stdout.trim();
}

test("the stock wg-quick template is not ours until tp0 was enabled or started", async () => {
  assertEquals(await wgPresent("inactive", "disabled"), "absent");
  assertEquals(await wgPresent("active", "disabled"), "present");
  assertEquals(await wgPresent("inactive", "enabled"), "present");
});

test("the Docker gate stage-1 folders are owned trees and are removed with the other folders", async () => {
  const source = await Deno.readTextFile(purgePath);
  const trees = extractConstant(source, "TP_OWNED_TREES") ?? "";
  const remove = extractFunction(source, "tp_remove_folders_and_shell") ?? "";
  for (
    const dir of [
      "/run/turbopanel-gate",
      "/var/cache/turbopanel-docker-gate",
      "/var/lib/turbopanel-docker-gate",
    ]
  ) {
    assertStringIncludes(trees, dir);
    assertStringIncludes(remove, `tp_safe_rm_tree ${dir}`);
  }
});

test("the build slice is stopped and its unit file removed although it is not turbopanel*", async () => {
  const units = await Deno.makeTempDir({ prefix: "tp-purge-units-" });
  await Deno.writeTextFile(join(units, "tpbuild.slice"), "[Slice]\n");
  await Deno.writeTextFile(join(units, "tpother.slice"), "[Slice]\n");
  const result = await runPurgeSh(
    ["tp_unit_present", "tp_collect_unit_names", "tp_remove_unit_files"],
    [
      `TP_SYSTEMD_DIRS=${units}`,
      // No systemctl: discovery falls back to the unit directories.
      'tp_has_tool() { [ "$1" != systemctl ] && command -v "$1" >/dev/null 2>&1; }',
      "tp_collect_unit_names",
      'cat "$TP_TMP/work.unitnames"',
      "tp_remove_unit_files",
    ].join("\n"),
  );
  assertStringIncludes(result.stdout, "tpbuild.slice\n", result.stderr);
  assertEquals(await exists(join(units, "tpbuild.slice")), false);
  assertEquals(await exists(join(units, "tpother.slice")), true);
});

async function stubBin(name: string, script: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-stub-" });
  await Deno.writeTextFile(join(dir, name), `#!/bin/sh\n${script}\n`, {
    mode: 0o755,
  });
  return dir;
}

const BASE_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";

test("an inactive slice systemd keeps without a unit file is not reported as left over", async () => {
  const stub = await stubBin(
    "systemctl",
    [
      'case "$*" in',
      "  *LoadState*) echo loaded ;;",
      "  *FragmentPath*) echo ;;",
      "  *ActiveState*) echo inactive ;;",
      "esac",
    ].join("\n"),
  );
  const empty = await Deno.makeTempDir({ prefix: "tp-purge-units-" });
  const result = await runPurgeSh(
    ["tp_unit_present"],
    `TP_SYSTEMD_DIRS=${empty}\nif tp_unit_present tpbuild.slice; then echo present; else echo absent; fi`,
    { PATH: `${stub}:${BASE_PATH}` },
  );
  assertEquals(result.stdout.trim(), "absent", result.stderr);
  // A slice that is still running, or whose unit file exists, is still ours.
  const live = await stubBin(
    "systemctl",
    'case "$*" in *LoadState*) echo loaded ;; *FragmentPath*) echo ;; *ActiveState*) echo active ;; esac',
  );
  const running = await runPurgeSh(
    ["tp_unit_present"],
    `TP_SYSTEMD_DIRS=${empty}\nif tp_unit_present tpbuild.slice; then echo present; else echo absent; fi`,
    { PATH: `${live}:${BASE_PATH}` },
  );
  assertEquals(running.stdout.trim(), "present", running.stderr);
});

test("the unit scan skips a stopped slice with no unit file but keeps a running one", async () => {
  const body = [
    "TP_SYSTEMD_DIRS=$TP_TMP/none",
    ': > "$TP_TMP/inv.units"',
    "tp_scan_systemctl_units",
    'cat "$TP_TMP/inv.units"',
  ].join("\n");
  const stubFor = (state: string) =>
    stubBin(
      "systemctl",
      [
        'case "$*" in',
        "  *LoadState*) echo loaded ;;",
        "  *FragmentPath*) echo ;;",
        `  *ActiveState*) echo ${state} ;;`,
        '  *list-units*) echo "turbopanel.slice loaded ${state} dead TurboPanel" ;;',
        "esac",
      ].join("\n"),
    );
  const fns = [
    "tp_scan_systemctl_units",
    "tp_note_unit",
    "tp_unit_present",
    "tp_list_has_word",
  ];
  const gone = await runPurgeSh(fns, body, {
    PATH: `${await stubFor("inactive")}:${BASE_PATH}`,
  });
  assertEquals(gone.stdout.trim(), "", gone.stderr);
  const running = await runPurgeSh(fns, body, {
    PATH: `${await stubFor("active")}:${BASE_PATH}`,
  });
  assertStringIncludes(running.stdout, "turbopanel.slice", running.stderr);
});

test("containers are not carried into the final check once Docker Engine was purged", async () => {
  const stub = await stubBin("docker", "exit 1");
  const run = (gone: string, left = "false") =>
    runPurgeSh(
      [
        "tp_inventory_docker",
        "tp_inv_skip",
        "tp_inv_warn",
        "tp_inv_keep_previous",
        "tp_docker_ready",
      ],
      [
        'echo "abc-in" > "$TP_TMP/before.containers"',
        ': > "$TP_TMP/inv.containers"',
        "TP_INV_QUIET=true",
        `TP_DOCKER_ENGINE_GONE=${gone}`,
        `TP_DOCKER_LEFT=${left}`,
        "tp_inventory_docker",
        'cat "$TP_TMP/inv.containers"',
      ].join("\n"),
      { PATH: `${stub}:${BASE_PATH}` },
    );
  assertEquals((await run("true")).stdout.trim(), "");
  // Daemon dead after the removal step ran: nothing is left to report.
  assertEquals((await run("false")).stdout.trim(), "");
  // Docker still installed, not answering, and the removal step was skipped:
  // the old list is kept.
  assertEquals((await run("false", "true")).stdout.trim(), "abc-in");
});

test("a purge with Docker already removed reports no false container failure", async () => {
  // Docker CLI gone: the removal step skips quietly and records no failure.
  const result = await runPurgeSh(
    ["tp_remove_docker", "tp_has_tool", "tp_record_skip"],
    'tp_has_tool() { return 1; }\ntp_remove_docker\necho "fail=$TP_FAIL_COUNT left=${TP_DOCKER_LEFT:-no}"',
  );
  assertStringIncludes(result.stdout, "fail=0 left=no");
  assertStringIncludes(result.stdout, "fail=0");
});

test("the hosting Caddy state folder is owned, inventoried and removed", async () => {
  const source = await Deno.readTextFile(purgePath);
  const dir = "/var/lib/turbopanel-hosting-caddy";
  assertStringIncludes(extractConstant(source, "TP_OWNED_TREES") ?? "", dir);
  assertStringIncludes(
    extractFunction(source, "tp_remove_folders_and_shell") ?? "",
    `tp_safe_rm_tree ${dir}`,
  );
  assertStringIncludes(
    extractFunction(source, "tp_inventory_folders") ?? "",
    dir,
  );
});

test("the Docker gate build group is removed by exact name even though its gid is outside the service band", async () => {
  const stub = await stubBin(
    "getent",
    [
      'case "$1" in',
      "  passwd) echo 'root:x:0:0::/root:/bin/sh' ;;",
      "  group) echo 'tpgatebuild:x:988:'; echo 'tpother:x:989:'; echo 'tp:x:9901:' ;;",
      "esac",
    ].join("\n"),
  );
  const result = await runPurgeSh(
    [
      "tp_account_delete_names",
      "tp_list_has_word",
      "tp_name_is_tp",
      "tp_id_in_band",
      "tp_home_is_principal",
    ],
    [
      "TP_OTHER_GROUPS=tpgatebuild",
      "tp_account_delete_names",
      'cat "$TP_TMP/work.groups"',
    ].join("\n"),
    { PATH: `${stub}:${BASE_PATH}` },
  );
  assertEquals(result.stdout.trim().split("\n").sort(), ["tp", "tpgatebuild"]);
});

test("only Docker's own firewall rules are matched for removal", async () => {
  const check = async (rule: string) =>
    (await runPurgeSh(
      ["tp_docker_net_rule"],
      `if tp_docker_net_rule "$RULE"; then echo ours; else echo foreign; fi`,
      { RULE: rule, PATH: BASE_PATH },
    )).stdout.trim();
  assertEquals(await check("-A FORWARD -j DOCKER-USER"), "ours");
  assertEquals(await check("-A FORWARD -o docker0 -j DOCKER"), "ours");
  assertEquals(
    await check(
      "-A POSTROUTING -s 172.18.0.0/16 ! -o br-0123456789ab -j MASQUERADE",
    ),
    "ours",
  );
  assertEquals(await check("-A FORWARD -j DOCKER-ISOLATION-STAGE-1"), "ours");
  assertEquals(await check("-A DOCKER -j RETURN"), "foreign");
  assertEquals(await check("-A INPUT -p tcp --dport 22 -j ACCEPT"), "foreign");
  assertEquals(await check("-A FORWARD -o br-lan -j ACCEPT"), "foreign");
  assertEquals(await check("-A INPUT -i docker0 -j ACCEPT"), "foreign");
  assertEquals(await check("-A INPUT -i br-0123456789ab -j ACCEPT"), "foreign");
  assertEquals(await check("-A OUTPUT -o docker0 -j ACCEPT"), "foreign");
  assertEquals(await check("-A OUTPUT -j DOCKER"), "ours");
  assertEquals(
    await check('-A FORWARD -o docker0 -m comment --comment "mine" -j ACCEPT'),
    "foreign",
  );
});

test("the Docker network cleanup removes Docker bridges and chains and nothing else", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-net-" });
  const calls = join(dir, "calls");
  await Deno.writeTextFile(
    join(dir, "ip"),
    [
      "#!/bin/sh",
      `echo "ip $*" >> ${calls}`,
      'case "$*" in',
      '  "-o link show type bridge") printf "3: docker0: <X>\\n4: br-0123456789ab: <X>\\n5: br-lan: <X>\\n6: virbr0: <X>\\n" ;;',
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  await Deno.writeTextFile(
    join(dir, "iptables"),
    [
      "#!/bin/sh",
      `echo "iptables $*" >> ${calls}`,
      'case "$*" in',
      '  *"-t filter -S") printf -- "-N DOCKER\\n-N DOCKER-USER\\n-A DOCKER-USER -j RETURN\\n-A FORWARD -j DOCKER-USER\\n-A INPUT -p tcp -j ACCEPT\\n" ;;',
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  const result = await runPurgeSh(
    [
      "tp_purge_docker_network_state",
      "tp_purge_docker_net_table",
      "tp_docker_net_rule",
    ],
    "tp_purge_docker_network_state",
    { PATH: `${dir}:${BASE_PATH}` },
  );
  assertEquals(result.code, 0, result.stderr);
  const log = await Deno.readTextFile(calls);
  assertStringIncludes(log, "ip link del docker0");
  assertStringIncludes(log, "ip link del br-0123456789ab");
  assert(!log.includes("br-lan") || !log.includes("link del br-lan"), log);
  assert(!log.includes("link del virbr0"), log);
  assertStringIncludes(log, "-t filter -D FORWARD -j DOCKER-USER");
  assertStringIncludes(log, "-t filter -X DOCKER");
  assert(!log.includes("-D INPUT"), log);
});

async function netCleanup(
  forward: string,
  extra: string,
): Promise<{ log: string; dir: string; stdout: string }> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-net2-" });
  const calls = join(dir, "calls");
  await Deno.writeTextFile(
    join(dir, "iptables"),
    [
      "#!/bin/sh",
      `echo "iptables $*" >> ${calls}`,
      'case "$*" in',
      `  *"-t filter -S") printf -- "${forward}" ;;`,
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  const result = await runPurgeSh(
    [
      "tp_purge_docker_net_table",
      "tp_docker_net_rule",
    ],
    `tp_purge_docker_net_table iptables filter\n${extra}`,
    { PATH: `${dir}:${BASE_PATH}` },
  );
  assertEquals(result.code, 0, result.stderr);
  let log = "";
  try {
    log = await Deno.readTextFile(calls);
  } catch { /* no calls */ }
  return { log, dir, stdout: result.stdout };
}

const NET_KEPT =
  "-N DOCKER\\n-N DOCKER-USER\\n-A DOCKER-USER -s 10.0.0.1 -j DROP\\n-A DOCKER-USER -j RETURN\\n-A FORWARD -j DOCKER-USER\\n-A FORWARD -o docker0 -j DOCKER\\n-A INPUT -i docker0 -j ACCEPT\\n";

test("a kept DOCKER-USER chain keeps its FORWARD jump; Docker's other rules and an admin INPUT docker0 rule are handled", async () => {
  const { log } = await netCleanup(NET_KEPT, "");
  assert(!log.includes("-D FORWARD -j DOCKER-USER"), log);
  assert(!log.includes("-D INPUT"), log);
  assertStringIncludes(log, "-t filter -D FORWARD -o docker0 -j DOCKER");
  assert(!log.includes("-X DOCKER-USER"), log);
  assert(!log.includes("-F DOCKER-USER"), log);
  assertStringIncludes(log, "-t filter -X DOCKER");
});

test("an inert DOCKER-USER chain (only RETURN) loses its jump and the chain", async () => {
  const { log } = await netCleanup(
    "-N DOCKER-USER\\n-A DOCKER-USER -j RETURN\\n-A FORWARD -j DOCKER-USER\\n",
    "",
  );
  assertStringIncludes(log, "-t filter -D FORWARD -j DOCKER-USER");
  assertStringIncludes(log, "-t filter -X DOCKER-USER");
});

test("running the network cleanup on an already clean table does nothing", async () => {
  const { log } = await netCleanup("-A INPUT -p tcp -j ACCEPT\\n", "");
  assert(!log.includes(" -D "), log);
  assert(!log.includes(" -X "), log);
  assert(!log.includes(" -F "), log);
});

async function engineGone(
  stubs: Record<string, string>,
  env: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-eng-" });
  for (const [name, body] of Object.entries(stubs)) {
    await Deno.writeTextFile(join(dir, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  }
  // Hermetic PATH: only the stubs plus sh, so a runner that really has
  // dockerd, docker-ce, snap or docker.service installed cannot leak in.
  await Deno.symlink("/bin/sh", join(dir, "sh"));
  const result = await runPurgeSh(
    ["tp_docker_engine_gone", "tp_has_tool", "tp_pkg_installed"],
    "DRY_RUN=false; if tp_docker_engine_gone; then echo gone; else echo present; fi",
    {
      PATH: dir,
      TP_DOCKER_SOCKETS: "/nonexistent/x.sock",
      ...env,
    },
  );
  return result.stdout.trim();
}

test("Docker Engine counts as gone only when no daemon, snap, service or socket remains", async () => {
  assertEquals(await engineGone({}), "gone");
  assertEquals(await engineGone({ dockerd: "exit 0" }), "present");
  assertEquals(
    await engineGone({ "dockerd-rootless.sh": "exit 0" }),
    "present",
  );
  assertEquals(await engineGone({ snap: "exit 0" }), "present");
  assertEquals(await engineGone({ systemctl: "exit 0" }), "present");
  assertEquals(
    await engineGone({ "dpkg-query": 'printf "install ok installed"' }),
    "present",
  );
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-sock-" });
  const sock = join(dir, "docker.sock");
  const listener = Deno.listen({ transport: "unix", path: sock });
  try {
    assertEquals(await engineGone({}, { TP_DOCKER_SOCKETS: sock }), "present");
  } finally {
    listener.close();
  }
});

// getent and groupdel stand-ins over a temp group/passwd pair: groupdel drops
// the line, as the real one would; tp_run prints "▸ groupdel <name>".
const GROUP_STUBS = `
getent() {
  if [ "$#" -lt 2 ]; then cat "$TP_TMP/$1"; return; fi
  awk -F: -v n="$2" '$1 == n { print; found = 1 } END { exit !found }' "$TP_TMP/$1"
}
groupdel() {
  awk -F: -v n="$1" '$1 != n' "$TP_TMP/group" > "$TP_TMP/group.new"
  mv "$TP_TMP/group.new" "$TP_TMP/group"
}
`;

async function purgeGroups(
  group: string[],
  passwd: string[],
  call: string,
): Promise<ShResult> {
  const result = await runPurgeSh(
    [
      "tp_principal_band_gid",
      "tp_gid_is_primary",
      "tp_group_has_members",
      "tp_principal_leave_home",
      "tp_purge_principal_groups",
    ],
    [
      GROUP_STUBS,
      `printf '%s\\n' ${
        group.map((l) => `'${l}'`).join(" ")
      } > "$TP_TMP/group"`,
      `printf '%s\\n' ${
        passwd.map((l) => `'${l}'`).join(" ")
      } > "$TP_TMP/passwd"`,
      `if ${call}; then echo KEPT_HOME=no; else echo KEPT_HOME=yes; fi`,
    ].join("\n"),
    { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
  );
  return { ...result, stdout: result.stdout + result.stderr };
}

test("purge removes a site owner's own group and an old <name>-grp, engines or not", async () => {
  const result = await purgeGroups(
    ["alice:x:15001:tpnginx", "alice-grp:x:15002:", "sudo:x:27:"],
    ["root:x:0:0::/root:/bin/sh"],
    `tp_purge_principal_groups alice /srv/users/alice account`,
  );
  assertStringIncludes(result.stdout, "groupdel alice\n");
  assertStringIncludes(result.stdout, "groupdel alice-grp\n");
  assertStringIncludes(result.stdout, "KEPT_HOME=no");
});

test("purge never removes a group of the owner's name outside the band", async () => {
  for (const name of ["sudo", "admin", "staff"]) {
    const result = await purgeGroups(
      [`${name}:x:27:`, `${name}-grp:x:1001:`],
      ["root:x:0:0::/root:/bin/sh"],
      `tp_purge_principal_groups ${name} /srv/users/${name} orphan`,
    );
    assert(!result.stdout.includes("groupdel"), result.stdout);
    assertStringIncludes(result.stdout, "KEPT_HOME=no");
    assertStringIncludes(
      result.stdout,
      `kept group ${name} (its id is outside`,
    );
  }
});

test("purge keeps an orphan's group that still has members or is a primary group", async () => {
  const members = await purgeGroups(
    ["carol:x:15003:tpnginx"],
    ["root:x:0:0::/root:/bin/sh"],
    `tp_purge_principal_groups carol /srv/users/carol orphan`,
  );
  assert(!members.stdout.includes("groupdel"), members.stdout);
  assertStringIncludes(members.stdout, "KEPT_HOME=yes");

  const primary = await purgeGroups(
    ["dave:x:15004:"],
    ["erin:x:15005:15004::/home/erin:/bin/sh"],
    `tp_purge_principal_groups dave /srv/users/dave account`,
  );
  assert(!primary.stdout.includes("groupdel"), primary.stdout);
  assertStringIncludes(primary.stdout, "KEPT_HOME=yes");
});

test("purge never touches a group named root or tp*", async () => {
  for (const name of ["root", "tp", "tpnginx"]) {
    const result = await purgeGroups(
      [`${name}:x:15006:`],
      ["root:x:0:0::/root:/bin/sh"],
      `tp_purge_principal_groups ${name} /srv/users/${name} orphan`,
    );
    assert(!result.stdout.includes("groupdel"), result.stdout);
  }
});
