import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  DaemonSourceRootError,
  defaultDaemonRootForMode,
  detectInstallMode,
  fabricNetworkDir,
  fabricPrivateKeyPath,
  fabricStatePath,
  hasDaemonCheckout,
  isCompiledStubRoot,
  pathExists,
  PROD_DAEMON_ROOT_DEFAULT,
  PROD_HOME_DEFAULT,
  PROD_RUNTIME_DIR_DEFAULT,
  readEnv,
  resolveDaemonRoot,
  resolveDevRoot,
  resolveLayout,
  resolveRuntimesDir,
} from "./layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("pathExists reports present and missing paths", async () => {
  await withTempLayout((fixture) => {
    assertEquals(pathExists(fixture.dirs.configDir), true);
    assertEquals(pathExists(join(fixture.dirs.configDir, "missing")), false);
  });
});

test("hasDaemonCheckout requires main.ts or orchestration/ansible.cfg", async () => {
  await withTempLayout(async (fixture) => {
    const root = join(fixture.dirs.stateDir, "checkout");
    await Deno.mkdir(root);
    assertEquals(hasDaemonCheckout(root), false);

    await Deno.writeTextFile(join(root, "main.ts"), "// checkout\n");
    assertEquals(hasDaemonCheckout(root), true);

    await Deno.remove(join(root, "main.ts"));
    await Deno.mkdir(join(root, "orchestration"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "orchestration", "ansible.cfg"),
      "[defaults]\n",
    );
    assertEquals(hasDaemonCheckout(root), true);
  });
});

test("isCompiledStubRoot detects deno-compile and non-checkout /tmp roots", async () => {
  assertEquals(isCompiledStubRoot("/tmp/deno-compile-abc/extracted"), true);
  assertEquals(isCompiledStubRoot("/opt/turbopanel/lib/daemon"), false);

  await withTempLayout(async (fixture) => {
    // makeTempDir lives under /tmp and has no checkout → compiled-stub heuristic.
    assertEquals(isCompiledStubRoot(fixture.dirs.stateDir), true);

    await Deno.writeTextFile(join(fixture.dirs.stateDir, "main.ts"), "// x\n");
    assertEquals(isCompiledStubRoot(fixture.dirs.stateDir), false);
  });
});

test("resolveDevRoot prefers TURBOPANEL_DEV_ROOT then HOME", () => {
  assertEquals(
    resolveDevRoot({ TURBOPANEL_DEV_ROOT: "/custom/dev/" }),
    "/custom/dev",
  );
  assertEquals(
    resolveDevRoot({ HOME: "/home/operator/" }),
    "/home/operator",
  );
  assertEquals(
    resolveDevRoot({ TURBOPANEL_DEV_ROOT: "  ", HOME: "  " }),
    resolveDevRoot({}),
  );
});

test("readEnv returns undefined when env access fails", () => {
  const originalGet = Deno.env.get.bind(Deno.env);
  Deno.env.get = () => {
    throw new Error("env blocked");
  };
  try {
    assertEquals(readEnv("TURBOPANEL_HOME"), undefined);
  } finally {
    Deno.env.get = originalGet;
  }
});

test("detectInstallMode discovers checkout from cwd and dev root", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "layout-cwd-" });
  const devRoot = await Deno.makeTempDir({ prefix: "layout-dev-" });
  const originalCwd = Deno.cwd();
  try {
    await Deno.writeTextFile(join(cwd, "main.ts"), "// cwd checkout\n");
    await Deno.chdir(cwd);
    assertEquals(
      detectInstallMode({}, {
        fromMeta: "/opt/turbopanel/lib/daemon",
        skipDiscovery: false,
      }),
      "development",
    );

    const checkout = join(devRoot, "turbopaneld");
    await Deno.mkdir(checkout);
    await Deno.writeTextFile(join(checkout, "main.ts"), "// dev checkout\n");
    const emptyCwd = await Deno.makeTempDir({ prefix: "layout-empty-" });
    await Deno.chdir(emptyCwd);
    assertEquals(
      detectInstallMode(
        { TURBOPANEL_DEV_ROOT: devRoot },
        { fromMeta: "/opt/turbopanel/lib/daemon", skipDiscovery: false },
      ),
      "development",
    );
    await Deno.remove(emptyCwd, { recursive: true });
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(cwd, { recursive: true });
    await Deno.remove(devRoot, { recursive: true });
  }
});

