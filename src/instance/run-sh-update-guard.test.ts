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
const runShPath = join(here, "../../scripts/run.sh");

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) {
    throw new TypeError(`missing ${name} in run.sh`);
  }
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new TypeError(`unclosed ${name} in run.sh`);
}

test("run.sh arms the update guard on the executed installer path", async () => {
  const source = await Deno.readTextFile(runShPath);
  const installerArm = source.indexOf(
    "# `--no-start` returns here so InstanceClient can restart the unit.",
  );
  assertEquals(installerArm >= 0, true);
  assertEquals(source.includes("if ! tp_arm_update_guard; then"), true);
  const afterInstaller = source.slice(source.lastIndexOf("run-installer"));
  assertStringIncludes(afterInstaller, "tp_arm_update_guard");

  const root = await Deno.makeTempDir({ prefix: "tp-run-sh-guard-" });
  const runDir = join(root, "run");
  const installRoot = join(root, "opt");
  const binDir = join(installRoot, "bin");
  const stubBin = join(root, "stub-bin");
  await Deno.mkdir(runDir, { recursive: true });
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.mkdir(stubBin, { recursive: true });

  const prevPath = join(binDir, "turbopaneld.prev");
  await Deno.writeTextFile(
    prevPath,
    "#!/bin/sh\nprintf 'turbopaneld v0.1.1 oldcommit (trunk, build, 2026-01-01T00:00:00Z)\\n'\n",
  );
  await Deno.chmod(prevPath, 0o755);

  const timerLog = join(root, "systemctl.log");
  await Deno.writeTextFile(
    join(stubBin, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${timerLog}"\nexit 0\n`,
  );
  await Deno.chmod(join(stubBin, "systemctl"), 0o755);

  const helpers = [
    "tp_print_error",
    "tp_parse_daemon_commit_from_version",
    "tp_daemon_file_group",
    "tp_install_daemon_readable_file",
    "tp_daemon_binary_name",
    "tp_daemon_js_fallback_name",
    "tp_daemon_binary_path",
    "tp_daemon_js_fallback_path",
    "tp_arm_update_guard",
  ].map((name) => extractShellFunction(source, name)).join("\n");

  const script = [
    "INSTANCE_INSTALL=false",
    `RUN_DIR="${runDir}"`,
    "_manifest_commit=newcommit",
    "UPDATE_GUARD_TIMER=turbopaneld-update-guard.timer",
    `tp_prod_home() { printf '%s' "${installRoot}"; }`,
    helpers,
    "tp_arm_update_guard",
  ].join("\n");

  try {
    const out = await new Deno.Command("sh", {
      args: ["-eu", "-c", script],
      env: {
        ...Deno.env.toObject(),
        PATH: `${stubBin}:${Deno.env.get("PATH") ?? ""}`,
        TURBOPANEL_DAEMON_GROUP: Deno.env.get("USER") ?? "users",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assertEquals(out.success, true, stderr);
    const guardRaw = await Deno.readTextFile(join(runDir, "update-guard.json"));
    assertStringIncludes(guardRaw, '"targetCommit":"newcommit"');
    assertStringIncludes(guardRaw, '"previousCommit":"oldcommit"');
    const started = await Deno.readTextFile(timerLog);
    assertStringIncludes(started, "start turbopaneld-update-guard.timer");
    const stat = await Deno.stat(join(runDir, "update-guard.json"));
    assertEquals(stat.mode !== null && (stat.mode & 0o777) === 0o640, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("tp_arm_update_guard fails the update when the timer cannot start", async () => {
  const source = await Deno.readTextFile(runShPath);
  const root = await Deno.makeTempDir({ prefix: "tp-run-sh-guard-fail-" });
  const runDir = join(root, "run");
  const installRoot = join(root, "opt");
  const binDir = join(installRoot, "bin");
  const stubBin = join(root, "stub-bin");
  await Deno.mkdir(runDir, { recursive: true });
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.mkdir(stubBin, { recursive: true });
  await Deno.writeTextFile(
    join(binDir, "turbopaneld.prev"),
    "#!/bin/sh\nexit 0\n",
  );
  await Deno.chmod(join(binDir, "turbopaneld.prev"), 0o755);
  await Deno.writeTextFile(
    join(stubBin, "systemctl"),
    "#!/bin/sh\nexit 1\n",
  );
  await Deno.chmod(join(stubBin, "systemctl"), 0o755);

  const helpers = [
    "tp_print_error",
    "tp_parse_daemon_commit_from_version",
    "tp_daemon_file_group",
    "tp_install_daemon_readable_file",
    "tp_daemon_binary_name",
    "tp_daemon_js_fallback_name",
    "tp_daemon_binary_path",
    "tp_daemon_js_fallback_path",
    "tp_arm_update_guard",
  ].map((name) => extractShellFunction(source, name)).join("\n");

  const script = [
    "INSTANCE_INSTALL=false",
    `RUN_DIR="${runDir}"`,
    "_manifest_commit=newcommit",
    "UPDATE_GUARD_TIMER=turbopaneld-update-guard.timer",
    `tp_prod_home() { printf '%s' "${installRoot}"; }`,
    helpers,
    "tp_arm_update_guard",
  ].join("\n");

  try {
    const out = await new Deno.Command("sh", {
      args: ["-eu", "-c", script],
      env: {
        ...Deno.env.toObject(),
        PATH: `${stubBin}:${Deno.env.get("PATH") ?? ""}`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.success, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
