import { journalDetail } from "./apply-native-apps.ts";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { resolveLayout } from "../../paths/layout.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { RunFn, RunResult } from "../ensure-principal.ts";
import { resolveDaemonReleasePaths } from "../release/release-layout.ts";
import { writeReleaseManifest } from "../release/deployment-json.ts";
import {
  HEALTHY_RECORD_MARKER,
  readHealthyRelease,
} from "../release/release-health.ts";
import type { NativeAppStart } from "./start-entry.ts";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeployPayload,
} from "../../contracts/commands-contracts.ts";
import {
  applyNativeAppLifecycle,
  applyNativeAppServices,
  ensureNativeAppRuntime,
  listEnvironmentNativeAppServiceIds,
  nativeAppBindingsFromPayload,
  nativeAppNodeVersions,
  pickPortDefault,
  removeNativeAppServices,
} from "./apply-native-apps.ts";
import {
  nativeAppConfigDir,
  nativeAppEnvPath,
  nativeAppEnvStagePath,
  nativeAppNodeBinary,
  nativeAppUnitName,
  nativeAppUnitPath,
  NEWEST_NATIVE_APP_NODE_VERSION,
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
  /** What `tp-host app-env-install` holds as root's copies, by service id. */
  envCopies: Map<string, string>;
};

/**
 * Host-free sudo seam. `cmp -s` compares for real — the install-only-on-change
 * discipline is exactly what these tests are checking, so a mock that always
 * reported "differs" would make every assertion vacuous.
 */
function createRunMock(layout?: LayoutPaths): RunMock {
  const calls: Array<{ command: string; args: string[] }> = [];
  const activeUnits = new Set<string>();
  const envCopies = new Map<string, string>();
  const run: RunFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== "sudo") return ok();

    // tp-host's two variables verbs: a service id, nothing else.
    if (args.includes("app-env-install")) {
      const id = args.at(-1) ?? "";
      if (layout === undefined) throw new TypeError("mock needs a layout");
      envCopies.set(
        id,
        await Deno.readTextFile(nativeAppEnvStagePath(layout, id)),
      );
      return ok();
    }
    if (args.includes("app-env-remove")) {
      envCopies.delete(args.at(-1) ?? "");
      return ok();
    }

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

    if (args.includes("is-failed")) {
      return fail("not-failed");
    }

    return ok();
  };

  return {
    run,
    calls,
    activeUnits,
    envCopies,
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
const USERNAME = "proj1";

/** The service folder the control plane plans for an app. */
const folderFor = (slug: string) => ({
  owner: USERNAME,
  scope: "production",
  slug,
});

function makeApp(
  overrides: Partial<EnvironmentDeployNativeAppService> = {},
): EnvironmentDeployNativeAppService {
  return {
    composeServiceName: "web",
    serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
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
      folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
      previousReleaseId: overrides.previousReleaseId ?? null,
      ...(overrides.startCommand === undefined
        ? {}
        : { startCommand: overrides.startCommand }),
    },
  ]]);
}

/**
 * Give `releaseId` a finalized daemon release record, marked healthy unless
 * `healthy` is false — what a release that once answered on this host has.
 */
async function recordRelease(
  layout: LayoutPaths,
  releaseId: string,
  opts: {
    healthy?: boolean;
    nativeStart?: NativeAppStart;
    startCommand?: string;
    startupFile?: string;
    runtime?: "node" | "deno";
  } = {},
): Promise<string> {
  const { releaseDir } = resolveDaemonReleasePaths(layout, {
    serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
    releaseId,
  });
  await Deno.mkdir(releaseDir, { recursive: true });
  await writeReleaseManifest(releaseDir, {
    version: 1,
    serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
    composeServiceName: "web",
    releaseId,
    sourceId: "s1",
    commitSha: "abc",
    ref: "main",
    promotedAt: "2026-10-06T00:00:00.000Z",
    ...(opts.nativeStart === undefined
      ? {}
      : { nativeStart: opts.nativeStart }),
    ...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
    ...(opts.startCommand === undefined
      ? {}
      : { startCommand: opts.startCommand }),
    ...(opts.startupFile === undefined
      ? {}
      : { startupFile: opts.startupFile }),
  });
  if (opts.healthy !== false) {
    await Deno.writeTextFile(join(releaseDir, HEALTHY_RECORD_MARKER), "");
  }
  return releaseDir;
}

/** The spare port tests hand a check copy. */
const CHECK_PORT = 41234;
const SERVICE_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70";
const OWN_UNIT = nativeAppUnitName(SERVICE_ID);
/** The new release's copy beside the one serving. */
const CHECK_UNIT = nativeAppUnitName(`${SERVICE_ID}-new`);

function applyOpts(host: TestHost, mock: RunMock, healthy = true) {
  return {
    bindings: bindings(),
    run: mock.run,
    runPlaybook: () => Promise.resolve(),
    probe: () => Promise.resolve(healthy),
    sleep: () => Promise.resolve(),
    pickPort: () => CHECK_PORT,
    systemdUnitDir: host.unitDir,
  };
}

/** A `sudo install` of the unit file at `path`. */
function installsAt(path: string) {
  return (args: string[]) => args.includes("install") && args.at(-1) === path;
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

    const unitPath = nativeAppUnitPath(
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
      host.unitDir,
    );
    const unit = await Deno.readTextFile(unitPath);
    assertStringIncludes(unit, `User=${USERNAME}`);
    assertStringIncludes(unit, `Group=${USERNAME}`);
    assertStringIncludes(unit, `Slice=turbopanel-${USERNAME}.slice`);
    assertStringIncludes(unit, "Environment=PORT=18100");
    assertStringIncludes(
      unit,
      "/production/services/019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70/current",
    );
    // Hardening is the whole justification for running containerless.
    assertStringIncludes(unit, "NoNewPrivileges=yes");
    assertStringIncludes(unit, "ProtectSystem=strict");
    assertStringIncludes(unit, "CapabilityBoundingSet=");
    assertStringIncludes(
      unit,
      "/production/services/019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70/shared",
    );

    assertEquals(mock.systemctl("daemon-reload").length > 0, true);
    assertEquals(mock.systemctl("enable"), [
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    ]);
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
    second.activeUnits.add(
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    );
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, second),
    );

    // Byte-identical unit + slice ⇒ the app's own unit is not reinstalled.
    // The only files written are the check copy's, which is started beside the
    // serving release first, so the only reloads are its own (in, then out).
    assertEquals(
      callIndexes(
        second,
        installsAt(nativeAppUnitPath(SERVICE_ID, host.unitDir)),
      )
        .length,
      0,
    );
    assertEquals(
      callIndexes(second, (args) => args.includes("install")).length,
      1,
    );
    assertEquals(second.systemctl("daemon-reload").length, 2);
    assertEquals(second.systemctl("restart"), [CHECK_UNIT, OWN_UNIT]);
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
    mock.activeUnits.add(
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    );
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp({ listenPort: 18201 })],
      applyOpts(host, mock),
    );

    // Check copy in, the app's own changed unit at the switch, check copy out.
    assertEquals(mock.systemctl("daemon-reload").length, 3);
    const [checkStarted] = callIndexes(
      mock,
      (args) => args.includes("restart") && args.at(-1) === CHECK_UNIT,
    );
    const [ownInstalled] = callIndexes(
      mock,
      installsAt(nativeAppUnitPath(SERVICE_ID, host.unitDir)),
    );
    assertEquals(checkStarted < ownInstalled, true);
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
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
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
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
    "production",
    "services",
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    { recursive: true },
  );
  await Deno.symlink(
    join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    join(siteDir, "current"),
  );

  // The old release ran as a standalone server.js; the new one as next start.
  await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71", {
    nativeStart: { kind: "file", path: "server.js" },
  });

  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          // Only the restored release answers.
          probe: async () =>
            await Deno.readLink(join(siteDir, "current")) ===
              join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
          bindings: new Map([["web", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
            previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
            releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
            nativeStart: { kind: "next-start" as const },
          }]]),
        }),
      Error,
    );
    assertStringIncludes(error.message, "did not answer on 127.0.0.1:18100");
    assertStringIncludes(
      error.message,
      "rolled back to release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
    );

    assertEquals(
      await Deno.readLink(join(siteDir, "current")),
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
    );
    // The unit is put back the way the old release ran, reloaded, restarted.
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(unit, "/bin/node server.js\n");
    const reloads = callIndexes(
      mock,
      (args) => args.includes("daemon-reload"),
    );
    const restarts = callIndexes(
      mock,
      (args) => args.includes("systemctl") && args.includes("restart"),
    );
    assertEquals((reloads.at(-1) ?? 0) < (restarts.at(-1) ?? 0), true);
    assertEquals(
      mock.systemctl("restart").at(-1),
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    );
    assertEquals(mock.systemctl("disable"), []);
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
    assertStringIncludes(
      error.message,
      "no previous release to roll back to; the app is stopped",
    );
  } finally {
    await host.cleanup();
  }
});

