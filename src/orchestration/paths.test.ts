import { dirname, join } from "@std/path";
import {
  ANSIBLE_CFG,
  ANSIBLE_CORE_VERSION,
  ANSIBLE_CURRENT_DIR,
  ANSIBLE_HOME,
  ANSIBLE_INSTALL_DIR,
  ANSIBLE_LOCAL_TMP,
  ANSIBLE_PLAYBOOK_BIN,
  ANSIBLE_PLAYBOOK_CWD,
  CACHE_DIR,
  CLICKHOUSE_VERSION,
  CLOUDFLARED_CURRENT_DIR,
  DAEMON_ROOT,
  DEFAULT_DAEMON_ROOT,
  DENO_BIN,
  DENO_CURRENT_DIR,
  DENO_RUNTIME_DIR,
  DENO_VERSION,
  GALAXY_COLLECTIONS_DIR,
  ORCHESTRATION_DIR,
  PYTHON_CURRENT_DIR,
  PYTHON_RUNTIME_DIR,
  PYTHON_VERSION,
  REQUIREMENTS_FILE,
  resolveDaemonRoot,
  RUNTIMES_DIR,
  TUNNELS_DIR,
  UV_BIN,
  UV_CURRENT_DIR,
  UV_INSTALL_DIR,
  UV_VERSION,
  VENV_BIN_DIR,
} from "./paths.ts";
import {
  DaemonSourceRootError,
  detectInstallMode,
  DEV_CONFIG_DIR_DEFAULT,
  DEV_DAEMON_LOG_DIR_DEFAULT,
  DEV_DAEMON_ROOT_DEFAULT,
  DEV_DAEMON_STATE_DIR_DEFAULT,
  DEV_INSTANCE_DIR_DEFAULT,
  DEV_RUNTIMES_DIR_DEFAULT,
  PROD_BIN_DIR_DEFAULT,
  PROD_CONFIG_DIR_DEFAULT,
  PROD_DAEMON_ROOT_DEFAULT,
  PROD_HOME_DEFAULT,
  PROD_INSTANCE_DIR_DEFAULT,
  PROD_LIB_DIR_DEFAULT,
  PROD_LOG_DIR_DEFAULT,
  PROD_ORCHESTRATION_DIR_DEFAULT,
  PROD_RUN_DIR_DEFAULT,
  PROD_RUNTIME_DIR_DEFAULT,
  PROD_SHARE_DIR_DEFAULT,
  PROD_STATE_DIR_DEFAULT,
  PROD_UI_DIR_DEFAULT,
  readEnv,
  resolveLayout,
} from "../paths/layout.ts";

const fromMeta = new URL("../..", import.meta.url).pathname;
const checkoutOrchestrationDir = join(fromMeta, "orchestration");

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function assertEq(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertThrowsSourceRoot(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof DaemonSourceRootError) return;
    throw new Error(
      `${label}: expected DaemonSourceRootError, got ${
        err instanceof Error ? err.name : String(err)
      }`,
    );
  }
  throw new Error(`${label}: expected DaemonSourceRootError, none thrown`);
}

test("resolveDaemonRoot prefers TURBOPANEL_DAEMON_ROOT", () => {
  const root = resolveDaemonRoot({
    TURBOPANEL_DAEMON_ROOT: "/custom/daemon",
  }, { skipDiscovery: true });
  assertEq(root, "/custom/daemon", "resolveDaemonRoot override");
});

test("resolveDaemonRoot uses default install path for compiled stub roots", () => {
  const root = resolveDaemonRoot({
    TURBOPANEL_DAEMON_ROOT: "",
  }, { fromMeta, skipDiscovery: true });
  const tempDirPrefix = `${
    Deno.env.get("TMPDIR") ?? Deno.env.get("TEMP") ?? ""
  }/`;
  if (
    fromMeta.includes("deno-compile") ||
    (tempDirPrefix.length > 1 && fromMeta.startsWith(tempDirPrefix))
  ) {
    assertEq(root, DEFAULT_DAEMON_ROOT, "compiled stub default root");
  }
});

