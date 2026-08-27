import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { resolveLayout } from "../../paths/layout.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { RunFn, RunResult } from "../ensure-principal.ts";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeployPayload,
} from "../../instance/commands/contracts.ts";
import {
  applyNativeAppLifecycle,
  applyNativeAppServices,
  listEnvironmentNativeAppServiceIds,
  nativeAppBindingsFromPayload,
  nativeAppNodeVersions,
  removeNativeAppServices,
} from "./apply-native-apps.ts";
import {
  DEFAULT_NATIVE_APP_NODE_VERSION,
  nativeAppConfigDir,
  nativeAppNodeBinary,
  nativeAppRuntimeGroup,
  nativeAppUnitName,
  nativeAppUnitPath,
  principalSliceContent,
  principalSlicePath,
} from "./unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

type TestHost = {
  layout: LayoutPaths;
  unitDir: string;
  cleanup: () => Promise<void>;
};

async function makeTestHost(): Promise<TestHost> {
  const root = await Deno.makeTempDir({ prefix: "tp-native-app-io-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: join(root, "state"),
      TURBOPANEL_CONFIG_DIR: join(root, "config"),
      TURBOPANEL_LOG_DIR: join(root, "log"),
      TURBOPANEL_RUN_DIR: join(root, "run"),
      TURBOPANEL_RUNTIMES_DIR: join(root, "runtimes"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: join(root, "srv", "users"),
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  const unitDir = join(root, "systemd");
  await Deno.mkdir(unitDir, { recursive: true });
  return {
    layout,
    unitDir,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

function ok(): RunResult {
  return { success: true, stdout: "", stderr: "" };
}

function fail(stderr: string): RunResult {
  return { success: false, stdout: "", stderr };
}

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

type RunMock = {
  run: RunFn;
  calls: Array<{ command: string; args: string[] }>;
  /** Units `is-active` should report as already running. */
  activeUnits: Set<string>;
  systemctl: (verb: string) => Array<string>;
};

/**
 * Host-free sudo seam. `cmp -s` compares for real — the install-only-on-change
 * discipline is exactly what these tests are checking, so a mock that always
 * reported "differs" would make every assertion vacuous.
 */
function createRunMock(): RunMock {
  const calls: Array<{ command: string; args: string[] }> = [];
  const activeUnits = new Set<string>();
  const run: RunFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== "sudo") return ok();

    if (args.includes("cmp")) {
      const right = args.at(-1);
      const left = args.at(-2);
      if (typeof left !== "string" || typeof right !== "string") {
        throw new TypeError("expected cmp left right");
      }
      return (await filesMatch(left, right)) ? ok() : fail("files differ");
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
      if (typeof path !== "string") throw new TypeError("expected rm path");
      try {
        await Deno.remove(path, { recursive: true });
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      return ok();
    }

    if (args.includes("is-active")) {
      const unit = args.at(-1);
      return typeof unit === "string" && activeUnits.has(unit)
        ? ok()
        : fail("inactive");
    }

    return ok();
  };

  return {
    run,
    calls,
    activeUnits,
    systemctl: (verb) =>
      calls
        .filter((call) =>
          call.args.includes("systemctl") && call.args.includes(verb)
        )
        .map((call) => call.args.at(-1) ?? ""),
  };
}

/** Indices into {@link RunMock.calls} matching a predicate — ordering evidence. */
function callIndexes(
  mock: RunMock,
  match: (args: string[]) => boolean,
): number[] {
  const indexes: number[] = [];
  mock.calls.forEach((call, index) => {
    if (match(call.args)) indexes.push(index);
  });
  return indexes;
}

const ENVIRONMENT_ID = "env-1";
const USERNAME = "tpproj1";

function makeApp(
  overrides: Partial<EnvironmentDeployNativeAppService> = {},
): EnvironmentDeployNativeAppService {
  return {
    composeServiceName: "web",
    serviceId: "svc-web",
    listenPort: 18100,
    framework: "auto",
    ...overrides,
  };
}

function bindings(
  overrides: Partial<
    { startCommand: string; previousReleaseId: string | null }
  > = {},
) {
  return new Map([[
    "web",
    {
      username: USERNAME,
      previousReleaseId: overrides.previousReleaseId ?? null,
      ...(overrides.startCommand === undefined
        ? {}
        : { startCommand: overrides.startCommand }),
    },
  ]]);
}

function applyOpts(host: TestHost, mock: RunMock, healthy = true) {
  return {
    bindings: bindings(),
    run: mock.run,
    runPlaybook: () => Promise.resolve(),
    probe: () => Promise.resolve(healthy),
    sleep: () => Promise.resolve(),
    systemdUnitDir: host.unitDir,
  };
}

test("applyNativeAppServices installs the unit, reloads, and enables it", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, mock),
    );
    assertEquals(result.applied, ["web"]);

    const unitPath = nativeAppUnitPath("svc-web", host.unitDir);
    const unit = await Deno.readTextFile(unitPath);
    assertStringIncludes(unit, `User=${USERNAME}`);
    assertStringIncludes(unit, `Group=${USERNAME}-grp`);
    assertStringIncludes(unit, `Slice=turbopanel-${USERNAME}.slice`);
    assertStringIncludes(unit, "Environment=PORT=18100");
    assertStringIncludes(unit, "/sites/svc-web/current");
    // Hardening is the whole justification for running containerless.
    assertStringIncludes(unit, "NoNewPrivileges=yes");
    assertStringIncludes(unit, "ProtectSystem=strict");
    assertStringIncludes(unit, "CapabilityBoundingSet=");
    assertStringIncludes(unit, "/sites/svc-web/shared");

    assertEquals(mock.systemctl("daemon-reload").length > 0, true);
    assertEquals(mock.systemctl("enable"), [nativeAppUnitName("svc-web")]);
  } finally {
    await host.cleanup();
  }
});

