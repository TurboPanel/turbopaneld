import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  applySites,
  RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES,
  removeSites,
  resolveSiteEngineNeeds,
  type SiteApplySpec,
  siteEngineApplyExtraArgs,
  type SiteManagedDirectory,
  type SitePlaybookFn,
  type SiteRelease,
  type SiteRunFn,
  type SiteRunResult,
  siteVhostPorts,
} from "./site.ts";
import {
  sitePhpKey,
  sitePhpRuntimeId,
  type SitePhpRuntimeMode,
} from "./site/php-runtime.ts";
import {
  holdPhpSeries,
  resetPhpSeriesPruneForTests,
} from "./site/php-series-prune.ts";
import { engineHoldKey, holdPruneKeys } from "./site/prune-holds.ts";

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

/**
 * The filesystem as root sees it. The sudo seam below acts through these, so a
 * test can deny the daemon's own `Deno.*` calls without denying tp-host's.
 */
const rootFs = {
  copyFile: Deno.copyFile.bind(Deno),
  lstat: Deno.lstat.bind(Deno),
  mkdir: Deno.mkdir.bind(Deno),
  readDir: Deno.readDir.bind(Deno),
  readFile: Deno.readFile.bind(Deno),
  readLink: Deno.readLink.bind(Deno),
  readTextFile: Deno.readTextFile.bind(Deno),
  remove: Deno.remove.bind(Deno),
  rename: Deno.rename.bind(Deno),
  stat: Deno.stat.bind(Deno),
};

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
      rootFs.readFile(a),
      rootFs.readFile(b),
    ]);
    if (left.length !== right.length) return false;
    return left.every((byte, index) => byte === right[index]);
  } catch {
    return false;
  }
}

/**
 * tp-host's read-only verbs. `test` pins the parent directory and refuses a
 * symlink anywhere in it, so a path *through* `current` answers "absent" here
 * exactly as it does on a host.
 */
async function privilegedReadVerb(
  args: readonly string[],
): Promise<SiteRunResult | null> {
  const path = args.at(-1);
  if (typeof path !== "string") return null;
  if (args.includes("cat")) {
    try {
      return {
        success: true,
        stdout: await rootFs.readTextFile(path),
        stderr: "",
      };
    } catch {
      return fail(`no such file ${path}`);
    }
  }
  if (args.includes("readlink")) {
    try {
      return {
        success: true,
        stdout: `${await rootFs.readLink(path)}\n`,
        stderr: "",
      };
    } catch {
      return fail(`readlink: ${path}`);
    }
  }
  if (!args.includes("test")) return null;
  if (dirname(path).split("/").includes("current")) {
    return fail(`refusing ${path}: a component is a symlink`);
  }
  try {
    if (args.includes("-L")) {
      return (await rootFs.lstat(path)).isSymlink ? ok() : fail("not a link");
    }
    if (args.includes("-d")) {
      // tp-host's `-d` never follows a symlink as the last component.
      return (await rootFs.lstat(path)).isDirectory ? ok() : fail("not a dir");
    }
    await rootFs.stat(path);
    return ok();
  } catch {
    return fail("");
  }
}

/**
 * Host-free sudo seam: install copies/mkdirs; `cmp -s` compares for real (the
 * apply path uses it to skip byte-identical rewrites); `cp`/`mv` snapshot and
 * swap staged candidates for real (the rollout path restores from them); rm
 * deletes; `curl` answers 200 so post-reload validation passes; everything
 * else succeeds.
 */
/**
 * `site-caddy-mounts` as the host answers it: what the running site Caddy holds
 * nosymfollow. `before` is what it holds already; `afterRestart` is what a
 * restart of the unit leaves it holding (it re-reads the fragments).
 */
type SiteCaddyMountsMock = {
  before?: readonly string[];
  afterRestart?: readonly string[];
};

