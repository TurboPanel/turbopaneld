import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  commandLogSpoolDir,
  DaemonSourceRootError,
  defaultDaemonRootForMode,
  detectInstallMode,
  DEV_CONFIG_DIR_DEFAULT,
  DEV_INSTANCE_DIR_DEFAULT,
  DEV_RUNTIMES_DIR_DEFAULT,
  fabricNetworkDir,
  fabricPrivateKeyPath,
  fabricStatePath,
  hasDaemonCheckout,
  isCompiledStubRoot,
  pathExists,
  principalHomePath,
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
  resolveDaemonRoot,
  resolveDevRoot,
  resolveLayout,
  resolveRuntimesDir,
  siteCurrentSymlink,
  siteReleasesDir,
  siteRoot,
  siteSharedDir,
  siteWebrootDir,
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
  assertEquals(resolveDevRoot({ TURBOPANEL_DEV_ROOT: "/" }), "");
});

test("resolveLayout ignores whitespace-only pickPath env overrides", () => {
  const production = resolveLayout(
    {
      TURBOPANEL_HOME: "   ",
      TURBOPANEL_BIN_DIR: "\t",
      TURBOPANEL_CONFIG_DIR: " \n ",
    },
    { forceMode: "production", skipDiscovery: true },
  );
  assertEquals(production.home, PROD_HOME_DEFAULT);
  assertEquals(production.binDir, PROD_BIN_DIR_DEFAULT);
  assertEquals(production.configDir, PROD_CONFIG_DIR_DEFAULT);

  const development = resolveLayout(
    {
      TURBOPANEL_HOME: "  ",
      TURBOPANEL_CONFIG_DIR: "\t",
    },
    { forceMode: "development", skipDiscovery: true },
  );
  assertEquals(development.home, PROD_HOME_DEFAULT);
  assertEquals(development.configDir, DEV_CONFIG_DIR_DEFAULT);
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

test("resolveLayout production defaults match the FHS tree", () => {
  const layout = resolveLayout({}, {
    forceMode: "production",
    skipDiscovery: true,
    fromMeta: "/opt/turbopanel/lib/daemon",
  });
  assertEquals(layout.mode, "production");
  assertEquals(layout.home, PROD_HOME_DEFAULT);
  assertEquals(layout.binDir, PROD_BIN_DIR_DEFAULT);
  assertEquals(layout.libDir, PROD_LIB_DIR_DEFAULT);
  assertEquals(layout.runtimeDir, PROD_RUNTIME_DIR_DEFAULT);
  assertEquals(layout.shareDir, PROD_SHARE_DIR_DEFAULT);
  assertEquals(layout.uiDir, PROD_UI_DIR_DEFAULT);
  assertEquals(layout.orchestrationDir, PROD_ORCHESTRATION_DIR_DEFAULT);
  assertEquals(layout.configDir, PROD_CONFIG_DIR_DEFAULT);
  assertEquals(layout.stateDir, PROD_STATE_DIR_DEFAULT);
  assertEquals(layout.logDir, PROD_LOG_DIR_DEFAULT);
  assertEquals(layout.runDir, PROD_RUN_DIR_DEFAULT);
  assertEquals(layout.daemonRootDefault, PROD_DAEMON_ROOT_DEFAULT);
  assertEquals(layout.runtimesDir, PROD_RUNTIME_DIR_DEFAULT);
  assertEquals(layout.instanceDir, PROD_INSTANCE_DIR_DEFAULT);
  assertEquals(
    layout.instanceConfigDir,
    join(PROD_CONFIG_DIR_DEFAULT, "instance"),
  );
  assertEquals(
    layout.instanceCaPath,
    join(PROD_CONFIG_DIR_DEFAULT, "instance-ca.pem"),
  );
  assertEquals(layout.tlsDir, join(PROD_CONFIG_DIR_DEFAULT, "tls"));
  assertEquals(layout.daemonStateDir, PROD_STATE_DIR_DEFAULT);
  assertEquals(layout.principalHomeRoot, "/srv/users");
});

test("resolveLayout development uses home-relative bins and FHS mutable dirs", () => {
  const layout = resolveLayout(
    { TURBOPANEL_HOME: "/custom/opt/" },
    { forceMode: "development", skipDiscovery: true },
  );
  assertEquals(layout.mode, "development");
  assertEquals(layout.home, "/custom/opt");
  assertEquals(layout.binDir, "/custom/opt/bin");
  assertEquals(layout.libDir, "/custom/opt/lib");
  assertEquals(layout.shareDir, "/custom/opt/share");
  assertEquals(layout.uiDir, "/custom/opt/share/ui");
  assertEquals(layout.runtimeDir, DEV_RUNTIMES_DIR_DEFAULT);
  assertEquals(layout.configDir, DEV_CONFIG_DIR_DEFAULT);
  assertEquals(layout.instanceDir, DEV_INSTANCE_DIR_DEFAULT);
  assertEquals(
    layout.orchestrationDir,
    join(defaultDaemonRootForMode("development", {}), "orchestration"),
  );

  const productionHome = resolveLayout(
    { TURBOPANEL_HOME: "/custom/opt/" },
    { forceMode: "production", skipDiscovery: true },
  );
  assertEquals(productionHome.binDir, PROD_BIN_DIR_DEFAULT);
  assertEquals(productionHome.libDir, PROD_LIB_DIR_DEFAULT);
  assertEquals(productionHome.orchestrationDir, PROD_ORCHESTRATION_DIR_DEFAULT);
});

test("resolveLayout honors every path override", () => {
  const layout = resolveLayout({
    TURBOPANEL_HOME: "/h/",
    TURBOPANEL_BIN_DIR: "/b/",
    TURBOPANEL_LIB_DIR: "/l/",
    TURBOPANEL_SHARE_DIR: "/s/",
    TURBOPANEL_UI_DIR: "/u/",
    TURBOPANEL_ORCHESTRATION_DIR: "/o/",
    TURBOPANEL_CONFIG_DIR: "/c/",
    TURBOPANEL_STATE_DIR: "/st/",
    TURBOPANEL_LOG_DIR: "/lg/",
    TURBOPANEL_RUN_DIR: "/r/",
    TURBOPANEL_RUNTIMES_DIR: "/v/",
    TURBOPANEL_INSTANCE_DIR: "/i/",
    TURBOPANEL_DAEMON_STATE_DIR: "/ds/",
    TURBOPANEL_PRINCIPAL_HOME_ROOT: "/p/",
  }, { forceMode: "production", skipDiscovery: true });

  assertEquals(layout.home, "/h");
  assertEquals(layout.binDir, "/b");
  assertEquals(layout.libDir, "/l");
  assertEquals(layout.shareDir, "/s");
  assertEquals(layout.uiDir, "/u");
  assertEquals(layout.orchestrationDir, "/o");
  assertEquals(layout.configDir, "/c");
  assertEquals(layout.stateDir, "/st");
  assertEquals(layout.logDir, "/lg");
  assertEquals(layout.runDir, "/r");
  assertEquals(layout.runtimesDir, "/v");
  assertEquals(layout.instanceDir, "/i");
  assertEquals(layout.daemonStateDir, "/ds");
  assertEquals(layout.principalHomeRoot, "/p");
  assertEquals(layout.instanceConfigDir, "/c/instance");
  assertEquals(layout.instanceCaPath, "/c/instance-ca.pem");
  assertEquals(layout.tlsDir, "/c/tls");
});

test("resolveLayout development orchestration dir follows TURBOPANEL_DAEMON_ROOT", () => {
  const layout = resolveLayout(
    { TURBOPANEL_DAEMON_ROOT: "/custom/checkout/" },
    { forceMode: "development", skipDiscovery: true },
  );
  assertEquals(layout.orchestrationDir, "/custom/checkout/orchestration");
});

function hideUnrelatedCheckouts(allowPrefix: string): () => void {
  const originalStat = Deno.statSync.bind(Deno);
  Deno.statSync = ((path: string | URL) => {
    const p = String(path);
    if (
      (p.endsWith("/main.ts") || p.endsWith("/orchestration/ansible.cfg")) &&
      !p.startsWith(allowPrefix)
    ) {
      throw new Deno.errors.NotFound(p);
    }
    return originalStat(path);
  }) as typeof Deno.statSync;
  return () => {
    Deno.statSync = originalStat;
  };
}

test("resolveLayout development orchestration dir discovers cwd checkout", async () => {
  await withTempLayout(async (fixture) => {
    const checkout = join(fixture.dirs.stateDir, "orch-cwd");
    await Deno.mkdir(checkout);
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");
    const originalCwd = Deno.cwd();
    const restoreStat = hideUnrelatedCheckouts(checkout);
    try {
      Deno.chdir(checkout);
      const layout = resolveLayout({}, {
        forceMode: "development",
        skipDiscovery: false,
      });
      assertEquals(layout.orchestrationDir, join(checkout, "orchestration"));
    } finally {
      restoreStat();
      Deno.chdir(originalCwd);
    }
  });
});

test("resolveLayout development orchestration dir discovers TURBOPANEL_DEV_ROOT", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.stateDir, "dev");
    const checkout = join(devRoot, "turbopaneld");
    await Deno.mkdir(checkout, { recursive: true });
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");
    const emptyCwd = await Deno.makeTempDir({ prefix: "layout-orch-empty-" });
    const originalCwd = Deno.cwd();
    const restoreStat = hideUnrelatedCheckouts(checkout);
    try {
      Deno.chdir(emptyCwd);
      const layout = resolveLayout(
        { TURBOPANEL_DEV_ROOT: devRoot },
        { forceMode: "development", skipDiscovery: false },
      );
      assertEquals(layout.orchestrationDir, join(checkout, "orchestration"));
    } finally {
      restoreStat();
      Deno.chdir(originalCwd);
      await Deno.remove(emptyCwd, { recursive: true });
    }
  });
});

