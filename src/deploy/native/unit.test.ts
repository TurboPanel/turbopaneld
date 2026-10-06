import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolveLayout } from "../../paths/layout.ts";
import type { EnvironmentDeployNativeAppService } from "../../contracts/commands-contracts.ts";
import {
  DEFAULT_NATIVE_APP_NODE_VERSION,
  DEFAULT_START_SCRIPT,
  formatCpuQuota,
  formatMemoryBytes,
  NATIVE_APP_PLATFORM_ENV_NAMES,
  nativeAppConfigDir,
  nativeAppEnvPath,
  nativeAppEnvStageDir,
  nativeAppEnvStagePath,
  nativeAppNodeBinary,
  nativeAppRuntimeRoot,
  nativeAppStagedFilePrefix,
  nativeAppStagedPath,
  nativeAppUnitContent,
  nativeAppUnitName,
  nativeAppUnitPath,
  principalSliceContent,
  principalSliceName,
  principalSliceStagedPath,
  quoteSystemdArgument,
  resolveExecStart,
  resolveNativeAppNodeVersion,
  serviceLabelsLine,
  systemdRestartDirective,
} from "./unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const layout = resolveLayout(
  {
    TURBOPANEL_RUNTIMES_DIR: "/opt/turbopanel/vendor",
    TURBOPANEL_CONFIG_DIR: "/etc/turbopanel",
    TURBOPANEL_PRINCIPAL_HOME_ROOT: "/srv/users",
  },
  { skipDiscovery: true, forceMode: "production" },
);

const app: EnvironmentDeployNativeAppService = {
  composeServiceName: "api",
  serviceId: "svc-native-1",
  listenPort: 4100,
  framework: "node",
};

test("resolveNativeAppNodeVersion defaults when nodeVersion is blank", () => {
  assertEquals(
    resolveNativeAppNodeVersion({}),
    DEFAULT_NATIVE_APP_NODE_VERSION,
  );
  assertEquals(
    resolveNativeAppNodeVersion({ nodeVersion: "   " }),
    DEFAULT_NATIVE_APP_NODE_VERSION,
  );
  assertEquals(
    resolveNativeAppNodeVersion({ nodeVersion: "22" }),
    "22",
  );
});

test("nativeAppRuntimeRoot and nativeAppNodeBinary stay under node-app", () => {
  assertEquals(
    nativeAppRuntimeRoot(layout),
    "/opt/turbopanel/vendor/node-app",
  );
  assertEquals(
    nativeAppNodeBinary(layout, "22"),
    "/opt/turbopanel/vendor/node-app/22/current/bin/node",
  );
});

test("native app path helpers follow systemd and staging conventions", () => {
  assertEquals(
    nativeAppUnitName("svc-native-1"),
    "turbopanel-app-svc-native-1.service",
  );
  assertEquals(
    nativeAppUnitPath("svc-native-1", "/tmp/systemd"),
    "/tmp/systemd/turbopanel-app-svc-native-1.service",
  );
  assertEquals(principalSliceName("appuser"), "turbopanel-appuser.slice");
  assertEquals(
    nativeAppConfigDir(layout),
    "/etc/turbopanel/node-apps",
  );
  assertEquals(nativeAppStagedFilePrefix("env-1"), "tp-env-1-");
  assertEquals(
    nativeAppStagedPath(layout, "env-1", "svc-native-1"),
    "/etc/turbopanel/node-apps/tp-env-1-svc-native-1.service",
  );
  assertEquals(
    principalSliceStagedPath(layout, "appuser"),
    "/etc/turbopanel/node-apps/slice-appuser.slice",
  );
});

test("quoteSystemdArgument escapes embedded single quotes", () => {
  assertEquals(quoteSystemdArgument("plain"), "'plain'");
  assertEquals(
    quoteSystemdArgument("it's fine"),
    "'it'\\''s fine'",
  );
});

