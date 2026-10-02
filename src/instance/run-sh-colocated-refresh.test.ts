import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { resolveInstanceConfig } from "./sockets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const runShPath = join(here, "../../scripts/run.sh");
const refreshPlaybook = join(
  here,
  "../../orchestration/playbooks/daemon-colocated-refresh.yml",
);

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

/** run.sh helpers that read and write lib/control-plane-refresh. */
const REFRESH_FILE_HELPERS = [
  "tp_release_manifest_url_ok",
  "tp_control_plane_refresh_file",
  "tp_refresh_channel_ok",
  "tp_refresh_value_ok",
  "tp_load_control_plane_refresh",
  "tp_install_root_only",
  "tp_write_control_plane_refresh",
];

/** Tests run unprivileged: install the root-only file without the chown. */
const INSTALL_AS_USER = 'tp_install_root_only() { install -m 0600 "$1" "$2"; }';

async function ownership(
  path: string,
): Promise<{ uid: number; gid: number; mode: number }> {
  const stat = await Deno.stat(path);
  return {
    uid: stat.uid ?? -1,
    gid: stat.gid ?? -1,
    mode: stat.mode === null ? -1 : stat.mode & 0o777,
  };
}

test("daemon-only refresh on a managed co-located host keeps the local socket and ownership", async () => {
  const playbook = await Deno.readTextFile(refreshPlaybook);
  assertEquals(playbook.includes("role: postgres"), false);
  assertEquals(playbook.includes("instance-launch"), false);
  assertEquals(playbook.includes("recurse: true"), false);
  assertStringIncludes(playbook, "turbopanel_after_instance_service: true");
  assertStringIncludes(playbook, 'turbopanel_instance_url: ""');

  const source = await Deno.readTextFile(runShPath);
  const refreshFn = extractShellFunction(
    source,
    "tp_run_colocated_daemon_refresh",
  );
  assertEquals(refreshFn.includes("daemon-install.yml"), false);
  assertStringIncludes(refreshFn, "daemon-colocated-refresh.yml");

  const root = await Deno.makeTempDir({ prefix: "tp-colo-refresh-" });
  const installRoot = join(root, "opt");
  const binDir = join(installRoot, "bin");
  const configDir = join(root, "etc");
  const stateDir = join(root, "var");
  const runDir = join(root, "run");
  const socketPath = join(runDir, "instance.sock");
  const protectedDb = join(stateDir, "postgres", "PG_VERSION");
  const protectedUi = join(installRoot, "share", "ui", "index.html");
  const protectedCaddy = join(stateDir, "caddy", "Caddyfile");
  const envFile = join(configDir, "daemon.env");
  const played = join(root, "playbook");
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.mkdir(join(stateDir, "postgres"), { recursive: true });
  await Deno.mkdir(join(stateDir, "caddy"), { recursive: true });
  await Deno.mkdir(join(installRoot, "share", "ui"), { recursive: true });
  await Deno.mkdir(runDir, { recursive: true });
  await Deno.writeTextFile(join(binDir, "turbopanel"), "instance\n");
  await Deno.writeTextFile(protectedDb, "18\n");
  await Deno.writeTextFile(protectedUi, "<html></html>\n");
  await Deno.writeTextFile(protectedCaddy, "admin off\n");
  await Deno.chmod(protectedDb, 0o600);
  await Deno.chmod(protectedUi, 0o640);
  await Deno.chmod(protectedCaddy, 0o640);
  await Deno.writeTextFile(
    envFile,
    `TURBOPANEL_RUN_DIR=${runDir}\nTURBOPANEL_UPDATE_CHANNEL=release\n`,
  );
  const before = {
    db: await ownership(protectedDb),
    ui: await ownership(protectedUi),
    caddy: await ownership(protectedCaddy),
  };
  const stub = join(binDir, "turbopaneld");
  await Deno.writeTextFile(
    stub,
    `#!/bin/sh
set -eu
playbook=""
vars=""
while [ $# -gt 0 ]; do
  case "$1" in
    --playbook) playbook="$2"; shift 2 ;;
    --vars-file) vars="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$playbook" > "${played}"
if [ "$playbook" = "daemon-install.yml" ]; then
  printf 'TURBOPANEL_INSTANCE_URL=https://turbopanel.app\\n' >> "${envFile}"
  chmod 0755 "${protectedDb}" "${protectedUi}" "${protectedCaddy}"
  exit 0
fi
if [ "$playbook" != "daemon-colocated-refresh.yml" ]; then
  echo "unexpected playbook $playbook" >&2
  exit 1
fi
grep -q 'turbopanel_after_instance_service: true' "$vars"
if grep -E 'turbopanel_instance_url: .*https://' "$vars" >/dev/null; then
  echo "refresh vars named a remote control plane" >&2
  exit 1
fi
grep -v '^TURBOPANEL_INSTANCE_URL=' "${envFile}" > "${envFile}.new"
mv "${envFile}.new" "${envFile}"
exit 0
`,
  );
  await Deno.chmod(stub, 0o755);

  const helpers = [
    "tp_print_step",
    "tp_print_ok",
    "tp_print_error",
    "tp_daemon_binary_name",
    "tp_daemon_js_fallback_name",
    "tp_daemon_binary_path",
    "tp_daemon_js_fallback_path",
    "tp_colocated_control_plane_host",
    ...REFRESH_FILE_HELPERS,
    "tp_run_colocated_daemon_refresh",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const script = [
    "set -eu",
    `INSTALL_ROOT="${installRoot}"`,
    `CONFIG_DIR="${configDir}"`,
    `STATE_DIR="${stateDir}"`,
    `ENV_FILE="${envFile}"`,
    `RUNTIMES_DIR="${join(installRoot, "vendor")}"`,
    `ORCHESTRATION_DIR="${join(installRoot, "share", "orchestration")}"`,
    "DAEMON_EXEC_MODE=native",
    "TP_EXEC_MODE_NATIVE=native",
    "NO_START=false",
    "MANIFEST_URL=https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.1/manifest.json",
    "DAEMON_ONLY=true",
    helpers,
    INSTALL_AS_USER,
    `tp_prod_home() { printf '%s' "${installRoot}"; }`,
    'tp_colocated_control_plane_host || { echo "not detected as co-located" >&2; exit 1; }',
    "tp_run_colocated_daemon_refresh",
  ].join("\n");

  const listener = Deno.listen({ path: socketPath, transport: "unix" });
  try {
    const out = await new Deno.Command("sh", {
      args: ["-c", script],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      out.code,
      0,
      new TextDecoder().decode(out.stderr),
    );
    assertEquals(
      await Deno.readTextFile(played),
      "daemon-colocated-refresh.yml\n",
    );
    const envText = await Deno.readTextFile(envFile);
    assertEquals(envText.includes("TURBOPANEL_INSTANCE_URL="), false);
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    const config = resolveInstanceConfig(env);
    if (config.kind !== "socket") {
      throw new TypeError("daemon left socket mode");
    }
    assertEquals(config.socketPath, socketPath);
    const accepted = listener.accept();
    const client = await Deno.connect({
      path: config.socketPath,
      transport: "unix",
    });
    const remote = await accepted;
    remote.close();
    client.close();
    assertEquals(await ownership(protectedDb), before.db);
    assertEquals(await ownership(protectedUi), before.ui);
    assertEquals(await ownership(protectedCaddy), before.caddy);
  } finally {
    listener.close();
    await Deno.remove(root, { recursive: true });
  }
});

/** Run extracted run.sh functions in a scratch layout; prints `$@`'s result. */
async function runPrepare(
  opts: {
    controlPlane: boolean;
    envChannel?: string;
    callerChannel?: string;
    /** Contents of lib/control-plane-refresh; absent = a pre-migration host. */
    refreshFile?: string;
    /** Contents of lib/update-origin; absent = a host installed before pins. */
    originPin?: string;
  },
): Promise<{ status: number; stdout: string; stderr: string }> {
  const source = await Deno.readTextFile(runShPath);
  const root = await Deno.makeTempDir({ prefix: "tp-colo-prepare-" });
  try {
    const installRoot = join(root, "opt");
    const configDir = join(root, "etc");
    await Deno.mkdir(join(installRoot, "bin"), { recursive: true });
    await Deno.mkdir(join(installRoot, "lib"), { recursive: true });
    await Deno.mkdir(configDir, { recursive: true });
    if (opts.controlPlane) {
      await Deno.writeTextFile(join(installRoot, "bin", "turbopanel"), "");
    }
    if (opts.refreshFile !== undefined) {
      await Deno.writeTextFile(
        join(installRoot, "lib", "control-plane-refresh"),
        opts.refreshFile,
      );
    }
    if (opts.originPin !== undefined) {
      await Deno.writeTextFile(
        join(installRoot, "lib", "update-origin"),
        opts.originPin,
      );
    }
    const envLines = ["TURBOPANEL_CONFIG_DIR=/etc/turbopanel"];
    if (opts.envChannel) {
      envLines.push(`TURBOPANEL_UPDATE_CHANNEL=${opts.envChannel}`);
    }
    if (!opts.controlPlane) {
      envLines.push("TURBOPANEL_INSTANCE_URL=https://panel.example.com");
    }
    await Deno.writeTextFile(
      join(configDir, "daemon.env"),
      envLines.join("\n") + "\n",
    );
    const script = [
      "set -eu",
      `INSTALL_ROOT="${installRoot}"`,
      `ENV_FILE="${configDir}/daemon.env"`,
      opts.callerChannel
        ? `TURBOPANEL_UPDATE_CHANNEL="${opts.callerChannel}"; export TURBOPANEL_UPDATE_CHANNEL`
        : "unset TURBOPANEL_UPDATE_CHANNEL",
      extractShellFunction(source, "tp_colocated_control_plane_host"),
      ...REFRESH_FILE_HELPERS.map((name) => extractShellFunction(source, name)),
      extractShellFunction(source, "tp_prepare_colocated_daemon_only"),
      'if tp_prepare_colocated_daemon_only; then echo "colocated channel=$TURBOPANEL_UPDATE_CHANNEL"; else echo remote; fi',
    ].join("\n");
    const out = await new Deno.Command("sh", {
      args: ["-c", script],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stdout: new TextDecoder().decode(out.stdout).trim(),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("--daemon-only on a control-plane host needs no license or manifest pin: the channel comes from lib/control-plane-refresh", async () => {
  const fromFile = await runPrepare({
    controlPlane: true,
    envChannel: "trunk",
    refreshFile: "channel=canary\ninstance_manifest_url=\nui_manifest_url=\n",
  });
  assertEquals(fromFile.status, 0, fromFile.stderr);
  assertEquals(fromFile.stdout, "colocated channel=canary");

  // A channel outside the allowlist reads as none.
  const badFile = await runPrepare({
    controlPlane: true,
    envChannel: "canary",
    refreshFile: "channel=nightly\n",
  });
  assertEquals(badFile.stdout, "colocated channel=release");

  // Detection reads the root-owned update-origin pin, not daemon.env.
  const pinned = await runPrepare({
    controlPlane: true,
    originPin: "host=\ndl_base=\ninstance_ca=\nuploaded_trust=\ncolocated=1\n",
    refreshFile: "channel=rc\n",
  });
  assertEquals(pinned.stdout, "colocated channel=rc");
  const remotePin = await runPrepare({
    controlPlane: true,
    originPin:
      "host=https://panel.example.com\ndl_base=\ninstance_ca=\nuploaded_trust=\n",
  });
  assertEquals(remotePin.stdout, "remote");
});

test("--daemon-only on a control-plane host that predates lib/control-plane-refresh takes the channel from daemon.env once", async () => {
  const fromEnv = await runPrepare({
    controlPlane: true,
    envChannel: "canary",
  });
  assertEquals(fromEnv.status, 0, fromEnv.stderr);
  assertEquals(fromEnv.stdout, "colocated channel=canary");

  const caller = await runPrepare({
    controlPlane: true,
    envChannel: "canary",
    callerChannel: "rc",
  });
  assertEquals(caller.stdout, "colocated channel=rc");

  const defaulted = await runPrepare({ controlPlane: true });
  assertEquals(defaulted.stdout, "colocated channel=release");

  // A remote daemon keeps the old requirements (license + pinned manifest).
  const remote = await runPrepare({
    controlPlane: false,
    envChannel: "canary",
  });
  assertEquals(remote.stdout, "remote");
});

test("run.sh gates --daemon-only's license and manifest checks behind the co-located test, and pins a control-plane host to the CDN", async () => {
  const source = await Deno.readTextFile(runShPath);
  assertStringIncludes(
    source,
    'if [ "$DAEMON_ONLY" = true ] && ! tp_prepare_colocated_daemon_only; then',
  );
  const pinFn = extractShellFunction(
    source,
    "tp_write_colocated_update_origin_pin",
  );
  assertStringIncludes(
    pinFn,
    "host=\\ndl_base=\\ninstance_ca=\\nuploaded_trust=\\ncolocated=1",
  );
  assertStringIncludes(pinFn, "install -m 0600 -o root -g root");
  assertStringIncludes(
    source,
    "else\n  tp_write_colocated_update_origin_pin\nfi",
  );
});

/**
 * Run run.sh's real argument checks — from the bare-run decision through the
 * license decode, exactly as shipped — against a scratch layout. The helper
 * test above passed while this section still demanded a license, so this one
 * exercises the whole gate a `--daemon-only` refresh actually goes through.
 */
async function runArgumentChecks(
  opts: { controlPlane: boolean; license?: string; manifestUrl?: string },
): Promise<{ status: number; stdout: string; stderr: string }> {
  const source = await Deno.readTextFile(runShPath);
  const start = source.indexOf("# A bare run — no license");
  const end = source.indexOf("\nif ! tp_is_root; then");
  if (start < 0 || end < 0 || end < start) {
    throw new Error("run.sh argument-check markers moved");
  }
  const root = await Deno.makeTempDir({ prefix: "tp-colo-args-" });
  try {
    const installRoot = join(root, "opt");
    const configDir = join(root, "etc");
    await Deno.mkdir(join(installRoot, "bin"), { recursive: true });
    await Deno.mkdir(configDir, { recursive: true });
    if (opts.controlPlane) {
      await Deno.writeTextFile(join(installRoot, "bin", "turbopanel"), "");
    }
    await Deno.writeTextFile(
      join(configDir, "daemon.env"),
      opts.controlPlane
        ? "TURBOPANEL_UPDATE_CHANNEL=canary\n"
        : "TURBOPANEL_UPDATE_CHANNEL=canary\nTURBOPANEL_INSTANCE_URL=https://panel.example.com\n",
    );
    const script = [
      "set -eu",
      `INSTALL_ROOT="${installRoot}"`,
      `ENV_FILE="${configDir}/daemon.env"`,
      `TURBOPANEL_STATE_DIR="${join(root, "state")}"`,
      "unset TURBOPANEL_UPDATE_CHANNEL",
      'tp_print_error() { printf "error: %s\\n" "$*"; }',
      "tp_builtin_repo_manifest_url() { return 0; }",
      "DAEMON_ONLY=true",
      "INSTANCE_INSTALL=false",
      `LICENSE="${opts.license ?? ""}"`,
      'HOST_URL=""; TUNNEL_TOKEN=""; INSTANCE_CA=""; DL_BASE=""',
      `MANIFEST_URL="${opts.manifestUrl ?? ""}"`,
      'INSTANCE_MANIFEST_URL=""; UI_MANIFEST_URL=""',
      "SKIP_DAEMON_PACKAGE=false; NO_START=false",
      extractShellFunction(source, "tp_colocated_control_plane_host"),
      ...REFRESH_FILE_HELPERS.map((name) => extractShellFunction(source, name)),
      extractShellFunction(source, "tp_prepare_colocated_daemon_only"),
      source.slice(start, end),
      'echo "passed colocated=$COLOCATED_DAEMON_ONLY channel=$TURBOPANEL_UPDATE_CHANNEL license_id=$LICENSE_ID"',
    ].join("\n");
    const out = await new Deno.Command("sh", {
      args: ["-c", script],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stdout: new TextDecoder().decode(out.stdout).trim(),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("--daemon-only on a control-plane host gets past every argument check with no license", async () => {
  // The owner's command on canary.turbopanel.dev (2026-09-27) stopped here
  // with "TURBOPANEL_LICENSE (or --license) is required to enrol a daemon".
  const withPin = await runArgumentChecks({
    controlPlane: true,
    manifestUrl:
      "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest-0.1.1-canary.1.json",
  });
  assertEquals(withPin.status, 0, withPin.stdout + withPin.stderr);
  assertEquals(
    withPin.stdout,
    "passed colocated=true channel=canary license_id=",
  );

  const bare = await runArgumentChecks({ controlPlane: true });
  assertEquals(bare.status, 0, bare.stdout + bare.stderr);
  assertEquals(bare.stdout, "passed colocated=true channel=canary license_id=");
});

test("--daemon-only still decodes a license a control-plane caller passes", async () => {
  const license = btoa("lic-id:lic-token").replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
  const out = await runArgumentChecks({ controlPlane: true, license });
  assertEquals(out.status, 0, out.stdout + out.stderr);
  assertEquals(
    out.stdout,
    "passed colocated=false channel=canary license_id=lic-id",
  );
});

test("--daemon-only on a remote daemon still needs a pinned manifest and a license", async () => {
  const noPin = await runArgumentChecks({ controlPlane: false });
  assertEquals(noPin.status, 1);
  assertStringIncludes(noPin.stdout, "requires a pinned https manifest");

  const noLicense = await runArgumentChecks({
    controlPlane: false,
    manifestUrl:
      "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest-0.1.1-canary.1.json",
  });
  assertEquals(noLicense.status, 1);
  assertStringIncludes(noLicense.stdout, "needs TURBOPANEL_LICENSE");
});

const INSTANCE_PIN =
  "https://github.com/TurboPanel/turbopanel/releases/download/v0.2.0/manifest.json";
const UI_PIN =
  "https://github.com/TurboPanel/ui/releases/download/v0.2.0/manifest.json";

/**
 * Run tp_run_colocated_daemon_refresh against a scratch layout and return the
 * vars file it hands the playbook, plus the root-only settings file after.
 */
async function runRefresh(
  root: string,
  opts: { daemonEnv: string; refreshFile?: string; channel?: string },
): Promise<{ vars: string; refreshFile: string; refreshMode: number }> {
  const source = await Deno.readTextFile(runShPath);
  const installRoot = join(root, "opt");
  const configDir = join(root, "etc");
  const captured = join(root, "vars.yml");
  const refreshPath = join(installRoot, "lib", "control-plane-refresh");
  await Deno.mkdir(join(installRoot, "bin"), { recursive: true });
  await Deno.mkdir(join(installRoot, "lib"), { recursive: true });
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.writeTextFile(join(installRoot, "bin", "turbopanel"), "");
  await Deno.writeTextFile(join(configDir, "daemon.env"), opts.daemonEnv);
  if (opts.refreshFile !== undefined) {
    await Deno.writeTextFile(refreshPath, opts.refreshFile);
  }
  const stub = join(installRoot, "bin", "turbopaneld");
  await Deno.writeTextFile(
    stub,
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = --vars-file ]; then cp "$2" "${captured}"; fi\n  shift\ndone\n`,
  );
  await Deno.chmod(stub, 0o755);
  const script = [
    "set -eu",
    `INSTALL_ROOT="${installRoot}"`,
    `CONFIG_DIR="${configDir}"`,
    `STATE_DIR="${join(root, "var")}"`,
    `ENV_FILE="${join(configDir, "daemon.env")}"`,
    `RUNTIMES_DIR="${join(installRoot, "vendor")}"`,
    `ORCHESTRATION_DIR="${join(installRoot, "share", "orchestration")}"`,
    "DAEMON_EXEC_MODE=native",
    "TP_EXEC_MODE_NATIVE=native",
    "NO_START=true",
    'MANIFEST_URL=""',
    'INSTANCE_MANIFEST_URL=""',
    'UI_MANIFEST_URL=""',
    opts.channel === undefined
      ? "unset TURBOPANEL_UPDATE_CHANNEL"
      : `TURBOPANEL_UPDATE_CHANNEL=${opts.channel}`,
    'tp_print_step() { :; }; tp_print_ok() { :; }; tp_print_error() { printf "%s\\n" "$*" >&2; }',
    `tp_daemon_binary_name() { printf turbopaneld; }`,
    `tp_daemon_binary_path() { printf '%s' "${stub}"; }`,
    `tp_daemon_js_fallback_path() { printf '%s' "${stub}.js"; }`,
    ...REFRESH_FILE_HELPERS.map((name) => extractShellFunction(source, name)),
    extractShellFunction(source, "tp_run_colocated_daemon_refresh"),
    INSTALL_AS_USER,
    "tp_run_colocated_daemon_refresh",
  ].join("\n");
  const out = await new Deno.Command("sh", {
    args: ["-c", script],
    env: { TMPDIR: root },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return {
    vars: await Deno.readTextFile(captured),
    refreshFile: await Deno.readTextFile(refreshPath),
    refreshMode: (await ownership(refreshPath)).mode,
  };
}

/** A daemon.env the daemon account could have rewritten, built at run time. */
function poisonedDaemonEnv(root: string): string {
  return [
    "TURBOPANEL_UPDATE_CHANNEL=trunk",
    `TURBOPANEL_INSTANCE_CA=${join(root, "not-a-ca")}`,
    "TURBOPANEL_DL_BASE=https://overlay.invalid/dl",
    "TURBOPANEL_INSTANCE_MANIFEST_URL=https://overlay.invalid/manifest.json",
    `TURBOPANEL_UI_MANIFEST_URL=${UI_PIN}`,
    "",
  ].join("\n");
}

test("the co-located refresh reads lib/control-plane-refresh, never daemon.env", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-colo-cpr-" });
  try {
    const out = await runRefresh(root, {
      daemonEnv: poisonedDaemonEnv(root),
      refreshFile:
        `channel=canary\ninstance_manifest_url=${INSTANCE_PIN}\nui_manifest_url=\n`,
    });
    assertStringIncludes(out.vars, "turbopanel_update_channel: canary\n");
    assertStringIncludes(
      out.vars,
      `turbopanel_instance_manifest_url: "${INSTANCE_PIN}"`,
    );
    for (const absent of ["instance_ca", "dl_base", "ui_manifest_url"]) {
      assertEquals(out.vars.includes(`turbopanel_${absent}:`), false, absent);
    }
    assertEquals(out.vars.includes("overlay.invalid"), false);
    assertEquals(out.refreshMode, 0o600);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a host without lib/control-plane-refresh migrates validated values from daemon.env once", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-colo-cpr-" });
  try {
    const first = await runRefresh(root, {
      daemonEnv: [
        "TURBOPANEL_UPDATE_CHANNEL=canary",
        `TURBOPANEL_INSTANCE_CA=${join(root, "not-a-ca")}`,
        "TURBOPANEL_DL_BASE=https://overlay.invalid/dl",
        `TURBOPANEL_INSTANCE_MANIFEST_URL=${INSTANCE_PIN}`,
        "TURBOPANEL_UI_MANIFEST_URL=https://overlay.invalid/manifest.json",
        "",
      ].join("\n"),
    });
    assertEquals(
      first.refreshFile,
      `channel=canary\ninstance_manifest_url=${INSTANCE_PIN}\nui_manifest_url=\n`,
    );
    assertEquals(first.refreshMode, 0o600);
    assertStringIncludes(first.vars, "turbopanel_update_channel: canary\n");
    assertEquals(first.vars.includes("turbopanel_instance_ca:"), false);
    assertEquals(first.vars.includes("turbopanel_dl_base:"), false);
    assertEquals(first.vars.includes("overlay.invalid"), false);

    // After the migration a rewritten daemon.env changes nothing.
    const second = await runRefresh(root, {
      daemonEnv: poisonedDaemonEnv(root),
    });
    assertEquals(second.refreshFile, first.refreshFile);
    assertStringIncludes(second.vars, "turbopanel_update_channel: canary\n");
    assertEquals(second.vars.includes(UI_PIN), false);

    // The daemon's own update names the channel; the file follows it.
    const third = await runRefresh(root, {
      daemonEnv: poisonedDaemonEnv(root),
      channel: "rc",
    });
    assertStringIncludes(third.refreshFile, "channel=rc\n");
    assertStringIncludes(third.vars, "turbopanel_update_channel: rc\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("daemon.env is daemon-only and the control-plane install records the refresh file", async () => {
  const tasks = await Deno.readTextFile(
    join(here, "../../orchestration/roles/daemon-config/tasks/main.yml"),
  );
  const start = tasks.indexOf("- name: Write daemon environment file");
  const task = tasks.slice(start, tasks.indexOf("\n- name:", start + 1));
  assertStringIncludes(task, 'mode: "0600"');

  const source = await Deno.readTextFile(runShPath);
  assertStringIncludes(
    extractShellFunction(source, "tp_install_root_only"),
    "install -m 0600 -o root -g root",
  );
  assertStringIncludes(
    extractShellFunction(source, "tp_run_instance_install"),
    "tp_write_control_plane_refresh",
  );
  const refreshFn = extractShellFunction(
    source,
    "tp_run_colocated_daemon_refresh",
  );
  assertEquals(refreshFn.includes("daemon.env"), false);
});
