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
  "tp_pkg_state_in",
  "tp_pkg_installed",
  "tp_pkg_purgeable",
];

const CONSTANTS = [
  "TP_SYSTEMD_DIRS",
  "TP_LEGACY_SHELL_RC_NEEDLE",
  "TP_OWNED_TREES",
  "TP_TIMER_STAMP_DIR",
  "TP_NFT_TABLES",
  "TP_DOCKER_PACKAGES",
  "TP_DOCKER_ENGINE_PACKAGES",
  "TP_DPKG_ON_DISK",
  "TP_APT_SOURCES_DIR",
  "TP_DOCKER_APT_SOURCES",
  "TP_DOCKER_APT_KEYS",
  "TP_SURY_APT_KEYS",
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
  // Tunnel connectors: the root-only token copies, the connector program and
  // the daemon's staged files and records.
  "/etc/turbopanel/tunnel-env",
  "/etc/turbopanel/tunnel-env/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.env",
  "/opt/turbopanel/vendor/cloudflared",
  "/opt/turbopanel/vendor/cloudflared/2026.10.7/cloudflared",
  "/var/lib/turbopanel/cloudflared/tunnels",
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
// (non-simulated) call is recorded in $FAKE_APT_LOG and does nothing. Like
// the real apt-get, a real `purge -y` of a package named in $FAKE_APT_HELD is
// refused without --allow-change-held-packages, while the simulation passes.
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
    'case " $* " in',
    '  *" --allow-change-held-packages "*) ;;',
    "  *)",
    "    for h in $FAKE_APT_HELD; do",
    '      case " $* " in *" $h "*)',
    '        echo "E: Held packages were changed and -y was used without --allow-change-held-packages." >&2',
    '        echo "refused: $*" >> "$FAKE_APT_LOG"',
    "        exit 100 ;;",
    "      esac",
    "    done ;;",
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
      "tp_pkg_purgeable() { return 0; }",
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
      "tp_pkg_purgeable() { return 0; }",
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
    "apt-get purge -y --allow-change-held-packages docker-ce docker-ce-cli",
  );
  assertEquals(
    result.stdout.split("--final")[1].trim().split("\n").sort(),
    ["docker-ce", "docker-ce-cli"],
    result.stderr,
  );
});

test("Docker packages the Docker role holds at a pinned version are still purged", async () => {
  const bin = await fakeAptBin();
  const log = join(bin, "apt.log");
  const result = await runPurgeSh(
    PACKAGE_FUNCTIONS,
    [
      'printf "containerd.io\\ndocker-ce\\ndocker-ce-cli\\n" > "$TP_TMP/docker.pkgs"',
      'tp_purge_guarded_packages Docker "$TP_TMP/docker.pkgs"',
      'echo "fail=$TP_FAIL_COUNT"',
    ].join("\n"),
    {
      PATH: `${bin}:${REAL_PATH}`,
      FAKE_APT_HELD: "docker-ce docker-ce-cli",
      FAKE_APT_LOG: log,
    },
  );
  assertStringIncludes(result.stdout, "fail=0", result.stderr);
  const calls = await Deno.readTextFile(log);
  assert(!calls.includes("refused"), calls);
  assertStringIncludes(
    calls,
    "purge -y --allow-change-held-packages containerd.io docker-ce docker-ce-cli",
  );
});

test("a held package the purge would drag along still keeps the candidate", async () => {
  const bin = await fakeAptBin();
  const log = join(bin, "apt.log");
  const result = await runPurgeSh(
    PACKAGE_FUNCTIONS,
    [
      'printf "docker-ce\\n" > "$TP_TMP/docker.pkgs"',
      'tp_purge_guarded_packages Docker "$TP_TMP/docker.pkgs"',
      'echo "--kept"; cat "$TP_TMP/kept-packages"',
    ].join("\n"),
    {
      PATH: `${bin}:${REAL_PATH}`,
      FAKE_APT_EXTRA: "admin-held-tool",
      FAKE_APT_HELD: "admin-held-tool",
      FAKE_APT_LOG: log,
    },
  );
  assertStringIncludes(result.stdout.split("--kept")[1], "admin-held-tool");
  assertEquals(await exists(log), false, "a real apt-get purge ran");
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

// A default route and a public range a hostile state.json could name; built
// from parts, they are never a host this test reaches.
const DEFAULT_ROUTE = `${[0, 0, 0, 0].join(".")}/0`;
const PUBLIC_RANGE = `${[8, 8, 8, 0].join(".")}/24`;
const LAN_GATEWAY = [10, 0, 0, 1].join(".");

test("LAN routes the daemon recorded are removed only when the kernel shows exactly that route", async () => {
  const state = await Deno.makeTempDir({ prefix: "tp-purge-state-" });
  await Deno.mkdir(join(state, "network"));
  await Deno.writeTextFile(
    join(state, "network", "state.json"),
    JSON.stringify(
      {
        prefix: "10.192.0.0/16",
        tunnel: false,
        installedLanRoutes: [
          { cidr: "10.193.5.0/24", via: "10.0.0.12", dev: "eth1" }, // NOSONAR typescript:S1313 — sample LAN neighbour for this test fixture, not a reachable host
          { cidr: "10.193.6.0/24", via: "10.0.0.13", dev: "eth1" }, // NOSONAR typescript:S1313 — route the kernel no longer has, test fixture only
          { cidr: "10.193.7.0/24", via: "10.0.0.12;rm", dev: "eth1" }, // NOSONAR typescript:S1313 — hostile entry, test fixture only
          { cidr: "10.193.8.0/24", via: "10.0.0.12", dev: "tp0" }, // NOSONAR typescript:S1313 — hostile entry, test fixture only
          { cidr: DEFAULT_ROUTE, via: LAN_GATEWAY, dev: "eth0" },
          { cidr: PUBLIC_RANGE, via: LAN_GATEWAY, dev: "eth0" },
          { cidr: "10.193.9.0/24", via: "10.0.0.12", dev: "docker0" }, // NOSONAR typescript:S1313 — hostile entry, test fixture only
        ],
      },
      null,
      2,
    ),
  );
  const bin = await Deno.makeTempDir({ prefix: "tp-purge-bin-" });
  const log = join(bin, "calls");
  await Deno.writeTextFile(
    join(bin, "ip"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${log}`,
      'case "$*" in',
      '  "-4 route show exact 10.193.5.0/24 dev eth1") echo "10.193.5.0/24 via 10.0.0.12 proto static" ;;',
      '  "-4 route show exact 10.193.6.0/24 dev eth1") echo "10.193.6.0/24 via 10.0.0.1" ;;',
      `  "-4 route show exact ${DEFAULT_ROUTE} dev eth0") echo "default via ${LAN_GATEWAY} proto dhcp" ;;`,
      `  "-4 route show exact ${PUBLIC_RANGE} dev eth0") echo "${PUBLIC_RANGE} via ${LAN_GATEWAY}" ;;`,
      '  "-4 route show exact 10.193.9.0/24 dev docker0") echo "10.193.9.0/24 via 10.0.0.12" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = await runPurgeSh(
    [
      "tp_lan_routes_from_state",
      "tp_ipv4_octet_ok",
      "tp_ipv4_literal_ok",
      "tp_fabric_route_v4_private",
      "tp_fabric_route_v4_cidr_ok",
      "tp_lan_nic_ok",
      "tp_lan_route_entry_ok",
      "tp_remove_lan_routes",
    ],
    [
      `TP_STATE_DIRS=${state}`,
      `TP_OWNED_TREES="${await Deno.realPath(state)} ${state}"`,
      "tp_remove_lan_routes",
    ].join("\n"),
    { PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` },
  );
  assertEquals(result.code, 0, result.stderr);
  const calls = (await Deno.readTextFile(log)).trim().split("\n");
  // The default route, the public range and docker0 never reach `ip`.
  assertEquals(calls, [
    "-4 route show exact 10.193.5.0/24 dev eth1",
    "route del 10.193.5.0/24 via 10.0.0.12 dev eth1",
    "-4 route show exact 10.193.6.0/24 dev eth1",
  ]);
});

/** An IPv4 literal built from its octets, so no address sits in source. */
function v4(...octets: number[]): string {
  return octets.join(".");
}