function createSiteRunMock(mounts?: SiteCaddyMountsMock): {
  run: SiteRunFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: SiteRunFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "curl") return { success: true, stdout: "200", stderr: "" };
    if (command !== "sudo") return ok();

    if (args.includes("site-caddy-mounts")) {
      const restarted = calls.some((c) =>
        c.args.includes("restart") && c.args.includes("turbopanel-site-caddy")
      );
      const held = restarted ? mounts?.afterRestart : mounts?.before;
      return { success: true, stdout: (held ?? []).join("\n"), stderr: "" };
    }

    if (args.includes("cmp")) {
      const right = args.at(-1);
      const left = args.at(-2);
      if (typeof left !== "string" || typeof right !== "string") {
        throw new TypeError("expected cmp left right");
      }
      return (await filesMatch(left, right)) ? ok() : fail("files differ");
    }

    const privilegedRead = await privilegedReadVerb(args);
    if (privilegedRead !== null) return privilegedRead;

    if (args.includes("install") && args.includes("-d")) {
      const path = args.at(-1);
      if (typeof path !== "string") {
        throw new TypeError("expected install -d path");
      }
      await rootFs.mkdir(path, { recursive: true, mode: 0o750 });
      return ok();
    }

    if (args.includes("install")) {
      const dest = args.at(-1);
      const src = args.at(-2);
      if (typeof src !== "string" || typeof dest !== "string") {
        throw new TypeError("expected install src dest");
      }
      await rootFs.mkdir(dirname(dest), { recursive: true });
      await rootFs.copyFile(src, dest);
      return ok();
    }

    // Real listing semantics: the managed-directory seed asks whether the
    // document root is empty before writing a placeholder into it, and a mock
    // that always answered "empty" would make that check untestable.
    if (args.includes("ls")) {
      const path = args.at(-1);
      if (typeof path !== "string") {
        throw new TypeError("expected ls path");
      }
      try {
        const names: string[] = [];
        for await (const entry of rootFs.readDir(path)) names.push(entry.name);
        return { success: true, stdout: names.join("\n"), stderr: "" };
      } catch {
        return fail("No such file or directory");
      }
    }

    if (args.includes("rm")) {
      const path = args.at(-1);
      if (typeof path !== "string") {
        throw new TypeError("expected rm path");
      }
      try {
        await rootFs.remove(path, { recursive: true });
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
        await rootFs.copyFile(src, dest);
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
        await rootFs.rename(src, dest);
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

test("removeSites stops the OpenLiteSpeed unit when its last site goes, and keeps it for another environment", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const unitCalls = () =>
    calls.filter((call) => call.args.includes("turbopanel-openlitespeed"))
      .map((call) => call.args.filter((arg) => arg !== "-n").join(" "))
      .filter((line) => line.includes("systemctl"));
  try {
    await applySites(layout, "envolsa", [olsSite], { run, runPlaybook });
    await applySites(
      layout,
      "envolsb",
      [{ ...olsSite, listenPort: olsSite.listenPort + 1 }],
      { run, runPlaybook },
    );

    calls.length = 0;
    await removeSites(layout, "envolsa", { run });
    const kept = unitCalls();
    assertEquals(kept.some((line) => line.includes("disable --now")), false);
    assertEquals(kept.some((line) => line.includes("reload")), true);

    calls.length = 0;
    await removeSites(layout, "envolsb", { run });
    const idle = unitCalls();
    assertEquals(idle.some((line) => line.includes("disable --now")), true);
    assertEquals(idle.some((line) => line.includes("reload")), false);
  } finally {
    await cleanup();
  }
});

test("applySites restarts the OpenLiteSpeed unit after it was stopped for idleness", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const isUnit = (args: string[], verb: string) =>
    args.includes("turbopanel-openlitespeed") && args.includes(verb);
  // A stopped unit refuses `reload`, as systemd does.
  const stoppedRun: SiteRunFn = (command, args) =>
    command === "sudo" && isUnit(args, "reload")
      ? Promise.resolve(
        fail("Unit turbopanel-openlitespeed.service is not active"),
      )
      : run(command, args);
  try {
    await applySites(layout, "envolsx", [olsSite], { run, runPlaybook });
    await removeSites(layout, "envolsx", { run });

    calls.length = 0;
    await applySites(layout, "envolsy", [olsSite], {
      run: stoppedRun,
      runPlaybook,
    });
    const enabled = calls.some((call) =>
      isUnit(call.args, "enable") && call.args.includes("--now")
    );
    assertEquals(enabled, true);
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

test("applySites rejects a document root that is only safe once trimmed", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  try {
    await assertRejects(
      () =>
        applySites(layout, "envtrim", [{ ...nginxSite, root: " public" }], {
          run,
          runPlaybook: () => Promise.resolve(),
        }),
      Error,
      "site root is unsafe",
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
      join(layout.configDir, "site-caddy", "sites", "tp-envcaddy-static.conf"),
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
      join(layout.configDir, "site-caddy", "sites", "tp-envcaddyphp-wp.conf"),
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

test("OpenLiteSpeed vendors lsphp only for detached lsphp, and packaged PHP for fastcgi and fpm", () => {
  const vars = (mode: SitePhpRuntimeMode) => {
    const site = { ...olsPhpSite, php: { version: "8.4", mode } };
    const [, json] = siteEngineApplyExtraArgs(
      "openlitespeed",
      resolveSiteEngineNeeds([site]),
      ["8.4"],
      {},
    );
    return JSON.parse(json ?? "{}");
  };
  assertEquals(vars("lsphp-detached"), {
    turbopanel_lsphp_install: true,
    openlitespeed_lsphp_versions: ["8.4"],
    turbopanel_php_fpm_install: false,
    php_fpm_versions: ["8.4"],
    php_fpm_extensions: {},
  });
  for (const mode of ["fastcgi", "fpm"] as const) {
    assertEquals(vars(mode).turbopanel_lsphp_install, false, mode);
    assertEquals(vars(mode).turbopanel_php_fpm_install, true, mode);
  }
});

test("per-site PHP on OpenLiteSpeed: a site without a mode runs FastCGI instead of failing the environment", async () => {
  const h = await perSitePhpHarness();
  try {
    const site = perSitePhpSite("openlitespeed", "fastcgi");
    const { mode: _mode, ...php } = site.php ?? {};
    await h.apply({ ...site, php });
    const id = phpRuntimeId("fastcgi");
    await Deno.stat(join(h.unitDir, `turbopanel-php-${id}.socket`));
    assertStringIncludes(
      await olsVhconf(h),
      `uds:///run/turbopanel-php-${id}/php.sock`,
    );
  } finally {
    await h.cleanup();
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
// Unused PHP series are removed; one anything still uses never is.
// ---------------------------------------------------------------------------

/** The host reports PHP 8.4 installed (the real `/usr/sbin` is never probed). */
const hostWithPhp84 = () => ({ php: { series: ["8.4"] } });

/**
 * An empty systemd unit folder inside the test layout, so the per-site PHP
 * unit listing never depends on the machine's own `/etc/systemd/system` (a
 * listing that fails keeps every series).
 */
async function emptyUnitDir(layout: LayoutPaths): Promise<string> {
  const dir = join(layout.stateDir, "test-systemd-units");
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

/** `php_series_prune` lists the playbook runs asked for, in order. */
function pruneRequests(
  captured: ReturnType<typeof capturePlaybooks>,
): unknown[] {
  return captured.extraVars
    .filter((entry) => entry.label.startsWith("php-series-prune"))
    .map((entry) => entry.vars.php_series_prune);
}

test("removeSites removes PHP 8.4 once the last site using it goes", async () => {
  resetPhpSeriesPruneForTests();
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const applied = capturePlaybooks();
  try {
    await applySites(layout, "envpruneA", [nginxPhpSite], {
      run,
      runPlaybook: applied.runPlaybook,
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
    // Applying a site that uses the series asks for no removal.
    assertEquals(pruneRequests(applied), []);

    const removal = capturePlaybooks();
    await removeSites(layout, "envpruneA", {
      run,
      runPlaybook: removal.runPlaybook,
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
    assertEquals(pruneRequests(removal), [["8.4"]]);
  } finally {
    resetPhpSeriesPruneForTests();
    await cleanup();
  }
});

test("removeSites keeps a PHP series another environment still uses", async () => {
  resetPhpSeriesPruneForTests();
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const applied = capturePlaybooks();
  try {
    for (
      const [environmentId, listenPort] of [
        ["envshareA", 18083],
        ["envshareB", 18183],
      ] as const
    ) {
      await applySites(
        layout,
        environmentId,
        [{ ...nginxPhpSite, listenPort }],
        {
          run,
          runPlaybook: applied.runPlaybook,
          hostRuntimes: hostWithPhp84,
          systemdUnitDir: await emptyUnitDir(layout),
        },
      );
    }
    const first = capturePlaybooks();
    await removeSites(layout, "envshareA", {
      run,
      runPlaybook: first.runPlaybook,
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
    assertEquals(pruneRequests(first), []);

    const last = capturePlaybooks();
    await removeSites(layout, "envshareB", {
      run,
      runPlaybook: last.runPlaybook,
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
    assertEquals(pruneRequests(last), [["8.4"]]);
  } finally {
    resetPhpSeriesPruneForTests();
    await cleanup();
  }
});

test("removeSites never removes a PHP series a deploy in flight holds", async () => {
  resetPhpSeriesPruneForTests();
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const applied = capturePlaybooks();
  try {
    await applySites(layout, "envholdA", [nginxPhpSite], {
      run,
      runPlaybook: applied.runPlaybook,
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
    const release = await holdPhpSeries(["8.4"]);
    const held = capturePlaybooks();
    await removeSites(layout, "envholdA", {
      run,
      runPlaybook: held.runPlaybook,
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
    assertEquals(pruneRequests(held), []);

    release();
    const after = capturePlaybooks();
    await removeSites(layout, "envholdA", {
      run,
      runPlaybook: after.runPlaybook,
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
    assertEquals(pruneRequests(after), [["8.4"]]);
  } finally {
    resetPhpSeriesPruneForTests();
    await cleanup();
  }
});

test("a failed PHP series removal never fails the teardown that triggered it", async () => {
  resetPhpSeriesPruneForTests();
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  try {
    await applySites(layout, "envfailA", [nginxPhpSite], {
      run,
      runPlaybook: capturePlaybooks().runPlaybook,
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
    await removeSites(layout, "envfailA", {
      run,
      runPlaybook: () => Promise.reject(new Error("apt is busy")),
      hostRuntimes: hostWithPhp84,
      systemdUnitDir: await emptyUnitDir(layout),
    });
  } finally {
    resetPhpSeriesPruneForTests();
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

// ---------------------------------------------------------------------------
// Managed-directory sites: a principal-owned webroot the tenant fills itself.
// ---------------------------------------------------------------------------

const managedBinding: SiteManagedDirectory = {
  serviceId: RELEASE_SERVICE_ID,
  username: RELEASE_USERNAME,
};

function managedBindingsFor(
  ...composeServiceNames: readonly string[]
): Map<string, SiteManagedDirectory> {
  return new Map(composeServiceNames.map((name) => [name, managedBinding]));
}

const managedSite: SiteApplySpec = {
  ...nginxSite,
  sourceKind: "managed-directory",
  principal: {
    principalId: "pr-1",
    username: RELEASE_USERNAME,
  },
};

test("a managed-directory site serves from a principal-owned webroot", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    const result = await applySites(layout, "envmd", [managedSite], {
      run,
      runPlaybook,
      managedDirectoryBindings: managedBindingsFor("www"),
    });
    assertEquals(result.applied, ["www"]);

    const webroot = join(siteTreeRoot(layout), "webroot", "public");
    const conf = await Deno.readTextFile(
      join(layout.configDir, "nginx", "sites", "tp-envmd-www.conf"),
    );
    assertStringIncludes(conf, `root ${webroot};`);

    // `webroot/` is a sibling of `current` and `releases/`, so connecting a
    // repository later is a field flip rather than a move.
    await Deno.stat(join(siteTreeRoot(layout), "webroot"));
    await Deno.stat(join(siteTreeRoot(layout), "shared"));

    // Owned by the principal, group the engine, so the tenant writes and the
    // engine reads.
    const mkdir = mock.calls.find((c) =>
      c.args.includes("install") && c.args.includes("-d") &&
      c.args.at(-1) === webroot
    );
    assert(mkdir);
    assertEquals(mkdir.args[mkdir.args.indexOf("-o") + 1], RELEASE_USERNAME);
    assertEquals(mkdir.args[mkdir.args.indexOf("-g") + 1], "tpnginx");
    assertEquals(mkdir.args[mkdir.args.indexOf("-m") + 1], "0750");

    // `sites/<serviceId>/` itself is root's: the tenant must not be able to
    // rename the leaves the engine serves (tp-host refuses anything else).
    const siteRootMkdir = mock.calls.find((c) =>
      c.args.includes("install") && c.args.includes("-d") &&
      c.args.at(-1) === siteTreeRoot(layout)
    );
    assert(siteRootMkdir);
    assertEquals(siteRootMkdir.args.slice(-7), [
      "-m",
      "0750",
      "-o",
      "root",
      "-g",
      RELEASE_GROUP,
      siteTreeRoot(layout),
    ]);

    // The engine joins the principal's group and therefore restarts.
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

test("the placeholder is seeded only into an empty document root", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  try {
    const first = createSiteRunMock();
    await applySites(layout, "envmd", [managedSite], {
      run: withGroupMembership(first.run, { tpnginx: ["tpnginx"] }),
      runPlaybook,
      managedDirectoryBindings: managedBindingsFor("www"),
    });

    const webroot = join(siteTreeRoot(layout), "webroot", "public");
    const indexPath = join(webroot, "index.html");
    assertStringIncludes(await Deno.readTextFile(indexPath), "TurboPanel site");

    // The tenant uploads their application over the placeholder.
    await Deno.writeTextFile(indexPath, "<h1>my site</h1>");

    const second = createSiteRunMock();
    await applySites(layout, "envmd", [managedSite], {
      run: withGroupMembership(second.run, { tpnginx: ["tpnginx"] }),
      runPlaybook,
      managedDirectoryBindings: managedBindingsFor("www"),
    });

    // Re-seeding would publish "TurboPanel site is ready" over their app — the
    // same reason the release lane asserts rather than creates.
    assertEquals(await Deno.readTextFile(indexPath), "<h1>my site</h1>");
  } finally {
    await cleanup();
  }
});

test("a managed directory is never recursively chowned", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envmd", [managedSite], {
      run,
      runPlaybook,
      managedDirectoryBindings: managedBindingsFor("www"),
    });
    // A recursive `chmod u=rwX,g=rX` every deploy would fight whatever modes
    // the tenant set on their own files.
    assertEquals(mock.calls.some((c) => c.args.includes("chown")), false);
    assertEquals(mock.calls.some((c) => c.args.includes("chmod")), false);
  } finally {
    await cleanup();
  }
});

test("a managed-directory PHP pool is confined by open_basedir", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpapache: ["tpapache"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    const site: SiteApplySpec = {
      ...apachePhpSite,
      sourceKind: "managed-directory",
      principal: { principalId: "pr-1", username: RELEASE_USERNAME },
    };
    await applySites(layout, "envmd", [site], {
      run,
      runPlaybook,
      managedDirectoryBindings: managedBindingsFor("phpapp"),
    });

    const pool = await Deno.readTextFile(
      join(layout.configDir, "php", "8.4", "pools", "tp-envmd-phpapp.conf"),
    );
    const webroot = join(siteTreeRoot(layout), "webroot", "public");
    // A managed directory is writable by the account running it, which is
    // exactly why it must not also be able to read the rest of the filesystem.
    assertStringIncludes(pool, `open_basedir`);
    assertStringIncludes(pool, webroot);
    assertStringIncludes(pool, join(siteTreeRoot(layout), "shared"));
    // No `current` symlink to move under a worker, so the realpath-cache
    // relaxations a release needs would be disabling caching for nothing.
    for (const directive of RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES) {
      assertEquals(pool.includes(directive), false);
    }
  } finally {
    await cleanup();
  }
});

test("a release wins over a managed-directory flag on the same site", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>release one</h1>");
    await applySites(layout, "envmd", [managedSite], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
      managedDirectoryBindings: managedBindingsFor("www"),
    });

    // Serving the directory instead would ignore a build the operator asked
    // for. `deployManagedDirectoryBindings` drops the entry for exactly this
    // reason; the branch order here is the backstop.
    const conf = await Deno.readTextFile(
      join(layout.configDir, "nginx", "sites", "tp-envmd-www.conf"),
    );
    assertStringIncludes(
      conf,
      `root ${join(siteTreeRoot(layout), "current", "public")};`,
    );
  } finally {
    await cleanup();
  }
});

function stubDenoCommand(run: SiteRunFn): () => void {
  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #command: string;
    #args: string[];
    constructor(command: string, options?: { args?: string[] }) {
      this.#command = command;
      this.#args = options?.args ?? [];
    }
    async output(): Promise<Deno.CommandOutput> {
      const result = await run(this.#command, this.#args);
      const enc = new TextEncoder();
      return {
        success: result.success,
        code: result.success ? 0 : 1,
        signal: null,
        stdout: enc.encode(result.stdout),
        stderr: enc.encode(result.stderr),
      };
    }
  };
  return () => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  };
}

test("applySites uses runDefault when run is omitted", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const restore = stubDenoCommand(run);
  try {
    const result = await applySites(layout, "envdef", [nginxSite], {
      runPlaybook,
    });
    assertEquals(result.applied, ["www"]);
  } finally {
    restore();
    await cleanup();
  }
});

test("applySites treats a missing engine playbook as already installed", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const originalStat = Deno.stat.bind(Deno);
  Deno.stat = ((path: string | URL) => {
    if (String(path).includes("site-nginx-apply")) {
      return Promise.reject(new Deno.errors.NotFound("playbook"));
    }
    return originalStat(path);
  }) as typeof Deno.stat;
  try {
    const result = await applySites(layout, "envpbmiss", [nginxSite], { run });
    assertEquals(result.applied, ["www"]);
  } finally {
    Deno.stat = originalStat;
    await cleanup();
  }
});

test("applySites rethrows a non-NotFound playbook stat error", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const originalStat = Deno.stat.bind(Deno);
  Deno.stat = ((path: string | URL) => {
    if (String(path).includes("site-nginx-apply")) {
      return Promise.reject(new Deno.errors.PermissionDenied("playbook"));
    }
    return originalStat(path);
  }) as typeof Deno.stat;
  try {
    await assertRejects(
      () => applySites(layout, "envpberr", [nginxSite], { run }),
      Deno.errors.PermissionDenied,
      "playbook",
    );
  } finally {
    Deno.stat = originalStat;
    await cleanup();
  }
});

test("applySites rejects an unsupported engine and an invalid listenPort", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  try {
    await assertRejects(
      () =>
        applySites(layout, "enveng", [{
          ...nginxSite,
          engine: "lighttpd" as SiteApplySpec["engine"],
        }], { run, runPlaybook }),
      Error,
      'site engine "lighttpd" is not supported',
    );
    await assertRejects(
      () =>
        applySites(layout, "envport", [{ ...nginxSite, listenPort: 80 }], {
          run,
          runPlaybook,
        }),
      Error,
      "site listenPort is invalid",
    );
    await assertRejects(
      () =>
        applySites(layout, "envport2", [{
          ...nginxSite,
          listenPort: 70_000,
        }], { run, runPlaybook }),
      Error,
      "site listenPort is invalid",
    );
    await assertRejects(
      () =>
        applySites(layout, "envport3", [{
          ...nginxSite,
          listenPort: 18080.5,
        }], { run, runPlaybook }),
      Error,
      "site listenPort is invalid",
    );
  } finally {
    await cleanup();
  }
});

test("applySites warns and continues when legacy chown/chmod/setgid fail", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  try {
    const chownBase = createSiteRunMock();
    const chownRun: SiteRunFn = async (command, args) => {
      if (args.includes("chown")) return fail("chown denied");
      return await chownBase.run(command, args);
    };
    assertEquals(
      (await applySites(layout, "envchown", [nginxSite], {
        run: chownRun,
        runPlaybook,
      })).applied,
      ["www"],
    );

    const modeBase = createSiteRunMock();
    const modeRun: SiteRunFn = async (command, args) => {
      if (args.includes("chmod") && args.includes("u=rwX,g=rX,o=")) {
        return fail("chmod denied");
      }
      if (args.includes("find") && args.includes("g+s")) {
        return fail("setgid denied");
      }
      return await modeBase.run(command, args);
    };
    assertEquals(
      // Another environment: its own port (the host refuses a shared one).
      (await applySites(layout, "envchmod", [{
        ...nginxSite,
        listenPort: nginxSite.listenPort + 100,
      }], {
        run: modeRun,
        runPlaybook,
      })).applied,
      ["www"],
    );
  } finally {
    await cleanup();
  }
});

test("applySites fails when release hosting metadata mkdir or install fails", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { runPlaybook } = capturePlaybooks();
  const site = { ...nginxSite, webEnv: { FOO: "bar" } };
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>one</h1>");

    const mkdirBase = createSiteRunMock();
    const mkdirRun = withGroupMembership(async (command, args) => {
      if (
        args.includes("install") && args.includes("-d") &&
        String(args.at(-1)).includes(".turbopanel-hosting")
      ) {
        return fail("mkdir hosting meta denied");
      }
      return await mkdirBase.run(command, args);
    }, { tpnginx: ["tpnginx"] });
    await assertRejects(
      () =>
        applySites(layout, "envmetamk", [site], {
          run: mkdirRun,
          runPlaybook,
          releaseBindings: releaseBindingsFor("www"),
        }),
      Error,
      "mkdir hosting meta denied",
    );

    const installBase = createSiteRunMock();
    const installRun = withGroupMembership(async (command, args) => {
      if (
        args.includes("install") && args.includes("0400") &&
        String(args.at(-1)).includes(".turbopanel-hosting")
      ) {
        return fail("install hosting meta denied");
      }
      return await installBase.run(command, args);
    }, { tpnginx: ["tpnginx"] });
    await assertRejects(
      () =>
        applySites(layout, "envmetainst", [site], {
          run: installRun,
          runPlaybook,
          releaseBindings: releaseBindingsFor("www"),
        }),
      Error,
      "install hosting meta denied",
    );
  } finally {
    await cleanup();
  }
});

test("hosting metadata is readable by the site owner alone: no web engine can read it through the owner's group", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>one</h1>");
    await applySites(layout, "envmetaperm", [
      { ...nginxSite, webEnv: { FOO: "bar" } },
    ], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });
    const metaDir = join(siteTreeRoot(layout), ".turbopanel-hosting");
    const installs = mock.calls.filter((c) =>
      c.args.includes("install") &&
      String(c.args.at(-1)).startsWith(metaDir)
    );
    assertEquals(installs.length, 2);
    for (const call of installs) {
      const isDir = call.args.includes("-d");
      // A root directory others only traverse, and files only the owner reads.
      assertEquals(
        call.args[call.args.indexOf("-m") + 1],
        isDir ? "0711" : "0400",
      );
      assertEquals(
        call.args[call.args.indexOf("-o") + 1],
        isDir ? "root" : RELEASE_USERNAME,
      );
      assertEquals(call.args[call.args.indexOf("-g") + 1], "root");
    }
  } finally {
    await cleanup();
  }
});

const managedCaddySite: SiteApplySpec = {
  ...caddySite,
  sourceKind: "managed-directory",
  principal: { principalId: "pr-1", username: RELEASE_USERNAME },
};

function siteCaddyRestarts(
  calls: ReadonlyArray<{ command: string; args: string[] }>,
): number {
  return systemctlActions(calls, "turbopanel-site-caddy").filter((a) =>
    a === "restart"
  ).length;
}

test("a managed-directory Caddy site restarts the site Caddy until its web root is mounted nosymfollow, after the web root exists", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const webroot = join(siteTreeRoot(layout), "webroot");
  const mock = createSiteRunMock({ afterRestart: [webroot] });
  // Already in the owner's group: only the mount rule can ask for a restart.
  const run = withGroupMembership(mock.run, {
    tpcaddysite: ["tpcaddysite", RELEASE_GROUP],
  });
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envmdcaddy", [managedCaddySite], {
      run,
      runPlaybook,
      managedDirectoryBindings: managedBindingsFor("static"),
    });
    assertEquals(siteCaddyRestarts(mock.calls), 1);
    // The directory the unit mounts at start exists before the restart.
    const created = mock.calls.findIndex((c) =>
      c.args.includes("install") && c.args.includes("-d") &&
      c.args.at(-1) === webroot
    );
    const restarted = mock.calls.findIndex((c) =>
      c.args.includes("restart") && c.args.includes("turbopanel-site-caddy")
    );
    assertEquals(created >= 0 && restarted > created, true);
  } finally {
    await cleanup();
  }
});

test("a Caddy site whose directory is already mounted is only reloaded", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const webroot = join(siteTreeRoot(layout), "webroot");
  const mock = createSiteRunMock({
    before: [webroot],
    afterRestart: [webroot],
  });
  const run = withGroupMembership(mock.run, {
    tpcaddysite: ["tpcaddysite", RELEASE_GROUP],
  });
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envmdmounted", [managedCaddySite], {
      run,
      runPlaybook,
      managedDirectoryBindings: managedBindingsFor("static"),
    });
    assertEquals(siteCaddyRestarts(mock.calls), 0);
  } finally {
    await cleanup();
  }
});

test("a release-backed Caddy site needs its releases tree mounted, not its current link", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const releases = join(siteTreeRoot(layout), "releases");
  const mock = createSiteRunMock({ afterRestart: [releases] });
  const run = withGroupMembership(mock.run, {
    tpcaddysite: ["tpcaddysite", RELEASE_GROUP],
  });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>one</h1>");
    await applySites(layout, "envrelcaddy", [{
      ...caddySite,
      composeServiceName: "static",
    }], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("static"),
    });
    assertEquals(siteCaddyRestarts(mock.calls), 1);
    // The new fragment is live before the restart reads it.
    const conf = await Deno.readTextFile(
      join(
        layout.configDir,
        "site-caddy",
        "sites",
        "tp-envrelcaddy-static.conf",
      ),
    );
    assertStringIncludes(conf, `root * ${siteTreeRoot(layout)}/current/public`);
  } finally {
    await cleanup();
  }
});

