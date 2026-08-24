import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  applySites,
  RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES,
  removeSites,
  type SiteApplySpec,
  type SitePlaybookFn,
  type SiteRelease,
  type SiteRunFn,
  type SiteRunResult,
} from "./site.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function makeTestLayout(): Promise<
  { layout: LayoutPaths; root: string; cleanup: () => Promise<void> }
> {
  const root = await Deno.makeTempDir({ prefix: "tp-site-io-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
      TURBOPANEL_LOG_DIR: `${root}/log`,
      TURBOPANEL_RUN_DIR: `${root}/run`,
      TURBOPANEL_RUNTIMES_DIR: `${root}/runtimes`,
      TURBOPANEL_PRINCIPAL_HOME_ROOT: `${root}/srv/users`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  return {
    layout,
    root,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

function ok(): SiteRunResult {
  return { success: true, stdout: "", stderr: "" };
}

function fail(stderr: string): SiteRunResult {
  return { success: false, stdout: "", stderr };
}

/** Real `cmp -s` semantics: equal contents succeed, a missing file does not. */
async function filesMatch(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      Deno.readFile(a),
      Deno.readFile(b),
    ]);
    if (left.length !== right.length) return false;
    return left.every((byte, index) => byte === right[index]);
  } catch {
    return false;
  }
}

/**
 * Host-free sudo seam: install copies/mkdirs; `cmp -s` compares for real (the
 * apply path uses it to skip byte-identical rewrites); `cp`/`mv` snapshot and
 * swap staged candidates for real (the rollout path restores from them); rm
 * deletes; `curl` answers 200 so post-reload validation passes; everything
 * else succeeds.
 */
function createSiteRunMock(): {
  run: SiteRunFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: SiteRunFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "curl") return { success: true, stdout: "200", stderr: "" };
    if (command !== "sudo") return ok();

    if (args.includes("cmp")) {
      const right = args.at(-1);
      const left = args.at(-2);
      if (typeof left !== "string" || typeof right !== "string") {
        throw new TypeError("expected cmp left right");
      }
      return (await filesMatch(left, right)) ? ok() : fail("files differ");
    }

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

    // The staging snapshot: a `cp` of a path that does not exist yet is how the
    // driver learns there is no previous config to restore.
    if (args.includes("cp")) {
      const dest = args.at(-1);
      const src = args.at(-2);
      if (typeof src !== "string" || typeof dest !== "string") {
        throw new TypeError("expected cp src dest");
      }
      try {
        await Deno.copyFile(src, dest);
      } catch {
        return fail(`cp: cannot stat '${src}'`);
      }
      return ok();
    }

    if (args.includes("mv")) {
      const dest = args.at(-1);
      const src = args.at(-2);
      if (typeof src !== "string" || typeof dest !== "string") {
        throw new TypeError("expected mv src dest");
      }
      try {
        await Deno.rename(src, dest);
      } catch {
        return fail(`mv: cannot move '${src}'`);
      }
      return ok();
    }

    return ok();
  };
  return { run, calls };
}

/**
 * Everything left under a site-config dir after an apply — live `*.conf` files
 * *and* any `.tpnew`/`.tpprev` staging temps a rollout should have cleaned up.
 */
async function listConfigDirEntries(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

function capturePlaybooks(): {
  runPlaybook: SitePlaybookFn;
  labels: string[];
  /** Extra `-e` vars per playbook label — which runtimes the daemon asked for. */
  extraVars: Array<{ label: string; vars: Record<string, unknown> }>;
} {
  const labels: string[] = [];
  const extraVars: Array<{ label: string; vars: Record<string, unknown> }> = [];
  return {
    labels,
    extraVars,
    runPlaybook: (_path, label, args) => {
      labels.push(label);
      const json = args?.[args.indexOf("-e") + 1];
      if (typeof json === "string") {
        extraVars.push({ label, vars: JSON.parse(json) });
      }
      return Promise.resolve();
    },
  };
}

/** The `-e` vars passed to the one playbook whose label mentions `engine`. */
function playbookVars(
  extraVars: ReadonlyArray<{ label: string; vars: Record<string, unknown> }>,
  engine: string,
): Record<string, unknown> | undefined {
  return extraVars.find((entry) => entry.label.includes(engine))?.vars;
}

const nginxSite: SiteApplySpec = {
  composeServiceName: "www",
  engine: "nginx",
  root: "public",
  listenPort: 18080,
};

const apachePhpSite: SiteApplySpec = {
  composeServiceName: "phpapp",
  engine: "apache",
  root: "public",
  listenPort: 18081,
  php: {
    version: "8.4",
    settings: { memory_limit: "128M", max_execution_time: "30" },
  },
};

const olsSite: SiteApplySpec = {
  composeServiceName: "static",
  engine: "openlitespeed",
  root: "html",
  listenPort: 18082,
};

test("applySites empty list is a no-op", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const result = await applySites(layout, "env1", []);
    assertEquals(result, { applied: [] });
  } finally {
    await cleanup();
  }
});