test("a previous release that never answered is not restored; the app is stopped", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const siteDir = join(
    host.layout.principalHomeRoot,
    USERNAME,
    "production",
    "services",
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    { recursive: true },
  );
  await Deno.symlink(
    join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    join(siteDir, "current"),
  );
  await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71", {
    healthy: false,
  });
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          bindings: bindings({
            previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
          }),
        }),
      Error,
    );
    assertStringIncludes(
      error.message,
      "the previous release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71 never passed a health check on this server, so it was not restored; the app is stopped",
    );
    assertEquals(
      await Deno.readLink(join(siteDir, "current")),
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    );
    // Stopped and disabled, so a reboot does not bring the crash loop back.
    assertEquals(mock.systemctl("disable"), [
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    ]);
  } finally {
    await host.cleanup();
  }
});

test("a rollback restores the old release's own start command and startup file, and must answer", async () => {
  const host = await makeTestHost();
  const siteDir = join(
    host.layout.principalHomeRoot,
    USERNAME,
    "production",
    "services",
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    { recursive: true },
  );
  await Deno.symlink(
    join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    join(siteDir, "current"),
  );
  // 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71 ran with an explicit command; the new deploy cleared it.
  await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71", {
    startCommand: "node dist/main.js",
  });
  const answers = { rolledBack: true };
  try {
    const mock = createRunMock();
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp({ startupFile: "dist/new.js" })],
          {
            ...applyOpts(host, mock, false),
            probe: async () =>
              answers.rolledBack &&
              await Deno.readLink(join(siteDir, "current")) ===
                join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
            bindings: new Map([["web", {
              username: USERNAME,
              folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
              previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
            }]]),
          },
        ),
      Error,
    );
    assertStringIncludes(
      error.message,
      "rolled back to release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
    );
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(unit, "ExecStart=/bin/sh -c 'node dist/main.js'\n");

    // The same rollback, but the old release does not answer either.
    answers.rolledBack = false;
    await Deno.remove(join(siteDir, "current"));
    await Deno.symlink(
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
      join(siteDir, "current"),
    );
    const silent = createRunMock();
    const error2 = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, silent, false),
          bindings: bindings({
            previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
          }),
        }),
      Error,
    );
    assertStringIncludes(
      error2.message,
      "rolled back to release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71, but it did not answer either; the app is stopped",
    );
    assertEquals(silent.systemctl("disable"), [
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    ]);
  } finally {
    await host.cleanup();
  }
});

test("a re-sent live release is never rolled back to itself", async () => {
  const host = await makeTestHost();
  try {
    await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e73");
    const mock = createRunMock();
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          bindings: new Map([["web", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
            previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e73",
            releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e73",
          }]]),
        }),
      Error,
    );
    assertStringIncludes(
      error.message,
      "no previous release to roll back to; the app is stopped",
    );
  } finally {
    await host.cleanup();
  }
});

test("a release that answers is recorded as a rollback target", async () => {
  const host = await makeTestHost();
  try {
    const recordDir = await recordRelease(
      host.layout,
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
      {
        healthy: false,
      },
    );
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...applyOpts(host, createRunMock()),
      bindings: new Map([["web", {
        username: USERNAME,
        folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
        previousReleaseId: null,
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
      }]]),
    });
    await Deno.stat(join(recordDir, HEALTHY_RECORD_MARKER));
    assertEquals(
      (await readHealthyRelease(
        host.layout,
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
      ))?.releaseId,
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
    );
    // A release with no record (published before records) is simply skipped.
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...applyOpts(host, createRunMock()),
      bindings: new Map([["web", {
        username: USERNAME,
        folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
        previousReleaseId: null,
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76",
      }]]),
    });
    assertEquals(
      await readHealthyRelease(
        host.layout,
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76",
      ),
      null,
    );
  } finally {
    await host.cleanup();
  }
});

test("a pending record is never a rollback target", async () => {
  const host = await makeTestHost();
  try {
    const recordDir = await recordRelease(
      host.layout,
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
    );
    assertEquals(
      (await readHealthyRelease(
        host.layout,
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
      ))?.releaseId,
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
    );
    await Deno.writeTextFile(join(recordDir, ".pending"), "");
    assertEquals(
      await readHealthyRelease(
        host.layout,
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
      ),
      null,
    );
  } finally {
    await host.cleanup();
  }
});

test("a failed health probe streams the unit journal into the transcript", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const run = mock.run;
  mock.run = async (command, args) => {
    if (args.includes("journalctl")) {
      mock.calls.push({ command, args: [...args] });
      return {
        success: true,
        stdout:
          "Error: Cannot find module '/srv/users/proj1/production/services/019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70/current/server.js'\n",
        stderr: "",
      };
    }
    return await run(command, args);
  };
  const lines: string[] = [];
  try {
    await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          run: mock.run,
          onOutput: (_stream, line) => lines.push(line),
        }),
      Error,
    );
    assertEquals(
      lines.some((line) => line.includes("waiting for 127.0.0.1:18100")),
      true,
    );
    assertEquals(
      lines.some((line) =>
        line.includes("Cannot find module") && line.includes("server.js")
      ),
      true,
    );
    assertEquals(
      mock.calls.some((call) => call.args.includes("journalctl")),
      true,
    );
  } finally {
    await host.cleanup();
  }
});

test("a failed health probe puts the last journal lines in the thrown error", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const run = mock.run;
  const journal = Array.from({ length: 14 }, (_, i) => `old line ${i}`);
  journal.push("ReferenceError: require is not defined in ES module scope");
  mock.run = async (command, args) => {
    if (args.includes("journalctl")) {
      mock.calls.push({ command, args: [...args] });
      return { success: true, stdout: journal.join("\n") + "\n", stderr: "" };
    }
    return await run(command, args);
  };
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          run: mock.run,
        }),
      Error,
    );
    assertEquals(error.message.includes("did not answer"), true);
    assertEquals(error.message.includes("require is not defined"), true);
    assertEquals(error.message.includes("old line 14"), false);
    assertEquals(error.message.includes("old line 4"), false);
    assertEquals(error.message.includes("old line 5"), true);
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
    assertEquals(stopped, [
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    ]);

    const removeMock = createRunMock();
    const removed = await removeNativeAppServices(host.layout, ENVIRONMENT_ID, {
      run: removeMock.run,
      systemdUnitDir: host.unitDir,
    });
    assertEquals(removed, 1);
    assertEquals(removeMock.systemctl("disable"), [
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    ]);

    // The other environment's unit is untouched, and the shared slice survives
    // a teardown because other environments of the same account still use it.
    await Deno.stat(nativeAppUnitPath("svc-other", host.unitDir));
    await Deno.stat(principalSlicePath(USERNAME, host.unitDir));
    await assertRejects(
      () =>
        Deno.stat(
          nativeAppUnitPath(
            "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
            host.unitDir,
          ),
        ),
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
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(
      unit,
      "ExecStart=/bin/sh -c 'node dist/main.js --port $PORT'",
    );
  } finally {
    await host.cleanup();
  }
});

