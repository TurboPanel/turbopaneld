import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * run.sh runs as root but writes into directories the `tp` user can change
 * (/etc/turbopanel, /var/lib/turbopanel, /run/turbopanel). These tests plant
 * the links and swapped directories `tp` could plant and check that root
 * neither writes through them nor reads a root file back out through them.
 * They run unprivileged: "owned by root" is "owned by the user running the
 * test", the same `id -u` comparison run.sh makes.
 */

const here = dirname(fromFileUrl(import.meta.url));
const runShPath = join(here, "../../scripts/run.sh");
const VICTIM = "victim-original\n";

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) throw new TypeError(`missing ${name} in run.sh`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new TypeError(`unclosed ${name} in run.sh`);
}

async function helpers(names: string[]): Promise<string> {
  const source = await Deno.readTextFile(runShPath);
  return names.map((name) => extractShellFunction(source, name)).join("\n");
}

async function runSh(
  lines: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const out = await new Deno.Command("sh", {
    args: ["-eu", "-c", lines.join("\n")],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function modeOf(path: string): Promise<number> {
  const info = await Deno.lstat(path);
  return (info.mode ?? 0) & 0o777;
}

async function plantVictim(root: string): Promise<string> {
  const victim = join(root, "victim");
  await Deno.writeTextFile(victim, VICTIM);
  await Deno.chmod(victim, 0o600);
  return victim;
}

async function assertVictimUntouched(victim: string): Promise<void> {
  assertEquals(await Deno.readTextFile(victim), VICTIM);
  assertEquals(await modeOf(victim), 0o600);
}

async function entries(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.toSorted((a, b) => a.localeCompare(b));
}

async function withRoot(
  prefix: string,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix });
  try {
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const SAFE_WRITE = [
  "tp_print_error",
  "tp_root_safe_stage",
  "tp_root_safe_write",
];

test("tp_root_safe_write replaces a planted link instead of writing through it", async () => {
  await withRoot("tp-rsw-link-", async (root) => {
    const victim = await plantVictim(root);
    const dir = join(root, "run");
    await Deno.mkdir(dir);
    const dest = join(dir, "update-guard.json");
    await Deno.symlink(victim, dest);
    const res = await runSh([
      await helpers(SAFE_WRITE),
      `printf '%s\\n' fresh | tp_root_safe_write "${dest}" 0640 ""`,
    ]);
    assertEquals(res.ok, true, res.stderr);
    await assertVictimUntouched(victim);
    const info = await Deno.lstat(dest);
    assertEquals(info.isFile, true);
    assertEquals(await Deno.readTextFile(dest), "fresh\n");
    assertEquals(await modeOf(dest), 0o640);
    // The staging directory beside `run` is gone again.
    assertEquals(await entries(root), ["run", "victim"]);
  });
});

test("tp_root_safe_write refuses a directory planted at the destination", async () => {
  await withRoot("tp-rsw-dir-", async (root) => {
    const dir = join(root, "run");
    const dest = join(dir, "update-guard.json");
    await Deno.mkdir(dest, { recursive: true });
    const res = await runSh([
      await helpers(SAFE_WRITE),
      `printf '%s\\n' fresh | tp_root_safe_write "${dest}" 0640 ""`,
    ]);
    assertEquals(res.ok, false);
    assertEquals(await entries(dest), []);
    assertEquals(await entries(root), ["run"]);
  });
});

test("tp_root_safe_write refuses a destination directory that is a link", async () => {
  await withRoot("tp-rsw-dirlink-", async (root) => {
    const elsewhere = join(root, "elsewhere");
    await Deno.mkdir(elsewhere);
    await Deno.symlink(elsewhere, join(root, "run"));
    const res = await runSh([
      await helpers(SAFE_WRITE),
      `printf '%s\\n' fresh | tp_root_safe_write "${
        join(root, "run", "update-guard.json")
      }" 0640 ""`,
    ]);
    assertEquals(res.ok, false);
    assertEquals(await entries(elsewhere), []);
  });
});

test("tp_arm_update_guard does not follow a link planted at update-guard.json", async () => {
  await withRoot("tp-guard-link-", async (root) => {
    const victim = await plantVictim(root);
    const runDir = join(root, "run");
    const binDir = join(root, "opt", "bin");
    const stubBin = join(root, "stub-bin");
    await Deno.mkdir(runDir, { recursive: true });
    await Deno.mkdir(binDir, { recursive: true });
    await Deno.mkdir(stubBin, { recursive: true });
    await Deno.writeTextFile(
      join(binDir, "turbopaneld.prev"),
      "#!/bin/sh\nexit 0\n",
    );
    await Deno.chmod(join(binDir, "turbopaneld.prev"), 0o755);
    await Deno.writeTextFile(join(stubBin, "systemctl"), "#!/bin/sh\nexit 0\n");
    await Deno.chmod(join(stubBin, "systemctl"), 0o755);
    const guard = join(runDir, "update-guard.json");
    await Deno.symlink(victim, guard);
    const res = await runSh([
      `PATH="${stubBin}:$PATH"`,
      "INSTANCE_INSTALL=false",
      `RUN_DIR="${runDir}"`,
      "_manifest_commit=newcommit",
      "UPDATE_GUARD_TIMER=turbopaneld-update-guard.timer",
      `tp_prod_home() { printf '%s' "${join(root, "opt")}"; }`,
      await helpers([
        ...SAFE_WRITE,
        "tp_parse_daemon_commit_from_version",
        "tp_daemon_file_group",
        "tp_daemon_binary_name",
        "tp_daemon_js_fallback_name",
        "tp_daemon_binary_path",
        "tp_daemon_js_fallback_path",
        "tp_arm_update_guard",
      ]),
      "tp_arm_update_guard",
    ]);
    assertEquals(res.ok, true, res.stderr);
    await assertVictimUntouched(victim);
    assertEquals((await Deno.lstat(guard)).isFile, true);
    assertStringIncludes(
      await Deno.readTextFile(guard),
      '"targetCommit":"newcommit"',
    );
    assertEquals(await modeOf(guard), 0o640);
  });
});

test("tp_mark_instance_swap does not follow a link planted at instance-swap.json", async () => {
  await withRoot("tp-swap-link-", async (root) => {
    const victim = await plantVictim(root);
    const state = join(root, "state");
    await Deno.mkdir(state);
    const marker = join(state, "instance-swap.json");
    await Deno.symlink(victim, marker);
    const res = await runSh([
      `TURBOPANEL_STATE_DIR="${state}"`,
      await helpers([
        ...SAFE_WRITE,
        "tp_instance_swap_marker",
        "tp_mark_instance_swap",
      ]),
      "tp_mark_instance_swap",
    ]);
    assertEquals(res.ok, true, res.stderr);
    await assertVictimUntouched(victim);
    assertEquals((await Deno.lstat(marker)).isFile, true);
    assertEquals(await Deno.readTextFile(marker), '{"swapped":true}\n');
    assertEquals(await modeOf(marker), 0o644);
  });
});

const LABEL_SYNC = [
  "tp_print_error",
  "tp_instance_build_label_path",
  "tp_rewrite_instance_runtime_env",
  "tp_sync_instance_build_label",
];

async function labelFixture(
  root: string,
): Promise<{ config: string; install: string }> {
  const config = join(root, "etc");
  const install = join(root, "opt");
  await Deno.mkdir(join(config, "instance"), { recursive: true, mode: 0o750 });
  await Deno.chmod(join(config, "instance"), 0o750);
  await Deno.mkdir(join(install, "lib"), { recursive: true });
  await Deno.writeTextFile(
    join(install, "lib", "build-label"),
    "0.1.7-canary.3\n",
  );
  return { config, install };
}

function labelScript(
  config: string,
  install: string,
  body: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return helpers(LABEL_SYNC).then((fns) =>
    runSh([`CONFIG_DIR="${config}"`, `INSTALL_ROOT="${install}"`, fns, body])
  );
}

test("tp_sync_instance_build_label replaces the label, keeps the rest, owner and mode", async () => {
  await withRoot("tp-label-ok-", async (root) => {
    const { config, install } = await labelFixture(root);
    const env = join(config, "instance", "runtime.env");
    await Deno.writeTextFile(env, "A=1\nTURBOPANEL_BUILD_LABEL=old\nB=2\n");
    await Deno.chmod(env, 0o640);
    const res = await labelScript(
      config,
      install,
      "tp_sync_instance_build_label",
    );
    assertEquals(res.ok, true, res.stderr);
    assertEquals(
      await Deno.readTextFile(env),
      "A=1\nB=2\nTURBOPANEL_BUILD_LABEL=0.1.7-canary.3\n",
    );
    assertEquals(await modeOf(env), 0o640);
    assertEquals((await Deno.lstat(env)).uid, Deno.uid());
    assertEquals(await entries(join(config, "instance")), ["runtime.env"]);
  });
});

test("tp_sync_instance_build_label refuses a runtime.env that is a link to a root file", async () => {
  await withRoot("tp-label-link-", async (root) => {
    const victim = await plantVictim(root);
    const { config, install } = await labelFixture(root);
    const env = join(config, "instance", "runtime.env");
    await Deno.symlink(victim, env);
    const res = await labelScript(
      config,
      install,
      "tp_sync_instance_build_label",
    );
    assertEquals(res.ok, true, res.stderr);
    assertStringIncludes(res.stderr, "Refusing");
    await assertVictimUntouched(victim);
    assertEquals((await Deno.lstat(env)).isSymlink, true);
    assertEquals(await entries(join(config, "instance")), ["runtime.env"]);
  });
});

test("tp_sync_instance_build_label refuses an instance dir swapped for a link elsewhere", async () => {
  await withRoot("tp-label-dirlink-", async (root) => {
    const { config, install } = await labelFixture(root);
    // tp renames instance/ away and points the name at a directory of root files.
    const target = join(root, "sudoers.d");
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, "runtime.env"), VICTIM);
    await Deno.chmod(join(target, "runtime.env"), 0o600);
    await Deno.remove(join(config, "instance"));
    await Deno.symlink(target, join(config, "instance"));
    const res = await labelScript(
      config,
      install,
      "tp_sync_instance_build_label",
    );
    assertEquals(res.ok, true, res.stderr);
    assertStringIncludes(res.stderr, "Refusing");
    await assertVictimUntouched(join(target, "runtime.env"));
    assertEquals(await entries(target), ["runtime.env"]);
  });
});

test("tp_sync_instance_build_label refuses an instance dir others can write", async () => {
  await withRoot("tp-label-writable-", async (root) => {
    const { config, install } = await labelFixture(root);
    const env = join(config, "instance", "runtime.env");
    await Deno.writeTextFile(env, "A=1\n");
    await Deno.chmod(join(config, "instance"), 0o770);
    const res = await labelScript(
      config,
      install,
      "tp_sync_instance_build_label",
    );
    assertEquals(res.ok, true, res.stderr);
    assertStringIncludes(res.stderr, "Refusing");
    assertEquals(await Deno.readTextFile(env), "A=1\n");
  });
});

test("tp_stage_daemon_license replaces a planted staging link with a fresh private dir", async () => {
  await withRoot("tp-license-stage-", async (root) => {
    const elsewhere = join(root, "elsewhere");
    await Deno.mkdir(elsewhere);
    const staging = join(root, "turbopanel-license-staging");
    await Deno.symlink(elsewhere, staging);
    const res = await runSh([
      `LICENSE_STAGING_DIR="${staging}"`,
      "LICENSE_ID=lic-id",
      "LICENSE_TOKEN=lic-token",
      await helpers(["tp_print_error", "tp_stage_daemon_license"]),
      "tp_stage_daemon_license",
    ]);
    assertEquals(res.ok, true, res.stderr);
    assertEquals(await entries(elsewhere), []);
    const info = await Deno.lstat(staging);
    assertEquals(info.isDirectory, true);
    assertEquals(await modeOf(staging), 0o700);
    assertEquals(
      await Deno.readTextFile(join(staging, "license.id")),
      "lic-id",
    );
    assertEquals(
      await Deno.readTextFile(join(staging, "license.token")),
      "lic-token",
    );
    assertEquals(await modeOf(join(staging, "license.id")), 0o600);
  });
});

test("run.sh stages the license outside tp's state dir and tells the role where", async () => {
  const source = await Deno.readTextFile(runShPath);
  assertStringIncludes(
    source,
    'LICENSE_STAGING_DIR="/var/lib/turbopanel-license-staging"',
  );
  assertStringIncludes(
    source,
    "printf 'turbopanel_daemon_license_staging_dir: %s\\n' \"$LICENSE_STAGING_DIR\"",
  );
  const defaults = await Deno.readTextFile(
    join(here, "../../orchestration/roles/daemon-config/defaults/main.yml"),
  );
  assertStringIncludes(
    defaults,
    'turbopanel_daemon_license_staging_dir: "/var/lib/turbopanel-license-staging"',
  );
});

test("tp_read_state_license_file reads a regular file and refuses links and fifos", async () => {
  await withRoot("tp-license-read-", async (root) => {
    const victim = await plantVictim(root);
    const state = join(root, "state");
    await Deno.mkdir(state);
    await Deno.writeTextFile(join(state, "license.id"), " id-123 \n");
    await Deno.symlink(victim, join(state, "license.token"));
    const fifo = join(state, "license.fifo");
    const mk = await new Deno.Command("mkfifo", { args: [fifo] }).output();
    assertEquals(mk.success, true);
    const res = await runSh([
      await helpers(["tp_read_state_license_file"]),
      `printf '[%s]' "$(tp_read_state_license_file "${
        join(state, "license.id")
      }")"`,
      `printf '[%s]' "$(tp_read_state_license_file "${
        join(state, "license.token")
      }")"`,
      `printf '[%s]' "$(tp_read_state_license_file "${fifo}")"`,
    ]);
    assertEquals(res.ok, true, res.stderr);
    assertEquals(res.stdout, "[id-123][][]");
  });
});