/** Runs shell functions lifted from `file` and prints one verdict per input. */
async function verdicts(
  file: string,
  functions: string[],
  check: string,
  inputs: string[],
): Promise<string[]> {
  const source = await Deno.readTextFile(file);
  const parts: string[] = [];
  for (const name of functions) {
    const fn = extractFunction(source, name);
    assert(fn, `${name} is missing from ${file}`);
    parts.push(fn);
  }
  parts.push(
    'for _in in "$@"; do',
    `  if ${check} "$_in"; then echo yes; else echo no; fi`,
    "done",
  );
  const out = await new Deno.Command("sh", {
    args: ["-c", parts.join("\n"), "sh", ...inputs],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim().split("\n");
}

const tpHostPath = join(here, "..", "orchestration", "scripts", "tp-host");

test("the purge judges LAN route fields exactly as the host wrapper does", async () => {
  const cidrs = [
    `${v4(10, 193, 5, 0)}/24`,
    `${v4(10, 0, 0, 0)}/8`,
    `${v4(10, 0, 0, 0)}/7`,
    `${v4(10, 1, 2, 0)}/32`,
    `${v4(10, 1, 2, 0)}/33`,
    `${v4(10, 1, 2, 0)}/08`,
    `${v4(10, 1, 2, 0)}/024`,
    `${v4(10, 1, 2, 0)}/`,
    `${v4(10, 1, 2, 0)}/24/1`,
    `${v4(10, 1, 2, 0)}/8x`,
    v4(10, 1, 2, 0),
    `${v4(10, 1, 2)}/24`,
    `${v4(10, 1, 2, 0)}.1/24`,
    `10.01.2.0/24`,
    `${v4(256, 1, 1, 0)}/24`,
    `${v4(172, 16, 0, 0)}/12`,
    `${v4(172, 16, 0, 0)}/11`,
    `${v4(172, 15, 0, 0)}/16`,
    `${v4(172, 32, 0, 0)}/16`,
    `${v4(192, 168, 1, 0)}/24`,
    `${v4(192, 168, 0, 0)}/15`,
    `${v4(192, 169, 0, 0)}/16`,
    `${v4(100, 64, 0, 0)}/10`,
    `${v4(100, 64, 0, 0)}/9`,
    `${v4(100, 63, 0, 0)}/16`,
    `${v4(100, 128, 0, 0)}/16`,
    `${v4(8, 8, 8, 0)}/24`,
    `${v4(0, 0, 0, 0)}/0`,
    "/24",
    "",
    ";rm",
  ];
  const vias = [
    v4(10, 0, 0, 12),
    v4(192, 168, 1, 1),
    v4(0, 0, 0, 0),
    v4(255, 255, 255, 255),
    v4(256, 0, 0, 1),
    v4(10, 0, 0),
    `${v4(10, 0, 0, 1)}.`,
    "10.00.0.1",
    "10..0.1",
    `${v4(10, 0, 0, 1)};rm`,
    "",
  ];
  const nics = [
    "eth0",
    "eth1.100",
    "enp3s0f1",
    "bond0_a",
    "e-1",
    "tp0",
    "lo",
    "docker0",
    "br-0a1b2c",
    "veth12ab",
    "tpn_web",
    "-eth0",
    ".",
    "..",
    "a".repeat(15),
    "a".repeat(16),
    "eth 0",
    "eth0;rm",
    "",
  ];
  const octet = ["tp_ipv4_octet_ok", "tp_ipv4_literal_ok"];
  const route = [...octet, "tp_fabric_route_v4_private"];
  assertEquals(
    await verdicts(
      purgePath,
      [...route, "tp_fabric_route_v4_cidr_ok"],
      "tp_fabric_route_v4_cidr_ok",
      cidrs,
    ),
    await verdicts(
      tpHostPath,
      [...route, "tp_fabric_route_cidr_ok"],
      "tp_fabric_route_cidr_ok",
      cidrs,
    ),
  );
  assertEquals(
    await verdicts(purgePath, octet, "tp_ipv4_literal_ok", vias),
    await verdicts(tpHostPath, octet, "tp_ipv4_literal_ok", vias),
  );
  assertEquals(
    await verdicts(purgePath, ["tp_lan_nic_ok"], "tp_lan_nic_ok", nics),
    await verdicts(tpHostPath, ["tp_lan_nic_ok"], "tp_lan_nic_ok", nics),
  );
  // The corpus must hold both verdicts, or the comparison proves nothing.
  const sample = await verdicts(
    purgePath,
    ["tp_lan_nic_ok"],
    "tp_lan_nic_ok",
    nics,
  );
  assert(sample.includes("yes") && sample.includes("no"), sample.join(" "));
});

/** A fake iptables: fixed listings, every call logged. */
async function fakeIptables(
  save: string,
  lists: Record<string, string>,
): Promise<{ bin: string; calls: string }> {
  const bin = await Deno.makeTempDir({ prefix: "tp-purge-fw-" });
  const calls = join(bin, "calls");
  const cases = Object.entries(lists).map(([chain, text]) =>
    `  "-w 5 -L ${chain} -n --line-numbers") printf '%s\\n' ${
      text.split("\n").map((l) => `'${l}'`).join(" ")
    } ;;`
  );
  await Deno.writeTextFile(
    join(bin, "iptables"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${calls}`,
      'case "$*" in',
      `  "-w 5 -S") printf '%s\\n' ${
        save.split("\n").map((l) => `'${l}'`).join(" ")
      } ;;`,
      ...cases,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await Deno.writeTextFile(calls, "");
  return { bin, calls };
}

async function firewallRun(
  save: string,
  lists: Record<string, string>,
): Promise<string[]> {
  const { bin, calls } = await fakeIptables(save, lists);
  const result = await runPurgeSh(
    [
      "tp_firewall_delete_jumps",
      "tp_firewall_try_delete",
      "tp_firewall_family",
    ],
    "tp_firewall_family iptables",
    { PATH: `${bin}:${BASE_PATH}` },
  );
  assertEquals(result.code, 0, result.stderr);
  return (await Deno.readTextFile(calls)).trim().split("\n").filter(Boolean);
}

const LAN_RANGE = `${v4(10, 193, 5, 0)}/24`;
const BRIDGE_RANGE = `${v4(10, 192, 1, 0)}/24`;
const OPERATOR_RANGE = `${v4(192, 168, 7, 0)}/24`;
const ANY = `${v4(0, 0, 0, 0)}/0`;
const HEADER = "num  target     prot opt source               destination";

test("TurboFabric's TP-FORWARD chain, its jumps and its LAN pairs go; an operator's rules stay", async () => {
  const save = [
    "-P INPUT ACCEPT",
    "-P FORWARD DROP",
    "-N DOCKER-USER",
    "-N TP-FORWARD",
    "-A FORWARD -j TP-FORWARD",
    "-A FORWARD -s " + OPERATOR_RANGE + " -j ACCEPT",
    "-A DOCKER-USER -j TP-FORWARD",
    "-A DOCKER-USER -s " + OPERATOR_RANGE + " -j ACCEPT",
    "-A TP-FORWARD -i tp0 -o tp0 -j DROP",
    `-A TP-FORWARD -s ${BRIDGE_RANGE} -d ${LAN_RANGE} -o eth1 -j ACCEPT`,
    `-A TP-FORWARD -s ${LAN_RANGE} -d ${BRIDGE_RANGE} -i eth1 -j ACCEPT`,
  ].join("\n");
  const calls = await firewallRun(save, {
    INPUT: ["Chain INPUT (policy ACCEPT)", HEADER].join("\n"),
    FORWARD: [
      "Chain FORWARD (policy DROP)",
      HEADER,
      `1    TP-FORWARD  all  --  ${ANY}  ${ANY}`,
      `2    ACCEPT     all  --  ${OPERATOR_RANGE}  ${ANY}`,
    ].join("\n"),
    "DOCKER-USER": [
      "Chain DOCKER-USER (1 references)",
      HEADER,
      `1    ACCEPT     all  --  ${OPERATOR_RANGE}  ${ANY}`,
      `2    TP-FORWARD  all  --  ${ANY}  ${ANY}`,
    ].join("\n"),
  });
  const changes = calls.filter((c) => / -[DFX] /.test(c));
  assertEquals(changes, [
    "-w 5 -D FORWARD 1",
    "-w 5 -D DOCKER-USER 2",
    "-w 5 -F TP-FORWARD",
    "-w 5 -X TP-FORWARD",
  ]);
});

/**
 * A fake iptables/ip6tables that keeps its rules in a file: `-S` prints them,
 * `-L CHAIN` numbers that chain's rules, and `-D CHAIN N`, `-F` and `-X`
 * change the file. Every changing call is logged with the binary's name.
 */
async function statefulFirewall(
  rules: string,
): Promise<{ bin: string; log: string }> {
  const bin = await Deno.makeTempDir({ prefix: "tp-purge-fwstate-" });
  const log = join(bin, "calls");
  await Deno.writeTextFile(log, "");
  const script = [
    "#!/bin/sh",
    'name=$(basename "$0")',
    `state=${bin}/$name.rules`,
    '[ "$1" = "-w" ] && shift 2',
    'case "$1" in',
    '  -S) cat "$state" ;;',
    "  -L)",
    '    echo "Chain $2"',
    '    echo "num  target     prot opt source               destination"',
    '    awk -v c="$2" \'$1 == "-A" && $2 == c { n++; t = "-"; for (i = 3; i < NF; i++) if ($i == "-j") t = $(i + 1); print n "    " t "  all  --" }\' "$state"',
    "    ;;",
    "  -D)",
    `    echo "$name $*" >> ${log}`,
    '    awk -v c="$2" -v k="$3" \'$1 == "-A" && $2 == c { n++; if (n == k) next } { print }\' "$state" > "$state.new" && mv "$state.new" "$state"',
    "    ;;",
    "  -F)",
    `    echo "$name $*" >> ${log}`,
    '    awk -v c="$2" \'!($1 == "-A" && $2 == c)\' "$state" > "$state.new" && mv "$state.new" "$state"',
    "    ;;",
    "  -X)",
    `    echo "$name $*" >> ${log}`,
    '    if grep -q -- "-j $2\\( \\|$\\)" "$state"; then exit 1; fi',
    '    awk -v c="$2" \'!($1 == "-N" && $2 == c)\' "$state" > "$state.new" && mv "$state.new" "$state"',
    "    ;;",
    "esac",
    "",
  ].join("\n");
  for (const name of ["iptables", "ip6tables"]) {
    await Deno.writeTextFile(join(bin, name), script, { mode: 0o755 });
    await Deno.writeTextFile(join(bin, `${name}.rules`), `${rules}\n`);
  }
  return { bin, log };
}

async function firewallPass(bin: string): Promise<void> {
  const result = await runPurgeSh(
    [
      "tp_firewall_delete_jumps",
      "tp_firewall_try_delete",
      "tp_firewall_family",
    ],
    "tp_firewall_family iptables\ntp_firewall_family ip6tables",
    { PATH: `${bin}:${BASE_PATH}` },
  );
  assertEquals(result.code, 0, result.stderr);
}

test("both firewall families end with only the operator's rules, and a second pass changes nothing", async () => {
  const operator = `-A DOCKER-USER -s ${OPERATOR_RANGE} -j ACCEPT`;
  const { bin, log } = await statefulFirewall(
    [
      "-P FORWARD DROP",
      "-N DOCKER-USER",
      "-N TP-FORWARD",
      "-N TP-FWD",
      "-A FORWARD -j TP-FORWARD",
      "-A DOCKER-USER -j TP-FORWARD",
      operator,
      "-A DOCKER-USER -j TP-FWD",
      "-A TP-FORWARD -i tp0 -o tp0 -j DROP",
      `-A TP-FORWARD -s ${BRIDGE_RANGE} -d ${LAN_RANGE} -o eth1 -j ACCEPT`,
      "-A TP-FWD -j TP-FORWARD",
    ].join("\n"),
  );
  await firewallPass(bin);
  for (const name of ["iptables", "ip6tables"]) {
    assertEquals(
      (await Deno.readTextFile(join(bin, `${name}.rules`))).trim().split("\n"),
      ["-P FORWARD DROP", "-N DOCKER-USER", operator],
    );
  }
  const first = (await Deno.readTextFile(log)).trim().split("\n");
  assert(
    first.some((c) => c.startsWith("ip6tables -X TP-FORWARD")),
    first.join("\n"),
  );
  await Deno.writeTextFile(log, "");
  await firewallPass(bin);
  assertEquals(await Deno.readTextFile(log), "");
});

test("the Docker gate folders are owned trees and are removed with the other folders", async () => {
  const source = await Deno.readTextFile(purgePath);
  const trees = extractConstant(source, "TP_OWNED_TREES") ?? "";
  const remove = extractFunction(source, "tp_remove_folders_and_shell") ?? "";
  // The gate's state folder sits inside /var/lib/turbopanel and goes with it.
  for (const dir of ["/run/turbopanel-gate", "/var/cache/turbopanel"]) {
    assertStringIncludes(trees, dir);
    assertStringIncludes(remove, `tp_safe_rm_tree ${dir}`);
  }
  assertEquals(trees.includes("turbopanel-docker-gate"), false);
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

const TUNNEL_UNITS = [
  "turbopanel-tunnel-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.service",
  "turbopanel-tunnel-1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e.service",
  "turbopanel-tunnel-instance.service",
  // The second unit a connector update starts beside the first.
  "turbopanel-tunnel-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d-b.service",
];

test("every tunnel connector service is stopped, disabled and its unit file removed", async () => {
  const units = await Deno.makeTempDir({ prefix: "tp-purge-units-" });
  for (const name of TUNNEL_UNITS) {
    await Deno.writeTextFile(join(units, name), "[Service]\n");
  }
  await Deno.writeTextFile(join(units, "unrelated.service"), "[Service]\n");
  const log = join(units, "systemctl.log");
  const stub = await stubBin(
    "systemctl",
    [
      `log=${log}`,
      'case "$*" in',
      "  *LoadState*) echo loaded ;;",
      "  *FragmentPath*) echo ;;",
      "  *ActiveState*) echo active ;;",
      "  is-active*) echo active ;;",
      "  is-enabled*) echo enabled ;;",
      "  *list-units*) cat <<'LIST'",
      ...TUNNEL_UNITS.map((u) =>
        `${u} loaded active running TurboPanel tunnel connector`
      ),
      "LIST",
      "  ;;",
      '  stop*|disable*) echo "$*" >> "$log" ;;',
      "esac",
    ].join("\n"),
  );
  const result = await runPurgeSh(
    [
      "tp_unit_present",
      "tp_list_has_word",
      "tp_collect_unit_names",
      "tp_stop_disable_unit",
      "tp_stop_units_matching",
      "tp_remove_unit_files",
    ],
    [
      `TP_SYSTEMD_DIRS=${units}`,
      "TP_LEGACY_UNITS=",
      "TP_OTHER_UNITS=",
      "tp_collect_unit_names",
      'cat "$TP_TMP/work.unitnames"',
      "tp_stop_units_matching service",
      "tp_remove_unit_files",
    ].join("\n"),
    { PATH: `${stub}:${BASE_PATH}` },
  );
  for (const name of TUNNEL_UNITS) {
    assertStringIncludes(result.stdout, `${name}\n`, result.stderr);
    assertEquals(await exists(join(units, name)), false, name);
  }
  const calls = (await Deno.readTextFile(log)).split("\n");
  for (const name of TUNNEL_UNITS) {
    assert(calls.includes(`stop ${name}`), `stop ${name}\n${calls.join("\n")}`);
    assert(calls.includes(`disable ${name}`), `disable ${name}`);
  }
  assertEquals(await exists(join(units, "unrelated.service")), true);
});

const TENANT_ACME_TEMPLATE = "turbopanel-tenant-acme@.service";
// Instances exist only in memory (started from the template), so systemd lists
// them but there is no file for them.
const TENANT_ACME_INSTANCES = [
  "turbopanel-tenant-acme@req_1.service",
  "turbopanel-tenant-acme@3f9c1e52-a7b4-4d10-9e2b-6c0d5a8f1b77.service",
];

test("a running certificate issuer is stopped and the template unit file is removed", async () => {
  const units = await Deno.makeTempDir({ prefix: "tp-purge-units-" });
  await Deno.writeTextFile(join(units, TENANT_ACME_TEMPLATE), "[Service]\n");
  await Deno.writeTextFile(join(units, "unrelated.service"), "[Service]\n");
  const log = join(units, "systemctl.log");
  const stub = await stubBin(
    "systemctl",
    [
      `log=${log}`,
      'case "$*" in',
      "  *LoadState*) echo loaded ;;",
      "  *FragmentPath*) echo ;;",
      "  *ActiveState*) echo active ;;",
      "  is-active*) echo active ;;",
      "  is-enabled*) echo static ;;",
      "  *list-units*) cat <<'LIST'",
      ...TENANT_ACME_INSTANCES.map((u) =>
        `${u} loaded active running TurboPanel certificate issuer`
      ),
      "LIST",
      "  ;;",
      '  stop*|disable*) echo "$*" >> "$log" ;;',
      "esac",
    ].join("\n"),
  );
  const result = await runPurgeSh(
    [
      "tp_unit_present",
      "tp_list_has_word",
      "tp_collect_unit_names",
      "tp_stop_disable_unit",
      "tp_stop_units_matching",
      "tp_remove_unit_files",
    ],
    [
      `TP_SYSTEMD_DIRS=${units}`,
      "TP_LEGACY_UNITS=",
      "TP_OTHER_UNITS=",
      "tp_collect_unit_names",
      'cat "$TP_TMP/work.unitnames"',
      "tp_stop_units_matching service",
      "tp_remove_unit_files",
    ].join("\n"),
    { PATH: `${stub}:${BASE_PATH}` },
  );
  for (const name of TENANT_ACME_INSTANCES) {
    assertStringIncludes(result.stdout, `${name}\n`, result.stderr);
  }
  const calls = (await Deno.readTextFile(log)).split("\n");
  for (const name of TENANT_ACME_INSTANCES) {
    assert(calls.includes(`stop ${name}`), `stop ${name}\n${calls.join("\n")}`);
  }
  assertEquals(await exists(join(units, TENANT_ACME_TEMPLATE)), false);
  assertEquals(await exists(join(units, "unrelated.service")), true);
});

test("the issuer's storage, requests, sockets and proof handlers sit in trees purge removes whole", async () => {
  const source = await Deno.readTextFile(purgePath);
  const trees = (extractConstant(source, "TP_OWNED_TREES") ?? "")
    .replace(/^[A-Z_]+="/, "")
    .replace(/"$/, "")
    .split(" ");
  // <state>/tenant-acme (account, requests, logs), <config>/hosting/proof and
  // the reserved proof sites, and <run>/tenant-acme-<id>.sock.
  for (
    const tree of ["/etc/turbopanel", "/var/lib/turbopanel", "/run/turbopanel"]
  ) {
    assert(trees.includes(tree), tree);
  }
});

test("the connector program and the token copies are inside trees purge removes whole", async () => {
  const source = await Deno.readTextFile(purgePath);
  const trees = (extractConstant(source, "TP_OWNED_TREES") ?? "")
    .replace(/^[A-Z_]+="/, "")
    .replace(/"$/, "")
    .split(" ");
  for (
    const tree of ["/opt/turbopanel", "/etc/turbopanel", "/var/lib/turbopanel"]
  ) {
    assert(trees.includes(tree), tree);
  }
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

const TP_TEST_UUID = "12345678-1234-1234-1234-123456789abc";

test("managed-ha orchestrator containers are included in the removal list", async () => {
  const result = await runPurgeSh(
    ["tp_docker_consider_row", "tp_file_add"],
    [
      ': > "$TP_TMP/work.containers"',
      `tp_docker_consider_row "${TP_TEST_UUID}-ha" - managed-ha - - - -`,
      'cat "$TP_TMP/work.containers"',
    ].join("\n"),
  );
  assertStringIncludes(result.stdout, `${TP_TEST_UUID}-ha`, result.stderr);
});

test("TurboPanel container names match only anchored UUID shapes", async () => {
  const fns = [
    "tp_is_turbopanel_container_name",
    "tp_docker_container_name_is_turbopanel",
    "tp_docker_consider_row",
    "tp_file_add",
    "tp_list_has_word",
  ];
  const owned = [
    TP_TEST_UUID,
    `${TP_TEST_UUID}-ha`,
    `${TP_TEST_UUID}-in`,
    `${TP_TEST_UUID}-1`,
  ];
  const foreign = [
    "myapp-ha",
    "nginx-ha",
    `${TP_TEST_UUID}-extra`,
    `${TP_TEST_UUID}-ha`.toUpperCase(),
    `prefix-${TP_TEST_UUID}`,
  ];
  for (const name of owned) {
    const result = await runPurgeSh(
      fns,
      `if tp_is_turbopanel_container_name "${name}"; then echo yes; else echo no; fi`,
    );
    assertEquals(result.stdout.trim(), "yes", name);
  }
  for (const name of foreign) {
    const result = await runPurgeSh(
      fns,
      `if tp_is_turbopanel_container_name "${name}"; then echo yes; else echo no; fi`,
    );
    assertEquals(result.stdout.trim(), "no", name);
  }
  const namesOnly = await runPurgeSh(
    fns,
    [
      ': > "$TP_TMP/work.containers"',
      ...foreign.map(
        (name) => `tp_docker_consider_row "${name}" - - - - - -`,
      ),
      `tp_docker_consider_row "${TP_TEST_UUID}-in" - - - - - -`,
      'wc -l < "$TP_TMP/work.containers"',
    ].join("\n"),
  );
  assertEquals(namesOnly.stdout.trim(), "1", namesOnly.stderr);
});

test("look-alike -ha names are not merged from the pre-purge inventory", async () => {
  const stub = await stubBin(
    "docker",
    [
      'case "$1" in',
      "  ps)",
      '    if [ "$2" = "-a" ]; then',
      '      printf "%s\\n" "myapp-ha|-|-|-|-|-|-"',
      "    fi",
      "    ;;",
      '  rm) echo rm:$3 >> "$TP_TMP/docker.rmlog" ;;',
      "esac",
    ].join("\n"),
  );
  const result = await runPurgeSh(
    [
      "tp_docker_ready",
      "tp_docker_collect",
      "tp_docker_consider_row",
      "tp_is_turbopanel_container_name",
      "tp_docker_container_name_is_turbopanel",
      "tp_docker_build_removal_list",
      "tp_docker_remove_one_container",
      "tp_remove_docker_containers",
      "tp_has_tool",
      "tp_list_has_word",
    ],
    [
      "export TP_TMP",
      'echo "myapp-ha" > "$TP_TMP/before.containers"',
      'tp_has_tool() { [ "$1" = docker ] && return 0; command -v "$1" >/dev/null 2>&1; }',
      "tp_docker_ready() { return 0; }",
      "tp_remove_docker_containers",
      'test ! -s "$TP_TMP/docker.rmlog" && echo no_removals',
    ].join("\n"),
    { PATH: `${stub}:${BASE_PATH}` },
  );
  assertStringIncludes(result.stdout, "no_removals", result.stderr);
});

test("container removal merges the pre-purge inventory and removes every name", async () => {
  const stub = await stubBin(
    "docker",
    [
      'case "$1" in',
      "  ps)",
      '    if [ "$2" = "-a" ]; then',
      '      printf "%s\\n" "turbopanel-database|turbopanel.role|database|-|-|-|-"',
      `      printf "%s\\\\n" "${TP_TEST_UUID}-ha|-|managed-ha|-|-|-|-"`,
      "    fi",
      "    ;;",
      '  rm) echo rm:$3 >> "$TP_TMP/docker.rmlog" ;;',
      "esac",
    ].join("\n"),
  );
  const result = await runPurgeSh(
    [
      "tp_docker_ready",
      "tp_docker_collect",
      "tp_docker_consider_row",
      "tp_docker_build_removal_list",
      "tp_docker_remove_one_container",
      "tp_remove_docker_containers",
      "tp_has_tool",
    ],
    [
      "export TP_TMP",
      'echo "turbopanel-database" > "$TP_TMP/before.containers"',
      `echo "${TP_TEST_UUID}-ha" >> "$TP_TMP/before.containers"`,
      'tp_has_tool() { [ "$1" = docker ] && return 0; command -v "$1" >/dev/null 2>&1; }',
      "tp_docker_ready() { return 0; }",
      "tp_remove_docker_containers",
      "tp_remove_docker_containers",
      'sort "$TP_TMP/docker.rmlog"',
    ].join("\n"),
    { PATH: `${stub}:${BASE_PATH}` },
  );
  const lines = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("rm:"));
  lines.sort();
  assertEquals(lines, [
    `rm:${TP_TEST_UUID}-ha`,
    `rm:${TP_TEST_UUID}-ha`,
    "rm:turbopanel-database",
    "rm:turbopanel-database",
  ]);
});

test("the summary does not treat inactive slices as left over after they unload", async () => {
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
  const result = await runPurgeSh(
    ["tp_unit_present", "tp_report_remaining"],
    [
      'printf "%s\\n" turbopanel.slice turbopanel-containers.slice > "$TP_TMP/before.units"',
      'printf "%s\\n" turbopanel.slice turbopanel-containers.slice > "$TP_TMP/inv.units"',
      "tp_report_remaining units units",
      'test ! -s "$TP_TMP/failed" && echo summary_ok',
    ].join("\n"),
    { PATH: `${stub}:${BASE_PATH}` },
  );
  assertStringIncludes(result.stdout, "summary_ok", result.stderr);
});

test("a slice whose unit file is already gone is not still counted as present", async () => {
  const units = await Deno.makeTempDir({ prefix: "tp-purge-units-" });
  const stub = await stubBin(
    "systemctl",
    [
      'case "$*" in',
      "  *LoadState*) echo loaded ;;",
      "  *FragmentPath*) echo /etc/systemd/system/turbopanel.slice ;;",
      "  *ActiveState*) echo inactive ;;",
      "esac",
    ].join("\n"),
  );
  const result = await runPurgeSh(
    ["tp_unit_present"],
    `TP_SYSTEMD_DIRS=${units}\nif tp_unit_present turbopanel.slice; then echo present; else echo absent; fi`,
    { PATH: `${stub}:${BASE_PATH}` },
  );
  assertEquals(result.stdout.trim(), "absent", result.stderr);
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

test("the hosting Caddy state folder is inside the state tree and goes with it", async () => {
  const source = await Deno.readTextFile(purgePath);
  const trees = extractConstant(source, "TP_OWNED_TREES") ?? "";
  assertStringIncludes(trees, " /var/lib/turbopanel ");
  assertEquals(trees.includes("turbopanel-hosting-caddy"), false);
  assertEquals(source.includes("/var/lib/turbopanel-hosting-caddy"), false);
});

test("the tunnel forwarding files live in the config tree and go with it", async () => {
  const source = await Deno.readTextFile(purgePath);
  const trees = extractConstant(source, "TP_OWNED_TREES") ?? "";
  // 10-tunnels.caddy, tunnel-routes.json and the peer certificate folder sit
  // under /etc/turbopanel/hosting, so no separate purge entry exists for them.
  assertStringIncludes(trees, " /etc/turbopanel ");
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

test("Docker Engine still-installed warning follows dpkg, not a stale dockerd on PATH", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-deb-" });
  await Deno.writeTextFile(
    join(dir, "dpkg-query"),
    '#!/bin/sh\ncase "$*" in *-s*docker-ce*) exit 1 ;; *) exit 0 ;; esac\n',
    { mode: 0o755 },
  );
  await Deno.writeTextFile(join(dir, "dockerd"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await Deno.symlink("/bin/sh", join(dir, "sh"));
  const result = await runPurgeSh(
    [
      "tp_docker_engine_packages_remain",
      "tp_pkg_installed",
      "tp_has_tool",
      "tp_docker_engine_gone",
    ],
    [
      "DRY_RUN=false",
      "if tp_docker_engine_packages_remain; then echo packages=yes; else echo packages=no; fi",
      "if tp_docker_engine_gone; then echo gone=yes; else echo gone=no; fi",
    ].join("\n"),
    { PATH: dir, TP_DOCKER_SOCKETS: "/nonexistent/x.sock" },
  );
  assertStringIncludes(result.stdout, "packages=no");
  assertStringIncludes(result.stdout, "gone=no");
});

test("moby or snap Docker left after apt purge does not mark the engine gone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-moby-" });
  await Deno.writeTextFile(
    join(dir, "dpkg-query"),
    '#!/bin/sh\ncase "$*" in *moby-engine*) printf "install ok installed\\n" ;; *) exit 1 ;; esac\n',
    { mode: 0o755 },
  );
  await Deno.symlink("/bin/sh", join(dir, "sh"));
  const result = await runPurgeSh(
    ["tp_docker_engine_gone", "tp_has_tool", "tp_pkg_installed"],
    [
      "DRY_RUN=false",
      "TP_DOCKER_ENGINE_GONE=false",
      "if tp_docker_engine_gone; then TP_DOCKER_ENGINE_GONE=true; else tp_print_warn leftover; fi",
      'echo "gone=${TP_DOCKER_ENGINE_GONE}"',
    ].join("\n"),
    { PATH: dir, TP_DOCKER_SOCKETS: "/nonexistent/x.sock" },
  );
  assertStringIncludes(result.stdout, "gone=false");
  assertStringIncludes(result.stderr + result.stdout, "leftover");
});

test("Docker Engine counts as gone only when no daemon, snap, package or service remains", async () => {
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

test("a dry run does not let the account it would delete block its own group", async () => {
  const dry = await purgeGroups(
    ["frank:x:15007:"],
    ["frank:x:15007:15007::/srv/users/frank:/bin/sh"],
    `{ DRY_RUN=true; tp_purge_principal_groups frank /srv/users/frank account; }`,
  );
  assertStringIncludes(dry.stdout, "groupdel frank");
  assertStringIncludes(dry.stdout, "KEPT_HOME=no");
  assert(!dry.stdout.includes("primary group"), dry.stdout);

  // Another account with the group as its primary group still blocks it, in a
  // dry run as well as a real one.
  const other = await purgeGroups(
    ["frank:x:15007:"],
    [
      "frank:x:15007:15007::/srv/users/frank:/bin/sh",
      "gina:x:15008:15007::/home/gina:/bin/sh",
    ],
    `{ DRY_RUN=true; tp_purge_principal_groups frank /srv/users/frank account; }`,
  );
  assert(!other.stdout.includes("groupdel"), other.stdout);
  assertStringIncludes(other.stdout, "KEPT_HOME=yes");
});

async function timerStampDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-timers-" });
  for (
    const name of [
      "stamp-turbopanel-backup-a1.timer",
      "stamp-turbopanel-postgres-backup.timer",
      "stamp-fstrim.timer",
      "stamp-apt-daily.timer",
      "stamp-turbopanel-backup-a1.service",
      "turbopanel-backup-a1.timer",
    ]
  ) await Deno.writeTextFile(join(dir, name), "");
  return dir;
}

const TIMER_GLOB =
  `tp_remove_glob "$TP_TIMER_STAMP_DIR/stamp-turbopanel-*.timer"`;

test("purge removes TurboPanel's persistent timer stamps and leaves other stamp files alone", async () => {
  const dir = await timerStampDir();
  const result = await runPurgeSh(
    ["tp_remove_glob"],
    `TP_TIMER_STAMP_DIR=${dir}\n${TIMER_GLOB}`,
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(
    await exists(join(dir, "stamp-turbopanel-backup-a1.timer")),
    false,
  );
  assertEquals(
    await exists(join(dir, "stamp-turbopanel-postgres-backup.timer")),
    false,
  );
  for (
    const kept of [
      "stamp-fstrim.timer",
      "stamp-apt-daily.timer",
      "stamp-turbopanel-backup-a1.service",
      "turbopanel-backup-a1.timer",
    ]
  ) assertEquals(await exists(join(dir, kept)), true, kept);
});

test("a dry run leaves the timer stamps in place, and the real step uses the stamp directory", async () => {
  const dir = await timerStampDir();
  const result = await runPurgeSh(
    ["tp_remove_glob"],
    `TP_TIMER_STAMP_DIR=${dir}\nDRY_RUN=true\n${TIMER_GLOB}`,
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(
    await exists(join(dir, "stamp-turbopanel-backup-a1.timer")),
    true,
  );

  const source = await Deno.readTextFile(purgePath);
  assertEquals(
    extractConstant(source, "TP_TIMER_STAMP_DIR"),
    "TP_TIMER_STAMP_DIR=/var/lib/systemd/timers",
  );
  assertStringIncludes(
    extractFunction(source, "tp_remove_host_config") ?? "",
    TIMER_GLOB,
  );
});

test("the inventory lists TurboPanel's timer stamps and nothing else from that folder", async () => {
  const dir = await timerStampDir();
  const result = await runPurgeSh(
    ["tp_inventory_host_files"],
    `TP_TIMER_STAMP_DIR=${dir}\n: > "$TP_TMP/inv.hostfiles"\ntp_inventory_host_files\ncat "$TP_TMP/inv.hostfiles"`,
  );
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "stamp-turbopanel-backup-a1.timer");
  assertStringIncludes(result.stdout, "stamp-turbopanel-postgres-backup.timer");
  assertEquals(result.stdout.includes("stamp-fstrim"), false);
  assertEquals(result.stdout.includes("stamp-apt-daily"), false);
  assertEquals(result.stdout.includes(".service"), false);
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

const DOCKER_SOURCE_FUNCTIONS = [
  "tp_purge_docker_sources",
  "tp_collect_signed_by",
];

// Lays out a fake apt tree under a temp dir and points the purge's apt
// constants at it. Key-path safety is stubbed to "inside the temp keyrings
// dir", since the real check only accepts the host's own keyring directories.
async function dockerAptTree(): Promise<{ root: string; preamble: string }> {
  const root = await Deno.makeTempDir({ prefix: "tp-purge-apt-" });
  await Deno.mkdir(join(root, "sources.list.d"));
  await Deno.mkdir(join(root, "keyrings"));
  const src = (name: string) => join(root, "sources.list.d", name);
  const key = (name: string) => join(root, "keyrings", name);
  const preamble = [
    `TP_APT_SOURCES_DIR=${join(root, "sources.list.d")}`,
    `TP_DOCKER_APT_SOURCES="${src("docker.sources")} ${src("docker.list")}"`,
    `TP_DOCKER_APT_KEYS="${key("docker.asc")} ${key("docker.asc.fetched")} ${
      key("docker.gpg")
    }"`,
    `tp_apt_keyring_path_ok() { case $1 in ${
      join(root, "keyrings")
    }/*) return 0 ;; esac; return 1; }`,
  ].join("\n");
  return { root, preamble };
}

test("Docker's apt source and key go by name too: offline source, orphan key, temp key copy", async () => {
  const { root, preamble } = await dockerAptTree();
  const src = (name: string) => join(root, "sources.list.d", name);
  const key = (name: string) => join(root, "keyrings", name);
  // The offline install's source has no download.docker.com and no key.
  await Deno.writeTextFile(
    src("docker.sources"),
    "Types: deb\nURIs: file:///srv/docker-debs\nSuites: ./\nTrusted: yes\n",
  );
  // An old one-line source found by its content, with its own Signed-By key.
  await Deno.writeTextFile(
    src("old-docker.list"),
    `deb [arch=amd64 signed-by=${
      key("old-docker.gpg")
    }] https://download.docker.com/linux/debian trixie stable\n`,
  );
  await Deno.writeTextFile(
    src("other.sources"),
    "Types: deb\nURIs: https://deb.example.org\nSuites: trixie\n",
  );
  // Keys whose source is already gone: a half-finished install, or an
  // interrupted purge, and the key download's temporary copy.
  for (
    const name of [
      "docker.asc",
      "docker.asc.fetched",
      "old-docker.gpg",
      "other.gpg",
    ]
  ) {
    await Deno.writeTextFile(key(name), "key\n");
  }
  const result = await runPurgeSh(
    DOCKER_SOURCE_FUNCTIONS,
    `${preamble}\ntp_purge_docker_sources\necho "fail=$TP_FAIL_COUNT"`,
  );
  assertStringIncludes(result.stdout, "fail=0", result.stderr);
  for (
    const gone of [
      src("docker.sources"),
      src("old-docker.list"),
      key("docker.asc"),
      key("docker.asc.fetched"),
      key("old-docker.gpg"),
    ]
  ) {
    assertEquals(await exists(gone), false, `${gone} was left`);
  }
  assertEquals(await exists(src("other.sources")), true);
  assertEquals(await exists(key("other.gpg")), true);
  // A second run over the clean tree changes nothing and fails nothing.
  const again = await runPurgeSh(
    DOCKER_SOURCE_FUNCTIONS,
    `${preamble}\ntp_purge_docker_sources\necho "fail=$TP_FAIL_COUNT"\ncat "$TP_TMP/removed" 2>/dev/null || true`,
  );
  assertEquals(again.stdout.trim(), "fail=0", again.stderr);
});

test("a Docker source found by content and by name is removed once, and a dry run only logs", async () => {
  const { root, preamble } = await dockerAptTree();
  const sources = join(root, "sources.list.d", "docker.sources");
  const key = join(root, "keyrings", "docker.asc");
  await Deno.writeTextFile(
    sources,
    `Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: trixie\nComponents: stable\nSigned-By: ${key}\n`,
  );
  await Deno.writeTextFile(key, "key\n");
  const result = await runPurgeSh(
    DOCKER_SOURCE_FUNCTIONS,
    `${preamble}\nDRY_RUN=true\ntp_purge_docker_sources\ncat "$TP_TMP/removed"`,
  );
  const lines = result.stdout.split("\n").filter((l) =>
    l.includes("[dry-run]")
  );
  assertEquals(
    lines.filter((l) => l.includes("[dry-run] remove ")).sort(),
    [`[dry-run] remove ${key}`, `[dry-run] remove ${sources}`],
    result.stdout,
  );
  assertEquals(await exists(sources), true);
  assertEquals(await exists(key), true);
});

test("a Docker Signed-By key outside the apt keyring directories is refused, not removed", async () => {
  const { root, preamble } = await dockerAptTree();
  const outside = join(root, "elsewhere.gpg");
  await Deno.writeTextFile(outside, "key\n");
  await Deno.writeTextFile(
    join(root, "sources.list.d", "docker.list"),
    `deb [signed-by=${outside}] https://download.docker.com/linux/debian trixie stable\n`,
  );
  const result = await runPurgeSh(
    DOCKER_SOURCE_FUNCTIONS,
    `${preamble}\ntp_purge_docker_sources\necho "fail=$TP_FAIL_COUNT"`,
  );
  assertStringIncludes(result.stdout, "fail=1", result.stderr);
  assertEquals(await exists(outside), true);
});

test("the PHP repository's loose signing key is evidence and is removed with the source", async () => {
  const keys = await Deno.makeTempDir({ prefix: "tp-purge-sury-" });
  const key = join(keys, "turbopanel-sury-php.gpg");
  const fetchedKey = `${key}.fetched`;
  await Deno.writeTextFile(key, "key\n");
  await Deno.writeTextFile(fetchedKey, "key\n");
  const apt = await fakeAptBin();
  const dpkg = await fakeDpkgBin([]);
  const result = await runPurgeSh(
    [
      ...PACKAGE_FUNCTIONS,
      "tp_purge_apt_packages",
      "tp_collect_purge_candidates",
      "tp_sury_evidence",
      "tp_pkg_installed",
    ],
    [
      `TP_SURY_APT_KEYS="${key} ${fetchedKey}"`,
      "if tp_sury_evidence; then echo evidence=yes; else echo evidence=no; fi",
      "tp_purge_apt_packages",
      'echo "fail=$TP_FAIL_COUNT"',
    ].join("\n"),
    {
      PATH: `${apt}:${dpkg}:${REAL_PATH}`,
      FAKE_APT_LOG: join(apt, "apt.log"),
    },
  );
  assertStringIncludes(result.stdout, "evidence=yes", result.stderr);
  assertStringIncludes(result.stdout, "fail=0", result.stderr);
  assertEquals(await exists(key), false, "the sury key was left");
  assertEquals(
    await exists(fetchedKey),
    false,
    "the sury key download copy was left",
  );
});

// A fake dpkg-query that answers `-W -f '${Status}\n' <pkg>` from a table of
// real dpkg Status strings, and the package list for any other query. Once
// $FAKE_DPKG_PURGED exists (the fake apt-get below writes it on a real purge),
// every package it lists reads as not installed.
async function fakeStatusDpkg(
  dir: string,
  statuses: Record<string, string>,
): Promise<void> {
  // printf repeats its format, so a Multi-Arch package prints one line each.
  const cases = Object.entries(statuses).map(([pkg, status]) =>
    `  ${pkg}) printf '%s\\n' ${
      status.split("\n").map((line) => `'${line}'`).join(" ")
    } ;;`
  );
  const script = [
    "#!/bin/sh",
    'for last in "$@"; do :; done',
    'if [ -n "${FAKE_DPKG_PURGED:-}" ] && [ -f "$FAKE_DPKG_PURGED" ] && grep -Fxq "$last" "$FAKE_DPKG_PURGED"; then',
    "  exit 1",
    "fi",
    'case "$last" in',
    ...cases,
    "  *) exit 1 ;;",
    "esac",
    "",
  ].join("\n");
  await Deno.writeTextFile(join(dir, "dpkg-query"), script, { mode: 0o755 });
}

test("a held, half-installed or conffiles-only package counts by dpkg's state, not its want", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-status-" });
  const statuses: Record<string, string> = {
    held: "hold ok installed",
    plain: "install ok installed",
    reinst: "install reinstreq half-installed",
    heldunpacked: "hold ok unpacked",
    halfconf: "install ok half-configured",
    trigaw: "install ok triggers-awaited",
    trigpend: "install ok triggers-pending",
    rc: "deinstall ok config-files",
    gone: "purge ok not-installed",
    unknownwant: "unknown ok not-installed",
    multiarch: "deinstall ok config-files\nhold ok installed",
  };
  await fakeStatusDpkg(dir, statuses);
  // Only sh on PATH: the status check must not need any other tool.
  await Deno.symlink("/bin/sh", join(dir, "sh"));
  const names = [...Object.keys(statuses), "neverseen"];
  const result = await runPurgeSh(
    [],
    names.map((p) =>
      `i=no; tp_pkg_installed ${p} && i=yes; g=no; tp_pkg_purgeable ${p} && g=yes; echo "${p}=$i/$g"`
    ).join("\n"),
    { PATH: dir },
  );
  const got = Object.fromEntries(
    result.stdout.trim().split("\n").map((l) => l.split("=")),
  );
  assertEquals(got, {
    held: "yes/yes",
    plain: "yes/yes",
    reinst: "yes/yes",
    heldunpacked: "yes/yes",
    halfconf: "yes/yes",
    trigaw: "yes/yes",
    trigpend: "yes/yes",
    rc: "no/yes",
    gone: "no/no",
    unknownwant: "no/no",
    multiarch: "yes/yes",
    neverseen: "no/no",
  }, result.stderr);
});