test("applySites nginx with mocked Ansible/Docker sudo install", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook, labels } = capturePlaybooks();
  try {
    const result = await applySites(layout, "env1", [nginxSite], {
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

test("applySites apache+php writes pool and site config", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook, labels } = capturePlaybooks();
  try {
    const result = await applySites(
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
      join(layout.configDir, "php", "8.4", "pools", "tp-env2-phpapp.conf"),
    );
    assertStringIncludes(poolConf, "[tp-env2-phpapp]");
  } finally {
    await cleanup();
  }
});

test("applySites openlitespeed installs vhost + fragment", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook, labels } = capturePlaybooks();
  try {
    const result = await applySites(layout, "env3", [olsSite], {
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

test("applySites applies nginx+apache+ols together", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook, labels } = capturePlaybooks();
  try {
    const result = await applySites(
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

test("removeSites removes nginx/apache/ols configs via mocked sudo", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envrm";
  try {
    await applySites(
      layout,
      environmentId,
      [nginxSite, apachePhpSite, olsSite],
      { run, runPlaybook },
    );

    await removeSites(layout, environmentId, { run });

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

test("applySites rejects unsafe environmentId", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  try {
    await assertRejects(
      () =>
        applySites(layout, "../evil", [nginxSite], {
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

test("applySites writes webEnv metadata and reloads nginx via start fallback", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const calls: Array<{ command: string; args: string[] }> = [];
  const base = createSiteRunMock();
  const run: SiteRunFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (
      args.includes("reload") && args.includes("turbopanel-nginx")
    ) {
      return { success: false, stdout: "", stderr: "not loaded" };
    }
    return await base.run(command, args);
  };
  try {
    const result = await applySites(
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

test("applySites fails when nginx -t fails", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const base = createSiteRunMock();
  const run: SiteRunFn = async (command, args) => {
    if (args.includes("-t") && args.includes("-c")) {
      return { success: false, stdout: "", stderr: "nginx config bad" };
    }
    return await base.run(command, args);
  };
  try {
    await assertRejects(
      () =>
        applySites(layout, "envfail", [nginxSite], {
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

test("applySites fails when apache reload and start both fail", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const base = createSiteRunMock();
  const run: SiteRunFn = async (command, args) => {
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
        applySites(layout, "envapache", [apachePhpSite], {
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

test("applySites rejects unsafe document root", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  try {
    await assertRejects(
      () =>
        applySites(
          layout,
          "envroot",
          [{ ...nginxSite, root: "../escape" }],
          {
            run,
            runPlaybook: () => Promise.resolve(),
          },
        ),
      Error,
      "site root is unsafe",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Release-backed sites: document roots resolve inside the Git release tree.
// ---------------------------------------------------------------------------

const RELEASE_USERNAME = "appuser";
const RELEASE_SERVICE_ID = "svc-1";
const RELEASE_GROUP = `${RELEASE_USERNAME}-grp`;

const releaseBinding: SiteRelease = {
  serviceId: RELEASE_SERVICE_ID,
  username: RELEASE_USERNAME,
};

function releaseBindingsFor(
  ...composeServiceNames: readonly string[]
): Map<string, SiteRelease> {
  return new Map(
    composeServiceNames.map((name) => [name, releaseBinding]),
  );
}

function siteTreeRoot(layout: LayoutPaths): string {
  return join(
    layout.principalHomeRoot,
    RELEASE_USERNAME,
    "sites",
    RELEASE_SERVICE_ID,
  );
}

/**
 * Seed what `promoteRelease` leaves behind: an immutable release directory
 * (with its `shared` link), a `shared/` state dir, and `current` pointing at
 * the release by relative path.
 */
async function seedRelease(
  layout: LayoutPaths,
  releaseId: string,
  docRootName: string,
  indexBody: string,
): Promise<string> {
  const siteRootDir = siteTreeRoot(layout);
  const releaseDir = join(siteRootDir, "releases", releaseId);
  await Deno.mkdir(join(releaseDir, docRootName), { recursive: true });
  await Deno.mkdir(join(siteRootDir, "shared"), { recursive: true });
  await Deno.writeTextFile(
    join(releaseDir, docRootName, "index.html"),
    indexBody,
  );
  try {
    await Deno.symlink(join("..", "..", "shared"), join(releaseDir, "shared"));
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }

  const currentLink = join(siteRootDir, "current");
  const tmpLink = `${currentLink}.tmp.${releaseId}`;
  await Deno.symlink(join("releases", releaseId), tmpLink);
  await Deno.rename(tmpLink, currentLink);
  return releaseDir;
}

/** Wrap the sudo mock so `id -nG <user>` reports `groups` for that user. */
function withGroupMembership(
  base: SiteRunFn,
  groupsByUser: Readonly<Record<string, readonly string[]>>,
): SiteRunFn {
  return async (command, args) => {
    if (command === "id" && args[0] === "-nG") {
      const user = args[1] ?? "";
      return {
        success: true,
        stdout: (groupsByUser[user] ?? []).join(" "),
        stderr: "",
      };
    }
    return await base(command, args);
  };
}

function usermodCalls(
  calls: ReadonlyArray<{ command: string; args: string[] }>,
): Array<{ command: string; args: string[] }> {
  return calls.filter((c) => c.args.includes("usermod"));
}

/** `sudo install <src> <dest>` calls — i.e. config/pool files actually rewritten. */
function installedConfigPaths(
  calls: ReadonlyArray<{ command: string; args: string[] }>,
): string[] {
  const paths: string[] = [];
  for (const call of calls) {
    if (!call.args.includes("install") || call.args.includes("-d")) continue;
    const dest = call.args.at(-1);
    if (typeof dest === "string") paths.push(dest);
  }
  return paths;
}

/** Every `systemctl <action> <unit>` this apply asked for, in order. */
function systemctlCalls(
  calls: ReadonlyArray<{ command: string; args: string[] }>,
): string[] {
  const out: string[] = [];
  for (const call of calls) {
    const at = call.args.indexOf("systemctl");
    if (at < 0) continue;
    out.push(call.args.slice(at + 1).join(" "));
  }
  return out;
}

function systemctlActions(
  calls: ReadonlyArray<{ command: string; args: string[] }>,
  unit: string,
): string[] {
  const actions: string[] = [];
  for (const call of calls) {
    if (!call.args.includes("systemctl") || !call.args.includes(unit)) continue;
    const action = call.args[call.args.indexOf("systemctl") + 1];
    if (action) actions.push(action);
  }
  return actions;
}

test("applySites serves a release-backed nginx site from current/", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>release one</h1>");

    const result = await applySites(layout, "envrel", [
      nginxSite,
    ], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });
    assertEquals(result.applied, ["www"]);

    // Document root is the stable `current` name, never a release id.
    const conf = await Deno.readTextFile(
      join(layout.configDir, "nginx", "sites", "tp-envrel-www.conf"),
    );
    assertStringIncludes(
      conf,
      `root ${join(siteTreeRoot(layout), "current", "public")};`,
    );

    // The release engine owns the tree — nothing seeded, nothing chowned.
    assertEquals(
      mock.calls.some((c) => c.args.includes("chown")),
      false,
    );
    assertEquals(
      await Deno.readTextFile(
        join(siteTreeRoot(layout), "current", "public", "index.html"),
      ),
      "<h1>release one</h1>",
    );

    // New group membership → restart, not reload: supplementary groups are
    // fixed when a worker process starts.
    assertEquals(usermodCalls(mock.calls).length, 1);
    assertEquals(
      usermodCalls(mock.calls)[0]?.args.slice(-3),
      ["-aG", RELEASE_GROUP, "tpnginx"],
    );
    assertEquals(
      systemctlActions(mock.calls, "turbopanel-nginx").includes("restart"),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("applySites writes release hosting metadata beside the release", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>one</h1>");

    await applySites(layout, "envmeta2", [
      { ...nginxSite, webEnv: { FOO: 'bar"baz' } },
    ], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });

    // Outside the immutable release, and outside `current` — a promote must not
    // take the hosting facts with it.
    const metaPath = join(
      siteTreeRoot(layout),
      ".turbopanel-hosting",
      "hosting.env",
    );
    assertStringIncludes(await Deno.readTextFile(metaPath), "FOO=");
    await assertRejects(
      () =>
        Deno.stat(
          join(
            siteTreeRoot(layout),
            "releases",
            "rel-1",
            ".turbopanel",
            "hosting.env",
          ),
        ),
      Deno.errors.NotFound,
    );
  } finally {
    await cleanup();
  }
});

test("applySites is byte-identical across a release promote", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  // Already a member: a redeploy must not restart the engine again.
  const run = withGroupMembership(mock.run, {
    tpnginx: ["tpnginx", RELEASE_GROUP],
  });
  const { runPlaybook } = capturePlaybooks();
  const confPath = join(
    layout.configDir,
    "nginx",
    "sites",
    "tp-envswap-www.conf",
  );
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>one</h1>");
    await applySites(layout, "envswap", [nginxSite], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });
    const firstConf = await Deno.readTextFile(confPath);
    // Everything below is scoped to the *second* apply only.
    const firstApplyCalls = mock.calls.length;

    // Second promote swaps `current` to a different release directory.
    await seedRelease(layout, "rel-2", "public", "<h1>two</h1>");
    await applySites(layout, "envswap", [nginxSite], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });
    const secondApply = mock.calls.slice(firstApplyCalls);

    // Only `current` moved; the generated vhost never needed a rewrite.
    assertEquals(await Deno.readTextFile(confPath), firstConf);
    assertEquals(
      await Deno.readTextFile(
        join(siteTreeRoot(layout), "current", "public", "index.html"),
      ),
      "<h1>two</h1>",
    );

    // …and because nothing changed, nothing was reinstalled, config-tested, or
    // reloaded: a Git-backed promote is a `current` symlink swap and no more.
    assertEquals(installedConfigPaths(secondApply), []);
    assertEquals(systemctlCalls(secondApply), []);
    assertEquals(
      secondApply.some((c) => c.args.includes("-t") && c.args.includes("-c")),
      false,
    );
    assertEquals(usermodCalls(mock.calls).length, 0);
  } finally {
    await cleanup();
  }
});

test("applySites reloads again once release-backed config changes", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, {
    tpnginx: ["tpnginx", RELEASE_GROUP],
  });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>one</h1>");
    await applySites(layout, "envport", [nginxSite], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });
    const firstApplyCalls = mock.calls.length;

    // A different listen port is a real vhost change — the skip is content
    // based, not "release-backed sites never reload".
    await applySites(layout, "envport", [{
      ...nginxSite,
      listenPort: 18099,
    }], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });
    const secondApply = mock.calls.slice(firstApplyCalls);

    assertEquals(installedConfigPaths(secondApply).length, 1);
    assertEquals(systemctlActions(secondApply, "turbopanel-nginx"), ["reload"]);
    assertStringIncludes(
      await Deno.readTextFile(
        join(layout.configDir, "nginx", "sites", "tp-envport-www.conf"),
      ),
      "listen 127.0.0.1:18099;",
    );
  } finally {
    await cleanup();
  }
});

test("applySites serves the last good release after a failed build", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, {
    tpnginx: ["tpnginx", RELEASE_GROUP],
  });
  const { runPlaybook } = capturePlaybooks();
  try {
    // `promoteRelease` guarantees this shape on failure: `current` still points
    // at the previous release and the staged directory is gone.
    await seedRelease(layout, "rel-1", "public", "<h1>last good</h1>");

    const result = await applySites(layout, "envfail2", [
      nginxSite,
    ], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });

    assertEquals(result.applied, ["www"]);
    assertEquals(
      await Deno.readTextFile(
        join(siteTreeRoot(layout), "current", "public", "index.html"),
      ),
      "<h1>last good</h1>",
    );
  } finally {
    await cleanup();
  }
});

test("applySites fails loudly when no release has been promoted", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await assertRejects(
      () =>
        applySites(layout, "envnorel", [nginxSite], {
          run,
          runPlaybook,
          releaseBindings: releaseBindingsFor("www"),
        }),
      Error,
      "release document root missing for www",
    );
    // Never synthesize a placeholder over what the operator believes is theirs.
    await assertRejects(
      () =>
        Deno.stat(
          join(siteTreeRoot(layout), "current", "public", "index.html"),
        ),
      Deno.errors.NotFound,
    );
  } finally {
    await cleanup();
  }
});

test("applySites confines a release-backed PHP pool with open_basedir", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpapache: ["tpapache"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<?php echo 1;");

    await applySites(layout, "envphp", [apachePhpSite], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("phpapp"),
    });

    const poolConf = await Deno.readTextFile(
      join(layout.configDir, "php", "8.4", "pools", "tp-envphp-phpapp.conf"),
    );
    const documentRoot = join(siteTreeRoot(layout), "current", "public");
    const sharedDir = join(siteTreeRoot(layout), "shared");
    assertStringIncludes(
      poolConf,
      `php_admin_value[open_basedir] = ${documentRoot}:${sharedDir}:/tmp`,
    );
    assertStringIncludes(poolConf, `chdir = ${documentRoot}`);

    // A promote moves `current` without reloading php-fpm, so already-running
    // workers must not be allowed to keep resolving it to the old release.
    for (const directive of RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES) {
      assertStringIncludes(poolConf, directive);
    }
    assertStringIncludes(poolConf, "php_admin_value[realpath_cache_ttl] = 0");
    assertStringIncludes(
      poolConf,
      "php_admin_value[opcache.revalidate_path] = 1",
    );

    // php-fpm workers run as the principal, which owns the group already.
    assertEquals(
      systemctlActions(mock.calls, "turbopanel-php-fpm@8.4").includes(
        "restart",
      ),
      false,
    );
  } finally {
    await cleanup();
  }
});

test("applySites leaves a legacy PHP pool on baseline caching", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envphpleg", [apachePhpSite], {
      run,
      runPlaybook,
    });

    // No symlink to outrun: a daemon-owned root keeps the vendored php.ini
    // opcache/realpath defaults rather than paying for a per-request stat.
    const poolConf = await Deno.readTextFile(
      join(layout.configDir, "php", "8.4", "pools", "tp-envphpleg-phpapp.conf"),
    );
    for (const directive of RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES) {
      assertEquals(poolConf.includes(directive), false);
    }
    assertEquals(poolConf.includes("open_basedir"), false);
  } finally {
    await cleanup();
  }
});

test("applySites skips the php-fpm reload on a release promote", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, {
    tpapache: ["tpapache", RELEASE_GROUP],
  });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<?php echo 1;");
    await applySites(layout, "envphpswap", [apachePhpSite], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("phpapp"),
    });
    const firstApplyCalls = mock.calls.length;

    await seedRelease(layout, "rel-2", "public", "<?php echo 2;");
    await applySites(layout, "envphpswap", [apachePhpSite], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("phpapp"),
    });
    const secondApply = mock.calls.slice(firstApplyCalls);

    // Pool and vhost are byte-identical across the swap, so neither php-fpm nor
    // Apache is touched — the pool directives are what make that safe.
    assertEquals(installedConfigPaths(secondApply), []);
    assertEquals(systemctlCalls(secondApply), []);
    assertEquals(
      await Deno.readTextFile(
        join(siteTreeRoot(layout), "current", "public", "index.html"),
      ),
      "<?php echo 2;",
    );
  } finally {
    await cleanup();
  }
});

