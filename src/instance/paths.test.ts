import { join } from "@std/path";
import {
  CANONICAL_INSTANCE_CA_PATH,
  createInstanceHttpClient,
  DEFAULT_SOCKET_DIR,
  resolveInstanceConfig,
  resolveInstanceCaPath,
  resolveInstanceSocket,
  resolveServerIdentityDir,
  resolveServerKeyPath,
} from "./paths.ts";
import {
  DEV_CONFIG_DIR_DEFAULT,
  PROD_CONFIG_DIR_DEFAULT,
  PROD_RUN_DIR_DEFAULT,
  readEnv,
  resolveLayout,
} from "../paths/layout.ts";
import { resolveInstanceConfigDir } from "./public-urls-env.ts";

const CADDY_HTTPS = "https://localhost:8443";
const PLATFORM_CA = "/opt/turbopanel/platform/instance/certs/ca.crt";

function assertEq(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("development layout resolves legacy socket and CA paths", () => {
  const layout = resolveLayout({}, { forceMode: "development" });
  assertEq(layout.runDir, "/run/turbopanel", "runDir");
  assertEq(
    layout.instanceCaPath,
    join(DEV_CONFIG_DIR_DEFAULT, "instance-ca.pem"),
    "instanceCaPath",
  );
  assertEq(
    layout.instanceConfigDir,
    join(DEV_CONFIG_DIR_DEFAULT, "instance"),
    "instanceConfigDir",
  );
});

Deno.test("production layout resolves FHS socket and CA paths", () => {
  const layout = resolveLayout({}, { forceMode: "production" });
  assertEq(layout.runDir, PROD_RUN_DIR_DEFAULT, "runDir");
  assertEq(
    layout.instanceCaPath,
    join(PROD_CONFIG_DIR_DEFAULT, "instance-ca.pem"),
    "instanceCaPath",
  );
  assertEq(
    layout.instanceConfigDir,
    join(PROD_CONFIG_DIR_DEFAULT, "instance"),
    "instanceConfigDir",
  );
});

Deno.test("DEFAULT_SOCKET_DIR and CANONICAL_INSTANCE_CA_PATH match active layout", () => {
  const layout = resolveLayout({
    TURBOPANEL_RUN_DIR: readEnv("TURBOPANEL_RUN_DIR"),
    TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
    TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
  });
  assertEq(DEFAULT_SOCKET_DIR, layout.runDir, "DEFAULT_SOCKET_DIR");
  assertEq(
    CANONICAL_INSTANCE_CA_PATH,
    layout.instanceCaPath,
    "CANONICAL_INSTANCE_CA_PATH",
  );
});

Deno.test("resolveInstanceSocket uses TURBOPANEL_RUN_DIR override", () => {
  const socket = resolveInstanceSocket({
    TURBOPANEL_RUN_DIR: "/custom/run",
  });
  assertEq(socket, "/custom/run/instance.sock", "socket path");
});

Deno.test("resolveInstanceConfigDir honors TURBOPANEL_CONFIG_DIR override", () => {
  assertEq(
    resolveInstanceConfigDir({ TURBOPANEL_CONFIG_DIR: "/custom/config" }),
    "/custom/config/instance",
    "instance config dir",
  );
});

Deno.test("layout env overrides apply to socket and config paths", () => {
  const layout = resolveLayout({
    TURBOPANEL_RUN_DIR: "/custom/run",
    TURBOPANEL_CONFIG_DIR: "/custom/config",
  }, { forceMode: "production" });
  assertEq(layout.runDir, "/custom/run", "runDir");
  assertEq(layout.configDir, "/custom/config", "configDir");
  assertEq(
    layout.instanceCaPath,
    "/custom/config/instance-ca.pem",
    "instanceCaPath",
  );
});

Deno.test("TURBOPANEL_STATE_DIR controls server identity storage", () => {
  const env = { TURBOPANEL_STATE_DIR: "/custom/state" };
  const layout = resolveLayout(env, { forceMode: "development" });
  assertEq(layout.stateDir, "/custom/state", "stateDir");
  assertEq(layout.daemonStateDir, "/custom/state", "daemonStateDir");
  assertEq(
    resolveServerIdentityDir(env),
    "/custom/state",
    "resolveServerIdentityDir",
  );
  assertEq(
    resolveServerKeyPath(env),
    "/custom/state/server-key.json",
    "resolveServerKeyPath",
  );
});

Deno.test("resolveInstanceConfig uses url mode when TURBOPANEL_INSTANCE_URL is set", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_URL: CADDY_HTTPS,
  });

  if (config.kind !== "url") {
    throw new Error("expected url mode when TURBOPANEL_INSTANCE_URL is set");
  }
  if (config.baseUrl !== CADDY_HTTPS) {
    throw new Error(`expected baseUrl ${CADDY_HTTPS}, got ${config.baseUrl}`);
  }
  if (config.wsBaseUrl !== "wss://localhost:8443") {
    throw new Error(
      `expected wss://localhost:8443, got ${config.wsBaseUrl}`,
    );
  }
});

Deno.test("resolveInstanceConfig uses socket mode when TURBOPANEL_INSTANCE_URL is absent", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "deno",
  });

  if (config.kind !== "socket") {
    throw new Error(
      "expected socket mode when TURBOPANEL_INSTANCE_URL is absent",
    );
  }
});

Deno.test("workers transition: url and CA env keys resolve to url mode", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "workers",
    TURBOPANEL_INSTANCE_URL: CADDY_HTTPS,
    TURBOPANEL_INSTANCE_CA: PLATFORM_CA,
  });

  if (config.kind !== "url") {
    throw new Error(
      "expected url mode after workers transition writes URL/CA keys",
    );
  }
  if (config.baseUrl !== CADDY_HTTPS) {
    throw new Error(`expected baseUrl ${CADDY_HTTPS}, got ${config.baseUrl}`);
  }
});

Deno.test("resolveInstanceCaPath prefers TURBOPANEL_INSTANCE_CA env when file exists", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    const path = resolveInstanceCaPath({
      TURBOPANEL_INSTANCE_CA: tmp,
    });
    if (path !== tmp) {
      throw new Error(`expected ${tmp}, got ${path}`);
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("resolveInstanceCaPath returns undefined when env unset and canonical file missing", () => {
  const path = resolveInstanceCaPath({});
  if (path !== undefined) {
    throw new Error(`expected undefined, got ${path}`);
  }
});

Deno.test("createInstanceHttpClient returns undefined for plaintext http without reading CA", async () => {
  const client = await createInstanceHttpClient(
    {
      kind: "url",
      baseUrl: "http://localhost:8880",
      wsBaseUrl: "ws://localhost:8880",
    },
    { caCertPath: "/nonexistent/platform/config/instance-ca.pem" },
  );
  if (client !== undefined) {
    throw new Error(`expected undefined, got ${client}`);
  }
});

Deno.test("deno transition: cleared URL key restores socket mode", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "deno",
    TURBOPANEL_INSTANCE_CA: PLATFORM_CA,
  });

  if (config.kind !== "socket") {
    throw new Error(
      "expected socket mode after deno transition clears TURBOPANEL_INSTANCE_URL",
    );
  }
});