test("the deploy fails when the site Caddy still holds no mount for a tree it serves", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock({});
  const run = withGroupMembership(mock.run, {
    tpcaddysite: ["tpcaddysite", RELEASE_GROUP],
  });
  const { runPlaybook } = capturePlaybooks();
  try {
    await assertRejects(
      () =>
        applySites(layout, "envnomount", [managedCaddySite], {
          run,
          runPlaybook,
          managedDirectoryBindings: managedBindingsFor("static"),
        }),
      Error,
      "did not mount",
    );
  } finally {
    await cleanup();
  }
});

test("an older host helper that does not know site-caddy-mounts gives a plain error, not a mystery failure", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run: SiteRunFn = (command, args) =>
    args.includes("site-caddy-mounts")
      ? Promise.resolve(fail("tp-host: refusing verb site-caddy-mounts"))
      : mock.run(command, args);
  const { runPlaybook } = capturePlaybooks();
  try {
    await assertRejects(
      () =>
        applySites(
          layout,
          "envoldhelper",
          [managedCaddySite],
          {
            run: withGroupMembership(run, {
              tpcaddysite: ["tpcaddysite", RELEASE_GROUP],
            }),
            runPlaybook,
            managedDirectoryBindings: managedBindingsFor("static"),
          },
        ),
      Error,
      "finish the update on this host",
    );
  } finally {
    await cleanup();
  }
});

test("a plain Caddy site only reloads", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envplaincaddy", [caddySite], {
      run: mock.run,
      runPlaybook,
    });
    assertEquals(
      systemctlActions(mock.calls, "turbopanel-site-caddy").includes(
        "restart",
      ),
      false,
    );
  } finally {
    await cleanup();
  }
});

test("applySites fails when a release document root is not a directory", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    const tree = siteTreeRoot(layout);
    await Deno.mkdir(join(tree, "current"), { recursive: true });
    await Deno.writeTextFile(join(tree, "current", "public"), "not-a-dir");
    await assertRejects(
      () =>
        applySites(layout, "envnotdir", [nginxSite], {
          run,
          runPlaybook,
          releaseBindings: releaseBindingsFor("www"),
        }),
      Error,
      "is not a directory",
    );
  } finally {
    await cleanup();
  }
});

/** Replace the release's `public` with a link to a directory outside it. */
async function linkReleaseDocumentRootOut(
  layout: LayoutPaths,
  releaseDir: string,
): Promise<void> {
  const foreign = join(layout.principalHomeRoot, "bob", "public");
  await Deno.mkdir(foreign, { recursive: true });
  await Deno.writeTextFile(join(foreign, "index.html"), "bob");
  await Deno.remove(join(releaseDir, "public"), { recursive: true });
  await Deno.symlink(foreign, join(releaseDir, "public"));
}

test("applySites refuses a release document root that is a symlink", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    const releaseDir = await seedRelease(layout, "rel-1", "public", "one");
    await linkReleaseDocumentRootOut(layout, releaseDir);
    await assertRejects(
      () =>
        applySites(layout, "envlinkroot", [nginxSite], {
          run,
          runPlaybook,
          releaseBindings: releaseBindingsFor("www"),
        }),
      Error,
      "is not a directory",
    );
  } finally {
    await cleanup();
  }
});

test("applySites refuses a symlinked release document root it cannot enter", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    const releaseDir = await seedRelease(layout, "rel-1", "public", "one");
    await linkReleaseDocumentRootOut(layout, releaseDir);
    const restore = denyDaemonFs(siteTreeRoot(layout));
    try {
      await assertRejects(
        () =>
          applySites(layout, "envlinkroot2", [nginxSite], {
            run,
            runPlaybook,
            releaseBindings: releaseBindingsFor("www"),
          }),
        Error,
        "release document root missing for www",
      );
    } finally {
      restore();
    }
  } finally {
    await cleanup();
  }
});

test("applySites skips a managed placeholder when index install fails", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const base = createSiteRunMock();
  const run = withGroupMembership(async (command, args) => {
    if (
      args.includes("install") && args.includes("0400") &&
      String(args.at(-1)).endsWith("index.html")
    ) {
      return fail("index skipped");
    }
    return await base.run(command, args);
  }, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    const result = await applySites(layout, "envidx", [managedSite], {
      run,
      runPlaybook,
      managedDirectoryBindings: managedBindingsFor("www"),
    });
    assertEquals(result.applied, ["www"]);
  } finally {
    await cleanup();
  }
});

test("removeSites warns when sudo rm, OLS vhost rm, php-fpm reload, or idle disable fail", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envrmfail";
  try {
    await applySites(layout, environmentId, [nginxPhpSite, olsSite], {
      run,
      runPlaybook,
    });
    const poolsDir = join(layout.configDir, "php", "8.4", "pools");
    await Deno.writeTextFile(join(poolsDir, "default.conf"), "; bootstrap\n");

    const remove: SiteRunFn = async (command, args) => {
      if (args.includes("rm") && args.includes("-rf")) {
        return fail("vhost rm refused");
      }
      if (
        args.includes("rm") &&
        String(args.at(-1)).includes("/nginx/sites/")
      ) {
        return fail("rm refused");
      }
      if (args.includes("--test")) throw new Error("fpm test exploded");
      if (args.includes("disable") && args.includes("--now")) {
        return fail("disable refused");
      }
      return await run(command, args);
    };
    await removeSites(layout, environmentId, { run: remove });
  } finally {
    await cleanup();
  }
});

test("removeSites skips idle disable when another pool remains and swallows a string reload error", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envrmkeep";
  try {
    await applySites(layout, environmentId, [nginxPhpSite], {
      run,
      runPlaybook,
    });
    const poolsDir = join(layout.configDir, "php", "8.4", "pools");
    await Deno.mkdir(join(layout.configDir, "php", "8.3", "pools"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(poolsDir, "tp-otherenv-keep.conf"),
      "; other env\n",
    );

    const remove: SiteRunFn = async (command, args) => {
      if (args.includes("--test")) throw "fpm-test-string";
      if (args.includes("disable") && args.includes("--now")) {
        throw new TypeError("disable must not run while another pool remains");
      }
      return await run(command, args);
    };
    await removeSites(layout, environmentId, { run: remove });
  } finally {
    await cleanup();
  }
});

test("removeSites rethrows a refused config-dir listing", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const base = createSiteRunMock();
  const run: SiteRunFn = async (command, args) => {
    if (
      args.includes("ls") &&
      String(args.at(-1)).includes(`${layout.configDir}/nginx/sites`)
    ) {
      return fail("tp-host: refusing path sites dir");
    }
    return await base.run(command, args);
  };
  try {
    await Deno.mkdir(join(layout.configDir, "nginx", "sites"), {
      recursive: true,
    });
    await assertRejects(
      () => removeSites(layout, "envrd", { run }),
      Error,
      "refusing path sites dir",
    );
  } finally {
    await cleanup();
  }
});

