import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolveLayout } from "../../paths/layout.ts";
import type { EnvironmentDeployNativeAppService } from "../../instance/commands/contracts.ts";
import {
  DEFAULT_NATIVE_APP_NODE_VERSION,
  DEFAULT_START_SCRIPT,
  formatCpuQuota,
  formatMemoryBytes,
  nativeAppConfigDir,
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
  assertEquals(resolveNativeAppNodeVersion({}), DEFAULT_NATIVE_APP_NODE_VERSION);
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
  assertEquals(nativeAppUnitName("svc-native-1"), "turbopanel-app-svc-native-1.service");
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

  assertStringIncludes(content, "WorkingDirectory=/srv/users/appuser/sites/svc-native-1/current");
  assertStringIncludes(content, "ReadWritePaths=/srv/users/appuser/sites/svc-native-1/shared");
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