test("the start the build detected becomes the unit's ExecStart", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...applyOpts(host, createRunMock()),
      bindings: new Map([["web", {
        username: USERNAME,
        folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
        previousReleaseId: null,
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
        nativeStart: { kind: "next-start" as const },
      }]]),
    });
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(
      unit,
      "node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 18100\n",
    );
  } finally {
    await host.cleanup();
  }
});

test("an operator-disabled app is installed but stopped and disabled, never probed", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  let probes = 0;
  const lines: string[] = [];
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp({ enabled: false })],
      {
        ...applyOpts(host, mock),
        probe: () => {
          probes += 1;
          return Promise.resolve(false);
        },
        onOutput: (_stream, line) => lines.push(line),
      },
    );
    // A disabled app still counts as applied — down *is* the desired state.
    assertEquals(result.applied, ["web"]);

    // The unit file is still installed, so re-enabling later is a start, not
    // a re-render.
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(unit, `User=${USERNAME}`);

    // `disable --now` instead of enable/restart; no probe, no rollback.
    assertEquals(mock.systemctl("disable"), [
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    ]);
    assertEquals(mock.systemctl("enable"), []);
    assertEquals(mock.systemctl("restart"), []);
    assertEquals(probes, 0);
    assertEquals(
      lines.some((line) => line.includes("disabled by operator")),
      true,
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
    serviceFolders: [{ serviceId: "web", folder: folderFor("web") }],
    sourceMaterial: [
      {
        sourceId: "s1",
        composeServiceName: "web",
        provider: "github",
        cloneUrl: "https://example.test/repo.git",
        ref: "main",
        commitSha: "abc",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
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
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e74",
        build: { kind: "native" },
      },
    ],
  } as unknown as EnvironmentDeployPayload;

  const resolved = nativeAppBindingsFromPayload(
    payload,
    new Map([["web", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"]]),
  );
  assertEquals(resolved.size, 1);
  assertEquals(resolved.get("web"), {
    username: USERNAME,
    folder: folderFor("web"),
    previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
    startCommand: "node server.js",
  });
});

test("nativeAppBindingsFromPayload carries the applied release and its detected start", () => {
  const payload = {
    environmentId: ENVIRONMENT_ID,
    serviceFolders: [{ serviceId: "web", folder: folderFor("web") }],
    sourceMaterial: [{
      sourceId: "s1",
      composeServiceName: "web",
      provider: "github",
      cloneUrl: "https://example.test/repo.git",
      ref: "main",
      commitSha: "abc",
      releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
      principal: { principalId: "pr1", username: USERNAME },
      build: { kind: "native" },
    }],
  } as unknown as EnvironmentDeployPayload;
  const resolved = nativeAppBindingsFromPayload(
    payload,
    new Map([["web", null]]),
    new Map([["web", {
      releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
      nativeStart: { kind: "start-script" as const },
    }]]),
  );
  assertEquals(resolved.get("web"), {
    username: USERNAME,
    folder: folderFor("web"),
    previousReleaseId: null,
    releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
    nativeStart: { kind: "start-script" },
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
    // The app is down, so it is started directly (no check copy).
    const mock = createRunMock();
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
      (args) => args.includes("systemctl") && args.includes("enable"),
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
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
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
          serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75",
          listenPort: 18101,
          nodeVersion: "24.17.0",
        }),
      ],
      {
        ...applyOpts(host, createRunMock()),
        runPlaybook: playbook.runPlaybook,
        bindings: new Map([
          ["web", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
            previousReleaseId: null,
          }],
          ["api", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75"),
            previousReleaseId: null,
          }],
        ]),
      },
    );

    const web = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    const api = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75", host.unitDir),
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
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(
      unit,
      `ExecStart=${
        nativeAppNodeBinary(host.layout, NEWEST_NATIVE_APP_NODE_VERSION)
      } server.js`,
    );
    assertEquals(
      JSON.parse(playbook.calls[0]?.extraArgs?.[1] ?? "{}"),
      { node_app_versions: [NEWEST_NATIVE_APP_NODE_VERSION] },
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

    // Every installed runtime may be run by every site owner's Linux user, so
    // deploying an app adds the owner to no group.
    assertEquals(usermodCalls(mock), []);
  } finally {
    await host.cleanup();
  }
});

test("ensureNativeAppRuntime is a no-op for an empty app list", async () => {
  let called = false;
  await ensureNativeAppRuntime([], {
    runPlaybook: () => {
      called = true;
      return Promise.resolve();
    },
  });
  assertEquals(called, false);
});

test("ensureNativeAppRuntime vendors the distinct series before the Git build", async () => {
  const playbook = createPlaybookMock();
  await ensureNativeAppRuntime(
    [
      makeApp(),
      makeApp({
        composeServiceName: "api",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75",
        nodeVersion: "22",
      }),
    ],
    { runPlaybook: playbook.runPlaybook },
  );
  assertEquals(playbook.calls.length, 1);
  const extraArgs = playbook.calls[0]!.extraArgs ?? [];
  assertEquals(JSON.parse(extraArgs[1] ?? "{}"), {
    node_app_versions: ["22", NEWEST_NATIVE_APP_NODE_VERSION],
  });
});

test("ensureNativeAppRuntime vendors Deno through its own playbook and leaves Node alone", async () => {
  // Deno only: the Node playbook never runs.
  const denoOnly = createPlaybookMock();
  await ensureNativeAppRuntime(
    [makeApp({ runtime: "deno", denoVersion: "2.9.7" })],
    { runPlaybook: denoOnly.runPlaybook },
  );
  assertEquals(denoOnly.calls.length, 1);
  assertEquals(
    denoOnly.calls[0]!.path.endsWith("deno-app-runtime-apply.yml"),
    true,
  );
  assertEquals(JSON.parse(denoOnly.calls[0]!.extraArgs?.[1] ?? "{}"), {
    deno_app_versions: ["2"],
  });
  // Mixed: each runtime gets its own series list, Node first.
  const mixed = createPlaybookMock();
  await ensureNativeAppRuntime(
    [
      makeApp({ nodeVersion: "22" }),
      makeApp({ serviceId: "svc-d", runtime: "deno" }),
      makeApp({ serviceId: "svc-d2", runtime: "deno", denoVersion: "2" }),
    ],
    { runPlaybook: mixed.runPlaybook },
  );
  assertEquals(mixed.calls.length, 2);
  assertEquals(JSON.parse(mixed.calls[0]!.extraArgs?.[1] ?? "{}"), {
    node_app_versions: ["22"],
  });
  assertEquals(JSON.parse(mixed.calls[1]!.extraArgs?.[1] ?? "{}"), {
    deno_app_versions: ["2"],
  });
  assertEquals(nativeAppNodeVersions([makeApp({ runtime: "deno" })]), []);
});

test("ensureNativeAppRuntime rejects an unsupported Deno series before any playbook", async () => {
  const playbook = createPlaybookMock();
  const error = await assertRejects(() =>
    ensureNativeAppRuntime([makeApp({ runtime: "deno", denoVersion: "3" })], {
      runPlaybook: playbook.runPlaybook,
    })
  );
  assertEquals(playbook.calls.length, 0);
  assertEquals((error as Error).message.includes("3"), true);
});

test("a Deno app gets a unit that runs the vendored Deno, and a rollback restores the old start", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const siteDir = join(
    host.layout.principalHomeRoot,
    USERNAME,
    "production",
    "services",
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    { recursive: true },
  );
  await Deno.symlink(
    join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    join(siteDir, "current"),
  );
  // The old release ran its entry file; the new one runs the start task.
  await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71", {
    runtime: "deno",
    nativeStart: { kind: "deno-file", path: "main.ts" },
  });
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp({ runtime: "deno", denoVersion: "2.9" })],
          {
            ...applyOpts(host, mock, false),
            probe: async () =>
              await Deno.readLink(join(siteDir, "current")) ===
                join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
            bindings: new Map([["web", {
              username: USERNAME,
              folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
              previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
              nativeStart: { kind: "deno-task" as const },
            }]]),
          },
        ),
      Error,
    );
    assertStringIncludes(
      error.message,
      "rolled back to release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
    );
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(
      unit,
      "/deno-app/2/current/bin/deno run --allow-all main.ts\n",
    );
    assertEquals(unit.includes("task start"), false);
  } finally {
    await host.cleanup();
  }
});