test("resolveLayout development orchestration dir falls back when discovery throws", () => {
  const originalCwd = Deno.cwd;
  const originalStat = Deno.statSync.bind(Deno);
  Deno.cwd = () => {
    throw new Error("cwd unavailable");
  };
  Deno.statSync = (() => {
    throw new Error("stat blocked");
  }) as typeof Deno.statSync;
  try {
    const layout = resolveLayout(
      { TURBOPANEL_DEV_ROOT: "/no/such/turbopanel-dev-root" },
      { forceMode: "development", skipDiscovery: false },
    );
    assertEquals(
      layout.orchestrationDir,
      "/no/such/turbopanel-dev-root/turbopaneld/orchestration",
    );
  } finally {
    Deno.cwd = originalCwd;
    Deno.statSync = originalStat;
  }
});

test("site and spool helpers join under principal home and daemon state", () => {
  const layout = resolveLayout({
    TURBOPANEL_DAEMON_STATE_DIR: "/custom/state",
    TURBOPANEL_PRINCIPAL_HOME_ROOT: "/srv/tenants",
  }, { forceMode: "production", skipDiscovery: true });

  assertEquals(
    commandLogSpoolDir(layout),
    "/custom/state/spool/execution-logs",
  );
  assertEquals(principalHomePath(layout, "alice"), "/srv/tenants/alice");
  assertEquals(
    siteRoot("/srv/tenants/alice", "svc-1"),
    "/srv/tenants/alice/sites/svc-1",
  );
  assertEquals(
    siteReleasesDir("/srv/tenants/alice", "svc-1"),
    "/srv/tenants/alice/sites/svc-1/releases",
  );
  assertEquals(
    siteCurrentSymlink("/srv/tenants/alice", "svc-1"),
    "/srv/tenants/alice/sites/svc-1/current",
  );
  assertEquals(
    siteWebrootDir("/srv/tenants/alice", "svc-1"),
    "/srv/tenants/alice/sites/svc-1/webroot",
  );
  assertEquals(
    siteSharedDir("/srv/tenants/alice", "svc-1"),
    "/srv/tenants/alice/sites/svc-1/shared",
  );
});