test("a re-run on a half-purged host purges the held Docker packages and their leftovers", async () => {
  // The state the first real purge left: docker-ce and docker-ce-cli held,
  // containerd.io kept, Docker's apt source and key already gone, the purge
  // marker still there, and docker's enablement links left behind.
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-resume-" });
  const purged = join(dir, "purged");
  await fakeStatusDpkg(dir, {
    "docker-ce": "hold ok installed",
    "docker-ce-cli": "hold ok installed",
    "containerd.io": "install ok installed",
    "docker-compose-plugin": "install ok installed",
    "docker.io": "purge ok not-installed",
  });
  const aptLog = join(dir, "apt.log");
  // Simulation passes on held packages; a real purge of a held one needs the
  // flag. A real purge records the packages as gone for the fake dpkg-query.
  await Deno.writeTextFile(
    join(dir, "apt-get"),
    [
      "#!/bin/sh",
      'case " $* " in *" -s "*)',
      '  for a in "$@"; do case $a in -*|purge) ;; *) echo "Purg $a [1.0]" ;; esac; done',
      "  exit 0 ;;",
      "esac",
      'case " $* " in *" --allow-change-held-packages "*) ;; *)',
      '  echo "refused: $*" >> "$FAKE_APT_LOG"; exit 100 ;;',
      "esac",
      'echo "$*" >> "$FAKE_APT_LOG"',
      'for a in "$@"; do case $a in -*|purge|env|LC_ALL=*|DEBIAN_FRONTEND=*) ;; *) echo "$a" >> "$FAKE_DPKG_PURGED" ;; esac; done',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const units = join(dir, "systemd");
  await Deno.mkdir(join(units, "multi-user.target.wants"), { recursive: true });
  await Deno.mkdir(join(units, "sockets.target.wants"));
  await Deno.mkdir(join(units, "docker.service.d"));
  await Deno.symlink(
    join(dir, "gone", "docker.service"),
    join(units, "multi-user.target.wants", "docker.service"),
  );
  await Deno.symlink(
    join(dir, "gone", "docker.socket"),
    join(units, "sockets.target.wants", "docker.socket"),
  );
  // The link targets sit under a directory that does not exist, so they are
  // dangling on any machine (a CI runner can have the real Docker units).
  // An admin's own containerd unit file is a real file and stays.
  await Deno.writeTextFile(join(units, "containerd.service"), "[Unit]\n");
  const resume = join(dir, "turbopanel-purge");
  await Deno.mkdir(resume);
  await Deno.writeTextFile(join(resume, "purge-in-progress"), "1\n");
  await Deno.writeTextFile(join(resume, "resume-manifest"), "\n");
  const result = await runPurgeSh(
    [
      ...PACKAGE_FUNCTIONS,
      "tp_collect_docker_packages",
      "tp_docker_engine_packages_remain",
      "tp_purge_docker_unit_leftovers",
      "tp_resume_clearable",
      "tp_clear_purge_resume",
      "tp_purge_marker_pending",
    ],
    [
      `TP_SYSTEMD_DIRS=${units}`,
      `TP_RESUME_DIR=${resume}`,
      `TP_PURGE_MARKER=${resume}/purge-in-progress`,
      `TP_RESUME_MANIFEST=${resume}/resume-manifest`,
      "tp_collect_docker_packages",
      'echo "selected=$(tr "\\n" " " < "$TP_TMP/docker.pkgs")"',
      'tp_purge_guarded_packages Docker "$TP_TMP/docker.pkgs"',
      "if tp_docker_engine_packages_remain; then echo remain=yes; else echo remain=no; fi",
      "tp_purge_docker_unit_leftovers",
      "tp_resume_clearable && tp_clear_purge_resume",
      'echo "fail=$TP_FAIL_COUNT"',
    ].join("\n"),
    {
      PATH: `${dir}:${REAL_PATH}`,
      FAKE_APT_LOG: aptLog,
      FAKE_DPKG_PURGED: purged,
    },
  );
  assertStringIncludes(
    result.stdout,
    "selected=docker-ce docker-ce-cli containerd.io docker-compose-plugin ",
    result.stderr,
  );
  const calls = await Deno.readTextFile(aptLog);
  assert(!calls.includes("refused"), calls);
  assertStringIncludes(
    calls,
    "purge -y --allow-change-held-packages containerd.io docker-ce docker-ce-cli docker-compose-plugin",
  );
  assertStringIncludes(result.stdout, "remain=no");
  assertStringIncludes(result.stdout, "fail=0");
  assertEquals(
    await exists(join(units, "multi-user.target.wants", "docker.service")),
    false,
  );
  assertEquals(
    await exists(join(units, "sockets.target.wants", "docker.socket")),
    false,
  );
  assertEquals(await exists(join(units, "docker.service.d")), false);
  assertEquals(await exists(join(units, "containerd.service")), true);
  assertEquals(await exists(join(resume, "purge-in-progress")), false);
});

test("failed-state reset names only loaded failed TurboPanel units, whatever is in the working directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-reset-" });
  const log = join(dir, "systemctl.log");
  // reset-failed on a name systemd has not loaded exits 1, as the real one does.
  await Deno.writeTextFile(
    join(dir, "systemctl"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_SYSTEMCTL_LOG"',
      'case "$1" in',
      "  list-units) printf '%s\\n' \"$FAKE_FAILED\" ;;",
      "  reset-failed)",
      "    shift",
      '    for u in "$@"; do case " $FAKE_FAILED_NAMES " in *" $u "*) ;; *) echo "Unit $u not loaded." >&2; exit 1 ;; esac; done ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // The working directory holds a turbopanel-orchestrate folder, as /tmp did
  // on the host where the unquoted glob turned into that unit name.
  const cwd = join(dir, "cwd");
  await Deno.mkdir(join(cwd, "turbopanel-orchestrate"), { recursive: true });
  const run = (failed: string, names: string) =>
    runPurgeSh(
      ["tp_reset_failed_units"],
      `cd ${cwd}\ntp_reset_failed_units\necho "fail=$TP_FAIL_COUNT"`,
      {
        PATH: `${dir}:${REAL_PATH}`,
        FAKE_SYSTEMCTL_LOG: log,
        FAKE_FAILED: failed,
        FAKE_FAILED_NAMES: names,
      },
    );
  const none = await run("", "");
  assertStringIncludes(none.stdout, "fail=0", none.stderr);
  let calls = await Deno.readTextFile(log);
  assert(!calls.includes("reset-failed"), calls);
  assertStringIncludes(calls, "turbopanel* turbopaneld* wg-quick@tp0.service");
  await Deno.remove(log);
  const some = await run(
    "turbopanel-ui.service loaded failed failed UI\n● turbopanel-caddy.service loaded failed failed Caddy",
    "turbopanel-ui.service turbopanel-caddy.service",
  );
  assertStringIncludes(some.stdout, "fail=0", some.stderr);
  calls = await Deno.readTextFile(log);
  assertStringIncludes(
    calls,
    "reset-failed turbopanel-ui.service turbopanel-caddy.service",
  );
  assert(!calls.includes("turbopanel-orchestrate"), calls);
});

async function dockerGroupRun(
  statuses: Record<string, string>,
  systemctlBody = "exit 0",
): Promise<ShResult> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-dgrp-" });
  await fakeStatusDpkg(dir, statuses);
  await Deno.writeTextFile(
    join(dir, "systemctl"),
    `#!/bin/sh\n${systemctlBody}\n`,
    {
      mode: 0o755,
    },
  );
  await Deno.symlink("/bin/sh", join(dir, "sh"));
  const result = await runPurgeSh(
    [
      "tp_purge_docker_group",
      "tp_reset_failed_docker_units",
      "tp_has_tool",
      "tp_pkg_installed",
      "tp_docker_engine_packages_remain",
    ],
    [
      GROUP_STUBS,
      `printf '%s\\n' 'docker:x:989:tp' 'sudo:x:27:' > "$TP_TMP/group"`,
      "tp_purge_docker_group",
      `if getent group docker >/dev/null 2>&1; then echo GROUP=kept; else echo GROUP=gone; fi`,
    ].join("\n"),
    { PATH: `${dir}:/usr/bin:/bin` },
  );
  return { ...result, stdout: result.stdout + result.stderr };
}