test("a first Deno deploy that fails rolls the site back onto Node, not a Deno unit", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const siteDir = join(
    host.layout.principalHomeRoot,
    USERNAME,
    "production",
    "services",
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    { recursive: true },
  );
  await Deno.symlink(
    join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    join(siteDir, "current"),
  );
  // The old release is a Node release: its record says nothing about a runtime.
  await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71", {
    startCommand: "node app.js",
  });
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp({ runtime: "deno", denoVersion: "2" })],
          {
            ...applyOpts(host, mock, false),
            probe: async () =>
              await Deno.readLink(join(siteDir, "current")) ===
                join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
            bindings: new Map([["web", {
              username: USERNAME,
              folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
              previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
              nativeStart: { kind: "deno-task" as const },
            }]]),
          },
        ),
      Error,
    );
    assertStringIncludes(
      error.message,
      "rolled back to release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
    );
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(unit, "ExecStart=/bin/sh -c 'node app.js'\n");
    assertStringIncludes(unit, "/node-app/");
    assertStringIncludes(unit, "COREPACK_HOME=");
    assertEquals(unit.includes("deno-app"), false);
    assertEquals(unit.includes("DENO_DIR"), false);
  } finally {
    await host.cleanup();
  }
});

test("a failed Node deploy of a site that ran Deno rolls back onto Deno", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const siteDir = join(
    host.layout.principalHomeRoot,
    USERNAME,
    "production",
    "services",
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    { recursive: true },
  );
  await Deno.symlink(
    join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    join(siteDir, "current"),
  );
  await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71", {
    runtime: "deno",
    nativeStart: { kind: "deno-task" },
  });
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp()],
          {
            ...applyOpts(host, mock, false),
            probe: async () =>
              await Deno.readLink(join(siteDir, "current")) ===
                join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
            bindings: new Map([["web", {
              username: USERNAME,
              folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
              previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
            }]]),
          },
        ),
      Error,
    );
    assertStringIncludes(
      error.message,
      "rolled back to release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
    );
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(unit, "/deno-app/2/current/bin/deno task start\n");
    assertStringIncludes(unit, "DENO_DIR=");
    assertEquals(unit.includes("COREPACK_HOME"), false);
  } finally {
    await host.cleanup();
  }
});

test("ensureNativeAppRuntime rejects an unsupported series with the supported list, before any playbook", async () => {
  const playbook = createPlaybookMock();
  const error = await assertRejects(() =>
    ensureNativeAppRuntime([makeApp({ nodeVersion: "18" })], {
      runPlaybook: playbook.runPlaybook,
    })
  );
  assertStringIncludes(
    (error as Error).message,
    "node 18 is not a supported node version on this server. Supported series: 22, 24, 26.",
  );
  assertEquals(playbook.calls.length, 0);
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
          serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75",
          listenPort: 18101,
        }),
      ],
      {
        ...applyOpts(host, createRunMock()),
        bindings: new Map([
          ["web", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
            previousReleaseId: null,
          }],
          ["api", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75"),
            previousReleaseId: null,
          }],
        ]),
      },
    );
    const ids = await listEnvironmentNativeAppServiceIds(
      host.layout,
      ENVIRONMENT_ID,
    );
    assertEquals(ids, [
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75",
    ]);
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
          serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75",
          listenPort: 18101,
        }),
      ],
      {
        ...applyOpts(host, createRunMock()),
        bindings: new Map([
          ["web", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
            previousReleaseId: null,
          }],
          ["api", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75"),
            previousReleaseId: null,
          }],
        ]),
      },
    );

    const mock = createRunMock();
    const originalRun = mock.run;
    mock.run = async (command, args) => {
      if (
        args.includes("stop") &&
        args.includes(nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"))
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
    assertEquals(touched, [
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75"),
    ]);
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
          serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75",
          listenPort: 18101,
        }),
      ],
      {
        ...applyOpts(host, createRunMock()),
        bindings: new Map([
          ["web", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
            previousReleaseId: null,
          }],
          ["api", {
            username: USERNAME,
            folder: folderFor("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75"),
            previousReleaseId: null,
          }],
        ]),
      },
    );

    const mock = createRunMock();
    const originalRun = mock.run;
    mock.run = async (command, args) => {
      if (
        args.includes("disable") &&
        args.includes(nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"))
      ) {
        return fail("disable refused");
      }
      if (
        args.includes("rm") &&
        String(args.at(-1)).includes(
          nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75"),
        )
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
  assertEquals(NEWEST_NATIVE_APP_NODE_VERSION, "26");
  assertEquals(
    nativeAppNodeVersions([
      makeApp({ nodeVersion: "24" }),
      makeApp({
        composeServiceName: "api",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e75",
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
    // The app that pins nothing contributes the newest offered series.
    ["22", "24", "26"],
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
  await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71");
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
            bindings: bindings({
              previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
            }),
            run: mock.run,
            runPlaybook: () => Promise.resolve(),
            sleep: () => Promise.resolve(),
            systemdUnitDir: host.unitDir,
          },
        ),
      Error,
    );
    assertStringIncludes(error.message, "did not answer on 127.0.0.1:18100");
    assertStringIncludes(
      error.message,
      "rolling back to release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71 failed; the app is stopped",
    );
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
    await Deno.writeTextFile(
      join(dir, "other-019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70.service"),
      "skip",
    );
    assertEquals(
      await listEnvironmentNativeAppServiceIds(host.layout, ENVIRONMENT_ID),
      ["019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"],
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
    "production",
    "services",
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(siteDir, "releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    { recursive: true },
  );
  await Deno.symlink(
    join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72"),
    join(siteDir, "current"),
  );
  const run: typeof mock.run = async (command, args) => {
    if (args.includes("systemctl") && args.includes("restart")) {
      return fail("restart refused");
    }
    return await mock.run(command, args);
  };
  await recordRelease(host.layout, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71");
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          run,
          bindings: bindings({
            previousReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
          }),
        }),
      Error,
    );
    assertStringIncludes(error.message, "did not answer on 127.0.0.1:18100");
    assertStringIncludes(
      error.message,
      "rolling back to release 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71 failed; the app is stopped",
    );
    assertEquals(
      await Deno.readLink(join(siteDir, "current")),
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71"),
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
      `tp-${ENVIRONMENT_ID}-019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70.service`,
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

test("waitForNativeApp stops immediately when systemd has already given up", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalRun = mock.run;
  mock.run = async (command, args) => {
    if (args.includes("is-failed")) return ok();
    return await originalRun(command, args);
  };
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          run: mock.run,
        }),
      Error,
    );
    assertStringIncludes(error.message, "did not answer on 127.0.0.1:18100");
  } finally {
    await host.cleanup();
  }
});

test("an empty unit journal is recorded as such in the transcript", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalRun = mock.run;
  mock.run = async (command, args) => {
    if (args.includes("journalctl")) {
      return { success: true, stdout: "", stderr: "" };
    }
    return await originalRun(command, args);
  };
  const lines: string[] = [];
  try {
    await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          run: mock.run,
          onOutput: (_stream, line) => lines.push(line),
        }),
      Error,
    );
    assertEquals(
      lines.some((line) => line.includes("(no journal output for this unit)")),
      true,
    );
  } finally {
    await host.cleanup();
  }
});

test("blank journal lines are skipped when copying into the transcript", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalRun = mock.run;
  mock.run = async (command, args) => {
    if (args.includes("journalctl")) {
      return {
        success: true,
        stdout: "keep\n\nError: boom\n\nmore\n",
        stderr: "",
      };
    }
    return await originalRun(command, args);
  };
  const lines: string[] = [];
  try {
    await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...applyOpts(host, mock, false),
          run: mock.run,
          onOutput: (_stream, line) => lines.push(line),
        }),
      Error,
    );
    assertEquals(lines.includes("keep"), true);
    assertEquals(lines.includes("Error: boom"), true);
    assertEquals(lines.includes("more"), true);
    assertEquals(lines.includes(""), false);
  } finally {
    await host.cleanup();
  }
});