test("detectInstallMode ignores deno-compile root containing main.ts", async () => {
  const compiledRoot = await Deno.makeTempDir({
    prefix: "deno-compile-",
    dir: fromMeta,
  });
  try {
    await Deno.writeTextFile(join(compiledRoot, "main.ts"), "// stub\n");
    const mode = detectInstallMode({}, {
      fromMeta: compiledRoot,
      skipDiscovery: true,
    });
    assertEq(mode, "production", "mode");
  } finally {
    await Deno.remove(compiledRoot, { recursive: true });
  }
});

test("resolveDaemonRoot ignores deno-compile root containing main.ts", async () => {
  const compiledRoot = await Deno.makeTempDir({
    prefix: "deno-compile-",
    dir: fromMeta,
  });
  try {
    await Deno.writeTextFile(join(compiledRoot, "main.ts"), "// stub\n");
    const root = resolveDaemonRoot({}, {
      fromMeta: compiledRoot,
      skipDiscovery: true,
    });
    assertEq(root, PROD_DAEMON_ROOT_DEFAULT, "resolveDaemonRoot");
  } finally {
    await Deno.remove(compiledRoot, { recursive: true });
  }
});

// --- Source-sync (requireCheckout) refuses managed / compiled / JS-fallback ---
//
// dev-sync replaces an editable source tree in place; it must never target the
// bundled entrypoint location or a binary install root. These exercise the
// bundled JS entrypoint (non-compiled, non-checkout dir like /opt/turbopanel/bin)
// and the compiled/native stub path, and assert source-sync cannot resolve a
// managed FHS install.