test("the docker group stays while Docker Engine packages remain", async () => {
  const result = await dockerGroupRun({
    "docker-ce": "install ok installed",
    "containerd.io": "install ok installed",
  });
  assertStringIncludes(result.stdout, "GROUP=kept");
  assertEquals(result.stdout.includes("groupdel docker"), false);
  assertStringIncludes(result.stdout, "keeping the docker group");
});

test("the docker group is deleted once the engine packages are gone", async () => {
  const result = await dockerGroupRun({
    "docker-ce": "purge ok not-installed",
    "docker.io": "deinstall ok config-files",
  });
  assertStringIncludes(result.stdout, "groupdel docker");
  assertStringIncludes(result.stdout, "GROUP=gone");
});

test("failed Docker units are reset, and only the ones systemd holds as failed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-rfd-" });
  const calls = join(dir, "calls");
  await Deno.writeTextFile(
    join(dir, "systemctl"),
    `#!/bin/sh
case "$1" in
  is-failed) if [ "$2" = docker.socket ]; then echo failed; exit 0; fi; echo inactive; exit 1 ;;
  reset-failed) shift; echo "$*" >> "${calls}"; exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  await Deno.symlink("/bin/sh", join(dir, "sh"));
  const result = await runPurgeSh(
    ["tp_reset_failed_docker_units", "tp_has_tool"],
    "tp_reset_failed_docker_units; echo fail=$TP_FAIL_COUNT",
    { PATH: dir },
  );
  assertStringIncludes(result.stdout, "fail=0");
  assertEquals((await Deno.readTextFile(calls)).trim(), "docker.socket");
});

async function staleSocketRun(listening: boolean): Promise<ShResult> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-sock-" });
  const sock = join(dir, "docker.sock");
  const server = Deno.listen({ transport: "unix", path: sock });
  if (!listening) server.close();
  const ss = `#!/bin/sh\n${
    listening ? `echo "u_str LISTEN 0 4096 ${sock} 1 * 0"` : "true"
  }\n`;
  const bin = join(dir, "bin");
  await Deno.mkdir(bin);
  await Deno.writeTextFile(join(bin, "ss"), ss, { mode: 0o755 });
  await Deno.symlink("/bin/sh", join(bin, "sh"));
  await Deno.symlink("/usr/bin/grep", join(bin, "grep")).catch(() =>
    Deno.symlink("/bin/grep", join(bin, "grep"))
  );
  await Deno.symlink("/bin/rm", join(bin, "rm")).catch(() =>
    Deno.symlink("/usr/bin/rm", join(bin, "rm"))
  );
  const result = await runPurgeSh(
    [
      "tp_docker_engine_gone",
      "tp_socket_listening",
      "tp_purge_docker_stale_sockets",
      "tp_has_tool",
      "tp_pkg_installed",
    ],
    `DRY_RUN=false