test("formatCpuQuota and formatMemoryBytes clamp to positive values", () => {
  assertEquals(formatCpuQuota(1.5), "150%");
  assertEquals(formatCpuQuota(0), "1%");
  assertEquals(formatMemoryBytes(1_073_741_824), "1073741824");
  assertEquals(formatMemoryBytes(0.4), "1");
});

test("resolveExecStart runs bare package-manager start via node --run", () => {
  assertEquals(
    resolveExecStart({
      nodeBinary: "/opt/node/bin/node",
      startCommand: "pnpm start",
    }),
    `/bin/sh -c ${quoteSystemdArgument("/opt/node/bin/node --run start")}`,
  );
  assertEquals(
    resolveExecStart({
      nodeBinary: "/opt/node/bin/node",
      startCommand: "yarn start",
    }),
    `/bin/sh -c ${quoteSystemdArgument("/opt/node/bin/node --run start")}`,
  );
});

test("resolveExecStart uses vendored node or sh -c for custom commands", () => {
  assertEquals(
    resolveExecStart({ nodeBinary: "/opt/node/bin/node" }),
    `/opt/node/bin/node ${DEFAULT_START_SCRIPT}`,
  );
  assertEquals(
    resolveExecStart({
      nodeBinary: "/opt/node/bin/node",
      startCommand: "node dist/main.js --flag",
    }),
    `/bin/sh -c ${quoteSystemdArgument("node dist/main.js --flag")}`,
  );
  assertEquals(
    resolveExecStart({
      nodeBinary: "/opt/node/bin/node",
      startCommand: "   ",
    }),
    `/opt/node/bin/node ${DEFAULT_START_SCRIPT}`,
  );
});

test("resolveExecStart honors startupFile unless a startCommand wins", () => {
  assertEquals(
    resolveExecStart({
      nodeBinary: "/opt/node/bin/node",
      startupFile: "dist/index.js",
    }),
    "/opt/node/bin/node dist/index.js",
  );
  // An explicit startCommand always wins over startupFile.
  assertEquals(
    resolveExecStart({
      nodeBinary: "/opt/node/bin/node",
      startCommand: "node dist/main.js",
      startupFile: "dist/index.js",
    }),
    `/bin/sh -c ${quoteSystemdArgument("node dist/main.js")}`,
  );
  // A blank startupFile falls back to the default script.
  assertEquals(
    resolveExecStart({
      nodeBinary: "/opt/node/bin/node",
      startupFile: "   ",
    }),
    `/opt/node/bin/node ${DEFAULT_START_SCRIPT}`,
  );
});

test("nativeAppUnitContent points WorkingDirectory at current and applies limits", () => {
  const content = nativeAppUnitContent({
    layout,
    app: {
      ...app,
      nodeVersion: "22",
      resources: { cpus: 2, memoryBytes: 512_000_000 },
    },
    username: "appuser",
    environmentId: "env-1",
    startCommand: "node server.mjs",
  });

  assertStringIncludes(
    content,
    "WorkingDirectory=/srv/users/appuser/sites/svc-native-1/current",
  );
  assertStringIncludes(
    content,
    "ReadWritePaths=/srv/users/appuser/sites/svc-native-1/shared",
  );
  assertStringIncludes(content, "User=appuser");
  assertStringIncludes(content, "Group=appuser-grp");
  assertStringIncludes(content, "Slice=turbopanel-appuser.slice");
  assertStringIncludes(content, "Environment=PORT=4100");
  assertStringIncludes(content, "CPUQuota=200%");
  assertStringIncludes(content, "MemoryMax=512000000");
  assertStringIncludes(
    content,
    `ExecStart=/bin/sh -c ${quoteSystemdArgument("node server.mjs")}`,
  );
});