test("disabling a native app uses a generic error when systemd is silent", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const originalRun = mock.run;
  mock.run = async (command, args) => {
    if (args.includes("disable")) return fail("");
    return await originalRun(command, args);
  };
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp({ enabled: false })],
          { ...applyOpts(host, mock), run: mock.run },
        ),
      Error,
    );
    assertStringIncludes(
      error.message,
      `Failed to disable native app unit ${
        nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70")
      }`,
    );
  } finally {
    await host.cleanup();
  }
});

test("waitForNativeApp uses sleepDefault between probes when sleep is omitted", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  let probes = 0;
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      {
        bindings: bindings(),
        run: mock.run,
        runPlaybook: () => Promise.resolve(),
        probe: () => {
          probes += 1;
          return Promise.resolve(probes >= 2);
        },
        systemdUnitDir: host.unitDir,
      },
    );
    assertEquals(result.applied, ["web"]);
    assertEquals(probes, 2);
  } finally {
    await host.cleanup();
  }
});

const VARIABLE_MATERIAL = [{
  key: "DB_PASSWORD",
  composeServiceName: "web",
  forBuild: false,
  forRuntime: true,
  isLiteral: false,
  valueEnvelope: "tpdaemon.hunter2",
}];

const decryptForTest = (envelopes: string[]) =>
  Promise.resolve(envelopes.map((e) => e.slice("tpdaemon.".length)));

const VARIABLES_APP = {
  variables: [
    { name: "API_URL", value: "https://example.test" },
    { name: "DB_PASSWORD", secretKey: "DB_PASSWORD" },
    { name: "PORT", value: "1" },
  ],
};

test("an app's variables are copied by tp-host before its unit is installed and started", async () => {
  const host = await makeTestHost();
  const mock = createRunMock(host.layout);
  const lines: string[] = [];
  const envPath = nativeAppEnvPath(
    host.layout,
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  );
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp(VARIABLES_APP)],
      {
        ...applyOpts(host, mock),
        variableMaterial: VARIABLE_MATERIAL,
        decryptSecrets: decryptForTest,
        onOutput: (_stream, line) => lines.push(line),
      },
    );

    // The copy exists by the time the unit is installed (the first moment the
    // host could start the app), and it is tp-host's: the daemon only named
    // the service id.
    const [copyAt] = callIndexes(
      mock,
      (args) => args.includes("app-env-install"),
    );
    const [unitAt] = callIndexes(
      mock,
      (args) =>
        args.includes("install") && args.at(-1)?.endsWith(".service") === true,
    );
    assertEquals(copyAt < unitAt, true);
    assertEquals(mock.calls[copyAt].args, [
      "-n",
      "app-env-install",
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
    ]);

    const text = mock.envCopies.get("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70")!;
    assertStringIncludes(text, "API_URL='https://example.test'\n");
    assertStringIncludes(text, "DB_PASSWORD='hunter2'\n");
    // A platform-set name never reaches the file, where it would override.
    assertEquals(text.includes("PORT="), false);
    // The daemon's own staged file is gone: the secret is not on disk twice.
    await assertRejects(
      () =>
        Deno.stat(
          nativeAppEnvStagePath(
            host.layout,
            "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
          ),
        ),
      Deno.errors.NotFound,
    );

    // The unit names the root-owned copy, never the daemon-writable staging
    // path, and holds no value.
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertStringIncludes(unit, `EnvironmentFile=${envPath}\n`);
    assertEquals(
      unit.includes(
        nativeAppEnvStagePath(
          host.layout,
          "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        ),
      ),
      false,
    );
    assertEquals(unit.includes("hunter2"), false);
    assertEquals(unit.includes("example.test"), false);

    // Names and counts reach the transcript; values never do.
    const transcript = lines.join("\n");
    assertStringIncludes(transcript, "web: 2 environment variables written");
    assertStringIncludes(transcript, "ignored PORT");
    assertEquals(transcript.includes("hunter2"), false);
    assertEquals(
      mock.calls.some((call) =>
        call.args.some((arg) => arg.includes("hunter2"))
      ),
      false,
    );
  } finally {
    await host.cleanup();
  }
});

test("dropping every variable: the unit stops loading the file first, then the copy goes", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [
      makeApp(VARIABLES_APP),
    ], {
      ...applyOpts(host, createRunMock(host.layout)),
      variableMaterial: VARIABLE_MATERIAL,
      decryptSecrets: decryptForTest,
    });

    const mock = createRunMock(host.layout);
    mock.envCopies.set(
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
      "left by the earlier deploy",
    );
    mock.activeUnits.add(
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    );
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, mock),
    );
    assertEquals(
      mock.envCopies.has("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
      false,
    );
    const unit = await Deno.readTextFile(
      nativeAppUnitPath("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70", host.unitDir),
    );
    assertEquals(unit.includes("EnvironmentFile"), false);
    // The unit changed at the switch, so systemd is told before the restart
    // (beside the check copy's own reloads, in and out).
    assertEquals(mock.systemctl("daemon-reload").length, 3);

    // A crash-restart of the old unit between these steps would fail if the
    // copy went first: it goes after the new unit is installed, reloaded and
    // restarted.
    const [unitAt] = callIndexes(
      mock,
      installsAt(nativeAppUnitPath(SERVICE_ID, host.unitDir)),
    );
    const reloadAt = callIndexes(
      mock,
      (args) => args.includes("daemon-reload"),
    ).find((index) => index > unitAt) ?? -1;
    const [restartAt] = callIndexes(
      mock,
      (args) => args.includes("restart") && args.at(-1) === OWN_UNIT,
    );
    const [removeAt] = callIndexes(
      mock,
      (args) => args.includes("app-env-remove") && args.at(-1) === SERVICE_ID,
    );
    assertEquals(unitAt < reloadAt && reloadAt < restartAt, true);
    assertEquals(restartAt < removeAt, true);
    assertEquals(mock.calls[removeAt].args, [
      "-n",
      "app-env-remove",
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
    ]);
  } finally {
    await host.cleanup();
  }
});

test("an app that never had variables asks tp-host for nothing but the removal, and its unit is untouched", async () => {
  const host = await makeTestHost();
  try {
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, createRunMock()),
    );
    const mock = createRunMock();
    mock.activeUnits.add(
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    );
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, mock),
    );
    assertEquals(
      callIndexes(mock, (args) => args.includes("app-env-install")).length,
      0,
    );
    // Only the check copy's reloads (in, then out): the app's own unit is
    // untouched.
    assertEquals(mock.systemctl("daemon-reload").length, 2);
    assertEquals(
      callIndexes(mock, installsAt(nativeAppUnitPath(SERVICE_ID, host.unitDir)))
        .length,
      0,
    );
  } finally {
    await host.cleanup();
  }
});

test("a refused removal of a stale copy warns and does not fail the deploy", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const refuse: RunFn = (command, args) =>
    args.includes("app-env-remove")
      ? Promise.resolve(fail("tp-host: refusing verb"))
      : mock.run(command, args);
  try {
    const result = await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      { ...applyOpts(host, mock), run: refuse },
    );
    assertEquals(result.applied, ["web"]);
  } finally {
    await host.cleanup();
  }
});

