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
    "tp_daemon_env_value",
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