test("detectInstallMode treats fromMeta checkout as development", async () => {
  await withTempLayout(async (fixture) => {
    const checkout = join(fixture.dirs.stateDir, "from-meta");
    await Deno.mkdir(checkout);
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");
    assertEquals(
      detectInstallMode({}, { fromMeta: checkout, skipDiscovery: true }),
      "development",
    );
  });
});

test("detectInstallMode returns production when cwd throws and no checkout exists", () => {
  const originalCwd = Deno.cwd;
  Deno.cwd = () => {
    throw new Error("cwd unavailable");
  };
  try {
    assertEquals(
      detectInstallMode(
        { TURBOPANEL_DEV_ROOT: "/no/such/turbopanel-dev-root" },
        { fromMeta: "/opt/turbopanel/lib/daemon", skipDiscovery: false },
      ),
      "production",
    );
  } finally {
    Deno.cwd = originalCwd;
  }
});

test("resolveDaemonRoot returns fromMeta checkout and cwd checkout", async () => {
  await withTempLayout(async (fixture) => {
    const fromMeta = join(fixture.dirs.stateDir, "meta-checkout");
    await Deno.mkdir(fromMeta);
    await Deno.writeTextFile(join(fromMeta, "main.ts"), "// checkout\n");
    assertEquals(
      resolveDaemonRoot({}, { fromMeta, skipDiscovery: true }),
      fromMeta,
    );

    const cwdCheckout = join(fixture.dirs.stateDir, "cwd-checkout");
    await Deno.mkdir(cwdCheckout);
    await Deno.writeTextFile(join(cwdCheckout, "main.ts"), "// checkout\n");
    const originalCwd = Deno.cwd();
    try {
      Deno.chdir(cwdCheckout);
      assertEquals(
        resolveDaemonRoot({}, {
          fromMeta: "/opt/turbopanel/lib/daemon",
          skipDiscovery: false,
        }),
        cwdCheckout,
      );
    } finally {
      Deno.chdir(originalCwd);
    }
  });
});