test("a second apply with identical content installs nothing and does not reload", async () => {
  const host = await makeTestHost();
  const first = createRunMock();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, first),
    );

    const second = createRunMock();
    second.activeUnits.add(nativeAppUnitName("svc-web"));
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, second),
    );

    // Byte-identical unit + slice ⇒ no install, no daemon-reload. Only the
    // restart that picks up the newly promoted release.
    assertEquals(
      second.calls.filter((call) => call.args.includes("install")).length,
      0,
    );
    assertEquals(second.systemctl("daemon-reload").length, 0);
    assertEquals(second.systemctl("restart"), [nativeAppUnitName("svc-web")]);
  } finally {
    await host.cleanup();
  }
});

test("a changed listen port reinstalls the unit and reloads", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, createRunMock()),
    );

    const mock = createRunMock();
    mock.activeUnits.add(nativeAppUnitName("svc-web"));
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp({ listenPort: 18201 })],
      applyOpts(host, mock),
    );

    assertEquals(mock.systemctl("daemon-reload").length, 1);
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("svc-web", host.unitDir),
    );
    assertStringIncludes(unit, "Environment=PORT=18201");
  } finally {
    await host.cleanup();
  }
});

test("the principal slice carries the account ceiling", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [
        makeApp({
          resources: { cpus: 1.5, memoryBytes: 512 * 1024 * 1024 },
          accountLimits: {
            cpus: 4,
            memoryBytes: 2048 * 1024 * 1024,
            tasksMax: 512,
          },
        }),
      ],
      applyOpts(host, mock),
    );

    const slice = await Deno.readTextFile(
      principalSlicePath(USERNAME, host.unitDir),
    );
    assertStringIncludes(slice, "CPUQuota=400%");
    assertStringIncludes(slice, `MemoryMax=${2048 * 1024 * 1024}`);
    assertStringIncludes(slice, "TasksMax=512");

    // The per-app unit stays under it rather than beside it.
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("svc-web", host.unitDir),
    );
    assertStringIncludes(unit, "CPUQuota=150%");
    assertStringIncludes(unit, `MemoryMax=${512 * 1024 * 1024}`);
    assertStringIncludes(unit, `Slice=turbopanel-${USERNAME}.slice`);
  } finally {
    await host.cleanup();
  }
});