if tp_docker_engine_gone; then echo gone; tp_purge_docker_stale_sockets; else echo present; fi
if [ -S "${sock}" ]; then echo sock=left; else echo sock=removed; fi`,
    { PATH: bin, TP_DOCKER_SOCKETS: sock },
  );
  if (listening) server.close();
  return { ...result, stdout: result.stdout + result.stderr };
}

test("a stale docker socket file with nothing installed counts as gone and is removed", async () => {
  const result = await staleSocketRun(false);
  assertStringIncludes(result.stdout, "gone");
  assertStringIncludes(result.stdout, "sock=removed");
});

test("a docker socket with a live listener keeps the engine present and the socket", async () => {
  const result = await staleSocketRun(true);
  assertStringIncludes(result.stdout, "present");
  assertStringIncludes(result.stdout, "sock=left");
});

test("docker group stays when only containerd.io remains", async () => {
  const result = await dockerGroupRun({
    "docker-ce": "purge ok not-installed",
    "containerd.io": "install ok installed",
  });
  assertStringIncludes(result.stdout, "GROUP=kept");
});

async function socketPathRun(
  ssBody: string,
  checkPath: string,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-sockp-" });
  if (ssBody) {
    await Deno.writeTextFile(join(dir, "ss"), `#!/bin/sh\n${ssBody}\n`, {
      mode: 0o755,
    });
  }
  await Deno.symlink("/bin/sh", join(dir, "sh"));
  await Deno.symlink("/usr/bin/grep", join(dir, "grep")).catch(() =>
    Deno.symlink("/bin/grep", join(dir, "grep"))
  );
  const result = await runPurgeSh(
    ["tp_socket_listening", "tp_has_tool"],
    `if tp_socket_listening ${checkPath}; then echo LIVE; else echo STALE; fi`,
    { PATH: dir },
  );
  return result.stdout;
}