test("a variable change with an identical unit still restarts the app; only the check copy reloads", async () => {
  const host = await makeTestHost();
  try {
    const opts = (decrypt: (e: string[]) => Promise<(string | null)[]>) => ({
      variableMaterial: VARIABLE_MATERIAL,
      decryptSecrets: decrypt,
    });
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [
      makeApp(VARIABLES_APP),
    ], {
      ...applyOpts(host, createRunMock(host.layout)),
      ...opts(decryptForTest),
    });

    const mock = createRunMock(host.layout);
    mock.activeUnits.add(
      nativeAppUnitName("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
    );
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [
      makeApp(VARIABLES_APP),
    ], {
      ...applyOpts(host, mock),
      ...opts((envelopes) => Promise.resolve(envelopes.map(() => "rotated"))),
    });
    assertStringIncludes(
      mock.envCopies.get("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70")!,
      "DB_PASSWORD='rotated'",
    );
    // The check copy ran on the rotated value first, and is gone again.
    assertEquals(mock.envCopies.has(`${SERVICE_ID}-new`), false);
    assertEquals(mock.systemctl("daemon-reload").length, 2);
    assertEquals(mock.systemctl("restart"), [CHECK_UNIT, OWN_UNIT]);
  } finally {
    await host.cleanup();
  }
});

test("a referenced secret with no sealed value fails before any unit is installed", async () => {
  const host = await makeTestHost();
  const mock = createRunMock(host.layout);
  try {
    await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp(VARIABLES_APP)],
          { ...applyOpts(host, mock), variableMaterial: [] },
        ),
      Error,
      "no sealed value for secret variable DB_PASSWORD",
    );
    assertEquals(
      mock.calls.some((c) =>
        c.args.includes("install") && c.args.at(-1)?.endsWith(".service")
      ),
      false,
    );
  } finally {
    await host.cleanup();
  }
});

test("removing an environment's apps also removes their variables copies", async () => {
  const host = await makeTestHost();
  const mock = createRunMock(host.layout);
  try {
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [
      makeApp(VARIABLES_APP),
    ], {
      ...applyOpts(host, mock),
      variableMaterial: VARIABLE_MATERIAL,
      decryptSecrets: decryptForTest,
    });
    assertEquals(
      mock.envCopies.has("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
      true,
    );

    await removeNativeAppServices(host.layout, ENVIRONMENT_ID, {
      run: mock.run,
      systemdUnitDir: host.unitDir,
    });
    assertEquals(
      mock.envCopies.has("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70"),
      false,
    );
  } finally {
    await host.cleanup();
  }
});

test("nativeAppBindingsFromPayload carries the service folder of the sourced service", () => {
  const folder = { owner: USERNAME, scope: "production", slug: "api" };
  const payload = {
    environmentId: ENVIRONMENT_ID,
    projectId: "p1",
    organizationId: "o1",
    projectName: "proj",
    composeFiles: [],
    hostings: [],
    sourceMaterial: [{
      sourceId: "s1",
      composeServiceName: "web",
      releaseServiceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
      provider: "github",
      cloneUrl: "https://example.test/repo.git",
      ref: "main",
      commitSha: "abc",
      releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
      principal: { principalId: "pr1", username: USERNAME },
      build: { kind: "native", startCommand: "node server.js" },
    }],
    serviceFolders: [{
      serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
      folder,
    }],
  } as unknown as Parameters<typeof nativeAppBindingsFromPayload>[0];
  assertEquals(
    nativeAppBindingsFromPayload(payload).get("web")?.folder,
    folder,
  );
  // A release published without moving `current` says so to the apply.
  assertEquals(
    nativeAppBindingsFromPayload(
      payload,
      undefined,
      new Map([["web", {
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72",
        heldCurrent: true,
      }]]),
    ).get("web")?.heldCurrent,
    true,
  );
  assertThrows(
    () => nativeAppBindingsFromPayload({ ...payload, serviceFolders: [] }),
    Error,
    "has no folder planned on this server",
  );
});

test("journalDetail caps long lines and the whole tail, and masks token-looking text", () => {
  const long = "x".repeat(900);
  const detail = journalDetail([
    long,
    "DB_PASSWORD=hunter2 started",
    `Authorization: ${["Bea", "rer"].join("")} ${
      ["abcdefgh", "ijklmnop1234"].join("")
    }`,
    "key " + "A".repeat(50),
  ]);
  assertEquals(detail.includes("hunter2"), false);
  assertEquals(detail.includes("abcdefghijklmnop1234"), false);
  assertEquals(detail.includes("A".repeat(50)), false);
  assertEquals(detail.includes("x".repeat(400)), false);
  const many = journalDetail(
    Array.from({ length: 10 }, () => "y ".repeat(140)),
  );
  assertEquals(many.length < 2100, true);
});

// ---------------------------------------------------------------------------
// A release already serving: the new one is started beside it on a spare
// port, must answer there, and only then takes the app's own port.
// ---------------------------------------------------------------------------

const SERVING_RELEASE = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e81";
const NEW_RELEASE = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e82";

/**
 * A host where `SERVING_RELEASE` serves and this deploy has just published
 * `NEW_RELEASE` (publishing moves `current`, or with `held` leaves it on the
 * release serving), with the app's unit installed by an earlier deploy and
 * running.
 */
async function servingHost(options: { held?: boolean } = {}) {
  const host = await makeTestHost();
  const siteDir = join(
    host.layout.principalHomeRoot,
    USERNAME,
    "production",
    "services",
    SERVICE_ID,
  );
  await Promise.all(
    [SERVING_RELEASE, NEW_RELEASE].map((release) =>
      Deno.mkdir(join(siteDir, "releases", release), { recursive: true })
    ),
  );
  await Deno.symlink(
    join("releases", options.held ? SERVING_RELEASE : NEW_RELEASE),
    join(siteDir, "current"),
  );
  await applyNativeAppServices(
    host.layout,
    ENVIRONMENT_ID,
    [makeApp()],
    applyOpts(host, createRunMock()),
  );
  const ownUnitBefore = await Deno.readTextFile(
    nativeAppUnitPath(SERVICE_ID, host.unitDir),
  );
  const mock = createRunMock();
  mock.activeUnits.add(OWN_UNIT);
  const phases: string[] = [];
  const lines: string[] = [];
  const opts = {
    ...applyOpts(host, mock),
    bindings: new Map([["web", {
      username: USERNAME,
      folder: folderFor(SERVICE_ID),
      previousReleaseId: SERVING_RELEASE,
      releaseId: NEW_RELEASE,
      ...(options.held ? { heldCurrent: true } : {}),
    }]]),
    setPhase: (phase: string) => {
      if (phases.at(-1) !== phase) phases.push(phase);
    },
    onOutput: (_stream: string, line: string) => {
      lines.push(line);
    },
  };
  const current = () => Deno.readLink(join(siteDir, "current"));
  return { host, mock, opts, phases, lines, current, siteDir, ownUnitBefore };
}

test("a new release that does not answer beside the old one never takes traffic", async () => {
  const { host, mock, opts, lines, current, ownUnitBefore } =
    await servingHost();
  const probed: number[] = [];
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...opts,
          // The release serving keeps answering; the new one never does.
          probe: (port: number) => {
            probed.push(port);
            return Promise.resolve(port !== CHECK_PORT);
          },
        }),
      Error,
    );
    assertStringIncludes(
      error.message,
      `the new release did not answer on 127.0.0.1:${CHECK_PORT} within 30s, so it never took traffic; the release that was serving keeps serving`,
    );
    // `current` is back on the release serving, which was never touched:
    // no restart, no stop, no disable, and its unit is what it was.
    assertEquals(await current(), join("releases", SERVING_RELEASE));
    assertEquals(probed.includes(18100), false);
    for (const verb of ["restart", "stop", "disable"]) {
      assertEquals(
        mock.systemctl(verb).filter((unit) => unit === OWN_UNIT),
        [],
      );
    }
    assertEquals(
      await Deno.readTextFile(nativeAppUnitPath(SERVICE_ID, host.unitDir)),
      ownUnitBefore,
    );
    // The check copy is stopped and gone, with its staged file.
    assertEquals(mock.systemctl("stop"), [CHECK_UNIT]);
    await assertRejects(() =>
      Deno.stat(nativeAppUnitPath(`${SERVICE_ID}-new`, host.unitDir))
    );
    assertEquals(
      await listEnvironmentNativeAppServiceIds(host.layout, ENVIRONMENT_ID),
      [SERVICE_ID],
    );
    // Its journal is in the transcript, and it is not a rollback target.
    assertEquals(
      lines.some((line) => line.includes(`${CHECK_UNIT} journal`)),
      true,
    );
    assertEquals(
      await readHealthyRelease(host.layout, SERVICE_ID, NEW_RELEASE).catch(
        () => null,
      ),
      null,
    );
  } finally {
    await host.cleanup();
  }
});