test("a failed health probe rolls current back to the previous release", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const siteDir = join(
    host.layout.principalHomeRoot,
    USERNAME,
    "sites",
    "svc-web",
  );
  await Deno.mkdir(join(siteDir, "releases", "rel-old"), { recursive: true });
  await Deno.mkdir(join(siteDir, "releases", "rel-new"), { recursive: true });
  await Deno.symlink(join("releases", "rel-new"), join(siteDir, "current"));

  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          bindings: bindings({ previousReleaseId: "rel-old" }),
        }),
      Error,
    );
    assertStringIncludes(error.message, "did not answer on 127.0.0.1:18100");
    assertStringIncludes(error.message, "rolled back to release rel-old");

    assertEquals(
      await Deno.readLink(join(siteDir, "current")),
      join("releases", "rel-old"),
    );
    assertEquals(
      mock.systemctl("restart").at(-1),
      nativeAppUnitName("svc-web"),
    );
  } finally {
    await host.cleanup();
  }
});

test("a failed health probe with no previous release says so instead of rolling back", async () => {
  const host = await makeTestHost();
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp()],
          applyOpts(host, createRunMock(), false),
        ),
      Error,
    );
    assertStringIncludes(error.message, "no previous release to roll back to");
  } finally {
    await host.cleanup();
  }
});

test("lifecycle and removal act on this environment's units only", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, createRunMock()),
    );
    await applyNativeAppServices(
      host.layout,
      "env-2",
      [makeApp({ composeServiceName: "web", serviceId: "svc-other" })],
      applyOpts(host, createRunMock()),
    );

    const lifecycleMock = createRunMock();
    const stopped = await applyNativeAppLifecycle(
      host.layout,
      ENVIRONMENT_ID,
      "stop",
      { run: lifecycleMock.run },
    );
    assertEquals(stopped, [nativeAppUnitName("svc-web")]);

    const removeMock = createRunMock();
    const removed = await removeNativeAppServices(host.layout, ENVIRONMENT_ID, {
      run: removeMock.run,
      systemdUnitDir: host.unitDir,
    });
    assertEquals(removed, 1);
    assertEquals(removeMock.systemctl("disable"), [
      nativeAppUnitName("svc-web"),
    ]);

    // The other environment's unit is untouched, and the shared slice survives
    // a teardown because other environments of the same account still use it.
    await Deno.stat(nativeAppUnitPath("svc-other", host.unitDir));
    await Deno.stat(principalSlicePath(USERNAME, host.unitDir));
    await assertRejects(
      () => Deno.stat(nativeAppUnitPath("svc-web", host.unitDir)),
      Deno.errors.NotFound,
    );
  } finally {
    await host.cleanup();
  }
});

test("an explicit startCommand replaces the default ExecStart", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...applyOpts(host, createRunMock()),
      bindings: bindings({ startCommand: "node dist/main.js --port $PORT" }),
    });
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("svc-web", host.unitDir),
    );
    assertStringIncludes(
      unit,
      "ExecStart=/bin/sh -c 'node dist/main.js --port $PORT'",
    );
  } finally {
    await host.cleanup();
  }
});

test("nativeAppBindingsFromPayload skips sources with no owning principal", () => {
  const payload = {
    environmentId: ENVIRONMENT_ID,
    projectId: "p1",
    organizationId: "o1",
    projectName: "proj",
    composeFiles: [],
    hostings: [],
    sourceMaterial: [
      {
        sourceId: "s1",
        composeServiceName: "web",
        provider: "github",
        cloneUrl: "https://example.test/repo.git",
        ref: "main",
        commitSha: "abc",
        releaseId: "rel-new",
        principal: { principalId: "pr1", username: USERNAME },
        build: { kind: "native", startCommand: "node server.js" },
      },
      {
        sourceId: "s2",
        composeServiceName: "worker",
        provider: "github",
        cloneUrl: "https://example.test/repo.git",
        ref: "main",
        commitSha: "abc",
        releaseId: "rel-new-2",
        build: { kind: "native" },
      },
    ],
  } as unknown as EnvironmentDeployPayload;

  const resolved = nativeAppBindingsFromPayload(
    payload,
    new Map([["web", "rel-old"]]),
  );
  assertEquals(resolved.size, 1);
  assertEquals(resolved.get("web"), {
    username: USERNAME,
    previousReleaseId: "rel-old",
    startCommand: "node server.js",
  });
});

test("principalSliceContent still emits a slice with no limits", () => {
  const slice = principalSliceContent({ username: USERNAME });
  assertStringIncludes(
    slice,
    `Description=TurboPanel tenant slice for ${USERNAME}`,
  );
  assertStringIncludes(slice, "[Slice]");
  assertEquals(slice.includes("CPUQuota="), false);
});