test("a listener bound as /var/run/docker.sock counts for /run/docker.sock and back", async () => {
  const a = await socketPathRun(
    'echo "u_str LISTEN 0 4096 /var/run/docker.sock 1 * 0"',
    "/run/docker.sock",
  );
  assertStringIncludes(a, "LIVE");
  const b = await socketPathRun(
    'echo "u_str LISTEN 0 4096 /run/docker.sock 1 * 0"',
    "/var/run/docker.sock",
  );
  assertStringIncludes(b, "LIVE");
});

test("a socket nobody listens on is stale, ss failing is uncertain (live), no ss is stale", async () => {
  assertStringIncludes(
    await socketPathRun(
      'echo "u_str LISTEN 0 4096 /run/other.sock 1 * 0"',
      "/run/docker.sock",
    ),
    "STALE",
  );
  assertStringIncludes(
    await socketPathRun("exit 1", "/run/docker.sock"),
    "LIVE",
  );
  assertStringIncludes(await socketPathRun("", "/run/docker.sock"), "STALE");
});

async function forwardPolicyRun(
  afterRules: string,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-purge-fwd-" });
  const calls = join(dir, "calls");
  await Deno.writeTextFile(
    join(dir, "iptables"),
    [
      "#!/bin/sh",
      `echo "iptables $*" >> ${calls}`,
      'case "$*" in',
      `  *"-t filter -S") printf -- "${afterRules}" ;;`,
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  const result = await runPurgeSh(
    ["tp_restore_forward_policy"],
    "tp_restore_forward_policy iptables",
    { PATH: `${dir}:${BASE_PATH}` },
  );
  assertEquals(result.code, 0, result.stderr);
  try {
    return await Deno.readTextFile(calls);
  } catch {
    return "";
  }
}

test("a FORWARD policy of DROP with no FORWARD rules left goes back to ACCEPT", async () => {
  const log = await forwardPolicyRun(
    "-P INPUT ACCEPT\\n-P FORWARD DROP\\n-P OUTPUT ACCEPT\\n",
  );
  assertStringIncludes(log, "-t filter -P FORWARD ACCEPT");
});

test("an operator's FORWARD rule, or a policy that is not DROP, leaves the policy alone", async () => {
  const kept = await forwardPolicyRun(
    "-P FORWARD DROP\\n-A FORWARD -s 10.0.0.1 -j ACCEPT\\n",
  );
  assert(!kept.includes("-P FORWARD ACCEPT"), kept);
  const accept = await forwardPolicyRun("-P FORWARD ACCEPT\\n");
  assert(!accept.includes("-P FORWARD ACCEPT"), accept);
});

async function purgeNotes(
  marker: boolean,
  bootLines: string[] | null,
  forward: string,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "tp-purge-notes-" });
  const markers = join(root, "kernel");
  await Deno.mkdir(markers);
  if (marker) {
    await Deno.writeTextFile(join(markers, "pi-4k-pagesize.applied"), "x\n");
  }
  const boot = join(root, "config.txt");
  if (bootLines) await Deno.writeTextFile(boot, bootLines.join("\n") + "\n");
  const fwd = join(root, "ip_forward");
  await Deno.writeTextFile(fwd, `${forward}\n`);
  const result = await runPurgeSh(
    [
      "tp_print_group",
      "tp_note_ip_forward",
      "tp_note_kernel_boot_line",
      "tp_print_purge_notes",
    ],
    [
      `TP_KERNEL_MARKER_DIR=${markers}`,
      `TP_PI_BOOT_CONFIG=${boot}`,
      `TP_IP_FORWARD_FILE=${fwd}`,
      "TP_NET_LEFT=false",
      ': > "$TP_TMP/kept-packages"',
      "tp_print_purge_notes",
    ].join("\n"),
  );
  assertEquals(result.code, 0, result.stderr);
  return result.stdout;
}