test("applySites fails when OpenLiteSpeed cannot create the vhost directory", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const base = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const run: SiteRunFn = async (command, args) => {
    if (
      args.includes("install") && args.includes("-d") &&
      String(args.at(-1)).includes("/openlitespeed/vhosts/")
    ) {
      return fail("ols vhost mkdir denied");
    }
    return await base.run(command, args);
  };
  try {
    await assertRejects(
      () => applySites(layout, "envolsdir", [olsSite], { run, runPlaybook }),
      Error,
      "ols vhost mkdir denied",
    );
  } finally {
    await cleanup();
  }
});

test("applySites treats a failed id lookup as no supplementary groups", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run: SiteRunFn = async (command, args) => {
    if (command === "id") return fail("no such user");
    return await mock.run(command, args);
  };
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>one</h1>");
    const result = await applySites(layout, "envidfail", [nginxSite], {
      run,
      runPlaybook,
      releaseBindings: releaseBindingsFor("www"),
    });
    assertEquals(result.applied, ["www"]);
    assert(
      mock.calls.some((call) =>
        call.args.includes("usermod") && call.args.includes("-aG")
      ),
    );
  } finally {
    await cleanup();
  }
});

test("applySites rethrows a non-NotFound document-root index stat", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const originalStat = Deno.stat.bind(Deno);
  Deno.stat = ((path: string | URL) => {
    if (
      String(path).endsWith("/index.html") && String(path).includes("/www/")
    ) {
      return Promise.reject(new Deno.errors.PermissionDenied("index"));
    }
    return originalStat(path);
  }) as typeof Deno.stat;
  try {
    await assertRejects(
      () => applySites(layout, "envidxstat", [nginxSite], { run, runPlaybook }),
      Deno.errors.PermissionDenied,
      "index",
    );
  } finally {
    Deno.stat = originalStat;
    await cleanup();
  }
});

/**
 * Deny the daemon's own `Deno.*` calls under `prefix`, the way a `0750` dir it
 * cannot enter does on a host. The sudo seam keeps acting through `rootFs`.
 */
function denyDaemonFs(prefix: string): () => void {
  const names = [
    "copyFile",
    "lstat",
    "mkdir",
    "readDir",
    "readLink",
    "readTextFile",
    "remove",
    "rename",
    "stat",
    "writeTextFile",
  ] as const;
  const denied = (path: unknown) => String(path).startsWith(prefix);
  const saved = names.map((name) => [name, Deno[name]] as const);
  for (const name of names) {
    const original = Deno[name] as (...args: unknown[]) => unknown;
    (Deno as unknown as Record<string, unknown>)[name] = (
      ...args: unknown[]
    ) => {
      if (args.slice(0, 2).some(denied)) {
        if (name === "readDir") {
          // deno-lint-ignore require-yield
          return (async function* () {
            throw new Deno.errors.PermissionDenied(String(args[0]));
          })();
        }
        return Promise.reject(
          new Deno.errors.PermissionDenied(String(args[0])),
        );
      }
      return original.apply(Deno, args);
    };
  }
  return () => {
    for (const [name, original] of saved) {
      (Deno as unknown as Record<string, unknown>)[name] = original;
    }
  };
}

test("applySites checks a release document root it cannot enter through tp-host", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "public", "<h1>one</h1>");
    const restore = denyDaemonFs(layout.principalHomeRoot);
    try {
      const result = await applySites(layout, "envstat", [nginxSite], {
        run,
        runPlaybook,
        releaseBindings: releaseBindingsFor("www"),
      });
      assertEquals(result.applied, ["www"]);
    } finally {
      restore();
    }
    const tests = mock.calls.filter((c) => c.args.includes("test"));
    // `current` is resolved with readlink, never traversed by a root check.
    assertEquals(
      tests.some((c) => dirname(c.args.at(-1) ?? "").includes("/current")),
      false,
    );
    assert(
      tests.some((c) =>
        c.args.at(-1) === join(siteTreeRoot(layout), "releases/rel-1/public")
      ),
    );
  } finally {
    await cleanup();
  }
});

test("applySites reports a missing release document root it cannot enter", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const run = withGroupMembership(mock.run, { tpnginx: ["tpnginx"] });
  const { runPlaybook } = capturePlaybooks();
  try {
    await seedRelease(layout, "rel-1", "dist", "<h1>one</h1>");
    const restore = denyDaemonFs(layout.principalHomeRoot);
    try {
      await assertRejects(
        () =>
          applySites(layout, "envstat2", [nginxSite], {
            run,
            runPlaybook,
            releaseBindings: releaseBindingsFor("www"),
          }),
        Error,
        "release document root missing for www",
      );
    } finally {
      restore();
    }
  } finally {
    await cleanup();
  }
});

test("removeSites swallows an engine reload failure after a successful site delete", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envengreload";
  try {
    await applySites(layout, environmentId, [nginxSite], { run, runPlaybook });
    const remove: SiteRunFn = async (command, args) => {
      if (args.includes("-t") && args.includes("-c")) {
        throw "nginx-test-string";
      }
      return await run(command, args);
    };
    await removeSites(layout, environmentId, { run: remove });
  } finally {
    await cleanup();
  }
});

test("removeSites removes php-fpm pools when the daemon cannot enter the php config dir", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const phpDir = join(layout.configDir, "php");
  const pool = join(phpDir, "8.4", "pools", "tp-envphpdeny-phpsite.conf");
  try {
    await applySites(layout, "envphpdeny", [nginxPhpSite], {
      run,
      runPlaybook,
    });
    await rootFs.stat(pool);
    const restore = denyDaemonFs(phpDir);
    try {
      await removeSites(layout, "envphpdeny", { run });
    } finally {
      restore();
    }
    await assertRejects(() => rootFs.stat(pool), Deno.errors.NotFound);
  } finally {
    await cleanup();
  }
});

test("removeSites warns and keeps the aggregate when an OLS fragment cannot be removed", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envolsrm";
  const olsDir = join(layout.configDir, "openlitespeed");
  try {
    await applySites(layout, environmentId, [olsSite], { run, runPlaybook });
    const fragment = join(olsDir, "sites", `tp-${environmentId}-static.conf`);
    const before = await rootFs.readTextFile(join(olsDir, "httpd_config.conf"));
    const remove: SiteRunFn = (command, args) =>
      args.includes("rm") && args.at(-1) === fragment
        ? Promise.resolve(fail("rm: denied"))
        : run(command, args);
    await removeSites(layout, environmentId, { run: remove });
    assertEquals(
      await rootFs.readTextFile(join(olsDir, "httpd_config.conf")),
      before,
    );
    // The aggregate still names this vhost, so its vhconf must survive too.
    await rootFs.stat(
      join(olsDir, "vhosts", `tp_${environmentId}_static`, "vhconf.conf"),
    );
  } finally {
    await cleanup();
  }
});

test("removeSites drops an OLS vhost dir only after the aggregate stops naming it", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envolsorder";
  const olsDir = join(layout.configDir, "openlitespeed");
  try {
    await applySites(layout, environmentId, [olsSite], { run, runPlaybook });
    const start = calls.length;
    await removeSites(layout, environmentId, { run });
    const teardown = calls.slice(start).map((c) => c.args.at(-1) ?? "");
    const fragmentRm = teardown.indexOf(
      join(olsDir, "sites", `tp-${environmentId}-static.conf`),
    );
    const aggregate = teardown.indexOf(join(olsDir, "httpd_config.conf"));
    const vhostRm = teardown.indexOf(
      join(olsDir, "vhosts", `tp_${environmentId}_static`),
    );
    assert(fragmentRm >= 0 && aggregate > fragmentRm, teardown.join("\n"));
    assert(vhostRm > aggregate, teardown.join("\n"));
  } finally {
    await cleanup();
  }
});

test("removeSites lists and removes root-owned engine configs through sudo", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envstage";
  const sitesDir = join(layout.configDir, "nginx", "sites");
  try {
    await applySites(layout, environmentId, [nginxSite], { run, runPlaybook });
    const leftover = join(sitesDir, `tp-${environmentId}-www.conf.tpprev`);
    await Deno.writeTextFile(leftover, "stale\n");
    calls.length = 0;
    await removeSites(layout, environmentId, { run });
    // The daemon cannot enter `root:tpnginx 0750`: list and unlink via tp-host.
    assertEquals(
      calls.some((c) =>
        c.command === "sudo" && c.args.includes("ls") &&
        c.args.at(-1) === sitesDir
      ),
      true,
    );
    const removed = calls
      .filter((c) => c.command === "sudo" && c.args.includes("rm"))
      .map((c) => c.args.at(-1));
    assertEquals(removed.includes(leftover), true);
    assertEquals(
      removed.includes(join(sitesDir, `tp-${environmentId}-www.conf`)),
      true,
    );
    assertEquals(await listConfigDirEntries(sitesDir), []);
  } finally {
    await cleanup();
  }
});

test("removeSites is a no-op when no engine config directories exist", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  try {
    await removeSites(layout, "envmissing", { run });
  } finally {
    await cleanup();
  }
});

test("removeSites reloads both PHP series an environment owned", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envtworm";
  try {
    await applySites(layout, environmentId, [
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
    calls.length = 0;
    await removeSites(layout, environmentId, { run });
    const units = calls
      .filter((c) => c.args.includes("systemctl"))
      .map((c) => c.args.at(-1));
    assertEquals(units.includes("turbopanel-php-fpm@8.3"), true);
    assertEquals(units.includes("turbopanel-php-fpm@8.4"), true);
  } finally {
    await cleanup();
  }
});

test("removeSites skips idle disable when the pools directory vanishes", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const base = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envnopools";
  const poolsDir = join(layout.configDir, "php", "8.4", "pools");
  let poolListings = 0;
  const run: SiteRunFn = async (command, args) => {
    if (args.includes("ls") && args.at(-1) === poolsDir) {
      poolListings += 1;
      // The removal sweep sees the pools; the idle check finds them gone.
      if (poolListings >= 2) return fail("No such file or directory");
    }
    if (args.includes("disable") && args.includes("--now")) {
      throw new TypeError("disable must not run when the pools dir is gone");
    }
    return await base.run(command, args);
  };
  try {
    await applySites(layout, environmentId, [nginxPhpSite], {
      run,
      runPlaybook,
    });
    await removeSites(layout, environmentId, { run });
    assertEquals(poolListings >= 2, true);
  } finally {
    await cleanup();
  }
});

test("removeSites skips leftover OLS files that are not this environment's fragments", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envolskeep";
  try {
    await applySites(layout, environmentId, [olsSite], { run, runPlaybook });
    const sitesDir = join(layout.configDir, "openlitespeed", "sites");
    await Deno.writeTextFile(join(sitesDir, "README"), "keep\n");
    await Deno.writeTextFile(
      join(sitesDir, "tp-otherenv-static.conf"),
      "other\n",
    );
    await removeSites(layout, environmentId, { run });
    assertEquals(await Deno.readTextFile(join(sitesDir, "README")), "keep\n");
    assertEquals(
      await Deno.readTextFile(join(sitesDir, "tp-otherenv-static.conf")),
      "other\n",
    );
  } finally {
    await cleanup();
  }
});

test("removeSites swallows a leftover staging file that cannot be unlinked", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const base = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envstagefile";
  const leftover = join(
    layout.configDir,
    "nginx",
    "sites",
    `tp-${environmentId}-www.conf.tpnew`,
  );
  const run: SiteRunFn = async (command, args) => {
    if (args.includes("rm") && args.at(-1) === leftover) {
      return fail("rm denied");
    }
    return await base.run(command, args);
  };
  try {
    await applySites(layout, environmentId, [nginxSite], { run, runPlaybook });
    await Deno.writeTextFile(leftover, "stale\n");
    await removeSites(layout, environmentId, { run });
  } finally {
    await cleanup();
  }
});

test("removeSites uses runDefault when run is omitted", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const restore = stubDenoCommand(run);
  try {
    await removeSites(layout, "envdefrun");
  } finally {
    restore();
    await cleanup();
  }
});

test("removeSites reloads site Caddy after tearing down a Caddy vhost", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envcaddyrm";
  try {
    await applySites(layout, environmentId, [caddySite], { run, runPlaybook });
    calls.length = 0;
    await removeSites(layout, environmentId, { run });
    assertEquals(
      calls.some((c) =>
        c.args.includes("validate") && c.args.includes("caddyfile")
      ),
      true,
    );
    assertEquals(
      systemctlActions(calls, "turbopanel-site-caddy").length > 0,
      true,
    );
  } finally {
    await cleanup();
  }
});