// ---------------------------------------------------------------------------
// Sequencing: every changed file is installed *before* the single
// `daemon-reload`, so a unit rewritten in the same apply as a slice is never
// started from the definition systemd loaded before this deploy.
// ---------------------------------------------------------------------------

test("a slice and a unit changing together still reload after the unit is installed", async () => {
  const host = await makeTestHost();
  try {
    // First deploy: writes both files and enables the unit.
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp({ accountLimits: { cpus: 2 } })],
      applyOpts(host, createRunMock()),
    );

    // Second deploy changes the account ceiling *and* the unit in one apply.
    const mock = createRunMock();
    mock.activeUnits.add(nativeAppUnitName("svc-web"));
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp({ listenPort: 18205, accountLimits: { cpus: 8 } })],
      applyOpts(host, mock),
    );

    const installs = callIndexes(mock, (args) => args.includes("install"));
    const reloads = callIndexes(
      mock,
      (args) => args.includes("systemctl") && args.includes("daemon-reload"),
    );
    const restarts = callIndexes(
      mock,
      (args) => args.includes("systemctl") && args.includes("restart"),
    );

    // Both files were rewritten, and one reload covers both.
    assertEquals(installs.length, 2);
    assertEquals(reloads.length, 1);

    // The reload is what makes the restart meaningful: it must come after the
    // last install and before the restart, or systemd restarts the app from
    // the stale unit contents.
    assertEquals(reloads[0]! > installs.at(-1)!, true);
    assertEquals(restarts.length, 1);
    assertEquals(restarts[0]! > reloads[0]!, true);

    const slice = await Deno.readTextFile(
      principalSlicePath(USERNAME, host.unitDir),
    );
    assertStringIncludes(slice, "CPUQuota=800%");
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("svc-web", host.unitDir),
    );
    assertStringIncludes(unit, "Environment=PORT=18205");
  } finally {
    await host.cleanup();
  }
});

test("a slice-only change still reloads before the unit is restarted", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp({ accountLimits: { cpus: 2 } })],
      applyOpts(host, createRunMock()),
    );

    const mock = createRunMock();
    mock.activeUnits.add(nativeAppUnitName("svc-web"));
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      // Same unit, different account ceiling.
      [makeApp({ accountLimits: { cpus: 6 } })],
      applyOpts(host, mock),
    );

    const installs = callIndexes(mock, (args) => args.includes("install"));
    const reloads = callIndexes(
      mock,
      (args) => args.includes("systemctl") && args.includes("daemon-reload"),
    );
    assertEquals(installs.length, 1);
    assertEquals(reloads.length, 1);
    assertEquals(reloads[0]! > installs[0]!, true);
  } finally {
    await host.cleanup();
  }
});

// ---------------------------------------------------------------------------
// `nodeVersion` is a runtime contract, not a decoration: a different pin has to
// produce a different vendored binary *and* a different playbook input.
// ---------------------------------------------------------------------------

/** Captures what the vendoring playbook was actually invoked with. */
function createPlaybookMock() {
  const calls: Array<{ path: string; label: string; extraArgs?: string[] }> =
    [];
  return {
    calls,
    runPlaybook: (path: string, label: string, extraArgs?: string[]) => {
      calls.push({
        path,
        label,
        ...(extraArgs === undefined ? {} : { extraArgs }),
      });
      return Promise.resolve();
    },
  };
}