test("the Pi page-size boot line is left on purpose and the summary says how to undo it", async () => {
  const out = await purgeNotes(true, [
    "kernel=kernel8.img",
    "[all]",
    "dtparam=audio=on",
  ], "0");
  assertStringIncludes(out, "boot setting kernel=kernel8.img");
  assertStringIncludes(out, "was left on purpose");
  assertStringIncludes(out, "delete that line from");
  assertStringIncludes(out, "then reboot");
  // Nothing to say without TurboPanel's marker, or once the line is gone.
  assert(
    !(await purgeNotes(false, ["kernel=kernel8.img"], "0")).includes("kernel8"),
  );
  assert(!(await purgeNotes(true, ["[all]"], "0")).includes("kernel8"));
  assert(!(await purgeNotes(true, null, "0")).includes("kernel8"));
});

test("the purge never edits the Pi boot file and keeps the kernel-features marker", async () => {
  const source = await Deno.readTextFile(purgePath);
  const code = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert(!/(rm|sed|mv|tee)[^\n]*TP_PI_BOOT_CONFIG/.test(code));
  assert(!/(rm|rmdir)[^\n]*TP_KERNEL_MARKER_DIR/.test(code));
  const owned = source.match(/^TP_OWNED_TREES="([^"]*)"/m);
  assert(
    owned && !owned[1].split(/\s+/).includes("/var/lib/turbopanel-kernel"),
  );
});