test("a Caddy site deploy and removal leave the control plane Caddy directory alone", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const environmentId = "envcaddycp";
  const controlPlaneDir = join(layout.configDir, "caddy");
  const controlPlaneFile = join(controlPlaneDir, "Caddyfile");
  try {
    await Deno.mkdir(controlPlaneDir, { recursive: true });
    await Deno.writeTextFile(controlPlaneFile, "control plane caddyfile\n");
    await applySites(layout, environmentId, [caddySite], { run, runPlaybook });
    await removeSites(layout, environmentId, { run });
    assertEquals(
      await Deno.readTextFile(controlPlaneFile),
      "control plane caddyfile\n",
    );
    assertEquals(
      [...Deno.readDirSync(controlPlaneDir)].map((e) => e.name),
      ["Caddyfile"],
    );
  } finally {
    await cleanup();
  }
});

test("OpenLiteSpeed apply and removal work when the daemon cannot enter its config dir", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  const olsDir = join(layout.configDir, "openlitespeed");
  const mainConfig = join(olsDir, "httpd_config.conf");
  try {
    const restore = denyDaemonFs(olsDir);
    try {
      await applySites(layout, "envolsa", [olsSite], { run, runPlaybook });
      await applySites(layout, "envolsb", [{
        ...olsSite,
        listenPort: olsSite.listenPort + 100,
      }], { run, runPlaybook });
      // A teardown of an environment with no OLS site must not trip on it.
      await removeSites(layout, "envnone", { run });
      await removeSites(layout, "envolsa", { run });
    } finally {
      restore();
    }
    const aggregate = await rootFs.readTextFile(mainConfig);
    assertStringIncludes(aggregate, "tp_envolsb_static");
    assertEquals(aggregate.includes("tp_envolsa_static"), false);
    assertEquals(await listConfigDirEntries(join(olsDir, "sites")), [
      "tp-envolsb-static.conf",
    ]);
  } finally {
    await cleanup();
  }
});

test("applySites creates root-owned engine config dirs through tp-host", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envdirs", [nginxPhpSite, caddySite], {
      run,
      runPlaybook,
    });
    await applySites(layout, "envdirs2", [apachePhpSite], {
      run,
      runPlaybook,
    });
    const dirGroups = new Map(
      calls
        .filter((c) =>
          c.command === "sudo" && c.args.includes("install") &&
          c.args.includes("-d")
        )
        .map((c) => [
          String(c.args.at(-1)),
          c.args[c.args.indexOf("-g") + 1],
        ]),
    );
    const conf = layout.configDir;
    assertEquals(dirGroups.get(join(conf, "nginx", "sites")), "tpnginx");
    assertEquals(
      dirGroups.get(join(conf, "site-caddy", "sites")),
      "tpcaddysite",
    );
    // The control plane Caddy's directory is never a site engine directory.
    assertEquals(dirGroups.has(join(conf, "caddy", "sites")), false);
    assertEquals(dirGroups.get(join(conf, "apache", "sites")), "tpapache");
    // php-fpm role's php_fpm_service_group, whichever engine asked.
    assertEquals(
      dirGroups.get(join(conf, "php", "8.4", "pools")),
      "tpapache",
    );
  } finally {
    await cleanup();
  }
});

test("applySites never stages a root-owned config inside its config dir", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const { run, calls } = createSiteRunMock();
  const { runPlaybook } = capturePlaybooks();
  try {
    await applySites(layout, "envsrc", [nginxPhpSite], { run, runPlaybook });
    const sources = calls
      .filter((c) =>
        c.command === "sudo" && c.args.includes("install") &&
        !c.args.includes("-d") && String(c.args.at(-1)).endsWith(".tpnew")
      )
      .map((c) => String(c.args.at(-2)));
    assertEquals(sources.length >= 2, true);
    for (const source of sources) {
      assertEquals(source.startsWith(layout.configDir), false, source);
    }
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Per-site PHP runtimes: FastCGI and php-fpm as the site's principal.
// ---------------------------------------------------------------------------

const PHP_PRINCIPAL = { principalId: "pr-1", username: RELEASE_USERNAME };

function perSitePhpSite(
  engine: "nginx" | "apache" | "nginx+apache" | "openlitespeed",
  mode: SitePhpRuntimeMode,
  settings: Record<string, string> = { memory_limit: "256M" },
): SiteApplySpec {
  return {
    composeServiceName: "shop",
    engine,
    root: "public",
    listenPort: 18090,
    ...(engine === "nginx+apache" ? { backendPort: 18091 } : {}),
    principal: PHP_PRINCIPAL,
    php: { version: "8.4", mode, settings },
  };
}

function phpRuntimeId(
  mode: SitePhpRuntimeMode,
  env = "envphp",
  service = "shop",
): string {
  return sitePhpRuntimeId(sitePhpKey(env, service), mode, "8.4");
}

type PerSitePhpHarness = {
  layout: LayoutPaths;
  unitDir: string;
  calls: Array<{ command: string; args: string[] }>;
  apply: (
    site: SiteApplySpec | SiteApplySpec[],
    env?: string,
  ) => Promise<unknown>;
  failProbe: (on: boolean) => void;
  failPhpTest: (on: boolean) => void;
  /** Fail the config test of the engine whose binary path ends with this. */
  failEngineTest: (binary: string | null) => void;
  /** Loopback ports the bind probe reports as taken by something else. */
  busyPorts: Set<number>;
  /** Ports the bind probe was asked about, in order. */
  probedPorts: number[];
  cleanup: () => Promise<void>;
};

async function perSitePhpHarness(): Promise<PerSitePhpHarness> {
  const { layout, root, cleanup } = await makeTestLayout();
  const unitDir = join(root, "units");
  await Deno.mkdir(unitDir, { recursive: true });
  const base = createSiteRunMock();
  let probeFails = false;
  let phpTestFails = false;
  let failingEngine: string | null = null;
  const run = withGroupMembership(async (command, args) => {
    if (probeFails && command === "curl") {
      return { success: true, stdout: "502", stderr: "" };
    }
    if (
      failingEngine !== null && args.includes("-t") &&
      args.some((arg) => arg.endsWith(failingEngine as string))
    ) {
      base.calls.push({ command, args: [...args] });
      return fail(`${failingEngine}: config test failed`);
    }
    if (phpTestFails && args.includes("php-test")) {
      base.calls.push({ command, args: [...args] });
      return fail("PHP Startup: Unable to load dynamic library");
    }
    return await base.run(command, args);
  }, {
    tpnginx: ["tpnginx", RELEASE_GROUP],
    tpapache: ["tpapache", RELEASE_GROUP],
    tpols: ["tpols", RELEASE_GROUP],
  });
  await seedRelease(layout, "rel-1", "public", "<?php echo 1;");
  const busyPorts = new Set<number>();
  const probedPorts: number[] = [];
  return {
    layout,
    unitDir,
    calls: base.calls,
    apply: (site, env = "envphp") => {
      const sites = Array.isArray(site) ? site : [site];
      return applySites(layout, env, sites, {
        run,
        runPlaybook: () => Promise.resolve(),
        releaseBindings: releaseBindingsFor(
          ...sites.map((s) => s.composeServiceName),
        ),
        systemdUnitDir: unitDir,
        sleep: () => Promise.resolve(),
        probeHostPort: (_address, port) => {
          probedPorts.push(port);
          return Promise.resolve(!busyPorts.has(port));
        },
      });
    },
    busyPorts,
    probedPorts,
    failProbe: (on) => {
      probeFails = on;
    },
    failPhpTest: (on) => {
      phpTestFails = on;
    },
    failEngineTest: (binary) => {
      failingEngine = binary;
    },
    cleanup,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function callIndex(
  calls: ReadonlyArray<{ args: string[] }>,
  match: (args: string[]) => boolean,
): number {
  return calls.findIndex((call) => match(call.args));
}

test("per-site FastCGI: the runtime is tested and started before the nginx vhost names its socket", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx", "fastcgi"));
    const id = phpRuntimeId("fastcgi");
    const service = await Deno.readTextFile(
      join(h.unitDir, `turbopanel-php-${id}.service`),
    );
    assertStringIncludes(
      service,
      `ExecStart=/usr/bin/php-cgi8.4 -c ${h.layout.configDir}/php/sites/${id}/php.ini`,
    );
    assertStringIncludes(service, `User=${RELEASE_USERNAME}`);
    assertStringIncludes(service, "StandardInput=socket");
    assertStringIncludes(
      service,
      `ReadWritePaths=${
        join(h.layout.principalHomeRoot, RELEASE_USERNAME, "tmp")
      } -${join(siteTreeRoot(h.layout), "shared")}`,
    );
    const socket = await Deno.readTextFile(
      join(h.unitDir, `turbopanel-php-${id}.socket`),
    );
    assertStringIncludes(socket, "SocketGroup=tpnginx");
    const ini = await Deno.readTextFile(
      join(h.layout.configDir, "php", "sites", id, "php.ini"),
    );
    assertStringIncludes(ini, "memory_limit = 256M");
    assertStringIncludes(ini, "opcache.memory_consumption = 128");
    assertStringIncludes(ini, "opcache.validate_root = 1");
    assertStringIncludes(ini, "session.save_path = /tmp");
    assertStringIncludes(
      ini,
      `open_basedir = ${join(siteTreeRoot(h.layout), "current", "public")}:${
        join(siteTreeRoot(h.layout), "shared")
      }:/tmp`,
    );

    const vhost = await Deno.readTextFile(
      join(h.layout.configDir, "nginx", "sites", "tp-envphp-shop.conf"),
    );
    assertStringIncludes(
      vhost,
      `fastcgi_pass unix:/run/turbopanel-php-${id}/php.sock;`,
    );
    // No pool on the shared master for this site.
    assertEquals(
      await exists(
        join(h.layout.configDir, "php", "8.4", "pools", "tp-envphp-shop.conf"),
      ),
      false,
    );

    const phpTest = callIndex(h.calls, (a) => a.includes("php-test"));
    const started = callIndex(
      h.calls,
      (a) =>
        a.includes("restart") && a.includes(`turbopanel-php-${id}.service`),
    );
    const nginxTest = callIndex(h.calls, (a) => a.includes("-t"));
    assert(phpTest >= 0 && phpTest < started, "php-test before start");
    assert(started < nginxTest, "runtime up before the vhost is tested");
    assertEquals(
      systemctlCalls(h.calls).filter((c) => c.includes(`php-${id}`)),
      [
        `enable --now turbopanel-php-${id}.socket`,
        `restart turbopanel-php-${id}.service`,
        `is-active --quiet turbopanel-php-${id}.service`,
      ],
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: a redeploy with nothing changed touches no runtime", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx", "fastcgi"));
    h.calls.length = 0;
    await h.apply(perSitePhpSite("nginx", "fastcgi"));
    assertEquals(h.calls.some((c) => c.args.includes("php-test")), false);
    assertEquals(
      systemctlCalls(h.calls).filter((c) => c.includes("turbopanel-php-")),
      [],
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site php-fpm on Apache: a pool for the owner, reachable by tpapache through an ACL", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("apache", "fpm"));
    const id = phpRuntimeId("fpm");
    const fpm = await Deno.readTextFile(
      join(h.layout.configDir, "php", "sites", id, "php-fpm.conf"),
    );
    assertStringIncludes(fpm, `[${id}]`);
    assertStringIncludes(fpm, "listen.acl_users = tpapache");
    assertEquals(fpm.includes("\nuser ="), false);
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${id}.socket`)),
      false,
    );
    const vhost = await Deno.readTextFile(
      join(h.layout.configDir, "apache", "sites", "tp-envphp-shop.conf"),
    );
    assertStringIncludes(
      vhost,
      `SetHandler "proxy:unix:/run/turbopanel-php-${id}/php.sock|fcgi://localhost/"`,
    );
    assertEquals(vhost.includes("ProxyFCGIBackendType"), false);
    assertEquals(
      systemctlCalls(h.calls).filter((c) => c.includes(`php-${id}`)),
      [
        `enable turbopanel-php-${id}.service`,
        `is-active --quiet turbopanel-php-${id}.service`,
        `restart turbopanel-php-${id}.service`,
        `is-active --quiet turbopanel-php-${id}.service`,
      ],
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site FastCGI on Apache tells proxy_fcgi it talks to a generic backend", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("apache", "fastcgi"));
    const vhost = await Deno.readTextFile(
      join(h.layout.configDir, "apache", "sites", "tp-envphp-shop.conf"),
    );
    assertStringIncludes(vhost, "  ProxyFCGIBackendType GENERIC\n");
    const socket = await Deno.readTextFile(
      join(h.unitDir, `turbopanel-php-${phpRuntimeId("fastcgi")}.socket`),
    );
    assertStringIncludes(socket, "SocketGroup=tpapache");
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: switching mode starts the new runtime first and removes the old only after the probe", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx", "fastcgi"));
    const oldId = phpRuntimeId("fastcgi");
    const newId = phpRuntimeId("fpm");
    h.calls.length = 0;
    await h.apply(perSitePhpSite("nginx", "fpm"));

    const newStarted = callIndex(
      h.calls,
      (a) =>
        a.includes("restart") && a.includes(`turbopanel-php-${newId}.service`),
    );
    const probe = h.calls.findIndex((c) => c.command === "curl");
    const oldStopped = callIndex(
      h.calls,
      (a) =>
        a.includes("stop") && a.includes(`turbopanel-php-${oldId}.service`),
    );
    assert(newStarted >= 0 && newStarted < probe, "new runtime before probe");
    assert(probe < oldStopped, "old runtime only after the probe");
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${oldId}.service`)),
      false,
    );
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${oldId}.socket`)),
      false,
    );
    assertEquals(
      await exists(join(h.layout.configDir, "php", "sites", oldId)),
      false,
    );
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${newId}.service`)),
      true,
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: a failed probe keeps the old runtime and removes the one the apply created", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx", "fastcgi"));
    const oldId = phpRuntimeId("fastcgi");
    const newId = phpRuntimeId("fpm");
    const vhostPath = join(
      h.layout.configDir,
      "nginx",
      "sites",
      "tp-envphp-shop.conf",
    );
    const lastGood = await Deno.readTextFile(vhostPath);
    h.failProbe(true);
    await assertRejects(
      () => h.apply(perSitePhpSite("nginx", "fpm")),
      Error,
      "did not serve shop",
    );
    assertEquals(await Deno.readTextFile(vhostPath), lastGood);
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${newId}.service`)),
      false,
    );
    assertEquals(
      await exists(join(h.layout.configDir, "php", "sites", newId)),
      false,
    );
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${oldId}.service`)),
      true,
    );
    // An fpm runtime has no socket unit to stop.
    assertEquals(
      systemctlCalls(h.calls).filter((c) => c.startsWith("stop")),
      [`stop turbopanel-php-${newId}.service`],
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: a failed config test stages no vhost and leaves no runtime", async () => {
  const h = await perSitePhpHarness();
  try {
    h.failPhpTest(true);
    await assertRejects(
      () => h.apply(perSitePhpSite("nginx", "fastcgi")),
      Error,
      "failed its config test: PHP Startup",
    );
    const id = phpRuntimeId("fastcgi");
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${id}.service`)),
      false,
    );
    assertEquals(
      await listConfigDirEntries(join(h.layout.configDir, "nginx", "sites")),
      [],
    );
    assertEquals(h.calls.some((c) => c.args.includes("-t")), false);
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: a settings change restores the previous config when the site stops answering", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx", "fpm"));
    const id = phpRuntimeId("fpm");
    const iniPath = join(h.layout.configDir, "php", "sites", id, "php.ini");
    const lastGood = await Deno.readTextFile(iniPath);
    h.calls.length = 0;
    h.failProbe(true);
    await assertRejects(
      () => h.apply(perSitePhpSite("nginx", "fpm", { memory_limit: "64M" })),
      Error,
      "did not serve shop",
    );
    // The vhost did not change, so nginx was never reloaded; the runtime was
    // restarted (a new memory_limit moves the unit's MemoryMax, which a
    // reload cannot apply), probed, and put back.
    assertEquals(h.calls.some((c) => c.args.includes("-t")), false);
    assertEquals(await Deno.readTextFile(iniPath), lastGood);
    assertEquals(await exists(`${iniPath}.tpprev`), false);
    assertEquals(
      systemctlCalls(h.calls).filter((c) => c.includes(`php-${id}`)),
      [
        `enable turbopanel-php-${id}.service`,
        `is-active --quiet turbopanel-php-${id}.service`,
        `restart turbopanel-php-${id}.service`,
        `is-active --quiet turbopanel-php-${id}.service`,
        `restart turbopanel-php-${id}.service`,
      ],
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP is refused without a principal, and lsphp is refused on nginx", async () => {
  const h = await perSitePhpHarness();
  try {
    const { principal: _none, ...ownerless } = perSitePhpSite(
      "nginx",
      "fastcgi",
    );
    await assertRejects(
      () => h.apply(ownerless),
      Error,
      "runs as the site's principal, and the site has none",
    );
    await assertRejects(
      () =>
        h.apply({
          ...perSitePhpSite("nginx", "fastcgi"),
          php: { version: "8.4", mode: "lsphp-detached" },
        }),
      Error,
      "PHP mode lsphp-detached needs OpenLiteSpeed, not nginx",
    );
  } finally {
    await h.cleanup();
  }
});

async function olsVhconf(h: PerSitePhpHarness, service = "shop") {
  return await Deno.readTextFile(
    join(
      h.layout.configDir,
      "openlitespeed",
      "vhosts",
      `tp_envphp_${service}`,
      "vhconf.conf",
    ),
  );
}

const OLS_DEAD_LINES = [
  "extUser",
  "extGroup",
  "setUIDMode",
  "runOnStartUp",
  "\n  user ",
];

test("per-site PHP on OpenLiteSpeed: fastcgi and fpm reach the owner's runtime through an fcgi processor", async () => {
  for (const [mode, maxConns] of [["fastcgi", 2], ["fpm", 10]] as const) {
    const h = await perSitePhpHarness();
    try {
      await h.apply(perSitePhpSite("openlitespeed", mode));
      const id = phpRuntimeId(mode);
      const service = await Deno.readTextFile(
        join(h.unitDir, `turbopanel-php-${id}.service`),
      );
      assertStringIncludes(service, `User=${RELEASE_USERNAME}`);
      if (mode === "fastcgi") {
        const socket = await Deno.readTextFile(
          join(h.unitDir, `turbopanel-php-${id}.socket`),
        );
        assertStringIncludes(socket, "SocketGroup=tpols");
      } else {
        const fpm = await Deno.readTextFile(
          join(h.layout.configDir, "php", "sites", id, "php-fpm.conf"),
        );
        assertStringIncludes(fpm, "listen.acl_users = tpols");
      }
      const ini = await Deno.readTextFile(
        join(h.layout.configDir, "php", "sites", id, "php.ini"),
      );
      assertStringIncludes(ini, "memory_limit = 256M");
      const vhost = await olsVhconf(h);
      assertStringIncludes(vhost, "type                      fcgi");
      assertStringIncludes(
        vhost,
        `address                   uds:///run/turbopanel-php-${id}/php.sock`,
      );
      assertStringIncludes(vhost, `maxConns                  ${maxConns}`);
      assertStringIncludes(vhost, "autoStart                 0");
      assertStringIncludes(
        vhost,
        "add                       fcgi:php_tp_envphp_shop php",
      );
      const fragment = await Deno.readTextFile(
        join(
          h.layout.configDir,
          "openlitespeed",
          "sites",
          "tp-envphp-shop.conf",
        ),
      );
      for (const dead of OLS_DEAD_LINES) {
        assertEquals(vhost.includes(dead), false, `${mode} vhost: ${dead}`);
        assertEquals(
          fragment.includes(dead),
          false,
          `${mode} fragment: ${dead}`,
        );
      }
      // The runtime answers before OpenLiteSpeed is tested against its socket.
      const started = callIndex(
        h.calls,
        (a) =>
          a.includes("restart") && a.includes(`turbopanel-php-${id}.service`),
      );
      const olsTest = callIndex(h.calls, (a) => a.includes("-t"));
      assert(started >= 0 && started < olsTest, `${mode}: runtime up first`);
    } finally {
      await h.cleanup();
    }
  }
});