test("different nodeVersion pins select different vendored runtimes", async () => {
  const host = await makeTestHost();
  const playbook = createPlaybookMock();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [
        makeApp({ nodeVersion: "22" }),
        makeApp({
          composeServiceName: "api",
          serviceId: "svc-api",
          listenPort: 18101,
          nodeVersion: "24.17.0",
        }),
      ],
      {
        ...applyOpts(host, createRunMock()),
        runPlaybook: playbook.runPlaybook,
        bindings: new Map([
          ["web", { username: USERNAME, previousReleaseId: null }],
          ["api", { username: USERNAME, previousReleaseId: null }],
        ]),
      },
    );

    const web = await Deno.readTextFile(
      nativeAppUnitPath("svc-web", host.unitDir),
    );
    const api = await Deno.readTextFile(
      nativeAppUnitPath("svc-api", host.unitDir),
    );
    assertStringIncludes(
      web,
      `ExecStart=${nativeAppNodeBinary(host.layout, "22")} server.js`,
    );
    assertStringIncludes(
      api,
      `ExecStart=${nativeAppNodeBinary(host.layout, "24.17.0")} server.js`,
    );
    // Not the same binary — the whole point of the pin.
    assertEquals(
      nativeAppNodeBinary(host.layout, "22") ===
        nativeAppNodeBinary(host.layout, "24.17.0"),
      false,
    );

    // Both series reach the vendoring role, sorted and deduplicated.
    assertEquals(playbook.calls.length, 1);
    const extraArgs = playbook.calls[0]!.extraArgs ?? [];
    assertEquals(extraArgs[0], "-e");
    assertEquals(JSON.parse(extraArgs[1] ?? "{}"), {
      node_app_versions: ["22", "24.17.0"],
    });
  } finally {
    await host.cleanup();
  }
});

test("an app with no nodeVersion vendors and runs the default series", async () => {
  const host = await makeTestHost();
  const playbook = createPlaybookMock();
  try {
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...applyOpts(host, createRunMock()),
      runPlaybook: playbook.runPlaybook,
    });

    const unit = await Deno.readTextFile(
      nativeAppUnitPath("svc-web", host.unitDir),
    );
    assertStringIncludes(
      unit,
      `ExecStart=${
        nativeAppNodeBinary(host.layout, DEFAULT_NATIVE_APP_NODE_VERSION)
      } server.js`,
    );
    assertEquals(
      JSON.parse(playbook.calls[0]?.extraArgs?.[1] ?? "{}"),
      { node_app_versions: [DEFAULT_NATIVE_APP_NODE_VERSION] },
    );
  } finally {
    await host.cleanup();
  }
});

/** `usermod -aG` calls the apply made through the sudo seam. */
function usermodCalls(mock: RunMock): string[][] {
  return mock.calls
    .filter((call) => call.args.includes("usermod"))
    .map((call) => call.args);
}

test("native apply no longer grants runtime groups itself", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, mock),
    );

    // Entitlement moved to `ensurePrincipalManagedGroups`, which runs during
    // principal materialization — before releases and before any unit is
    // installed. Keeping a second grant here would be a second source of truth
    // that can only ever add, never revoke.
    assertEquals(usermodCalls(mock), []);
  } finally {
    await host.cleanup();
  }
});

test("nativeAppRuntimeGroup resolves the per-series entitlement group", () => {
  // Per series, not one group for the whole tree: granting Node 24 must not
  // also grant Node 22.
  assertEquals(nativeAppRuntimeGroup("24"), "tpnode24");
  assertEquals(nativeAppRuntimeGroup("24.17.0"), "tpnode24");
  assertEquals(nativeAppRuntimeGroup("22"), "tpnode22");
  // An unknown series has no group rather than an invented name — a name that
  // does not exist would fail `usermod` far from the cause.
  assertEquals(nativeAppRuntimeGroup("18"), undefined);
});

test("applyNativeAppServices with an empty list is a no-op", async () => {
  const host = await makeTestHost();
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [],
      applyOpts(host, createRunMock()),
    );
    assertEquals(result, { applied: [] });
  } finally {
    await host.cleanup();
  }
});

test("applyNativeAppServices skips apps without a principal binding", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      {
        ...applyOpts(host, mock),
        bindings: new Map(),
      },
    );
    assertEquals(result, { applied: [] });
    assertEquals(mock.systemctl("enable").length, 0);
  } finally {
    await host.cleanup();
  }
});

test("applyNativeAppServices fails when daemon-reload fails after a unit change", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalRun = mock.run;
  mock.run = async (command, args) => {
    if (args.includes("daemon-reload")) {
      return fail("reload refused");
    }
    return await originalRun(command, args);
  };
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp()],
          applyOpts(host, mock),
        ),
      Error,
    );
    assertStringIncludes(error.message, "reload refused");
  } finally {
    await host.cleanup();
  }
});