test("resolveDaemonRoot uses mode default when it is a checkout", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.stateDir, "dev");
    const checkout = join(devRoot, "turbopaneld");
    await Deno.mkdir(checkout, { recursive: true });
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");
    assertEquals(
      resolveDaemonRoot(
        { TURBOPANEL_DEV_ROOT: devRoot },
        {
          fromMeta: "/opt/turbopanel/lib/daemon",
          skipDiscovery: true,
          forceMode: "development",
        },
      ),
      checkout,
    );
  });
});

test("resolveDaemonRoot compiled stub falls back to the production default", () => {
  assertEquals(
    resolveDaemonRoot({}, {
      fromMeta: "/tmp/deno-compile-abc/extracted",
      skipDiscovery: true,
      forceMode: "production",
    }),
    PROD_DAEMON_ROOT_DEFAULT,
  );
});

test("resolveDaemonRoot returns fromMeta when it is not a compiled stub", () => {
  assertEquals(
    resolveDaemonRoot({}, {
      fromMeta: "/opt/turbopanel/lib/daemon",
      skipDiscovery: true,
      forceMode: "production",
    }),
    "/opt/turbopanel/lib/daemon",
  );
});

test("resolveDaemonRoot cwd throw does not fail discovery", () => {
  const originalCwd = Deno.cwd;
  Deno.cwd = () => {
    throw new Error("cwd unavailable");
  };
  try {
    assertEquals(
      resolveDaemonRoot({}, {
        fromMeta: "/opt/turbopanel/lib/daemon",
        skipDiscovery: false,
        forceMode: "production",
      }),
      "/opt/turbopanel/lib/daemon",
    );
  } finally {
    Deno.cwd = originalCwd;
  }
});

test("detectInstallMode ignores whitespace and non-checkout TURBOPANEL_DAEMON_ROOT", async () => {
  assertEquals(
    detectInstallMode(
      { TURBOPANEL_DAEMON_ROOT: "   " },
      { fromMeta: "/opt/turbopanel/lib/daemon", skipDiscovery: true },
    ),
    "production",
  );

  await withTempLayout(async (fixture) => {
    const notCheckout = join(fixture.dirs.stateDir, "not-checkout");
    await Deno.mkdir(notCheckout);
    assertEquals(
      detectInstallMode(
        { TURBOPANEL_DAEMON_ROOT: notCheckout },
        { fromMeta: "/opt/turbopanel/lib/daemon", skipDiscovery: true },
      ),
      "production",
    );
  });
});

test("resolveDaemonRoot requireCheckout rejects a compiled-stub override", () => {
  assertThrows(
    () =>
      resolveDaemonRoot(
        { TURBOPANEL_DAEMON_ROOT: "/tmp/deno-compile-stub" },
        { skipDiscovery: true, requireCheckout: true },
      ),
    DaemonSourceRootError,
    "not a daemon source checkout",
  );
});

test("DaemonSourceRootError keeps a distinct name", () => {
  const err = new DaemonSourceRootError("missing checkout");
  assertEquals(err.name, "DaemonSourceRootError");
  assertEquals(err.message, "missing checkout");
});