test("a new release that answers beside the old one takes over its port; its copy stops first", async () => {
  const { host, mock, opts, phases, lines, current } = await servingHost();
  const seen: Array<{ port: number; current: string; checkUnit?: string }> = [];
  try {
    await recordRelease(host.layout, NEW_RELEASE);
    await Deno.remove(
      join(
        resolveDaemonReleasePaths(host.layout, {
          serviceId: SERVICE_ID,
          releaseId: NEW_RELEASE,
        }).releaseDir,
        HEALTHY_RECORD_MARKER,
      ),
    );
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...opts,
      probe: async (port: number) => {
        seen.push({
          port,
          current: await current(),
          ...(port === CHECK_PORT
            ? {
              checkUnit: await Deno.readTextFile(
                nativeAppUnitPath(`${SERVICE_ID}-new`, host.unitDir),
              ),
            }
            : {}),
        });
        return true;
      },
    });
    // Checked first, while `current` still served the old release; switched
    // after.
    assertEquals(seen.map((entry) => entry.port), [CHECK_PORT, 18100]);
    assertEquals(seen[0].current, join("releases", SERVING_RELEASE));
    assertEquals(seen[1].current, join("releases", NEW_RELEASE));
    assertEquals(await current(), join("releases", NEW_RELEASE));
    assertEquals(mock.systemctl("restart"), [CHECK_UNIT, OWN_UNIT]);

    // The copy ran the new release's own folder on the spare port, and can
    // never be enabled.
    const checkUnit = seen[0].checkUnit ?? "";
    assertStringIncludes(
      checkUnit,
      `WorkingDirectory=${
        join(
          host.layout.principalHomeRoot,
          USERNAME,
          "production",
          "services",
          SERVICE_ID,
          "releases",
          NEW_RELEASE,
        )
      }\n`,
    );
    assertStringIncludes(checkUnit, `Environment=PORT=${CHECK_PORT}\n`);
    assertEquals(checkUnit.includes("[Install]"), false);

    // It is stopped before the app's own unit starts the same release (they
    // share the account's ceilings), and removed afterwards; the new release
    // is a rollback target now.
    assertStringIncludes(checkUnit, "OOMScoreAdjust=900\n");
    assertEquals(mock.systemctl("stop"), [CHECK_UNIT, CHECK_UNIT]);
    const [ownRestart] = callIndexes(
      mock,
      (args) => args.includes("restart") && args.at(-1) === OWN_UNIT,
    );
    const [checkStop] = callIndexes(
      mock,
      (args) => args.includes("stop") && args.at(-1) === CHECK_UNIT,
    );
    assertEquals(checkStop < ownRestart, true);
    await assertRejects(() =>
      Deno.stat(nativeAppUnitPath(`${SERVICE_ID}-new`, host.unitDir))
    );
    assertEquals(
      (await readHealthyRelease(host.layout, SERVICE_ID, NEW_RELEASE)) !==
        null,
      true,
    );
    assertEquals(phases, [
      "start-release",
      "health",
      "switch-traffic",
      "stop-old-release",
    ]);
    assertEquals(
      lines.some((line) =>
        line.includes(`release ${SERVING_RELEASE} stays on disk for a rollback`)
      ),
      true,
    );
  } finally {
    await host.cleanup();
  }
});

test("a release held at publish whose app stopped since goes live when started directly", async () => {
  const { host, mock, opts, current } = await servingHost({ held: true });
  const seen: string[] = [];
  try {
    await recordRelease(host.layout, NEW_RELEASE);
    await Deno.remove(
      join(
        resolveDaemonReleasePaths(host.layout, {
          serviceId: SERVICE_ID,
          releaseId: NEW_RELEASE,
        }).releaseDir,
        HEALTHY_RECORD_MARKER,
      ),
    );
    // The unit crashed (or was killed) after the publish: nothing serves.
    mock.activeUnits.delete(OWN_UNIT);
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...opts,
      probe: async (port: number) => {
        seen.push(`${port} ${await current()}`);
        return true;
      },
    });
    // Started directly, out of the new release.
    assertEquals(seen, [`18100 ${join("releases", NEW_RELEASE)}`]);
    assertEquals(await current(), join("releases", NEW_RELEASE));
    assertEquals(mock.systemctl("enable"), [OWN_UNIT]);
    assertEquals(
      mock.calls.some((call) => call.args.includes(CHECK_UNIT)),
      false,
    );
    assertEquals(
      (await readHealthyRelease(host.layout, SERVICE_ID, NEW_RELEASE)) !==
        null,
      true,
    );
  } finally {
    await host.cleanup();
  }
});

test("a first deploy starts the app directly and has nothing to switch from", async () => {
  const host = await makeTestHost();
  const mock = createRunMock();
  const phases: string[] = [];
  const lines: string[] = [];
  try {
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...applyOpts(host, mock),
      setPhase: (phase: string) => {
        if (phases.at(-1) !== phase) phases.push(phase);
      },
      onOutput: (_stream: string, line: string) => {
        lines.push(line);
      },
    });
    assertEquals(mock.systemctl("enable"), [OWN_UNIT]);
    assertEquals(
      mock.calls.some((call) => call.args.includes(CHECK_UNIT)),
      false,
    );
    assertEquals(phases, [
      "start-release",
      "health",
      "switch-traffic",
      "stop-old-release",
    ]);
    assertEquals(
      lines.some((line) => line.includes("nothing was serving before")),
      true,
    );
  } finally {
    await host.cleanup();
  }
});

test("with no spare port the release serving is left as it was", async () => {
  const { host, mock, opts, current } = await servingHost();
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...opts,
          pickPort: () => {
            throw new Error("Address already in use");
          },
        }),
      Error,
    );
    assertStringIncludes(error.message, "no free loopback port");
    assertStringIncludes(error.message, "keeps serving");
    assertEquals(await current(), join("releases", SERVING_RELEASE));
    assertEquals(mock.systemctl("restart"), []);
  } finally {
    await host.cleanup();
  }
});

test("a check copy that systemd refuses to start fails the deploy and is removed", async () => {
  const { host, mock, opts, current } = await servingHost();
  const refuse: RunFn = (command, args) =>
    args.includes("restart") && args.at(-1) === CHECK_UNIT
      ? Promise.resolve(fail("Unit failed to start"))
      : mock.run(command, args);
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...opts,
          run: refuse,
        }),
      Error,
    );
    assertStringIncludes(
      error.message,
      "the new release could not be started (Unit failed to start), so it never took traffic",
    );
    assertEquals(await current(), join("releases", SERVING_RELEASE));
    assertEquals(mock.systemctl("stop"), [CHECK_UNIT]);
  } finally {
    await host.cleanup();
  }
});

test("a release that answered beside the old one but not after the switch rolls back", async () => {
  const { host, mock, opts, current } = await servingHost();
  await recordRelease(host.layout, SERVING_RELEASE);
  let switched = false;
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...opts,
          probe: async (port: number) => {
            if (port === CHECK_PORT) return true;
            // After the switch only the restored release answers.
            switched = true;
            return await current() === join("releases", SERVING_RELEASE);
          },
        }),
      Error,
    );
    assertEquals(switched, true);
    assertStringIncludes(
      error.message,
      `rolled back to release ${SERVING_RELEASE}`,
    );
    assertEquals(await current(), join("releases", SERVING_RELEASE));
    // The copy is removed on this path too.
    assertEquals(mock.systemctl("stop"), [CHECK_UNIT, CHECK_UNIT]);
  } finally {
    await host.cleanup();
  }
});