test("applySites keeps legacy behavior for a source-less site", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    // A binding for a *different* compose service must not leak onto this one.
    const result = await applySites(layout, "envlegacy", [
      { ...nginxSite, webEnv: { FOO: "bar" } },
    ], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("someothersvc"),
    });
    assertEquals(result.applied, ["www"]);

    const legacyBase = join(layout.stateDir, "sites", "envlegacy", "www");
    assertStringIncludes(
      await Deno.readTextFile(join(legacyBase, "public", "index.html")),
      "www",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(legacyBase, ".turbopanel", "hosting.env")),
      "FOO=",
    );
    assertStringIncludes(
      await Deno.readTextFile(
        join(layout.configDir, "nginx", "sites", "tp-envlegacy-www.conf"),
      ),
      `root ${join(legacyBase, "public")};`,
    );

    // Legacy trees still get the principal/engine chown and an ordinary reload.
    assertEquals(mock.calls.some((c) => c.args.includes("chown")), true);
    assertEquals(usermodCalls(mock.calls).length, 0);
    assertEquals(
      systemctlActions(mock.calls, "turbopanel-nginx"),
      ["reload"],
    );
  } finally {
    await cleanup();
  }
});

const nginxPhpSite: SiteApplySpec = {
  composeServiceName: "phpsite",
  engine: "nginx",
  root: "public",
  listenPort: 18083,
  php: { version: "8.4", settings: { memory_limit: "192M" } },
};