test("nativeAppUnitContent prefixes PATH with the vendored tenant Node bin", () => {
  const content = nativeAppUnitContent({
    layout,
    app: { ...app, nodeVersion: "22" },
    username: "appuser",
    environmentId: "env-1",
    startCommand: "pnpm start",
  });
  assertStringIncludes(
    content,
    "Environment=PATH=/opt/turbopanel/vendor/node-app/22/current/bin:/usr/bin:/bin",
  );
  assertStringIncludes(
    content,
    "Environment=XDG_CACHE_HOME=/srv/users/appuser/sites/svc-native-1/shared/.cache",
  );
  assertStringIncludes(
    content,
    "Environment=COREPACK_HOME=/srv/users/appuser/sites/svc-native-1/shared/.corepack",
  );
  assertStringIncludes(
    content,
    `ExecStart=/bin/sh -c ${
      quoteSystemdArgument(
        "/opt/turbopanel/vendor/node-app/22/current/bin/node --run start",
      )
    }`,
  );
});

test("nativeAppUnitContent defaults ExecStart to vendored node when no startCommand", () => {
  const content = nativeAppUnitContent({
    layout,
    app: { ...app, nodeVersion: "22" },
    username: "appuser",
    environmentId: "env-1",
  });
  assertStringIncludes(
    content,
    `ExecStart=${nativeAppNodeBinary(layout, "22")} ${DEFAULT_START_SCRIPT}`,
  );
});

test("nativeAppUnitContent sets NODE_ENV from appMode and defaults to production", () => {
  const dev = nativeAppUnitContent({
    layout,
    app: { ...app, appMode: "development" },
    username: "appuser",
    environmentId: "env-1",
  });
  assertStringIncludes(dev, "Environment=NODE_ENV=development");

  const prod = nativeAppUnitContent({
    layout,
    app,
    username: "appuser",
    environmentId: "env-1",
  });
  assertStringIncludes(prod, "Environment=NODE_ENV=production");
});

test("nativeAppUnitContent threads startupFile into ExecStart", () => {
  const content = nativeAppUnitContent({
    layout,
    app: { ...app, nodeVersion: "22", startupFile: "dist/index.js" },
    username: "appuser",
    environmentId: "env-1",
  });
  assertStringIncludes(
    content,
    `ExecStart=${nativeAppNodeBinary(layout, "22")} dist/index.js`,
  );
});

test("principalSliceContent emits account limits when provided", () => {
  const slice = principalSliceContent({
    username: "appuser",
    limits: { cpus: 4, memoryBytes: 2_000_000_000, tasksMax: 128 },
  });
  assertStringIncludes(slice, "CPUQuota=400%");
  assertStringIncludes(slice, "MemoryHigh=2000000000");
  assertStringIncludes(slice, "MemoryMax=2000000000");
  assertStringIncludes(slice, "TasksMax=128");
});

test("an app with no restart_policy keeps the historical supervision lines", () => {
  // The regression that matters most: adding the field must not rewrite units
  // that existed before it. A payload without a policy has to render exactly
  // the two lines the lane has always emitted, or the next deploy reinstalls
  // and restarts every tenant app for no reason.
  const content = nativeAppUnitContent({
    layout,
    app,
    username: "appuser",
    environmentId: "env-1",
  });
  assertStringIncludes(content, "\nRestart=on-failure\n");
  assertStringIncludes(content, "\nRestartSec=2\n");
  assertEquals(content.includes("StartLimit"), false);
  assertEquals(content.includes("X-TurboPanel-Labels"), false);
});

test("systemdRestartDirective maps the Compose vocabulary onto systemd's", () => {
  // Two of the three names differ; a passthrough would emit `Restart=any`,
  // which systemd rejects outright.
  assertEquals(systemdRestartDirective("none"), "no");
  assertEquals(systemdRestartDirective("any"), "always");
  assertEquals(systemdRestartDirective("on-failure"), "on-failure");
});

test("an authored restart_policy becomes the unit's supervision directives", () => {
  const content = nativeAppUnitContent({
    layout,
    app: {
      ...app,
      restartPolicy: {
        condition: "any",
        delay: "5s",
        maxAttempts: 3,
        window: "1m30s",
      },
    },
    username: "appuser",
    environmentId: "env-1",
  });
  assertStringIncludes(content, "\nRestart=always\n");
  assertStringIncludes(content, "\nRestartSec=5s\n");
  // Rate-limit directives are `[Unit]`, not `[Service]` — emitting them beside
  // `Restart=` would make systemd ignore them.
  const unitSection = content.slice(0, content.indexOf("[Service]"));
  assertStringIncludes(unitSection, "StartLimitBurst=3");
  assertStringIncludes(unitSection, "StartLimitIntervalSec=1m30s");
});

