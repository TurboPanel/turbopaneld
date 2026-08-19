import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  applyTraditionalWebSites,
  removeTraditionalWebSites,
  type TraditionalWebApplySite,
  type TraditionalWebPlaybookFn,
  type TraditionalWebRunFn,
  type TraditionalWebRunResult,
} from "./traditional-web.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function makeTestLayout(): Promise<
  { layout: LayoutPaths; cleanup: () => Promise<void> }
> {
  const root = await Deno.makeTempDir({ prefix: "tp-traditional-web-io-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
      TURBOPANEL_LOG_DIR: `${root}/log`,
      TURBOPANEL_RUN_DIR: `${root}/run`,
      TURBOPANEL_RUNTIMES_DIR: `${root}/runtimes`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  return { layout, cleanup: () => Deno.remove(root, { recursive: true }) };
}

function ok(): TraditionalWebRunResult {
  return { success: true, stdout: "", stderr: "" };
}

/** Host-free sudo seam: install copies/mkdirs; rm deletes; everything else succeeds. */
function createTraditionalWebRunMock(): {
  run: TraditionalWebRunFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: TraditionalWebRunFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== "sudo") return ok();

    if (args.includes("install") && args.includes("-d")) {
      const path = args.at(-1);
      if (typeof path !== "string") {
        throw new TypeError("expected install -d path");
      }
      await Deno.mkdir(path, { recursive: true, mode: 0o750 });
      return ok();
    }

    if (args.includes("install")) {
      const dest = args.at(-1);
      const src = args.at(-2);
      if (typeof src !== "string" || typeof dest !== "string") {
        throw new TypeError("expected install src dest");
      }
      await Deno.mkdir(dirname(dest), { recursive: true });
      await Deno.copyFile(src, dest);
      return ok();
    }

    if (args.includes("rm")) {
      const path = args.at(-1);
      if (typeof path !== "string") {
        throw new TypeError("expected rm path");
      }
      try {
        await Deno.remove(path, { recursive: true });
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      return ok();
    }

    return ok();
  };
  return { run, calls };
}

function capturePlaybooks(): {
  runPlaybook: TraditionalWebPlaybookFn;
  labels: string[];
} {
  const labels: string[] = [];
  return {
    labels,
    runPlaybook: (_path, label) => {
      labels.push(label);
      return Promise.resolve();
    },
  };
}

const nginxSite: TraditionalWebApplySite = {
  composeServiceName: "www",
  engine: "nginx",
  root: "public",
  listenPort: 18080,
};

const apachePhpSite: TraditionalWebApplySite = {
  composeServiceName: "phpapp",
  engine: "apache",
  root: "public",
  listenPort: 18081,
  php: { version: "8.4", memoryLimit: "128M", maxExecutionTime: 30 },
};

const olsSite: TraditionalWebApplySite = {
  composeServiceName: "static",
  engine: "openlitespeed",
  root: "html",
  listenPort: 18082,
};

test("applyTraditionalWebSites empty list is a no-op", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const result = await applyTraditionalWebSites(layout, "env1", []);
    assertEquals(result, { applied: [] });
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites nginx with mocked Ansible/Docker sudo install", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createTraditionalWebRunMock();
  const { runPlaybook, labels } = capturePlaybooks();
  try {
    const result = await applyTraditionalWebSites(layout, "env1", [nginxSite], {
      run,
      runPlaybook,
      dockerBindAddress: "203.0.113.10",
    });
    assertEquals(result.applied, ["www"]);
    assertEquals(labels.some((l) => l.includes("nginx")), true);

    const confPath = join(
      layout.configDir,
      "nginx",
      "sites",
      "tp-env1-www.conf",
    );
    const conf = await Deno.readTextFile(confPath);
    assertStringIncludes(conf, "listen 127.0.0.1:18080;");
    assertStringIncludes(conf, "listen 203.0.113.10:18080;");

    const index = await Deno.readTextFile(
      join(layout.stateDir, "sites", "env1", "www", "public", "index.html"),
    );
    assertStringIncludes(index, "www");

    assertEquals(
      calls.some((c) =>
        c.command === "sudo" && c.args.includes("systemctl") &&
        c.args.includes("turbopanel-nginx")
      ),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites apache+php writes pool and site config", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createTraditionalWebRunMock();
  const { runPlaybook, labels } = capturePlaybooks();
  try {
    const result = await applyTraditionalWebSites(
      layout,
      "env2",
      [apachePhpSite],
      { run, runPlaybook },
    );
    assertEquals(result.applied, ["phpapp"]);
    assertEquals(labels.some((l) => l.includes("apache")), true);

    const siteConf = await Deno.readTextFile(
      join(layout.configDir, "apache", "sites", "tp-env2-phpapp.conf"),
    );
    assertStringIncludes(siteConf, "Listen 127.0.0.1:18081");
    assertStringIncludes(siteConf, "proxy:unix:");

    const poolConf = await Deno.readTextFile(
      join(layout.configDir, "php", "pools", "tp-env2-phpapp.conf"),
    );
    assertStringIncludes(poolConf, "[tp-env2-phpapp]");
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites openlitespeed installs vhost + fragment", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createTraditionalWebRunMock();
  const { runPlaybook, labels } = capturePlaybooks();
  try {
    const result = await applyTraditionalWebSites(layout, "env3", [olsSite], {
      run,
      runPlaybook,
    });
    assertEquals(result.applied, ["static"]);
    assertEquals(labels.some((l) => l.includes("openlitespeed")), true);

    const fragment = await Deno.readTextFile(
      join(
        layout.configDir,
        "openlitespeed",
        "sites",
        "tp-env3-static.conf",
      ),
    );
    assertStringIncludes(fragment, "vhRoot");
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites applies nginx+apache+ols together", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createTraditionalWebRunMock();
  const { runPlaybook, labels } = capturePlaybooks();
  try {
    const result = await applyTraditionalWebSites(
      layout,
      "env4",
      [nginxSite, apachePhpSite, olsSite],
      { run, runPlaybook },
    );
    assertEquals(result.applied, ["www", "phpapp", "static"]);
    assertEquals(labels.length, 3);
  } finally {
    await cleanup();
  }
});

test("removeTraditionalWebSites removes nginx/apache/ols configs via mocked sudo", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createTraditionalWebRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envrm";
  try {
    await applyTraditionalWebSites(
      layout,
      environmentId,
      [nginxSite, apachePhpSite, olsSite],
      { run, runPlaybook },
    );

    await removeTraditionalWebSites(layout, environmentId, { run });

    for (
      const path of [
        join(
          layout.configDir,
          "nginx",
          "sites",
          `tp-${environmentId}-www.conf`,
        ),
        join(
          layout.configDir,
          "apache",
          "sites",
          `tp-${environmentId}-phpapp.conf`,
        ),
        join(
          layout.configDir,
          "php",
          "pools",
          `tp-${environmentId}-phpapp.conf`,
        ),
        join(
          layout.configDir,
          "openlitespeed",
          "sites",
          `tp-${environmentId}-static.conf`,
        ),
      ]
    ) {
      await assertRejects(
        () => Deno.stat(path),
        Deno.errors.NotFound,
      );
    }
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites rejects unsafe environmentId", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createTraditionalWebRunMock();
  try {
    await assertRejects(
      () =>
        applyTraditionalWebSites(layout, "../evil", [nginxSite], {
          run,
          runPlaybook: () => Promise.resolve(),
        }),
      Error,
      "environmentId contains unsupported characters",
    );
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites writes webEnv metadata and reloads nginx via start fallback", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const calls: Array<{ command: string; args: string[] }> = [];
  const base = createTraditionalWebRunMock();
  const run: TraditionalWebRunFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (
      args.includes("reload") && args.includes("turbopanel-nginx")
    ) {
      return { success: false, stdout: "", stderr: "not loaded" };
    }
    return await base.run(command, args);
  };
  try {
    const result = await applyTraditionalWebSites(
      layout,
      "envmeta",
      [
        {
          ...nginxSite,
          webEnv: { FOO: 'bar"baz', NOTE: "line\n2" },
        },
      ],
      { run, runPlaybook },
    );
    assertEquals(result.applied, ["www"]);
    const envPath = join(
      layout.stateDir,
      "sites",
      "envmeta",
      "www",
      ".turbopanel",
      "hosting.env",
    );
    const envBody = await Deno.readTextFile(envPath);
    assertStringIncludes(envBody, "FOO=");
    assertEquals(
      calls.some((c) =>
        c.args.includes("enable") && c.args.includes("turbopanel-nginx")
      ),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites fails when nginx -t fails", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const base = createTraditionalWebRunMock();
  const run: TraditionalWebRunFn = async (command, args) => {
    if (args.includes("-t") && args.includes("-c")) {
      return { success: false, stdout: "", stderr: "nginx config bad" };
    }
    return await base.run(command, args);
  };
  try {
    await assertRejects(
      () =>
        applyTraditionalWebSites(layout, "envfail", [nginxSite], {
          run,
          runPlaybook,
        }),
      Error,
      "nginx config bad",
    );
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites fails when apache reload and start both fail", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const base = createTraditionalWebRunMock();
  const run: TraditionalWebRunFn = async (command, args) => {
    if (args.includes("reload") && args.includes("turbopanel-apache")) {
      return { success: false, stdout: "", stderr: "reload failed" };
    }
    if (args.includes("enable") && args.includes("turbopanel-apache")) {
      return { success: false, stdout: "", stderr: "start failed" };
    }
    return await base.run(command, args);
  };
  try {
    await assertRejects(
      () =>
        applyTraditionalWebSites(layout, "envapache", [apachePhpSite], {
          run,
          runPlaybook,
        }),
      Error,
      "reload failed",
    );
  } finally {
    await cleanup();
  }
});

test("applyTraditionalWebSites rejects unsafe document root", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createTraditionalWebRunMock();
  try {
    await assertRejects(
      () =>
        applyTraditionalWebSites(
          layout,
          "envroot",
          [{ ...nginxSite, root: "../escape" }],
          {
            run,
            runPlaybook: () => Promise.resolve(),
          },
        ),
      Error,
      "traditional-web root is unsafe",
    );
  } finally {
    await cleanup();
  }
});