test("a check copy left by a deploy that did not finish is removed by the next one and by stop", async () => {
  const host = await makeTestHost();
  const checkId = `${SERVICE_ID}-new`;
  const leave = async () => {
    await Deno.mkdir(join(nativeAppConfigDir(host.layout), "check"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(
        nativeAppConfigDir(host.layout),
        "check",
        `tp-${ENVIRONMENT_ID}-${checkId}.service`,
      ),
      "leftover",
    );
    await Deno.writeTextFile(
      nativeAppUnitPath(checkId, host.unitDir),
      "leftover",
    );
  };
  try {
    await leave();
    const mock = createRunMock();
    await applyNativeAppServices(
      host.layout,
      ENVIRONMENT_ID,
      [makeApp()],
      applyOpts(host, mock),
    );
    assertEquals(mock.systemctl("stop"), [CHECK_UNIT]);
    await assertRejects(() =>
      Deno.stat(nativeAppUnitPath(checkId, host.unitDir))
    );
    // Removed before the app is started.
    const [stopAt] = callIndexes(mock, (args) => args.includes("stop"));
    const [enableAt] = callIndexes(mock, (args) => args.includes("enable"));
    assertEquals(stopAt < enableAt, true);

    await leave();
    const stop = createRunMock();
    await removeNativeAppServices(host.layout, ENVIRONMENT_ID, {
      run: stop.run,
      systemdUnitDir: host.unitDir,
    });
    assertEquals(stop.systemctl("stop"), [CHECK_UNIT]);
    await assertRejects(() =>
      Deno.stat(nativeAppUnitPath(checkId, host.unitDir))
    );
  } finally {
    await host.cleanup();
  }
});

test("without a port seam the check copy gets a free loopback port from the kernel", async () => {
  const { host, opts } = await servingHost();
  const { pickPort: _seam, ...withoutSeam } = opts;
  const ports: number[] = [];
  try {
    await applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
      ...withoutSeam,
      probe: (port: number) => {
        ports.push(port);
        return Promise.resolve(true);
      },
    });
    assertEquals(ports.length, 2);
    assertEquals(ports[0] !== 18100 && ports[0] > 1024, true);
    assertEquals(ports[1], 18100);
  } finally {
    await host.cleanup();
  }
});

test("a check copy whose unit cannot be removed stays staged, so the next deploy retries", async () => {
  const host = await makeTestHost();
  const checkId = `${SERVICE_ID}-new`;
  const staged = join(
    nativeAppConfigDir(host.layout),
    "check",
    `tp-${ENVIRONMENT_ID}-${checkId}.service`,
  );
  try {
    await Deno.mkdir(dirname(staged), { recursive: true });
    await Deno.writeTextFile(staged, "leftover");
    const mock = createRunMock();
    const refuse: RunFn = (command, args) =>
      (args.includes("stop") || args.includes("rm")) &&
        args.at(-1)?.includes(checkId) === true
        ? Promise.resolve(fail("refused"))
        : mock.run(command, args);
    await removeNativeAppServices(host.layout, ENVIRONMENT_ID, {
      run: refuse,
      systemdUnitDir: host.unitDir,
    });
    assertEquals((await Deno.stat(staged)).isFile, true);
    assertEquals(mock.systemctl("daemon-reload"), []);
  } finally {
    await host.cleanup();
  }
});

test("an app id shaped like a check copy is refused", async () => {
  const host = await makeTestHost();
  try {
    await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [makeApp({ serviceId: "web-new" })],
          applyOpts(host, createRunMock()),
        ),
      Error,
      "must not end in -new",
    );
  } finally {
    await host.cleanup();
  }
});

test("the app's own unit refusing to restart at the switch rolls back to the release that served", async () => {
  const { host, mock, opts, current } = await servingHost();
  await recordRelease(host.layout, SERVING_RELEASE);
  let refused = false;
  const refuseOnce: RunFn = (command, args) => {
    if (!refused && args.includes("restart") && args.at(-1) === OWN_UNIT) {
      refused = true;
      return Promise.resolve(fail("Job for the unit failed"));
    }
    return mock.run(command, args);
  };
  try {
    const error = await assertRejects(
      () =>
        applyNativeAppServices(host.layout, ENVIRONMENT_ID, [makeApp()], {
          ...opts,
          run: refuseOnce,
        }),
      Error,
    );
    assertStringIncludes(error.message, "Job for the unit failed");
    assertStringIncludes(
      error.message,
      `rolled back to release ${SERVING_RELEASE}`,
    );
    assertEquals(await current(), join("releases", SERVING_RELEASE));
    // Restarted again on the release that served, not left down (the refused
    // first restart never reached the mock).
    assertEquals(refused, true);
    assertEquals(
      mock.systemctl("restart").filter((unit) => unit === OWN_UNIT).length,
      1,
    );
  } finally {
    await host.cleanup();
  }
});

test("every serving app gets its release back before any app is prepared", async () => {
  const { host, opts, siteDir, current } = await servingHost();
  // A second app, serving too, whose release was also just published.
  const otherId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e90";
  const otherDir = join(dirname(siteDir), otherId);
  await Promise.all(
    [SERVING_RELEASE, NEW_RELEASE].map((release) =>
      Deno.mkdir(join(otherDir, "releases", release), { recursive: true })
    ),
  );
  await Deno.symlink(join("releases", NEW_RELEASE), join(otherDir, "current"));
  const mock = createRunMock();
  mock.activeUnits.add(OWN_UNIT);
  mock.activeUnits.add(nativeAppUnitName(otherId));
  let picks = 0;
  try {
    await assertRejects(
      () =>
        applyNativeAppServices(
          host.layout,
          ENVIRONMENT_ID,
          [
            makeApp(),
            makeApp({ composeServiceName: "api", serviceId: otherId }),
          ],
          {
            ...opts,
            run: mock.run,
            bindings: new Map([
              ...opts.bindings,
              ["api", {
                username: USERNAME,
                folder: folderFor(otherId),
                previousReleaseId: SERVING_RELEASE,
                releaseId: NEW_RELEASE,
              }],
            ]),
            // The first app's check copy gets a port; the second app fails.
            pickPort: () => {
              picks += 1;
              if (picks > 1) throw new Error("Address already in use");
              return CHECK_PORT;
            },
          },
        ),
      Error,
      "no free loopback port",
    );
    assertEquals(await current(), join("releases", SERVING_RELEASE));
    assertEquals(
      await Deno.readLink(join(otherDir, "current")),
      join("releases", SERVING_RELEASE),
    );
  } finally {
    await host.cleanup();
  }
});

test("a check copy that will not stop keeps its unit and marker; lifecycle stop retries", async () => {
  const host = await makeTestHost();
  const checkId = `${SERVICE_ID}-new`;
  const staged = join(
    nativeAppConfigDir(host.layout),
    "check",
    `tp-${ENVIRONMENT_ID}-${checkId}.service`,
  );
  const unitPath = nativeAppUnitPath(checkId, host.unitDir);
  try {
    await Deno.mkdir(dirname(staged), { recursive: true });
    await Deno.writeTextFile(staged, "");
    await Deno.writeTextFile(unitPath, "leftover");
    const busy = createRunMock();
    const refuseStop: RunFn = (command, args) =>
      args.includes("stop") && args.at(-1) === CHECK_UNIT
        ? Promise.resolve(fail("unit busy"))
        : busy.run(command, args);
    await applyNativeAppLifecycle(host.layout, ENVIRONMENT_ID, "stop", {
      run: refuseStop,
      systemdUnitDir: host.unitDir,
    });
    assertEquals((await Deno.stat(unitPath)).isFile, true);
    assertEquals((await Deno.stat(staged)).isFile, true);

    const mock = createRunMock();
    await applyNativeAppLifecycle(host.layout, ENVIRONMENT_ID, "stop", {
      run: mock.run,
      systemdUnitDir: host.unitDir,
    });
    await assertRejects(() => Deno.stat(unitPath));
    await assertRejects(() => Deno.stat(staged));
  } finally {
    await host.cleanup();
  }
});

test("the default port pick skips the control plane's band", () => {
  const offered = [18_080, 19_799, 18_500, 40_001];
  assertEquals(pickPortDefault(() => offered.shift() ?? 0), 40_001);
  assertThrows(() => pickPortDefault(() => 18_100), Error, "18080-19799");
});