test("restart condition none disables restarting without touching the backoff", () => {
  const content = nativeAppUnitContent({
    layout,
    app: { ...app, restartPolicy: { condition: "none" } },
    username: "appuser",
    environmentId: "env-1",
  });
  assertStringIncludes(content, "\nRestart=no\n");
  assertStringIncludes(content, "\nRestartSec=2\n");
});

test("serviceLabelsLine is one sorted, escaped JSON line or nothing", () => {
  assertEquals(serviceLabelsLine(undefined), null);
  assertEquals(serviceLabelsLine({}), null);
  // Sorted so the rendered unit is a function of the label set alone — the
  // install path is a byte diff, and a reordered mapping would reload units
  // that did not change.
  assertEquals(
    serviceLabelsLine({ team: "platform", app: "api" }),
    'X-TurboPanel-Labels={"app":"api","team":"platform"}',
  );
  // A newline in a value cannot break out into a directive of its own.
  const escaped = serviceLabelsLine({ note: "one\ntwo" });
  assertEquals(escaped, 'X-TurboPanel-Labels={"note":"one\\ntwo"}');
});

test("authored deploy.labels are preserved on the generated unit", () => {
  const content = nativeAppUnitContent({
    layout,
    app: { ...app, serviceLabels: { "com.example.team": "platform" } },
    username: "appuser",
    environmentId: "env-1",
  });
  const unitSection = content.slice(0, content.indexOf("[Service]"));
  assertStringIncludes(
    unitSection,
    'X-TurboPanel-Labels={"com.example.team":"platform"}',
  );
});

test("a native app writes only its own site's shared/, not the owner's home/, data/ or tmp/", () => {
  const content = nativeAppUnitContent({
    layout,
    app,
    username: "appuser",
    environmentId: "env-1",
  });
  const lines = content.split("\n");

  // HOME is the owner's home/ (read-only to the app), never the sealed root.
  assertStringIncludes(content, "Environment=HOME=/srv/users/appuser/home\n");
  assertEquals(lines.includes("Environment=HOME=/srv/users/appuser"), false);
  // Temp files go to the unit's private /tmp, not the owner's tmp/.
  assertStringIncludes(content, "Environment=TMPDIR=/tmp\n");
  assertStringIncludes(content, "PrivateTmp=yes\n");
  assertEquals(
    lines.filter((line) => line.startsWith("ReadWritePaths=")),
    ["ReadWritePaths=/srv/users/appuser/sites/svc-native-1/shared"],
  );
  for (const dir of ["home", "data", "tmp"]) {
    assertEquals(
      lines.some((line) =>
        line.startsWith("ReadWritePaths=") &&
        line.includes(`/srv/users/appuser/${dir}`)
      ),
      false,
      `${dir}/ must not be writable by a Node app`,
    );
  }
});

test("a unit loads an environment file only when the app has variables", () => {
  const user = { layout, app, username: "alice", environmentId: "env-1" };
  const without = nativeAppUnitContent(user);
  assertEquals(without.includes("EnvironmentFile"), false);
  // Asking explicitly for no file is the same text as not asking, so shipping
  // this feature rewrites (and restarts) no app that has no variables.
  assertEquals(
    nativeAppUnitContent({ ...user, environmentFile: false }),
    without,
  );

  const withFile = nativeAppUnitContent({ ...user, environmentFile: true });
  assertStringIncludes(
    withFile,
    "EnvironmentFile=/etc/turbopanel/node-app-env/svc-native-1.env\n",
  );
  // The unit names the root-owned copy tp-host makes, never the daemon's
  // staged file (a daemon-writable path systemd, as root, must not read).
  assertEquals(
    nativeAppEnvPath(layout, "svc-native-1"),
    "/etc/turbopanel/node-app-env/svc-native-1.env",
  );
  assertEquals(nativeAppEnvStageDir(layout), "/etc/turbopanel/node-apps/envs");
  assertEquals(
    nativeAppEnvStagePath(layout, "svc-native-1"),
    "/etc/turbopanel/node-apps/envs/svc-native-1.env",
  );
  assertEquals(withFile.includes("node-apps"), false);
  // Never an optional (`-`) path: a missing file must fail the unit loudly
  // rather than start an app without the credentials it was promised.
  assertEquals(withFile.includes("EnvironmentFile=-"), false);
});