test("detached lsphp on OpenLiteSpeed: systemd runs the vendored lsphp as the owner, OpenLiteSpeed only connects", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("openlitespeed", "lsphp-detached"));
    const id = phpRuntimeId("lsphp-detached");
    assertEquals(id.endsWith("-lsd84"), true, id);
    const service = await Deno.readTextFile(
      join(h.unitDir, `turbopanel-php-${id}.service`),
    );
    for (
      const want of [
        `ExecStart=${h.layout.runtimesDir}/lsphp/8.4/current/bin/lsphp\n`,
        "StandardInput=socket\n",
        `Environment=PHPRC=${h.layout.configDir}/php/sites/${id}/php.ini\n`,
        "Environment=LSAPI_CHILDREN=10\n",
        `User=${RELEASE_USERNAME}\n`,
        "\nIPAddressDeny=localhost ",
        "\nIPAddressAllow=127.0.0.1 127.0.0.53\n",
        "tp-php-loopback sync\n",
        "\nMemoryMax=",
        "\nTasksMax=",
      ]
    ) {
      assertStringIncludes(service, want);
    }
    const socket = await Deno.readTextFile(
      join(h.unitDir, `turbopanel-php-${id}.socket`),
    );
    assertStringIncludes(
      socket,
      `ListenStream=/run/turbopanel-php-${id}/php.sock`,
    );
    assertStringIncludes(socket, "SocketGroup=tpols");
    const ini = await Deno.readTextFile(
      join(h.layout.configDir, "php", "sites", id, "php.ini"),
    );
    assertStringIncludes(
      ini,
      `extension_dir = ${h.layout.runtimesDir}/lsphp/8.4/current/lib/php/ext\n`,
    );
    assertStringIncludes(ini, "extension = mysqli.so\n");
    assertStringIncludes(ini, "memory_limit = 256M\n");
    const vhost = await olsVhconf(h);
    assertStringIncludes(vhost, "type                      lsapi");
    assertStringIncludes(
      vhost,
      `address                   uds:///run/turbopanel-php-${id}/php.sock`,
    );
    assertStringIncludes(vhost, "maxConns                  5");
    assertStringIncludes(vhost, "autoStart                 0");
    assertStringIncludes(
      vhost,
      "add                       lsapi:php_tp_envphp_shop php",
    );
    // #283's script-source deny rules sit beside the handler, and the locked
    // limits go to lsphp as admin values.
    assertStringIncludes(vhost, "rewrite {\n  enable                    1");
    assertStringIncludes(vhost, "phpIniOverride {\n  php_admin_value ");
    for (const dead of [...OLS_DEAD_LINES, "path "]) {
      assertEquals(vhost.includes(dead), false, dead);
    }
    assertEquals(
      systemctlCalls(h.calls).filter((c) => c.includes(`php-${id}`)),
      [
        `enable --now turbopanel-php-${id}.socket`,
        `restart turbopanel-php-${id}.service`,
        `is-active --quiet turbopanel-php-${id}.service`,
      ],
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP on OpenLiteSpeed: a site asking for attached lsphp runs detached and does not fail the apply", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply([
      perSitePhpSite("openlitespeed", "lsphp-detached"),
      {
        ...perSitePhpSite("openlitespeed", "fpm"),
        composeServiceName: "attached",
        listenPort: 18092,
        php: { version: "8.4", mode: "lsphp-attached" },
      },
    ]);
    const attached = phpRuntimeId("lsphp-detached", "envphp", "attached");
    const service = await Deno.readTextFile(
      join(h.unitDir, `turbopanel-php-${attached}.service`),
    );
    assertStringIncludes(service, "StandardInput=socket\n");
    // Same sandbox as every per-site PHP unit: loopback filter, its root
    // guard, and the memory and task caps.
    assertStringIncludes(service, "\nIPAddressDeny=localhost ");
    assertStringIncludes(service, "\nIPAddressAllow=127.0.0.1 127.0.0.53\n");
    assertStringIncludes(service, "\nExecStartPre=+");
    assertStringIncludes(service, "tp-php-loopback sync\n");
    assertStringIncludes(service, "\nMemoryMax=");
    assertStringIncludes(service, "\nTasksMax=");
  } finally {
    await h.cleanup();
  }
});