const olsPhpSite: SiteApplySpec = {
  composeServiceName: "olsphp",
  engine: "openlitespeed",
  root: "public",
  listenPort: 18084,
  php: { version: "8.4", settings: { memory_limit: "192M" } },
};

const caddySite: SiteApplySpec = {
  composeServiceName: "static",
  engine: "caddy",
  root: "public",
  listenPort: 18085,
};

const caddyPhpSite: SiteApplySpec = {
  composeServiceName: "wp",
  engine: "caddy",
  root: "public",
  listenPort: 18086,
  php: { version: "8.4", settings: { memory_limit: "256M" } },
};

test("applySites caddy writes a site block and reloads the site Caddy", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook, extraVars } = capturePlaybooks();
  try {
    await applySites(layout, "envcaddy", [caddySite], { run, runPlaybook });

    // A static Caddy site needs no PHP at all.
    assertEquals(playbookVars(extraVars, "caddy"), {
      turbopanel_php_fpm_install: false,
      php_fpm_versions: [],
      php_fpm_extensions: {},
    });

    const conf = await Deno.readTextFile(
      join(layout.configDir, "caddy", "sites", "tp-envcaddy-static.conf"),
    );
    assertStringIncludes(conf, ":18085 {");
    assertStringIncludes(conf, "file_server");

    // Same transaction as every other engine: validate before reload.
    assertEquals(
      calls.some((c) =>
        c.args.includes("validate") && c.args.includes("--adapter")
      ),
      true,
    );
    assertEquals(
      systemctlActions(calls, "turbopanel-site-caddy").length > 0,
      true,
    );
    // The site Caddy is a separate unit from the edge one.
    assertEquals(systemctlActions(calls, "turbopanel-hosting-caddy"), []);
  } finally {
    await cleanup();
  }
});