test("resolveDaemonRoot requireCheckout accepts a real checkout override", async () => {
  const checkout = await Deno.makeTempDir({ dir: fromMeta });
  try {
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");
    const root = resolveDaemonRoot(
      { TURBOPANEL_DAEMON_ROOT: checkout },
      { skipDiscovery: true, requireCheckout: true },
    );
    assertEq(root, checkout, "requireCheckout checkout override");
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

test("resolveDaemonRoot requireCheckout rejects a non-checkout override", async () => {
  const notCheckout = await Deno.makeTempDir({ dir: fromMeta });
  try {
    assertThrowsSourceRoot(
      () =>
        resolveDaemonRoot(
          { TURBOPANEL_DAEMON_ROOT: notCheckout },
          { skipDiscovery: true, requireCheckout: true },
        ),
      "requireCheckout non-checkout override",
    );
  } finally {
    await Deno.remove(notCheckout, { recursive: true });
  }
});

test("resolveDaemonRoot requireCheckout rejects the bundled JS entrypoint location", async () => {
  // A non-compiled, non-checkout dir (e.g. /opt/turbopanel/bin where the
  // turbopaneld.js fallback resolves import.meta) — never under /tmp so it is
  // not classified as a compiled stub.
  const binDir = await Deno.makeTempDir({ dir: fromMeta });
  try {
    // Without requireCheckout the resolver falls back to this wrong root...
    const fallback = resolveDaemonRoot({}, {
      fromMeta: binDir,
      forceMode: "production",
      skipDiscovery: true,
    });
    assertEq(
      fallback,
      binDir,
      "managed fallback returns bundled entrypoint dir",
    );
    // ...but source-sync must refuse it.
    assertThrowsSourceRoot(
      () =>
        resolveDaemonRoot({}, {
          fromMeta: binDir,
          forceMode: "production",
          skipDiscovery: true,
          requireCheckout: true,
        }),
      "requireCheckout bundled JS entrypoint",
    );
  } finally {
    await Deno.remove(binDir, { recursive: true });
  }
});

test("resolveDaemonRoot requireCheckout rejects the compiled/native stub root", async () => {
  const compiledRoot = await Deno.makeTempDir({
    prefix: "deno-compile-",
    dir: fromMeta,
  });
  try {
    await Deno.writeTextFile(join(compiledRoot, "main.ts"), "// stub\n");
    assertThrowsSourceRoot(
      () =>
        resolveDaemonRoot({}, {
          fromMeta: compiledRoot,
          forceMode: "production",
          skipDiscovery: true,
          requireCheckout: true,
        }),
      "requireCheckout compiled stub",
    );
  } finally {
    await Deno.remove(compiledRoot, { recursive: true });
  }
});

test("production orchestration dir resolves share/orchestration", () => {
  const layout = resolveLayout({}, { forceMode: "production" });
  assertEq(
    layout.orchestrationDir,
    join(PROD_SHARE_DIR_DEFAULT, "orchestration"),
    "orchestrationDir",
  );
  assertEq(
    layout.orchestrationDir,
    PROD_ORCHESTRATION_DIR_DEFAULT,
    "PROD_ORCHESTRATION_DIR_DEFAULT",
  );
});

test("development layout resolves checkout orchestration and legacy runtimes", () => {
  const layout = resolveLayout({}, { forceMode: "development", fromMeta });
  assertEq(layout.mode, "development", "mode");
  assertEq(
    layout.daemonRootDefault,
    DEV_DAEMON_ROOT_DEFAULT,
    "daemonRootDefault",
  );
  assertEq(
    layout.orchestrationDir,
    checkoutOrchestrationDir,
    "orchestrationDir",
  );
  assertEq(layout.runtimesDir, DEV_RUNTIMES_DIR_DEFAULT, "runtimesDir");
  assertEq(
    layout.instanceDir,
    DEV_INSTANCE_DIR_DEFAULT,
    "instanceDir",
  );
});

test("production layout resolves FHS orchestration and runtime dirs", () => {
  const layout = resolveLayout({}, { forceMode: "production" });
  assertEq(layout.mode, "production", "mode");
  assertEq(
    layout.daemonRootDefault,
    PROD_DAEMON_ROOT_DEFAULT,
    "daemonRootDefault",
  );
  assertEq(
    layout.orchestrationDir,
    join(PROD_SHARE_DIR_DEFAULT, "orchestration"),
    "orchestrationDir",
  );
  assertEq(layout.runtimesDir, PROD_RUNTIME_DIR_DEFAULT, "runtimesDir");
  assertEq(layout.runDir, PROD_RUN_DIR_DEFAULT, "runDir");
  assertEq(layout.configDir, PROD_CONFIG_DIR_DEFAULT, "configDir");
  assertEq(
    layout.instanceCaPath,
    join(PROD_CONFIG_DIR_DEFAULT, "instance-ca.pem"),
    "instanceCaPath",
  );
  assertEq(
    layout.tlsDir,
    join(PROD_CONFIG_DIR_DEFAULT, "tls"),
    "tlsDir",
  );
  assertEq(layout.stateDir, PROD_STATE_DIR_DEFAULT, "stateDir");
  // Managed installs must resolve the FHS lib tree — never the dev checkout.
  assertEq(
    layout.instanceDir,
    PROD_INSTANCE_DIR_DEFAULT,
    "PROD_INSTANCE_DIR_DEFAULT",
  );
  assertEq(
    layout.instanceDir,
    "/opt/turbopanel/lib/instance",
    "instanceDir literal",
  );
});

test("layout env overrides apply in development mode", () => {
  const layout = resolveLayout({
    TURBOPANEL_RUNTIMES_DIR: "/custom/runtimes",
    TURBOPANEL_ORCHESTRATION_DIR: "/custom/orchestration",
    TURBOPANEL_INSTANCE_DIR: "/custom/instance",
    TURBOPANEL_CONFIG_DIR: "/custom/config",
    TURBOPANEL_RUN_DIR: "/custom/run",
    TURBOPANEL_STATE_DIR: "/custom/state",
  }, { forceMode: "development" });

  assertEq(layout.runtimesDir, "/custom/runtimes", "runtimesDir");
  assertEq(
    layout.orchestrationDir,
    "/custom/orchestration",
    "orchestrationDir",
  );
  assertEq(layout.instanceDir, "/custom/instance", "instanceDir");
  assertEq(layout.configDir, "/custom/config", "configDir");
  assertEq(layout.runDir, "/custom/run", "runDir");
  assertEq(layout.stateDir, "/custom/state", "stateDir");
  assertEq(layout.daemonStateDir, "/custom/state", "daemonStateDir");
  assertEq(
    layout.instanceCaPath,
    "/custom/config/instance-ca.pem",
    "instanceCaPath",
  );
});

test("layout env overrides apply in production mode", () => {
  const layout = resolveLayout({
    TURBOPANEL_RUNTIME_DIR: "/custom/lib/runtime",
    TURBOPANEL_ORCHESTRATION_DIR: "/custom/share/orchestration",
    TURBOPANEL_CONFIG_DIR: "/custom/etc/turbopanel",
    TURBOPANEL_STATE_DIR: "/custom/var/lib/turbopanel",
  }, { forceMode: "production" });

  assertEq(layout.runtimesDir, "/custom/lib/runtime", "runtimesDir");
  assertEq(
    layout.orchestrationDir,
    "/custom/share/orchestration",
    "orchestrationDir",
  );
  assertEq(layout.configDir, "/custom/etc/turbopanel", "configDir");
  assertEq(layout.stateDir, "/custom/var/lib/turbopanel", "stateDir");
});

test("module-level orchestration constants match active layout", () => {
  const layout = resolveLayout({
    TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
    TURBOPANEL_RUNTIMES_DIR: readEnv("TURBOPANEL_RUNTIMES_DIR"),
    TURBOPANEL_RUNTIME_DIR: readEnv("TURBOPANEL_RUNTIME_DIR"),
    TURBOPANEL_ORCHESTRATION_DIR: readEnv("TURBOPANEL_ORCHESTRATION_DIR"),
  });
  assertEq(
    DAEMON_ROOT,
    resolveDaemonRoot({
      TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
    }),
    "DAEMON_ROOT",
  );
  assertEq(ORCHESTRATION_DIR, layout.orchestrationDir, "ORCHESTRATION_DIR");
  assertEq(RUNTIMES_DIR, layout.runtimesDir, "RUNTIMES_DIR");
  assertEq(
    ANSIBLE_PLAYBOOK_CWD,
    dirname(layout.runtimesDir),
    "ANSIBLE_PLAYBOOK_CWD",
  );
  assertEq(
    UV_INSTALL_DIR,
    join(layout.runtimesDir, "uv", UV_VERSION),
    "UV_INSTALL_DIR",
  );
  assertEq(
    UV_CURRENT_DIR,
    join(layout.runtimesDir, "uv", "current"),
    "UV_CURRENT_DIR",
  );
  assertEq(UV_BIN, join(layout.runtimesDir, "uv", UV_VERSION, "uv"), "UV_BIN");
  assertEq(
    PYTHON_RUNTIME_DIR,
    join(layout.runtimesDir, "python", PYTHON_VERSION),
    "PYTHON_RUNTIME_DIR",
  );
  assertEq(
    PYTHON_CURRENT_DIR,
    join(layout.runtimesDir, "python", "current"),
    "PYTHON_CURRENT_DIR",
  );
  assertEq(
    CACHE_DIR,
    join(layout.runtimesDir, "uv", "cache"),
    "CACHE_DIR",
  );
  assertEq(
    ANSIBLE_INSTALL_DIR,
    join(layout.runtimesDir, "ansible", ANSIBLE_CORE_VERSION),
    "ANSIBLE_INSTALL_DIR",
  );
  assertEq(
    VENV_BIN_DIR,
    join(layout.runtimesDir, "ansible", ANSIBLE_CORE_VERSION, "bin"),
    "VENV_BIN_DIR",
  );
  assertEq(
    ANSIBLE_PLAYBOOK_BIN,
    join(
      layout.runtimesDir,
      "ansible",
      ANSIBLE_CORE_VERSION,
      "bin",
      "ansible-playbook",
    ),
    "ANSIBLE_PLAYBOOK_BIN",
  );
  assertEq(
    ANSIBLE_CURRENT_DIR,
    join(layout.runtimesDir, "ansible", "current"),
    "ANSIBLE_CURRENT_DIR",
  );
  assertEq(
    REQUIREMENTS_FILE,
    join(layout.orchestrationDir, "requirements.txt"),
    "REQUIREMENTS_FILE",
  );
  assertEq(
    GALAXY_COLLECTIONS_DIR,
    join(layout.runtimesDir, "ansible", "galaxy-collections"),
    "GALAXY_COLLECTIONS_DIR",
  );
  assertEq(
    ANSIBLE_LOCAL_TMP,
    join(layout.runtimesDir, "uv", "cache", "ansible-tmp"),
    "ANSIBLE_LOCAL_TMP",
  );
  assertEq(
    ANSIBLE_HOME,
    "/tmp/turbopanel-ansible",
    "ANSIBLE_HOME",
  );
  assertEq(
    ANSIBLE_CFG,
    join(layout.orchestrationDir, "ansible.cfg"),
    "ANSIBLE_CFG",
  );
  assertEq(
    DENO_RUNTIME_DIR,
    join(layout.runtimesDir, "deno", "2.9.3"),
    "DENO_RUNTIME_DIR",
  );
  assertEq(
    DENO_CURRENT_DIR,
    join(layout.runtimesDir, "deno", "current"),
    "DENO_CURRENT_DIR",
  );
  assertEq(
    DENO_BIN,
    join(layout.runtimesDir, "deno", "bin", "deno"),
    "DENO_BIN",
  );
  assertEq(
    CLOUDFLARED_CURRENT_DIR,
    join(layout.runtimesDir, "cloudflared", "current"),
    "CLOUDFLARED_CURRENT_DIR",
  );
  assertEq(
    TUNNELS_DIR,
    join(layout.daemonStateDir, "cloudflared", "tunnels"),
    "TUNNELS_DIR",
  );
});

test("module-level orchestration constants honor TURBOPANEL_RUNTIMES_DIR", () => {
  const customRuntimes = "/override/runtimes";
  const layout = resolveLayout({
    TURBOPANEL_RUNTIMES_DIR: customRuntimes,
  }, { forceMode: "development", fromMeta });
  assertEq(layout.runtimesDir, customRuntimes, "layout runtimesDir");
  assertEq(
    join(customRuntimes, "uv", UV_VERSION),
    join(layout.runtimesDir, "uv", UV_VERSION),
    "uv install path shape",
  );
});

// --- Dev-vs-prod path model contract -------------------------------------
//
// These pin the full FHS production tree and the co-located dev checkout tree
// so a regression to either default (or a leak of one into the other) fails CI
// rather than silently shipping the wrong layout.

test("production FHS default constants are the canonical absolute paths", () => {
  assertEq(PROD_HOME_DEFAULT, "/opt/turbopanel", "PROD_HOME_DEFAULT");
  assertEq(PROD_BIN_DIR_DEFAULT, "/opt/turbopanel/bin", "PROD_BIN_DIR_DEFAULT");
  assertEq(PROD_LIB_DIR_DEFAULT, "/opt/turbopanel/lib", "PROD_LIB_DIR_DEFAULT");
  assertEq(
    PROD_RUNTIME_DIR_DEFAULT,
    "/opt/turbopanel/vendor",
    "PROD_RUNTIME_DIR_DEFAULT",
  );
  assertEq(
    PROD_SHARE_DIR_DEFAULT,
    "/opt/turbopanel/share",
    "PROD_SHARE_DIR_DEFAULT",
  );
  assertEq(
    PROD_UI_DIR_DEFAULT,
    "/opt/turbopanel/share/ui",
    "PROD_UI_DIR_DEFAULT",
  );
  assertEq(
    PROD_ORCHESTRATION_DIR_DEFAULT,
    "/opt/turbopanel/share/orchestration",
    "PROD_ORCHESTRATION_DIR_DEFAULT",
  );
  assertEq(
    PROD_DAEMON_ROOT_DEFAULT,
    "/opt/turbopanel/lib/daemon",
    "PROD_DAEMON_ROOT_DEFAULT",
  );
  assertEq(
    PROD_INSTANCE_DIR_DEFAULT,
    "/opt/turbopanel/lib/instance",
    "PROD_INSTANCE_DIR_DEFAULT",
  );
  assertEq(
    PROD_CONFIG_DIR_DEFAULT,
    "/etc/turbopanel",
    "PROD_CONFIG_DIR_DEFAULT",
  );
  assertEq(
    PROD_STATE_DIR_DEFAULT,
    "/var/lib/turbopanel",
    "PROD_STATE_DIR_DEFAULT",
  );
  assertEq(PROD_LOG_DIR_DEFAULT, "/var/log/turbopanel", "PROD_LOG_DIR_DEFAULT");
  assertEq(PROD_RUN_DIR_DEFAULT, "/run/turbopanel", "PROD_RUN_DIR_DEFAULT");
});

test("production layout resolves the complete FHS tree with no defaults", () => {
  const layout = resolveLayout({}, { forceMode: "production" });
  assertEq(layout.mode, "production", "mode");
  assertEq(layout.home, PROD_HOME_DEFAULT, "home");
  assertEq(layout.binDir, PROD_BIN_DIR_DEFAULT, "binDir");
  assertEq(layout.libDir, PROD_LIB_DIR_DEFAULT, "libDir");
  assertEq(layout.runtimeDir, PROD_RUNTIME_DIR_DEFAULT, "runtimeDir");
  assertEq(layout.runtimesDir, PROD_RUNTIME_DIR_DEFAULT, "runtimesDir");
  assertEq(layout.shareDir, PROD_SHARE_DIR_DEFAULT, "shareDir");
  assertEq(layout.uiDir, PROD_UI_DIR_DEFAULT, "uiDir");
  assertEq(
    layout.orchestrationDir,
    PROD_ORCHESTRATION_DIR_DEFAULT,
    "orchestrationDir",
  );
  assertEq(layout.configDir, PROD_CONFIG_DIR_DEFAULT, "configDir");
  assertEq(layout.stateDir, PROD_STATE_DIR_DEFAULT, "stateDir");
  assertEq(layout.daemonStateDir, PROD_STATE_DIR_DEFAULT, "daemonStateDir");
  assertEq(layout.logDir, PROD_LOG_DIR_DEFAULT, "logDir");
  assertEq(layout.runDir, PROD_RUN_DIR_DEFAULT, "runDir");
  assertEq(
    layout.daemonRootDefault,
    PROD_DAEMON_ROOT_DEFAULT,
    "daemonRootDefault",
  );
  assertEq(layout.instanceDir, PROD_INSTANCE_DIR_DEFAULT, "instanceDir");
  // The production tree must never inherit the co-located dev checkout root.
  if (layout.orchestrationDir.includes("/platform/")) {
    throw new Error(
      `production orchestrationDir leaked a dev checkout path: ${layout.orchestrationDir}`,
    );
  }
  if (layout.instanceDir.includes("/platform/")) {
    throw new Error(
      `production instanceDir leaked a dev checkout path: ${layout.instanceDir}`,
    );
  }
  if (layout.runtimesDir.includes("/runtimes")) {
    throw new Error(
      `production runtimesDir must be vendor, got: ${layout.runtimesDir}`,
    );
  }
});

test("development layout resolves source repos with FHS mutable dirs", () => {
  const layout = resolveLayout({}, { forceMode: "development", fromMeta });
  assertEq(layout.mode, "development", "mode");
  assertEq(layout.runtimesDir, DEV_RUNTIMES_DIR_DEFAULT, "runtimesDir");
  assertEq(layout.configDir, DEV_CONFIG_DIR_DEFAULT, "configDir");
  assertEq(layout.instanceDir, DEV_INSTANCE_DIR_DEFAULT, "instanceDir");
  assertEq(layout.logDir, DEV_DAEMON_LOG_DIR_DEFAULT, "logDir");
  assertEq(
    layout.daemonRootDefault,
    DEV_DAEMON_ROOT_DEFAULT,
    "daemonRootDefault",
  );
  assertEq(
    layout.orchestrationDir,
    checkoutOrchestrationDir,
    "orchestrationDir",
  );
  // Dev now shares the production FHS mutable dirs (dev-user-owned at runtime).
  assertEq(layout.runtimesDir, "/opt/turbopanel/vendor", "runtimesDir literal");
  assertEq(layout.configDir, "/etc/turbopanel", "configDir literal");
  assertEq(
    layout.instanceDir,
    "/opt/turbopanel/lib/instance",
    "instanceDir literal",
  );
  assertEq(layout.logDir, "/var/log/turbopanel", "logDir literal");
});

test("dev daemon state default uses the FHS state dir", () => {
  assertEq(
    DEV_DAEMON_STATE_DIR_DEFAULT,
    "/var/lib/turbopanel",
    "DEV_DAEMON_STATE_DIR_DEFAULT",
  );
});

test("dev daemon log dir default uses the FHS log dir", () => {
  assertEq(
    DEV_DAEMON_LOG_DIR_DEFAULT,
    "/var/log/turbopanel",
    "DEV_DAEMON_LOG_DIR_DEFAULT",
  );
});

test("logDir follows the dev-vs-prod contract", () => {
  const dev = resolveLayout({}, { forceMode: "development", fromMeta });
  assertEq(dev.logDir, DEV_DAEMON_LOG_DIR_DEFAULT, "development logDir");
  assertEq(
    dev.logDir,
    "/var/log/turbopanel",
    "development logDir literal",
  );

  const prod = resolveLayout({}, { forceMode: "production" });
  assertEq(prod.logDir, PROD_LOG_DIR_DEFAULT, "production logDir");
  assertEq(prod.logDir, "/var/log/turbopanel", "production logDir literal");
});

test("PYTHON_VERSION matches uv-managed python pin", () => {
  assertEq(PYTHON_VERSION, "3.14.6", "PYTHON_VERSION");
  assertEq(
    PYTHON_RUNTIME_DIR,
    join(RUNTIMES_DIR, "python", PYTHON_VERSION),
    "PYTHON_RUNTIME_DIR under RUNTIMES_DIR",
  );
  assertEq(
    PYTHON_CURRENT_DIR,
    join(RUNTIMES_DIR, "python", "current"),
    "PYTHON_CURRENT_DIR under RUNTIMES_DIR",
  );
});

test("DENO_VERSION matches the deno-runtime Ansible role default", () => {
  const roleDefaults = join(
    fromMeta,
    "orchestration",
    "roles",
    "deno-runtime",
    "defaults",
    "main.yml",
  );
  const yaml = Deno.readTextFileSync(roleDefaults);
  const match = yaml.match(/^\s*deno_version:\s*["']?([\d.]+)["']?\s*$/m);
  if (!match) {
    throw new Error(`could not read deno_version from ${roleDefaults}`);
  }
  assertEq(match[1], DENO_VERSION, "deno_version role default");
});

test("DENO_VERSION matches TP_DENO_VERSION in scripts/run.sh", () => {
  const runSh = Deno.readTextFileSync(join(fromMeta, "scripts", "run.sh"));
  const match = /TP_DENO_VERSION="([\d.]+)"/.exec(runSh);
  if (!match) {
    throw new Error("could not read TP_DENO_VERSION from scripts/run.sh");
  }
  assertEq(match[1], DENO_VERSION, "TP_DENO_VERSION in run.sh");
});

test("CLICKHOUSE_VERSION matches the clickhouse Ansible role default", () => {
  const roleDefaults = join(
    fromMeta,
    "orchestration",
    "roles",
    "clickhouse",
    "defaults",
    "main.yml",
  );
  const yaml = Deno.readTextFileSync(roleDefaults);
  const match = yaml.match(/^\s*clickhouse_version:\s*["']?([\d.]+)["']?\s*$/m);
  if (!match) {
    throw new Error(`could not read clickhouse_version from ${roleDefaults}`);
  }
  assertEq(match[1], CLICKHOUSE_VERSION, "clickhouse_version role default");
});

test("ANSIBLE_CORE_VERSION matches the ansible-core pin in requirements.txt", () => {
  const requirements = Deno.readTextFileSync(REQUIREMENTS_FILE);
  const match = requirements.match(/^ansible-core==(\d+\.\d+)\.\*/m);
  if (!match) {
    throw new Error(
      `could not read ansible-core pin from ${REQUIREMENTS_FILE}`,
    );
  }
  assertEq(match[1], ANSIBLE_CORE_VERSION, "ansible-core requirements pin");
});