test("two OpenLiteSpeed PHP sites in one apply restart OpenLiteSpeed once", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply([
      perSitePhpSite("openlitespeed", "lsphp-detached"),
      {
        ...perSitePhpSite("openlitespeed", "fastcgi"),
        composeServiceName: "blog",
        listenPort: 18091,
      },
    ]);
    assertEquals(
      systemctlCalls(h.calls).filter((c) =>
        c.includes("turbopanel-openlitespeed") && !c.startsWith("is-active")
      ),
      ["reload turbopanel-openlitespeed"],
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: a site that names no mode keeps the shared php-fpm pool", async () => {
  const h = await perSitePhpHarness();
  try {
    const site = perSitePhpSite("nginx", "fastcgi");
    await h.apply({ ...site, php: { version: "8.4" } });
    assertEquals(
      await exists(
        join(h.layout.configDir, "php", "8.4", "pools", "tp-envphp-shop.conf"),
      ),
      true,
    );
    assertEquals(h.calls.some((c) => c.args.includes("php-test")), false);
  } finally {
    await h.cleanup();
  }
});

test("removeSites removes the environment's per-site PHP runtimes after the vhosts", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx", "fastcgi"));
    await h.apply(
      { ...perSitePhpSite("nginx", "fpm"), listenPort: 18190 },
      "envother",
    );
    const id = phpRuntimeId("fastcgi");
    const other = phpRuntimeId("fpm", "envother");
    const mock = createSiteRunMock();
    await removeSites(h.layout, "envphp", {
      run: mock.run,
      systemdUnitDir: h.unitDir,
    });
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${id}.service`)),
      false,
    );
    assertEquals(
      await exists(join(h.layout.configDir, "php", "sites", id)),
      false,
    );
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${other}.service`)),
      true,
    );
    const nginxReload = callIndex(
      mock.calls,
      (a) => a.includes("-t") || a.includes("reload"),
    );
    const stopped = callIndex(
      mock.calls,
      (a) => a.includes("stop") && a.includes(`turbopanel-php-${id}.service`),
    );
    assert(nginxReload < stopped, "vhost gone before its runtime");
  } finally {
    await h.cleanup();
  }
});

function sharedPoolPath(layout: LayoutPaths, env = "envphp"): string {
  return join(layout.configDir, "php", "8.4", "pools", `tp-${env}-shop.conf`);
}

test("per-site PHP: moving off the shared master removes the site's pool and stops the idle master", async () => {
  const h = await perSitePhpHarness();
  try {
    const site = perSitePhpSite("nginx", "fastcgi");
    await h.apply({ ...site, php: { version: "8.4" } });
    assertEquals(await exists(sharedPoolPath(h.layout)), true);
    h.calls.length = 0;
    await h.apply(site);

    assertEquals(await exists(sharedPoolPath(h.layout)), false);
    const fpm = systemctlCalls(h.calls).filter((c) =>
      c.includes("turbopanel-php-fpm@8.4")
    );
    assert(fpm.some((c) => c.startsWith("reload")), fpm.join("; "));
    // Its only pool is gone: the master goes with it.
    assertEquals(fpm.at(-1), "disable --now turbopanel-php-fpm@8.4");
    const probe = h.calls.findIndex((c) => c.command === "curl");
    const poolGone = callIndex(
      h.calls,
      (a) => a.includes("rm") && a.at(-1) === sharedPoolPath(h.layout),
    );
    assert(probe >= 0 && probe < poolGone, "pool only after the probe");
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: the shared master keeps running while another site's pool is on it", async () => {
  const h = await perSitePhpHarness();
  try {
    const site = perSitePhpSite("nginx", "fpm");
    await h.apply(
      { ...site, listenPort: 18190, php: { version: "8.4" } },
      "envkeep",
    );
    await h.apply({ ...site, php: { version: "8.4" } });
    h.calls.length = 0;
    await h.apply(site);
    assertEquals(await exists(sharedPoolPath(h.layout)), false);
    assertEquals(await exists(sharedPoolPath(h.layout, "envkeep")), true);
    assertEquals(
      systemctlCalls(h.calls).filter((c) => c.startsWith("disable --now")),
      [],
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: moving back to the shared master installs the pool before the vhost and removes the runtime after", async () => {
  const h = await perSitePhpHarness();
  try {
    const site = perSitePhpSite("nginx", "fastcgi");
    await h.apply(site);
    const id = phpRuntimeId("fastcgi");
    h.calls.length = 0;
    await h.apply({ ...site, php: { version: "8.4" } });

    assertEquals(await exists(sharedPoolPath(h.layout)), true);
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${id}.service`)),
      false,
    );
    assertEquals(
      await exists(join(h.layout.configDir, "php", "sites", id)),
      false,
    );
    const fpmUp = callIndex(
      h.calls,
      (a) => a.includes("systemctl") && a.includes("turbopanel-php-fpm@8.4"),
    );
    const nginxTest = callIndex(h.calls, (a) => a.includes("-t"));
    const runtimeStopped = callIndex(
      h.calls,
      (a) => a.includes("stop") && a.includes(`turbopanel-php-${id}.service`),
    );
    assert(fpmUp >= 0 && fpmUp < nginxTest, "pool live before nginx -t");
    assert(nginxTest < runtimeStopped, "runtime only after the vhost moved");
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP: a site whose key extends another's keeps its runtime when the other goes", async () => {
  const h = await perSitePhpHarness();
  try {
    // Slugs to `<shop's key>-x`, so its runtime ids start with `<key>-`.
    const lookalike = `${sitePhpKey("envphp", "shop")}-x`;
    const longer = sitePhpRuntimeId(
      sitePhpKey("envother", lookalike),
      "fpm",
      "8.4",
    );
    assert(longer.startsWith(`${sitePhpKey("envphp", "shop")}-`));
    await h.apply({
      ...perSitePhpSite("nginx", "fpm"),
      composeServiceName: lookalike,
      listenPort: 18190,
    }, "envother");
    await h.apply(perSitePhpSite("nginx", "fastcgi"));
    // Switching shop's mode must not take the lookalike's runtime either.
    await h.apply(perSitePhpSite("nginx", "fpm"));
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${longer}.service`)),
      true,
    );
    await removeSites(h.layout, "envphp", {
      run: createSiteRunMock().run,
      systemdUnitDir: h.unitDir,
    });
    assertEquals(
      await exists(
        join(h.unitDir, `turbopanel-php-${phpRuntimeId("fpm")}.service`),
      ),
      false,
    );
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${longer}.service`)),
      true,
    );
  } finally {
    await h.cleanup();
  }
});