test("resolveLayout development orchestration dir follows checkout meta", async () => {
  await withTempLayout(async (fixture) => {
    const checkout = join(fixture.dirs.stateDir, "turbopaneld");
    await Deno.mkdir(checkout);
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");

    const layout = resolveLayout(
      {},
      {
        forceMode: "development",
        skipDiscovery: true,
        fromMeta: checkout,
      },
    );
    assertEquals(layout.orchestrationDir, join(checkout, "orchestration"));
  });
});

test("detectInstallMode honors forceMode and checkout override", async () => {
  assertEquals(
    detectInstallMode({}, { forceMode: "production", skipDiscovery: true }),
    "production",
  );

  await withTempLayout(async (fixture) => {
    const checkout = join(fixture.dirs.stateDir, "turbopaneld");
    await Deno.mkdir(checkout);
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");

    assertEquals(
      detectInstallMode(
        { TURBOPANEL_DAEMON_ROOT: checkout },
        { skipDiscovery: true },
      ),
      "development",
    );
    assertEquals(
      detectInstallMode(
        { TURBOPANEL_DAEMON_ROOT: "/tmp/deno-compile-stub" },
        {
          skipDiscovery: true,
          fromMeta: "/opt/turbopanel/lib/daemon",
        },
      ),
      "production",
    );
  });
});

test("defaultDaemonRootForMode and resolveRuntimesDir follow mode defaults", () => {
  assertEquals(
    defaultDaemonRootForMode("production", {}),
    PROD_DAEMON_ROOT_DEFAULT,
  );
  assertEquals(
    defaultDaemonRootForMode("development", {
      TURBOPANEL_DEV_ROOT: "/home/dev",
    }),
    "/home/dev/turbopaneld",
  );

  assertEquals(
    resolveRuntimesDir({}, { forceMode: "production", skipDiscovery: true }),
    PROD_RUNTIME_DIR_DEFAULT,
  );
  assertEquals(
    resolveRuntimesDir(
      { TURBOPANEL_RUNTIMES_DIR: "/custom/vendor/" },
      { forceMode: "production", skipDiscovery: true },
    ),
    "/custom/vendor",
  );
});

test("resolveLayout strips trailing slashes and wires fabric helpers", () => {
  const layout = resolveLayout({
    TURBOPANEL_HOME: `${PROD_HOME_DEFAULT}/`,
    TURBOPANEL_DAEMON_STATE_DIR: "/custom/state/",
    TURBOPANEL_PRINCIPAL_HOME_ROOT: "/srv/tenants/",
  }, { forceMode: "production", skipDiscovery: true });

  assertEquals(layout.home, PROD_HOME_DEFAULT);
  assertEquals(layout.daemonStateDir, "/custom/state");
  assertEquals(layout.principalHomeRoot, "/srv/tenants");
  assertEquals(fabricNetworkDir(layout), "/custom/state/network");
  assertEquals(
    fabricPrivateKeyPath(layout),
    "/custom/state/network/wireguard/private.key",
  );
  assertEquals(fabricStatePath(layout), "/custom/state/network/state.json");
});

test("resolveDaemonRoot requireCheckout throws DaemonSourceRootError", async () => {
  await withTempLayout(async (fixture) => {
    const notCheckout = join(fixture.dirs.stateDir, "bin");
    await Deno.mkdir(notCheckout);

    assertThrows(
      () =>
        resolveDaemonRoot(
          { TURBOPANEL_DAEMON_ROOT: notCheckout },
          { skipDiscovery: true, requireCheckout: true },
        ),
      DaemonSourceRootError,
      "not a daemon source checkout",
    );

    assertThrows(
      () =>
        resolveDaemonRoot({}, {
          fromMeta: notCheckout,
          forceMode: "production",
          skipDiscovery: true,
          requireCheckout: true,
        }),
      DaemonSourceRootError,
      "no daemon source checkout found",
    );
  });
});

test("resolveDaemonRoot returns a real checkout override", async () => {
  await withTempLayout(async (fixture) => {
    const checkout = join(fixture.dirs.stateDir, "src");
    await Deno.mkdir(checkout);
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");

    assertEquals(
      resolveDaemonRoot(
        { TURBOPANEL_DAEMON_ROOT: checkout },
        { skipDiscovery: true, requireCheckout: true },
      ),
      checkout,
    );
  });
});