test("applySites caddy+php installs php-fpm and reloads it before Caddy", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook, extraVars } = capturePlaybooks();
  try {
    await applySites(layout, "envcaddyphp", [caddyPhpSite], {
      run,
      runPlaybook,
    });

    // php-fpm has to come from the *caddy* playbook: on a Caddy-only host
    // neither the nginx nor the Apache playbook ever runs.
    assertEquals(playbookVars(extraVars, "caddy"), {
      turbopanel_php_fpm_install: true,
      php_fpm_versions: ["8.4"],
      php_fpm_extensions: { "8.4": [] },
    });

    const pool = await Deno.readTextFile(
      join(layout.configDir, "php", "8.4", "pools", "tp-envcaddyphp-wp.conf"),
    );
    assertStringIncludes(pool, "[tp-envcaddyphp-wp]");
    // The socket is owned by whichever engine consumes it.
    assertStringIncludes(pool, "listen.owner = tpcaddysite");

    const conf = await Deno.readTextFile(
      join(layout.configDir, "caddy", "sites", "tp-envcaddyphp-wp.conf"),
    );
    assertStringIncludes(
      conf,
      `php_fastcgi unix/${layout.runDir}/php/8.4/tp-envcaddyphp-wp.sock`,
    );

    // php-fpm reloads first so the socket exists when `caddy validate` runs.
    const units = calls
      .filter((c) => c.args.includes("systemctl"))
      .map((c) => c.args.at(-1));
    assertEquals(
      units.indexOf("turbopanel-php-fpm@8.4") <
        units.indexOf("turbopanel-site-caddy"),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("applySites runs two PHP series side by side", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook, extraVars } = capturePlaybooks();
  try {
    await applySites(layout, "envmulti", [
      {
        composeServiceName: "legacy",
        engine: "apache",
        root: "public",
        listenPort: 18090,
        php: { version: "8.3" },
      },
      {
        composeServiceName: "modern",
        engine: "nginx",
        root: "public",
        listenPort: 18091,
        php: { version: "8.4" },
      },
    ], { run, runPlaybook });

    // Both series cross the Ansible seam; the role installs, never removes.
    assertEquals(playbookVars(extraVars, "nginx")?.php_fpm_versions, [
      "8.3",
      "8.4",
    ]);

    // Distinct pools, distinct sockets, distinct config trees.
    const legacyPool = await Deno.readTextFile(
      join(layout.configDir, "php", "8.3", "pools", "tp-envmulti-legacy.conf"),
    );
    assertStringIncludes(legacyPool, `${layout.runDir}/php/8.3/`);
    const modernPool = await Deno.readTextFile(
      join(layout.configDir, "php", "8.4", "pools", "tp-envmulti-modern.conf"),
    );
    assertStringIncludes(modernPool, `${layout.runDir}/php/8.4/`);

    const nginxConf = await Deno.readTextFile(
      join(layout.configDir, "nginx", "sites", "tp-envmulti-modern.conf"),
    );
    assertStringIncludes(
      nginxConf,
      `fastcgi_pass unix:${layout.runDir}/php/8.4/tp-envmulti-modern.sock;`,
    );

    // One systemd instance per series — a master is one binary.
    assertEquals(
      systemctlActions(calls, "turbopanel-php-fpm@8.3").length > 0,
      true,
    );
    assertEquals(
      systemctlActions(calls, "turbopanel-php-fpm@8.4").length > 0,
      true,
    );
  } finally {
    await cleanup();
  }
});