test("removeSites also removes a runtime no vhost names any more", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx", "fpm"), "envkeep");
    const kept = phpRuntimeId("fpm", "envkeep");
    // Left by a site removed while its runtime stayed: no vhost names it.
    const orphan = phpRuntimeId("fastcgi", "envgone");
    await Deno.writeTextFile(
      join(h.unitDir, `turbopanel-php-${orphan}.service`),
      "",
    );
    await Deno.writeTextFile(
      join(h.unitDir, `turbopanel-php-${orphan}.socket`),
      "",
    );
    await removeSites(h.layout, "envphp", {
      run: createSiteRunMock().run,
      systemdUnitDir: h.unitDir,
    });
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${orphan}.service`)),
      false,
    );
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${orphan}.socket`)),
      false,
    );
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${kept}.service`)),
      true,
    );
  } finally {
    await h.cleanup();
  }
});

test("per-site PHP is refused for a document root outside the owner's home", async () => {
  const h = await perSitePhpHarness();
  try {
    await assertRejects(
      () =>
        applySites(h.layout, "envphp", [perSitePhpSite("nginx", "fastcgi")], {
          run: createSiteRunMock().run,
          runPlaybook: () => Promise.resolve(),
          systemdUnitDir: h.unitDir,
          sleep: () => Promise.resolve(),
        }),
      Error,
      "serves only from the owner's home",
    );
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// nginx in front of Apache: two engines, Apache rolled out first.
// ---------------------------------------------------------------------------

function pairedConfPaths(layout: LayoutPaths): {
  apache: string;
  nginx: string;
} {
  return {
    apache: join(layout.configDir, "apache", "sites", "tp-envphp-shop.conf"),
    nginx: join(layout.configDir, "nginx", "sites", "tp-envphp-shop.conf"),
  };
}

/** The probed URLs, in order. */
function probedUrls(
  calls: ReadonlyArray<{ command: string; args: string[] }>,
): string[] {
  return calls.filter((c) => c.command === "curl").map((c) =>
    String(c.args.at(-1))
  );
}

test("nginx+apache: Apache runs PHP behind nginx and is rolled out and probed first", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx+apache", "fastcgi"));
    const id = phpRuntimeId("fastcgi");
    const paths = pairedConfPaths(h.layout);
    const backend = await Deno.readTextFile(paths.apache);
    assertStringIncludes(backend, "<VirtualHost 127.0.0.1:18091>");
    assertStringIncludes(backend, "RemoteIPInternalProxy 127.0.0.2\n");
    assertStringIncludes(
      backend,
      `SetHandler "proxy:unix:/run/turbopanel-php-${id}/php.sock|fcgi://localhost/"`,
    );
    const front = await Deno.readTextFile(paths.nginx);
    assertStringIncludes(front, "proxy_bind 127.0.0.2;");
    assertStringIncludes(front, "listen 127.0.0.1:18090;");
    assertStringIncludes(front, "proxy_pass http://127.0.0.1:18091;");
    assertEquals(front.includes("fastcgi_pass"), false);
    // The socket is Apache's to connect to, not nginx's.
    const socket = await Deno.readTextFile(
      join(h.unitDir, `turbopanel-php-${id}.socket`),
    );
    assertStringIncludes(socket, "SocketGroup=tpapache");

    const apacheTest = callIndex(
      h.calls,
      (a) => a.some((x) => x.endsWith("/httpd")),
    );
    const nginxTest = callIndex(
      h.calls,
      (a) => a.some((x) => x.endsWith("/nginx")),
    );
    assert(apacheTest >= 0 && apacheTest < nginxTest, "Apache before nginx");
    const urls = probedUrls(h.calls);
    const backendProbe = urls.indexOf("http://127.0.0.1:18091/");
    const frontProbe = urls.lastIndexOf("http://127.0.0.1:18090/");
    assert(backendProbe >= 0 && backendProbe < frontProbe, urls.join(" "));
    assertEquals(
      await listConfigDirEntries(dirname(paths.apache)),
      ["tp-envphp-shop.conf"],
    );
  } finally {
    await h.cleanup();
  }
});

test("nginx+apache: nginx failing after Apache rolled out puts both back", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx+apache", "fastcgi"));
    const paths = pairedConfPaths(h.layout);
    const lastGood = {
      apache: await Deno.readTextFile(paths.apache),
      nginx: await Deno.readTextFile(paths.nginx),
    };
    const oldId = phpRuntimeId("fastcgi");
    const newId = phpRuntimeId("fpm");

    h.failEngineTest("/nginx");
    const before = h.calls.length;
    await assertRejects(
      // A new backend port: both vhosts change, so both engines roll out.
      () =>
        h.apply({
          ...perSitePhpSite("nginx+apache", "fpm"),
          backendPort: 18092,
        }),
      Error,
      "config test failed",
    );
    // Apache did roll out (and reload) on the new socket before nginx failed…
    const calls = h.calls.slice(before);
    assert(
      callIndex(calls, (a) => a.some((x) => x.endsWith("/httpd"))) >= 0,
      "Apache rolled out first",
    );
    // …and is back on the previous vhost, as is nginx: nothing left staged.
    assertEquals(await Deno.readTextFile(paths.apache), lastGood.apache);
    assertEquals(await Deno.readTextFile(paths.nginx), lastGood.nginx);
    assertEquals(
      await listConfigDirEntries(dirname(paths.apache)),
      ["tp-envphp-shop.conf"],
    );
    assertEquals(
      await listConfigDirEntries(dirname(paths.nginx)),
      ["tp-envphp-shop.conf"],
    );
    // The old runtime still serves; the one this apply created is gone.
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${oldId}.service`)),
      true,
    );
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${newId}.service`)),
      false,
    );
  } finally {
    await h.cleanup();
  }
});

test("nginx+apache: a failed Apache rollout never touches nginx", async () => {
  const h = await perSitePhpHarness();
  try {
    h.failEngineTest("/httpd");
    await assertRejects(
      () => h.apply(perSitePhpSite("nginx+apache", "fastcgi")),
      Error,
      "config test failed",
    );
    assertEquals(
      callIndex(h.calls, (a) => a.some((x) => x.endsWith("/nginx"))),
      -1,
    );
    const paths = pairedConfPaths(h.layout);
    assertEquals(await exists(paths.apache), false);
    assertEquals(await exists(paths.nginx), false);
  } finally {
    await h.cleanup();
  }
});

test("nginx+apache: both engines join the owner's group and restart", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  try {
    await seedRelease(layout, "rel-1", "public", "<?php echo 1;");
    await applySites(layout, "envpair", [{
      composeServiceName: "shop",
      engine: "nginx+apache",
      root: "public",
      listenPort: 18090,
      backendPort: 18091,
      principal: PHP_PRINCIPAL,
    }], {
      run: mock.run,
      runPlaybook: () => Promise.resolve(),
      releaseBindings: releaseBindingsFor("shop"),
    });
    const joined = usermodCalls(mock.calls).map((c) => c.args.at(-1));
    assertEquals(joined.sort(), ["tpapache", "tpnginx"]);
    assertEquals(
      systemctlActions(mock.calls, "turbopanel-apache")[0],
      "restart",
    );
    assertEquals(
      systemctlActions(mock.calls, "turbopanel-nginx")[0],
      "restart",
    );
  } finally {
    await cleanup();
  }
});

test("nginx+apache: refused without a backend port or an owner", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  const site: SiteApplySpec = {
    composeServiceName: "shop",
    engine: "nginx+apache",
    root: "public",
    listenPort: 18090,
    backendPort: 18091,
    principal: PHP_PRINCIPAL,
  };
  try {
    for (
      const [bad, message] of [
        [{ ...site, backendPort: undefined }, "needs a backendPort"],
        [{ ...site, backendPort: 18090 }, "needs a backendPort"],
        [{ ...site, principal: undefined }, "needs a principal"],
      ] as const
    ) {
      await assertRejects(
        () => applySites(layout, "envpair", [bad], { run: mock.run }),
        Error,
        message,
      );
    }
    assertEquals(mock.calls.length, 0);
  } finally {
    await cleanup();
  }
});

test("removeSites drops both vhosts of a paired site and its runtime", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx+apache", "fastcgi"));
    const id = phpRuntimeId("fastcgi");
    const mock = createSiteRunMock();
    await removeSites(h.layout, "envphp", {
      run: mock.run,
      systemdUnitDir: h.unitDir,
    });
    const paths = pairedConfPaths(h.layout);
    assertEquals(await exists(paths.apache), false);
    assertEquals(await exists(paths.nginx), false);
    assertEquals(
      await exists(join(h.unitDir, `turbopanel-php-${id}.service`)),
      false,
    );
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Host-wide ports and engine switches.
// ---------------------------------------------------------------------------

test("a port another environment's vhost holds is refused before anything is written", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx+apache", "fastcgi"));
    const paths = pairedConfPaths(h.layout);
    const lastGood = await Deno.readTextFile(paths.apache);
    const otherConf = (engine: string) =>
      join(h.layout.configDir, engine, "sites", "tp-envb-shop.conf");
    for (
      const [clash, port] of [
        [{ listenPort: 18090, backendPort: 18191 }, 18090],
        // Apache's backend port is a port too: nginx proxies to it.
        [{ listenPort: 18190, backendPort: 18091 }, 18091],
        // A plain site on another environment's backend port.
        [{ engine: "apache" as const, listenPort: 18091 }, 18091],
      ] as const
    ) {
      const before = h.calls.length;
      await assertRejects(
        () =>
          h.apply(
            { ...perSitePhpSite("nginx+apache", "fpm"), ...clash },
            "envb",
          ),
        Error,
        `port ${port} is already used by`,
      );
      // Refused before the engines were installed, staged or reloaded.
      const calls = h.calls.slice(before);
      assertEquals(
        calls.some((c) =>
          c.args.includes("install") || c.args.includes("reload") ||
          c.args.includes("useradd")
        ),
        false,
      );
    }
    assertEquals(await exists(otherConf("nginx")), false);
    assertEquals(await exists(otherConf("apache")), false);
    assertEquals(await Deno.readTextFile(paths.apache), lastGood);
    // The environment that owns the ports redeploys on them.
    await h.apply(perSitePhpSite("nginx+apache", "fpm"));
  } finally {
    await h.cleanup();
  }
});

test("a newly claimed port held by anything else is refused; the site's own ports are not probed", async () => {
  const h = await perSitePhpHarness();
  try {
    h.busyPorts.add(18091);
    await assertRejects(
      () => h.apply(perSitePhpSite("nginx+apache", "fastcgi")),
      Error,
      "port 18091 is already in use on this host",
    );
    assertEquals(await exists(pairedConfPaths(h.layout).nginx), false);

    h.busyPorts.clear();
    await h.apply(perSitePhpSite("nginx+apache", "fastcgi"));
    // Held by the site's own engines now: a redeploy must not trip on them.
    h.busyPorts.add(18090);
    h.busyPorts.add(18091);
    h.probedPorts.length = 0;
    await h.apply(perSitePhpSite("nginx+apache", "fpm"));
    assertEquals(h.probedPorts, []);
  } finally {
    await h.cleanup();
  }
});

test("two sites of one deploy cannot claim the same port", async () => {
  const { layout, cleanup } = await makeTestLayout();
  const mock = createSiteRunMock();
  try {
    await assertRejects(
      () =>
        applySites(layout, "envdup", [
          { ...nginxSite, composeServiceName: "a" },
          { ...nginxSite, composeServiceName: "b" },
        ], { run: mock.run, runPlaybook: () => Promise.resolve() }),
      Error,
      "also claimed by site a",
    );
  } finally {
    await cleanup();
  }
});

test("siteVhostPorts reads directive lines only", () => {
  assertEquals(
    siteVhostPorts(
      [
        ":18080 {",
        "  bind 127.0.0.1 ::1",
        "  env FOO 127.0.0.1:18500",
        "}",
        "listen 127.0.0.1:18081;",
        "  listen [::1]:18081;",
        "  proxy_pass http://127.0.0.1:18082;",
        "Listen 172.17.0.1:18083",
        '  SetEnv TARGET "127.0.0.1:18501"',
        "  fastcgi_param X 127.0.0.1:18502;",
        "  address                   127.0.0.1:18084",
      ].join("\n"),
    ).sort(),
    [18080, 18081, 18082, 18083, 18084],
  );
});

test("nginx+apache -> apache: nginx drops the site's vhost and reloads before Apache binds listenPort", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx+apache", "fastcgi"));
    const paths = pairedConfPaths(h.layout);
    const before = h.calls.length;
    await h.apply(perSitePhpSite("apache", "fastcgi"));
    const calls = h.calls.slice(before);

    assertEquals(await exists(paths.nginx), false);
    const apache = await Deno.readTextFile(paths.apache);
    assertStringIncludes(apache, "Listen 127.0.0.1:18090\n");
    assertEquals(apache.includes("18091"), false);

    const nginxReload = callIndex(
      calls,
      (a) => a.includes("reload") && a.includes("turbopanel-nginx"),
    );
    const apacheTest = callIndex(
      calls,
      (a) => a.some((x) => x.endsWith("/httpd")),
    );
    assert(nginxReload >= 0, "nginx reloaded without the vhost");
    assert(nginxReload < apacheTest, "nginx let go before Apache rolled out");
  } finally {
    await h.cleanup();
  }
});

test("nginx+apache -> nginx: Apache drops the backend vhost, and PHP's socket moves to nginx", async () => {
  const h = await perSitePhpHarness();
  try {
    await h.apply(perSitePhpSite("nginx+apache", "fastcgi"));
    const paths = pairedConfPaths(h.layout);
    const before = h.calls.length;
    await h.apply(perSitePhpSite("nginx", "fastcgi"));
    const calls = h.calls.slice(before);

    assertEquals(await exists(paths.apache), false);
    const nginx = await Deno.readTextFile(paths.nginx);
    assertEquals(nginx.includes("proxy_pass"), false);
    assertStringIncludes(nginx, "fastcgi_pass");
    const apacheReload = callIndex(
      calls,
      (a) => a.includes("reload") && a.includes("turbopanel-apache"),
    );
    const nginxTest = callIndex(
      calls,
      (a) => a.some((x) => x.endsWith("/nginx")),
    );
    assert(
      apacheReload >= 0 && apacheReload < nginxTest,
      "Apache let go first",
    );
    const id = phpRuntimeId("fastcgi");
    const socket = await Deno.readTextFile(
      join(h.unitDir, `turbopanel-php-${id}.socket`),
    );
    assertStringIncludes(socket, "SocketGroup=tpnginx");
    // Same runtime id, new group: the live socket is restarted, or it keeps
    // tpapache and nginx cannot connect.
    const socketRestart = callIndex(
      calls,
      (a) => a.includes("restart") && a.includes(`turbopanel-php-${id}.socket`),
    );
    assert(socketRestart >= 0 && socketRestart < nginxTest, "socket restarted");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unused web engines are removed; one a site or a deploy still needs never is.
// ---------------------------------------------------------------------------

/** Mark `engine` installed the way the roles do (`<vendor>/<engine>/current`). */
async function installEngine(
  layout: LayoutPaths,
  engine: string,
): Promise<void> {
  await Deno.mkdir(join(layout.runtimesDir, engine, "current"), {
    recursive: true,
  });
}

/** `engine_prune` lists the playbook runs asked for, in order. */
function enginePruneRequests(
  captured: ReturnType<typeof capturePlaybooks>,
): unknown[] {
  return captured.extraVars
    .filter((entry) => entry.label.startsWith("engine-prune"))
    .map((entry) => entry.vars.engine_prune);
}

test("applySites removes an installed engine no site uses, and keeps the one it serves", async () => {
  resetPhpSeriesPruneForTests();
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  const applied = capturePlaybooks();
  try {
    await installEngine(layout, "nginx");
    await installEngine(layout, "apache");
    await applySites(layout, "envengA", [nginxSite], {
      run,
      runPlaybook: applied.runPlaybook,
    });
    assertEquals(enginePruneRequests(applied), [["apache"]]);
  } finally {
    resetPhpSeriesPruneForTests();
    await cleanup();
  }
});

test("removeSites removes nginx once its last site goes, unless a deploy holds it", async () => {
  resetPhpSeriesPruneForTests();
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  try {
    await installEngine(layout, "nginx");
    await applySites(layout, "envengB", [nginxSite], {
      run,
      runPlaybook: capturePlaybooks().runPlaybook,
    });
    const release = await holdPruneKeys([engineHoldKey("nginx")]);
    const held = capturePlaybooks();
    await removeSites(layout, "envengB", {
      run,
      runPlaybook: held.runPlaybook,
    });
    assertEquals(enginePruneRequests(held), []);

    release();
    const after = capturePlaybooks();
    await removeSites(layout, "envengB", {
      run,
      runPlaybook: after.runPlaybook,
    });
    assertEquals(enginePruneRequests(after), [["nginx"]]);
  } finally {
    resetPhpSeriesPruneForTests();
    await cleanup();
  }
});

test("an OpenLiteSpeed site directory keeps the engine, and a failed removal never fails the teardown", async () => {
  resetPhpSeriesPruneForTests();
  const { layout, cleanup } = await makeTestLayout();
  const { run } = createSiteRunMock();
  try {
    await installEngine(layout, "openlitespeed");
    const vhost = join(layout.configDir, "openlitespeed", "vhosts", "left");
    await Deno.mkdir(vhost, { recursive: true });
    const kept = capturePlaybooks();
    await removeSites(layout, "envengC", {
      run,
      runPlaybook: kept.runPlaybook,
    });
    assertEquals(enginePruneRequests(kept), []);

    await Deno.remove(vhost);
    await removeSites(layout, "envengC", {
      run,
      runPlaybook: () => Promise.reject(new Error("unit busy")),
    });
    // The failure kept the engine and locked nothing: the next teardown asks again.
    const retry = capturePlaybooks();
    await removeSites(layout, "envengC", {
      run,
      runPlaybook: retry.runPlaybook,
    });
    assertEquals(enginePruneRequests(retry), [["openlitespeed"]]);
  } finally {
    resetPhpSeriesPruneForTests();
    await cleanup();
  }
});