test("the platform-owned names are exactly the Environment= keys a unit sets", () => {
  const unit = nativeAppUnitContent({
    layout,
    app,
    username: "alice",
    environmentId: "env-1",
    environmentFile: true,
  });
  const set = unit.split("\n")
    .filter((line) => line.startsWith("Environment="))
    .map((line) => line.slice("Environment=".length).split("=")[0]);
  // systemd lets EnvironmentFile override Environment=, so every name the unit
  // sets must be on the list that keeps tenant values out of the file.
  assertEquals([...set].sort(), [...NATIVE_APP_PLATFORM_ENV_NAMES].sort());
});

test("every native app binds loopback under both HOST and HOSTNAME", () => {
  const unit = nativeAppUnitContent({
    layout,
    app,
    username: "alice",
    environmentId: "env-1",
  });
  // Next.js (standalone server.js) reads HOSTNAME; without it the app binds
  // every interface, beside the proxy rather than behind it.
  assertStringIncludes(unit, "Environment=HOST=127.0.0.1\n");
  assertStringIncludes(unit, "Environment=HOSTNAME=127.0.0.1\n");
  assertEquals(NATIVE_APP_PLATFORM_ENV_NAMES.has("HOSTNAME"), true);
});

test("resolveExecStart: author's command, then startupFile, then the detected start", () => {
  const node = nativeAppNodeBinary(layout, "24");
  const next = { kind: "next-start" } as const;
  // Standalone Next and a plain Node app with server.js: exactly as before.
  assertEquals(
    resolveExecStart({
      nodeBinary: node,
      nativeStart: { kind: "file", path: "server.js" },
      listenPort: 4100,
    }),
    `${node} server.js`,
  );
  assertEquals(resolveExecStart({ nodeBinary: node }), `${node} server.js`);
  // A Next build shipped without standalone output: next start, on loopback.
  assertEquals(
    resolveExecStart({ nodeBinary: node, nativeStart: next, listenPort: 4100 }),
    `${node} node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4100`,
  );
  assertEquals(
    resolveExecStart({
      nodeBinary: node,
      nativeStart: { kind: "start-script" },
      listenPort: 4100,
    }),
    `${node} --run start`,
  );
  // What the author set always wins over what the build detected.
  assertEquals(
    resolveExecStart({
      nodeBinary: node,
      startupFile: "dist/index.js",
      nativeStart: next,
      listenPort: 4100,
    }),
    `${node} dist/index.js`,
  );
  assertEquals(
    resolveExecStart({
      nodeBinary: node,
      startCommand: "node worker.js",
      nativeStart: next,
      listenPort: 4100,
    }),
    `/bin/sh -c ${quoteSystemdArgument("node worker.js")}`,
  );
});

test("a recorded server.js start renders the same unit as no recorded start", () => {
  const base = { layout, app, username: "alice", environmentId: "env-1" };
  assertEquals(
    nativeAppUnitContent({
      ...base,
      nativeStart: { kind: "file", path: DEFAULT_START_SCRIPT },
    }),
    nativeAppUnitContent(base),
  );
  assertStringIncludes(
    nativeAppUnitContent({ ...base, nativeStart: { kind: "next-start" } }),
    `ExecStart=${
      nativeAppNodeBinary(layout)
    } node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4100\n`,
  );
});