test("applySites reloads only the series a deploy touched", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  try {
    // Establish both series on the host.
    const first = createSiteRunMock();
    await applySites(layout, "envA", [{
      composeServiceName: "legacy",
      engine: "apache",
      root: "public",
      listenPort: 18092,
      php: { version: "8.3" },
    }], { run: first.run, runPlaybook });

    // A second environment on 8.4 must not disturb the 8.3 master serving the
    // first — that is the whole point of one instance per series.
    const second = createSiteRunMock();
    await applySites(layout, "envB", [{
      composeServiceName: "modern",
      engine: "nginx",
      root: "public",
      listenPort: 18093,
      php: { version: "8.4" },
    }], { run: second.run, runPlaybook });

    assertEquals(systemctlActions(second.calls, "turbopanel-php-fpm@8.3"), []);
    assertEquals(
      systemctlActions(second.calls, "turbopanel-php-fpm@8.4").length > 0,
      true,
    );
  } finally {
    await cleanup();
  }
});

test("applySites nginx+php vendors php-fpm and writes its pool", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook, extraVars } = capturePlaybooks();
  try {
    await applySites(layout, "envnginxphp", [nginxPhpSite], {
      run,
      runPlaybook,
    });

    // php-fpm must be vendored from the *nginx* playbook: the Apache one never
    // runs on an nginx-only host.
    assertEquals(playbookVars(extraVars, "nginx"), {
      turbopanel_php_fpm_install: true,
      php_fpm_versions: ["8.4"],
      php_fpm_extensions: { "8.4": [] },
    });

    const pool = await Deno.readTextFile(
      join(
        layout.configDir,
        "php",
        "8.4",
        "pools",
        "tp-envnginxphp-phpsite.conf",
      ),
    );
    assertStringIncludes(pool, "[tp-envnginxphp-phpsite]");
    assertStringIncludes(pool, "listen.owner = tpnginx");
    assertStringIncludes(pool, "php_admin_value[memory_limit] = 192M");

    const conf = await Deno.readTextFile(
      join(layout.configDir, "nginx", "sites", "tp-envnginxphp-phpsite.conf"),
    );
    assertStringIncludes(
      conf,
      `fastcgi_pass unix:${layout.runDir}/php/8.4/tp-envnginxphp-phpsite.sock;`,
    );

    // php-fpm is installed from sury, so its config test must exec the apt
    // binary. The vendored `<runtimesDir>/php/current/sbin/php-fpm` path this
    // replaced no longer exists, and an ENOENT here fails the config test and
    // rolls the whole apply back.
    assertEquals(
      calls.some(
        (c) =>
          c.args.includes("/usr/sbin/php-fpm8.4") && c.args.includes("--test"),
      ),
      true,
    );

    // php-fpm reloads before nginx so `nginx -t` finds the socket it names.
    const units = calls
      .filter((c) => c.args.includes("systemctl"))
      .map((c) => c.args.at(-1));
    assertEquals(
      units.indexOf("turbopanel-php-fpm@8.4") <
        units.indexOf("turbopanel-nginx"),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("applySites openlitespeed+php vendors lsphp and wires LSAPI", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook, extraVars } = capturePlaybooks();
  try {
    await applySites(layout, "envols", [olsPhpSite], {
      run,
      runPlaybook,
    });

    assertEquals(playbookVars(extraVars, "openlitespeed"), {
      turbopanel_lsphp_install: true,
      openlitespeed_lsphp_versions: ["8.4"],
    });

    const vhost = await Deno.readTextFile(
      join(
        layout.configDir,
        "openlitespeed",
        "vhosts",
        "tp_envols_olsphp",
        "vhconf.conf",
      ),
    );
    assertStringIncludes(vhost, "extprocessor lsphp_tp_envols_olsphp{");
    assertStringIncludes(
      vhost,
      `path                      ${layout.runtimesDir}/lsphp/8.4/current/bin/lsphp`,
    );
    assertStringIncludes(vhost, "extUser                   tpols");
    assertStringIncludes(vhost, "php_admin_value memory_limit 192M");

    const fragment = await Deno.readTextFile(
      join(
        layout.configDir,
        "openlitespeed",
        "sites",
        "tp-envols-olsphp.conf",
      ),
    );
    assertStringIncludes(fragment, "enableScript              1");

    // No php-fpm anywhere: OLS runs its own lsphp.
    assertEquals(systemctlActions(calls, "turbopanel-php-fpm@8.4"), []);
  } finally {
    await cleanup();
  }
});