test("listEnvironmentNativeAppServiceIds reads staged unit filenames", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [
        makeApp(),
        makeApp({
          composeServiceName: "api",
          serviceId: "svc-api",
          listenPort: 18101,
        }),
      ],
      {
        ...applyOpts(host, createRunMock()),
        bindings: new Map([
          ["web", { username: USERNAME, previousReleaseId: null }],
          ["api", { username: USERNAME, previousReleaseId: null }],
        ]),
      },
    );
    const ids = await listEnvironmentNativeAppServiceIds(
      host.layout,
      ENVIRONMENT_ID,
    );
    assertEquals(ids, ["svc-api", "svc-web"]);
    assertEquals(
      await listEnvironmentNativeAppServiceIds(host.layout, "missing-env"),
      [],
    );
  } finally {
    await host.cleanup();
  }
});

test("applyNativeAppLifecycle continues when one unit refuses the action", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [
        makeApp(),
        makeApp({
          composeServiceName: "api",
          serviceId: "svc-api",
          listenPort: 18101,
        }),
      ],
      {
        ...applyOpts(host, createRunMock()),
        bindings: new Map([
          ["web", { username: USERNAME, previousReleaseId: null }],
          ["api", { username: USERNAME, previousReleaseId: null }],
        ]),
      },
    );

    const mock = createRunMock();
    const originalRun = mock.run;
    mock.run = async (command, args) => {
      if (
        args.includes("stop") &&
        args.includes(nativeAppUnitName("svc-web"))
      ) {
        return fail("unit busy");
      }
      return await originalRun(command, args);
    };
    const touched = await applyNativeAppLifecycle(
      host.layout,
      ENVIRONMENT_ID,
      "stop",
      { run: mock.run },
    );
    assertEquals(touched, [nativeAppUnitName("svc-api")]);
  } finally {
    await host.cleanup();
  }
});

test("removeNativeAppServices is a no-op when nothing is staged", async () => {
  const host = await makeTestHost();
  try {
    assertEquals(
      await removeNativeAppServices(host.layout, ENVIRONMENT_ID, {
        run: createRunMock().run,
        systemdUnitDir: host.unitDir,
      }),
      0,
    );
  } finally {
    await host.cleanup();
  }
});

test("applyNativeAppServices fails when unit install is refused", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalRun = mock.run;
  mock.run = async (command, args) => {
    if (args.includes("install") && String(args.at(-1)).endsWith(".service")) {
      return fail("install refused");
    }
    return await originalRun(command, args);
  };
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp()],
          applyOpts(host, mock),
        ),
      Error,
    );
    assertStringIncludes(error.message, "install refused");
  } finally {
    await host.cleanup();
  }
});

test("applyNativeAppServices fails when enable --now is refused", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalRun = mock.run;
  mock.run = async (command, args) => {
    if (args.includes("enable")) return fail("enable refused");
    return await originalRun(command, args);
  };
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp()],
          applyOpts(host, mock),
        ),
      Error,
    );
    assertStringIncludes(error.message, "enable refused");
  } finally {
    await host.cleanup();
  }
});

test("removeNativeAppServices continues when disable or unit removal fails", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [
        makeApp(),
        makeApp({
          composeServiceName: "api",
          serviceId: "svc-api",
          listenPort: 18101,
        }),
      ],
      {
        ...applyOpts(host, createRunMock()),
        bindings: new Map([
          ["web", { username: USERNAME, previousReleaseId: null }],
          ["api", { username: USERNAME, previousReleaseId: null }],
        ]),
      },
    );

    const mock = createRunMock();
    const originalRun = mock.run;
    mock.run = async (command, args) => {
      if (
        args.includes("disable") &&
        args.includes(nativeAppUnitName("svc-web"))
      ) {
        return fail("disable refused");
      }
      if (
        args.includes("rm") &&
        String(args.at(-1)).includes(nativeAppUnitName("svc-api"))
      ) {
        return fail("rm refused");
      }
      return await originalRun(command, args);
    };
    const removed = await removeNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      { run: mock.run, systemdUnitDir: host.unitDir },
    );
    // disable failure is warned and removal still proceeds; rm failure skips
    // that unit. web is removed, api is not.
    assertEquals(removed, 1);
  } finally {
    await host.cleanup();
  }
});