test("the summary says IPv4 forwarding stays on until a reboot only when it is on", async () => {
  assertStringIncludes(
    await purgeNotes(false, null, "1"),
    "net.ipv4.ip_forward) stays on until this host reboots",
  );
  assert(!(await purgeNotes(false, null, "0")).includes("ip_forward"));
});

// A stateful fake `nft`: `list tables` prints the loaded tables, `delete table`
// drops one and logs the call.
async function fakeNft(
  tables: string[],
): Promise<{ bin: string; log: string }> {
  const bin = await Deno.makeTempDir({ prefix: "tp-purge-nft-" });
  const log = join(bin, "calls");
  const state = join(bin, "nft.tables");
  await Deno.writeTextFile(log, "");
  await Deno.writeTextFile(state, tables.map((t) => `table ${t}\n`).join(""));
  const script = [
    "#!/bin/sh",
    'case "$1 $2" in',
    `  "list tables") cat ${state} ;;`,
    '  "delete table")',
    `    echo "nft $*" >> ${log}`,
    `    grep -vx "table $3 $4" ${state} > ${state}.new; mv ${state}.new ${state}`,
    "    ;;",
    "esac",
    "",
  ].join("\n");
  await Deno.writeTextFile(join(bin, "nft"), script, { mode: 0o755 });
  return { bin, log };
}

const NFT_FUNCTIONS = ["tp_remove_nft_tables"];

test("purge deletes TurboPanel's nft tables by name and leaves every other table alone", async () => {
  const { bin, log } = await fakeNft([
    "inet turbopanel_ingress_guard",
    "inet turbopanel_build",
    "inet turbopanel_php",
    "inet filter",
    "ip nat",
    "inet turbopanel_operator_own",
  ]);
  const result = await runPurgeSh(NFT_FUNCTIONS, "tp_remove_nft_tables", {
    PATH: `${bin}:${BASE_PATH}`,
  });
  assertEquals(result.code, 0, result.stderr);
  assertEquals((await Deno.readTextFile(log)).trim().split("\n"), [
    "nft delete table inet turbopanel_ingress_guard",
    "nft delete table inet turbopanel_build",
    "nft delete table inet turbopanel_php",
  ]);
  assertEquals(
    (await Deno.readTextFile(join(bin, "nft.tables"))).trim().split("\n"),
    ["table inet filter", "table ip nat", "table inet turbopanel_operator_own"],
  );
  // A second pass finds nothing to delete.
  await Deno.writeTextFile(log, "");
  const again = await runPurgeSh(NFT_FUNCTIONS, "tp_remove_nft_tables", {
    PATH: `${bin}:${BASE_PATH}`,
  });
  assertEquals(again.code, 0, again.stderr);
  assertEquals(await Deno.readTextFile(log), "");
});

test("a dry run deletes no nft table", async () => {
  const { bin, log } = await fakeNft(["inet turbopanel_php"]);
  const result = await runPurgeSh(
    NFT_FUNCTIONS,
    "DRY_RUN=true\ntp_remove_nft_tables",
    { PATH: `${bin}:${BASE_PATH}` },
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(await Deno.readTextFile(log), "");
});

test("without nft the table step is skipped, not failed", async () => {
  // The host under test may have a real nft, so the tool check is overridden.
  const result = await runPurgeSh(
    NFT_FUNCTIONS,
    'tp_has_tool() { [ "$1" != nft ] && command -v "$1" >/dev/null 2>&1; }\ntp_remove_nft_tables\necho "fail=$TP_FAIL_COUNT"\ncat "$TP_TMP/skipped"',
  );
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "fail=0");
  assertStringIncludes(result.stdout, "SKIPPED: nft not installed");
});

test("the inventory lists only TurboPanel's nft tables", async () => {
  const { bin } = await fakeNft([
    "inet turbopanel_php",
    "inet filter",
    "inet turbopanel_operator_own",
  ]);
  const result = await runPurgeSh(
    ["tp_inventory_nft_tables", "tp_inv_skip", "tp_inv_warn"],
    ': > "$TP_TMP/inv.chains"\ntp_inventory_nft_tables\ncat "$TP_TMP/inv.chains"',
    { PATH: `${bin}:${BASE_PATH}` },
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.stdout.trim(), "nft inet turbopanel_php");
});