test("removeSites drops nginx pools and reloads php-fpm", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envrm", [nginxPhpSite], {
      run,
      runPlaybook,
    });
    const poolPath = join(
      layout.configDir,
      "php",
      "8.4",
      "pools",
      "tp-envrm-phpsite.conf",
    );
    await Deno.stat(poolPath);

    const remove = createSiteRunMock();
    await removeSites(layout, "envrm", { run: remove.run });

    await assertRejects(
      () => Deno.stat(poolPath),
      Deno.errors.NotFound,
    );
    assertEquals(
      systemctlActions(remove.calls, "turbopanel-php-fpm@8.4").length > 0,
      true,
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Safe rollout: a candidate that the engine rejects — or that leaves the engine
// unable to answer — must never survive on disk.
// ---------------------------------------------------------------------------

test("applySites restores the previous config when nginx -t fails", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const base = createSiteRunMock();
  const sitesDir = join(layout.configDir, "nginx", "sites");
  const confPath = join(sitesDir, "tp-envroll-www.conf");
  let rejectConfigTest = false;
  const run: SiteRunFn = async (command, args) => {
    if (
      rejectConfigTest && args.includes("-t") && args.includes("-c")
    ) {
      return fail("nginx: [emerg] invalid vhost");
    }
    return await base.run(command, args);
  };
  try {
    await applySites(layout, "envroll", [nginxSite], {
      run,
      runPlaybook,
    });
    const lastGood = await Deno.readTextFile(confPath);
    assertStringIncludes(lastGood, "listen 127.0.0.1:18080;");

    // A second apply renders a different vhost, which the engine rejects.
    rejectConfigTest = true;
    await assertRejects(
      () =>
        applySites(layout, "envroll", [{
          ...nginxSite,
          listenPort: 18099,
        }], { run, runPlaybook }),
      Error,
      "invalid vhost",
    );

    // The last-known-good bytes are back, and nothing was left staged: the next
    // reload or restart on this host still finds a config nginx accepts.
    assertEquals(await Deno.readTextFile(confPath), lastGood);
    assertEquals(await listConfigDirEntries(sitesDir), ["tp-envroll-www.conf"]);
  } finally {
    await cleanup();
  }
});