test("removeNativeAppServices warns when daemon-reload fails after teardown", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, createRunMock()),
    );
    const mock = createRunMock();
    const originalRun = mock.run;
    mock.run = async (command, args) => {
      if (args.includes("daemon-reload")) return fail("reload refused");
      return await originalRun(command, args);
    };
    assertEquals(
      await removeNativeAppServices(host.layout, ENVIRONMENT_ID, {
        run: mock.run,
        systemdUnitDir: host.unitDir,
      }),
      1,
    );
  } finally {
    await host.cleanup();
  }
});

test("nativeAppNodeVersions deduplicates and sorts series pins", () => {
  assertEquals(DEFAULT_NATIVE_APP_NODE_VERSION, "24");
  assertEquals(
    nativeAppNodeVersions([
      makeApp({ nodeVersion: "24" }),
      makeApp({
        composeServiceName: "api",
        serviceId: "svc-api",
        listenPort: 18101,
        nodeVersion: "22",
      }),
      makeApp({
        composeServiceName: "worker",
        serviceId: "svc-worker",
        listenPort: 18102,
        nodeVersion: "24",
      }),
      makeApp({
        composeServiceName: "default",
        serviceId: "svc-default",
        listenPort: 18103,
      }),
    ]),
    ["22", "24"],
  );
});

function stubDenoCommand(run: RunFn): () => void {
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

test("applyNativeAppServices uses runDefault when run is omitted", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const restore = stubDenoCommand(mock.run);
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      {
        bindings: bindings(),
        runPlaybook: () => Promise.resolve(),
        probe: () => Promise.resolve(true),
        sleep: () => Promise.resolve(),
        systemdUnitDir: host.unitDir,
      },
    );
    assertEquals(result.applied, ["web"]);
  } finally {
    restore();
    await host.cleanup();
  }
});

test("applyNativeAppServices treats a missing Node playbook as already installed", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalStat = Deno.stat.bind(Deno);
  Deno.stat = ((path: string | URL) => {
    if (String(path).includes("node-app-runtime")) {
      return Promise.reject(new Deno.errors.NotFound("playbook"));
    }
    return originalStat(path);
  }) as typeof Deno.stat;
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      {
        bindings: bindings(),
        run: mock.run,
        probe: () => Promise.resolve(true),
        sleep: () => Promise.resolve(),
        systemdUnitDir: host.unitDir,
      },
    );
    assertEquals(result.applied, ["web"]);
  } finally {
    Deno.stat = originalStat;
    await host.cleanup();
  }
});

test("applyNativeAppServices rethrows a non-NotFound playbook stat error", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalStat = Deno.stat.bind(Deno);
  Deno.stat = ((path: string | URL) => {
    if (String(path).includes("node-app-runtime")) {
      return Promise.reject(new Deno.errors.PermissionDenied("playbook"));
    }
    return originalStat(path);
  }) as typeof Deno.stat;
  try {
    await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp()],
          {
            bindings: bindings(),
            run: mock.run,
            probe: () => Promise.resolve(true),
            sleep: () => Promise.resolve(),
            systemdUnitDir: host.unitDir,
          },
        ),
      Deno.errors.PermissionDenied,
      "playbook",
    );
  } finally {
    Deno.stat = originalStat;
    await host.cleanup();
  }
});

test("applyNativeAppServices rejects an unsafe serviceId", async () => {
  const host = await makeTestHost();
  try {
    await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp({ serviceId: "svc/web" })],
          applyOpts(host, createRunMock()),
        ),
      Error,
      "unsupported characters",
    );
  } finally {
    await host.cleanup();
  }
});

test("probeDefault treats any completed HTTP response as healthy", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("missing", { status: 404 }));
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      {
        bindings: bindings(),
        run: mock.run,
        runPlaybook: () => Promise.resolve(),
        sleep: () => Promise.resolve(),
        systemdUnitDir: host.unitDir,
      },
    );
    assertEquals(result.applied, ["web"]);
  } finally {
    globalThis.fetch = originalFetch;
    await host.cleanup();
  }
});

test("probeDefault returns false when fetch fails and rollback catch does not mask the health error", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalFetch = globalThis.fetch;
  const originalSymlink = Deno.symlink.bind(Deno);
  globalThis.fetch = () => Promise.reject(new TypeError("connection refused"));
  Deno.symlink =
    (() => Promise.reject(new Error("symlink refused"))) as typeof Deno.symlink;
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp()],
          {
            bindings: bindings({ previousReleaseId: "rel-old" }),
            run: mock.run,
            runPlaybook: () => Promise.resolve(),
            sleep: () => Promise.resolve(),
            systemdUnitDir: host.unitDir,
          },
        ),
      Error,
    );
    assertStringIncludes(error.message, "did not answer on 127.0.0.1:18100");
    assertStringIncludes(error.message, "no previous release to roll back to");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.symlink = originalSymlink;
    await host.cleanup();
  }
});

test("listEnvironmentNativeAppServiceIds skips non-files and rethrows a non-NotFound readDir", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, createRunMock()),
    );
    const dir = nativeAppConfigDir(host.layout);
    await Deno.mkdir(join(dir, "tp-env-1-not-a-file"));
    await Deno.writeTextFile(join(dir, "tp-env-1-notes.txt"), "skip");
    await Deno.writeTextFile(join(dir, "other-svc-web.service"), "skip");
    assertEquals(
      await listEnvironmentNativeAppServiceIds(host.layout, ENVIRONMENT_ID),
      ["svc-web"],
    );

    const originalReadDir = Deno.readDir.bind(Deno);
    Deno.readDir = ((path: string | URL) => {
      if (String(path) === dir) {
        // deno-lint-ignore require-yield
        return (async function* () {
          throw new Deno.errors.PermissionDenied("units dir");
        })();
      }
      return originalReadDir(path);
    }) as typeof Deno.readDir;
    try {
      await assertRejects(
        () => listEnvironmentNativeAppServiceIds(host.layout, ENVIRONMENT_ID),
        Deno.errors.PermissionDenied,
        "units dir",
      );
    } finally {
      Deno.readDir = originalReadDir;
    }
  } finally {
    await host.cleanup();
  }
});

test("applyNativeAppServices retries the health probe after the injected sleep", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  let probes = 0;
  let sleeps = 0;
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      {
        ...applyOpts(host, mock),
        probe: () => {
          probes += 1;
          return Promise.resolve(probes >= 2);
        },
        sleep: () => {
          sleeps += 1;
          return Promise.resolve();
        },
      },
    );
    assertEquals(result.applied, ["web"]);
    assertEquals(probes, 2);
    assertEquals(sleeps, 1);
  } finally {
    await host.cleanup();
  }
});

test("a failed rollback restart does not claim the previous release was restored", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const siteDir = join(
    host.layout.principalHomeRoot,
    USERNAME,
    "sites",
    "svc-web",
  );
  await Deno.mkdir(join(siteDir, "releases", "rel-old"), { recursive: true });
  await Deno.mkdir(join(siteDir, "releases", "rel-new"), { recursive: true });
  await Deno.symlink(join("releases", "rel-new"), join(siteDir, "current"));
  const run: typeof mock.run = async (command, args) => {
    if (args.includes("systemctl") && args.includes("restart")) {
      return fail("restart refused");
    }
    return await mock.run(command, args);
  };
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          run,
          bindings: bindings({ previousReleaseId: "rel-old" }),
        }),
      Error,
    );
    assertStringIncludes(error.message, "did not answer on 127.0.0.1:18100");
    assertStringIncludes(error.message, "no previous release to roll back to");
    assertEquals(
      await Deno.readLink(join(siteDir, "current")),
      join("releases", "rel-old"),
    );
  } finally {
    await host.cleanup();
  }
});

test("removeNativeAppServices swallows a leftover staged file that cannot be unlinked", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalRemove = Deno.remove.bind(Deno);
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, mock),
    );
    const staged = join(
      nativeAppConfigDir(host.layout),
      `tp-${ENVIRONMENT_ID}-svc-web.service`,
    );
    Deno.remove = ((path: string | URL, options?: Deno.RemoveOptions) => {
      if (String(path) === staged) {
        return Promise.reject(new Deno.errors.PermissionDenied("staged"));
      }
      return originalRemove(path, options);
    }) as typeof Deno.remove;
    assertEquals(
      await removeNativeAppServices(host.layout, ENVIRONMENT_ID, {
        run: mock.run,
        systemdUnitDir: host.unitDir,
      }),
      1,
    );
  } finally {
    Deno.remove = originalRemove;
    await host.cleanup();
  }
});