test("applySites leaves no config behind when the first apply fails its config test", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const base = createSiteRunMock();
  const run: SiteRunFn = async (command, args) => {
    if (args.includes("-t") && args.includes("-c")) {
      return fail("nginx: [emerg] invalid vhost");
    }
    return await base.run(command, args);
  };
  try {
    await assertRejects(
      () =>
        applySites(layout, "envnew", [nginxSite], {
          run,
          runPlaybook,
        }),
      Error,
      "invalid vhost",
    );

    // No previous config to restore means the rollback is a delete — an
    // unserveable vhost must not linger and break the *next* reload.
    assertEquals(
      await listConfigDirEntries(join(layout.configDir, "nginx", "sites")),
      [],
    );
  } finally {
    await cleanup();
  }
});

test("applySites restores the previous config when the reloaded engine stops answering", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const base = createSiteRunMock();
  const sitesDir = join(layout.configDir, "nginx", "sites");
  const confPath = join(sitesDir, "tp-envprobe-www.conf");
  let breakValidation = false;
  const run: SiteRunFn = async (command, args) => {
    if (breakValidation && command === "curl") {
      return { success: true, stdout: "502", stderr: "" };
    }
    return await base.run(command, args);
  };
  try {
    await applySites(layout, "envprobe", [nginxSite], {
      run,
      runPlaybook,
    });
    const lastGood = await Deno.readTextFile(confPath);

    // `nginx -t` passes and the reload succeeds, but the site no longer serves.
    breakValidation = true;
    await assertRejects(
      () =>
        applySites(layout, "envprobe", [{
          ...nginxSite,
          listenPort: 18099,
        }], { run, runPlaybook }),
      Error,
      "did not serve www at http://127.0.0.1:18099/",
    );

    assertEquals(await Deno.readTextFile(confPath), lastGood);
    assertEquals(await listConfigDirEntries(sitesDir), [
      "tp-envprobe-www.conf",
    ]);
  } finally {
    await cleanup();
  }
});

test("applySites fails when openlitespeed -t rejects the config", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const base = createSiteRunMock();
  const olsBinary = join(
    layout.runtimesDir,
    "openlitespeed",
    "current",
    "bin",
    "openlitespeed",
  );
  const run: SiteRunFn = async (command, args) => {
    if (args.includes(olsBinary) && args.includes("-t")) {
      return fail("[config] invalid virtual host");
    }
    return await base.run(command, args);
  };
  try {
    // OpenLiteSpeed reloads as a restart, so an unvalidated config would be
    // downtime — it gets the same engine-native gate nginx and Apache do.
    await assertRejects(
      () =>
        applySites(layout, "envolsbad", [olsSite], {
          run,
          runPlaybook,
        }),
      Error,
      "invalid virtual host",
    );

    assertEquals(
      await listConfigDirEntries(
        join(layout.configDir, "openlitespeed", "sites"),
      ),
      [],
    );
    // The restart never ran: the config test is what stands between a bad
    // fragment and a stopped server.
    assertEquals(
      base.calls.some((c) =>
        c.args.includes("systemctl") &&
        c.args.includes("turbopanel-openlitespeed")
      ),
      false,
    );
  } finally {
    await cleanup();
  }
});

const olsPrincipalPhpSite: SiteApplySpec = {
  composeServiceName: "olsowned",
  engine: "openlitespeed",
  root: "public",
  listenPort: 18085,
  php: { version: "8.4", settings: { memory_limit: "128M" } },
  principal: { principalId: "prin-1", username: "siteowner" },
};

test("applySites scopes an OpenLiteSpeed PHP vhost to its principal", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envolsown", [olsPrincipalPhpSite], {
      run,
      runPlaybook,
    });

    const fragment = await Deno.readTextFile(
      join(
        layout.configDir,
        "openlitespeed",
        "sites",
        "tp-envolsown-olsowned.conf",
      ),
    );
    // suEXEC is declared on the vhost itself, not only on its extprocessor —
    // that is what makes the shared-hosting boundary hold for everything the
    // vhost runs.
    assertStringIncludes(fragment, "user                      siteowner");
    assertStringIncludes(fragment, "group                     siteowner-grp");
    assertStringIncludes(fragment, "setUIDMode                0");
    assertStringIncludes(fragment, "enableScript              1");

    const vhost = await Deno.readTextFile(
      join(
        layout.configDir,
        "openlitespeed",
        "vhosts",
        "tp_envolsown_olsowned",
        "vhconf.conf",
      ),
    );
    assertStringIncludes(vhost, "extUser                   siteowner");
    assertStringIncludes(vhost, "extGroup                  siteowner-grp");
  } finally {
    await cleanup();
  }
});
