import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { COMMAND_LOG_PHASES } from "../../logs/contracts.ts";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import type { DecryptSecretsFn } from "../materialize-tls.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import {
  readReleaseManifest,
  writeReleaseManifest,
} from "./deployment-json.ts";
import {
  RELEASE_METADATA_DIRNAME,
  resolveDaemonReleasePaths,
  resolveReleasePaths,
} from "./release-layout.ts";
import { readCurrentReleaseId, swapCurrentSymlink } from "./promote.ts";
import {
  applySourceReleases,
  resolveReleaseServiceId,
} from "./apply-source-releases.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** The service folder the control plane plans for a service in these fixtures. */
function folderOf(serviceId: string, owner = "appuser") {
  return { owner, scope: "production", slug: serviceId };
}

/**
 * Stand-in for the privileged runner: `install -d` makes the folder for real
 * (under the temp layout), everything else succeeds.
 */
function folderRun(
  _command: string,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  if (args.includes("install") && args.includes("-d")) {
    try {
      Deno.mkdirSync(args[args.length - 1], { recursive: true });
    } catch {
      // Outside the temp layout (a default layout): nothing to make.
    }
  }
  return Promise.resolve({ success: true, stdout: "", stderr: "" });
}

function fakeLogSink(): {
  phases: string[];
  lines: Array<{ stream: "stdout" | "stderr"; message: string }>;
  sink: {
    onLine: (stream: "stdout" | "stderr", message: string) => void;
    setPhase: (phase: string) => void;
    addSecrets: (values: string[]) => void;
    redactSummary: (text: string) => string;
    finalize: () => Promise<void>;
  };
} {
  const phases: string[] = [];
  const lines: Array<{ stream: "stdout" | "stderr"; message: string }> = [];
  return {
    phases,
    lines,
    sink: {
      onLine(stream, message) {
        lines.push({ stream, message });
      },
      setPhase(phase) {
        phases.push(phase);
      },
      addSecrets() {},
      redactSummary(text) {
        return text;
      },
      finalize() {
        return Promise.resolve();
      },
    },
  };
}

function basePayload(
  overrides: Partial<EnvironmentDeployPayload> = {},
): EnvironmentDeployPayload {
  const payload: EnvironmentDeployPayload = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "test",
    composeFiles: [],
    hostings: [],
    ...overrides,
    ...(overrides.sourceMaterial
      ? { sourceMaterial: withServiceIds(overrides) }
      : {}),
  };
  return overrides.serviceFolders === undefined && payload.sourceMaterial
    ? { ...payload, serviceFolders: plannedFolders(payload) }
    : payload;
}

/** A sourced service with an owner is keyed by a service UUID, never its compose name. */
function withServiceIds(
  payload: Partial<EnvironmentDeployPayload>,
): EnvironmentDeploySource[] {
  return (payload.sourceMaterial ?? []).map((entry) =>
    entry.releaseServiceId === undefined &&
      resolveReleaseServiceId(
          {
            ...payload,
            composeFiles: [],
            hostings: payload.hostings ?? [],
          } as EnvironmentDeployPayload,
          entry.composeServiceName,
        ) === entry.composeServiceName
      ? { ...entry, releaseServiceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c0000ff" }
      : entry
  );
}

function plannedFolders(
  payload: Partial<EnvironmentDeployPayload>,
): NonNullable<EnvironmentDeployPayload["serviceFolders"]> {
  const full = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "test",
    composeFiles: [],
    hostings: [],
    ...payload,
  } as EnvironmentDeployPayload;
  return (payload.sourceMaterial ?? []).filter((entry) => entry.principal)
    .map((entry) => {
      const serviceId = resolveReleaseServiceId(full, entry.composeServiceName);
      return {
        serviceId,
        folder: folderOf(serviceId, entry.principal?.username),
      };
    });
}

function baseSource(
  overrides: Partial<EnvironmentDeploySource> = {},
): EnvironmentDeploySource {
  return {
    sourceId: "src-1",
    composeServiceName: "web",
    provider: "github",
    cloneUrl: "https://github.com/example/repo.git",
    ref: "main",
    commitSha: "abc123def456",
    releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000001",
    build: { kind: "native" },
    ...overrides,
  };
}

function layoutFromFixture(
  fixture: Awaited<ReturnType<typeof createTempLayout>>,
) {
  const principalHomeRoot = join(fixture.dirs.stateDir, "principal-homes");
  return resolveLayout({
    ...fixture.env,
    TURBOPANEL_PRINCIPAL_HOME_ROOT: principalHomeRoot,
  });
}

async function mkdirReleaseTree(
  paths: {
    sitesDir: string;
    siteDir: string;
    releasesDir: string;
    sharedDir: string;
    releaseDir: string;
  },
): Promise<void> {
  await Promise.all(
    [
      paths.sitesDir,
      paths.siteDir,
      paths.releasesDir,
      paths.sharedDir,
      paths.releaseDir,
    ].map((dir) => Deno.mkdir(dir, { recursive: true })),
  );
}

test("resolveReleaseServiceId prefers sourceMaterial releaseServiceId", () => {
  const payload = basePayload({
    hostings: [{
      hostingId: "host-1",
      composeServiceName: "web",
      serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000002",
      hostnames: ["app.example.com"],
    }],
    sourceMaterial: [
      baseSource({
        composeServiceName: "web",
        releaseServiceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000003",
      }),
    ],
  });
  assertEquals(
    resolveReleaseServiceId(payload, "web"),
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c000003",
  );
});

test("resolveReleaseServiceId uses nativeAppServices when releaseServiceId absent", () => {
  const payload = basePayload({
    nativeAppServices: [{
      composeServiceName: "app",
      serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000004",
      listenPort: 18080,
      framework: "auto",
    }],
  });
  assertEquals(
    resolveReleaseServiceId(payload, "app"),
    "019e0a1b-7c3d-7a52-9b4e-3f1a2c000004",
  );
});

test("resolveReleaseServiceId uses compose service name when unmatched", () => {
  const payload = basePayload({ hostings: [], ingressServices: [] });
  assertEquals(resolveReleaseServiceId(payload, "worker"), "worker");
});

test("resolveReleaseServiceId keys a git worker from releaseServiceId without nativeAppServices", () => {
  const envServiceId = "00000000-0000-4000-8000-0000000000c1";
  const payload = basePayload({
    sourceMaterial: [
      baseSource({
        composeServiceName: "worker",
        releaseServiceId: envServiceId,
      }),
    ],
  });
  assertEquals(resolveReleaseServiceId(payload, "worker"), envServiceId);
});

test("resolveReleaseServiceId treats empty hosting and ingress arrays as absent", () => {
  const payload = basePayload({ hostings: [], ingressServices: [] });
  assertEquals(resolveReleaseServiceId(payload, "web"), "web");
});

test("applySourceReleases returns empty for missing sourceMaterial", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const log = fakeLogSink();
      const applied = await applySourceReleases(layout, basePayload(), {
        logSink: log.sink,
        decryptSecrets: undefined,
      });
      assertEquals(applied, []);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases skips principal-less native entries with a transcript line", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [baseSource({ composeServiceName: "api" })],
        }),
        { logSink: log.sink, decryptSecrets: undefined },
      );
      assertEquals(applied, []);
      assertEquals(
        log.lines.some((line) =>
          line.stream === "stderr" &&
          line.message.includes(
            "release skipped for api: no project principal assigned",
          )
        ),
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases promotes native releases with injected checkout/build/promote", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c000005";
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId,
        folder: folderOf(serviceId),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
      });
      await mkdirReleaseTree(paths);

      let pruneCalled = false;
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-native",
            composeServiceName: "web",
            serviceId,
            hostnames: ["app.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              composeServiceName: "web",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
              releaseServiceId: serviceId,
              principal: {
                principalId: "pr-1",
                username: "appuser",
                uid: 2000,
                gid: 2001,
              },
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "web",
            serviceId,
            listenPort: 3000,
            framework: "next",
          }],
        }),
        {
          logSink: log.sink,
          decryptSecrets: undefined,
          now: () => "2026-01-01T00:00:00.000Z",
          runFn: folderRun,
          checkoutReleaseFn: async (params) => {
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            await Deno.writeTextFile(join(workingDir, "index.html"), "built");
            return { workingDir, commitSha: "resolved-commit" };
          },
          runReleaseBuildFn: () => Promise.resolve(),
          prepareNativeAppBuildOutputFn: () =>
            Promise.resolve({
              standaloneOutput: true,
              staticExport: false,
              outputDirectory: undefined,
            }),
          promoteReleaseFn: async (params) => {
            await Deno.writeTextFile(
              join(params.paths.releaseDir, "index.html"),
              "published",
            );
            await writeReleaseManifest(params.paths.releaseDir, {
              version: 1,
              serviceId,
              composeServiceName: "web",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
              sourceId: "src-1",
              commitSha: "resolved-commit",
              ref: "main",
              promotedAt: "2026-01-01T00:00:00.000Z",
              standaloneOutput: true,
              staticExport: false,
            });
            await swapCurrentSymlink(params.paths);
            return params.paths.releaseDir;
          },
          pruneReleasesFn: () => {
            pruneCalled = true;
            return Promise.resolve(["019e0a1b-7c3d-7a52-9b4e-3f1a2c000007"]);
          },
        },
      );

      assertEquals(applied.length, 1);
      const row = applied[0];
      if (!row) throw new TypeError("expected one applied release");
      assertEquals(row.serviceId, serviceId);
      assertEquals(row.commitSha, "resolved-commit");
      assertEquals(row.standaloneOutput, true);
      assertEquals(row.staticExport, false);
      assertEquals(row.previousReleaseId, null);
      assertEquals(pruneCalled, true);
      assertEquals(
        log.phases.includes(COMMAND_LOG_PHASES.FETCH),
        true,
      );
      assertEquals(
        log.phases.includes(COMMAND_LOG_PHASES.BUILD),
        true,
      );
      assertEquals(
        log.phases.includes(COMMAND_LOG_PHASES.RELEASE_PROMOTE),
        true,
      );
      assertEquals(
        log.lines.some((line) => line.message.includes("pruned 1 superseded")),
        true,
      );
      try {
        await Deno.stat(paths.scratchDir);
        throw new Error("scratch dir should be removed");
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases publishes a serving Node app's release without moving current", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c000005";
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId,
        folder: folderOf(serviceId),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
      });
      await mkdirReleaseTree(paths);

      const asked: string[] = [];
      const keepCurrent: boolean[] = [];
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-native",
            composeServiceName: "web",
            serviceId,
            hostnames: ["app.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              composeServiceName: "web",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
              releaseServiceId: serviceId,
              principal: {
                principalId: "pr-1",
                username: "appuser",
                uid: 2000,
                gid: 2001,
              },
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "web",
            serviceId,
            listenPort: 3000,
            framework: "next",
          }],
        }),
        {
          logSink: log.sink,
          decryptSecrets: undefined,
          now: () => "2026-01-01T00:00:00.000Z",
          runFn: folderRun,
          checkoutReleaseFn: async (params) => {
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            await Deno.writeTextFile(join(workingDir, "index.html"), "built");
            return { workingDir, commitSha: "resolved-commit" };
          },
          runReleaseBuildFn: () => Promise.resolve(),
          prepareNativeAppBuildOutputFn: () =>
            Promise.resolve({
              standaloneOutput: true,
              staticExport: false,
              outputDirectory: undefined,
            }),
          holdCurrent: (service) => {
            asked.push(service.composeServiceName + "/" + service.serviceId);
            return Promise.resolve(true);
          },
          promoteReleaseFn: async (params) => {
            keepCurrent.push(params.keepCurrent === true);
            await Deno.writeTextFile(
              join(params.paths.releaseDir, "index.html"),
              "published",
            );
            await writeReleaseManifest(params.paths.releaseDir, {
              version: 1,
              serviceId,
              composeServiceName: "web",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
              sourceId: "src-1",
              commitSha: "resolved-commit",
              ref: "main",
              promotedAt: "2026-01-01T00:00:00.000Z",
              standaloneOutput: true,
              staticExport: false,
            });
            if (params.keepCurrent !== true) {
              await swapCurrentSymlink(params.paths);
            }
            return params.paths.releaseDir;
          },
          pruneReleasesFn: () =>
            Promise.resolve(["019e0a1b-7c3d-7a52-9b4e-3f1a2c000007"]),
        },
      );

      assertEquals(applied.length, 1);
      // Serving: published beside, `current` left on the release serving.
      assertEquals(asked, [`web/${serviceId}`]);
      assertEquals(keepCurrent, [true]);
      assertEquals(applied[0].heldCurrent, true);
      assertEquals(await readCurrentReleaseId(paths), null);
      assertEquals(
        log.lines.some((line) =>
          line.message.includes("takes traffic once it answers")
        ),
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases never holds current for a static export", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c000005";
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId,
        folder: folderOf(serviceId),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
      });
      await mkdirReleaseTree(paths);

      const asked: string[] = [];
      const keepCurrent: boolean[] = [];
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-native",
            composeServiceName: "web",
            serviceId,
            hostnames: ["app.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              composeServiceName: "web",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
              releaseServiceId: serviceId,
              principal: {
                principalId: "pr-1",
                username: "appuser",
                uid: 2000,
                gid: 2001,
              },
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "web",
            serviceId,
            listenPort: 3000,
            framework: "next",
          }],
        }),
        {
          logSink: log.sink,
          decryptSecrets: undefined,
          now: () => "2026-01-01T00:00:00.000Z",
          runFn: folderRun,
          checkoutReleaseFn: async (params) => {
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            await Deno.writeTextFile(join(workingDir, "index.html"), "built");
            return { workingDir, commitSha: "resolved-commit" };
          },
          runReleaseBuildFn: () => Promise.resolve(),
          prepareNativeAppBuildOutputFn: () =>
            Promise.resolve({
              standaloneOutput: false,
              staticExport: true,
              outputDirectory: undefined,
            }),
          holdCurrent: (service) => {
            asked.push(service.composeServiceName + "/" + service.serviceId);
            return Promise.resolve(true);
          },
          promoteReleaseFn: async (params) => {
            keepCurrent.push(params.keepCurrent === true);
            await Deno.writeTextFile(
              join(params.paths.releaseDir, "index.html"),
              "published",
            );
            await writeReleaseManifest(params.paths.releaseDir, {
              version: 1,
              serviceId,
              composeServiceName: "web",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
              sourceId: "src-1",
              commitSha: "resolved-commit",
              ref: "main",
              promotedAt: "2026-01-01T00:00:00.000Z",
              standaloneOutput: true,
              staticExport: false,
            });
            if (params.keepCurrent !== true) {
              await swapCurrentSymlink(params.paths);
            }
            return params.paths.releaseDir;
          },
          pruneReleasesFn: () =>
            Promise.resolve(["019e0a1b-7c3d-7a52-9b4e-3f1a2c000007"]),
        },
      );

      assertEquals(applied.length, 1);
      // A static export leaves the Node app lane: never held.
      assertEquals(asked, []);
      assertEquals(keepCurrent, [false]);
      assertEquals(applied[0].heldCurrent, undefined);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases builds a service with a folder inside it, publishing by components", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c4d";
      const folder = {
        owner: "appuser",
        scope: "production",
        slug: "shop.test",
      };
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId,
        releaseId: "0192a8f4-3c1e-7a52-9b0d-000000000099",
        folder,
      });
      await mkdirReleaseTree(paths);

      const calls: string[][] = [];
      const seen: Array<typeof paths> = [];
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-native",
            composeServiceName: "web",
            serviceId,
            hostnames: ["app.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              composeServiceName: "web",
              releaseId: "0192a8f4-3c1e-7a52-9b0d-000000000099",
              releaseServiceId: serviceId,
              principal: {
                principalId: "pr-1",
                username: "appuser",
                uid: 2000,
                gid: 2001,
              },
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "web",
            serviceId,
            listenPort: 3000,
            framework: "next",
          }],
          serviceFolders: [{ serviceId, folder }],
        }),
        {
          logSink: log.sink,
          runFn: (command, args) => {
            calls.push([command, ...args]);
            return Promise.resolve({ success: true, stdout: "", stderr: "" });
          },
          decryptSecrets: undefined,
          now: () => "2026-01-01T00:00:00.000Z",

          checkoutReleaseFn: async (params) => {
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            await Deno.writeTextFile(join(workingDir, "index.html"), "built");
            return { workingDir, commitSha: "resolved-commit" };
          },
          runReleaseBuildFn: () => Promise.resolve(),
          prepareNativeAppBuildOutputFn: () =>
            Promise.resolve({
              standaloneOutput: true,
              staticExport: false,
              outputDirectory: undefined,
            }),
          promoteReleaseFn: async (params) => {
            seen.push(params.paths);
            await Deno.writeTextFile(
              join(params.paths.releaseDir, "index.html"),
              "published",
            );
            await writeReleaseManifest(params.paths.releaseDir, {
              version: 1,
              serviceId,
              composeServiceName: "web",
              releaseId: "0192a8f4-3c1e-7a52-9b0d-000000000099",
              sourceId: "src-1",
              commitSha: "resolved-commit",
              ref: "main",
              promotedAt: "2026-01-01T00:00:00.000Z",
              standaloneOutput: true,
              staticExport: false,
            });
            await swapCurrentSymlink(params.paths);
            return params.paths.releaseDir;
          },
          pruneReleasesFn: () => {
            calls.push(["prune"]);
            return Promise.resolve(["019e0a1b-7c3d-7a52-9b4e-3f1a2c000007"]);
          },
        },
      );

      assertEquals(applied.length, 1);
      assertEquals(applied[0]?.serviceId, serviceId);
      assertEquals(seen[0]?.publish, {
        folder,
        serviceId,
        releaseId: "0192a8f4-3c1e-7a52-9b0d-000000000099",
        publishId: seen[0]?.publish?.publishId ?? "",
      });
      assertEquals(
        seen[0]?.releaseDir,
        join(
          layout.principalHomeRoot,
          "appuser",
          "production",
          "services",
          "shop.test",
          "releases",
          "0192a8f4-3c1e-7a52-9b0d-000000000099",
        ),
      );
      // The folder is made through the one install seam, scope tree first.
      const made = calls.filter((c) => c.includes("install")).map((c) =>
        c.at(-1)
      );
      assertEquals(
        made[0],
        join(layout.principalHomeRoot, "appuser", "production"),
      );
      assertEquals(
        made.includes(
          join(
            layout.principalHomeRoot,
            "appuser",
            "production",
            "services",
            "shop.test",
            "logs",
          ),
        ),
        true,
      );
      // And the components it was first made with are on record.
      const record = JSON.parse(
        await Deno.readTextFile(
          join(layout.daemonStateDir, "folders", `${serviceId}.json`),
        ),
      );
      assertEquals(record.slug, "shop.test");
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases removes scratch dir after a failed native promote", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000008",
        folder: folderOf("019e0a1b-7c3d-7a52-9b4e-3f1a2c000008"),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000009",
      });

      const log = fakeLogSink();
      await assertRejects(
        () =>
          applySourceReleases(
            layout,
            basePayload({
              hostings: [{
                hostingId: "host-fail",
                composeServiceName: "web",
                serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000008",
                hostnames: ["fail.example.com"],
              }],
              sourceMaterial: [
                baseSource({
                  composeServiceName: "web",
                  releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000009",
                  principal: {
                    principalId: "pr-1",
                    username: "appuser",
                    uid: 2000,
                    gid: 2001,
                  },
                }),
              ],
            }),
            {
              logSink: log.sink,
              decryptSecrets: undefined,
              runFn: folderRun,
              checkoutReleaseFn: async (params) => {
                const workingDir = join(params.scratchDir, "source");
                await Deno.mkdir(workingDir, { recursive: true });
                return { workingDir, commitSha: "deadbeef" };
              },
              runReleaseBuildFn: () => Promise.resolve(),
              promoteReleaseFn: () => {
                throw new Error("probe failed");
              },
            },
          ),
        Error,
        "probe failed",
      );

      try {
        await Deno.stat(paths.scratchDir);
        throw new Error("scratch dir should be removed after failure");
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases rejects clone credentials when decrypt is unavailable", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const log = fakeLogSink();
      await assertRejects(
        () =>
          applySourceReleases(
            layout,
            basePayload({
              sourceMaterial: [
                baseSource({
                  credential: "tpdaemon.sealed",
                  principal: {
                    principalId: "pr-1",
                    username: "appuser",
                    uid: 2000,
                    gid: 2001,
                  },
                }),
              ],
            }),
            {
              logSink: log.sink,
              decryptSecrets: undefined,
              runFn: folderRun,
            },
          ),
        Error,
        "secrets decrypt is unavailable",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases rejects empty decrypted clone credentials", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const log = fakeLogSink();
      const decryptSecrets: DecryptSecretsFn = () => Promise.resolve([""]);
      await assertRejects(
        () =>
          applySourceReleases(
            layout,
            basePayload({
              sourceMaterial: [
                baseSource({
                  credential: "tpdaemon.sealed",
                  principal: {
                    principalId: "pr-1",
                    username: "appuser",
                    uid: 2000,
                    gid: 2001,
                  },
                }),
              ],
            }),
            {
              logSink: log.sink,
              decryptSecrets,
              runFn: folderRun,
            },
          ),
        Error,
        "clone credential could not be decrypted",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases rolls back native releases without fetch or build", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000a";
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId,
        folder: folderOf(serviceId),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000007",
      });
      await mkdirReleaseTree(paths);
      await Deno.writeTextFile(join(paths.releaseDir, "index.html"), "old");
      const recordDir = resolveDaemonReleasePaths(layout, {
        serviceId,
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000007",
      }).releaseDir;
      await Deno.mkdir(recordDir, { recursive: true });
      await writeReleaseManifest(recordDir, {
        version: 1,
        serviceId,
        composeServiceName: "web",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000007",
        sourceId: "src-1",
        commitSha: "old-commit",
        ref: "main",
        promotedAt: "2025-12-01T00:00:00.000Z",
        standaloneOutput: false,
        staticExport: true,
        nativeStart: { kind: "next-start" },
      });

      let checkoutCalled = false;
      let buildCalled = false;
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-roll",
            composeServiceName: "web",
            serviceId,
            hostnames: ["roll.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
              rollbackToReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000007",
              releaseServiceId: serviceId,
              commitSha: "wire-placeholder",
              principal: {
                principalId: "pr-1",
                username: "appuser",
                uid: 2000,
                gid: 2001,
              },
            }),
          ],
        }),
        {
          logSink: log.sink,
          decryptSecrets: undefined,
          checkoutReleaseFn: () => {
            checkoutCalled = true;
            return Promise.resolve({
              workingDir: "/tmp/nope",
              commitSha: "nope",
            });
          },
          runReleaseBuildFn: () => {
            buildCalled = true;
            return Promise.resolve();
          },
          promoteExistingReleaseFn: async (params) => {
            await swapCurrentSymlink(params.paths);
            return params.paths.releaseDir;
          },
        },
      );

      assertEquals(checkoutCalled, false);
      assertEquals(buildCalled, false);
      assertEquals(applied.length, 1);
      const row = applied[0];
      if (!row) throw new TypeError("expected rollback row");
      assertEquals(row.releaseId, "019e0a1b-7c3d-7a52-9b4e-3f1a2c000007");
      assertEquals(row.commitSha, "old-commit");
      assertEquals(row.staticExport, true);
      assertEquals(row.standaloneOutput, false);
      // How the old release started comes back from its record, not a guess.
      assertEquals(row.nativeStart, { kind: "next-start" });
      assertEquals(
        log.phases.includes(COMMAND_LOG_PHASES.FETCH),
        false,
      );
      assertEquals(
        log.phases.includes(COMMAND_LOG_PHASES.BUILD),
        false,
      );
      assertEquals(
        log.phases.includes(COMMAND_LOG_PHASES.RELEASE_PROMOTE),
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases fails rollback when the target release is missing", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const log = fakeLogSink();
      const recordDir = resolveDaemonReleasePaths(layout, {
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c0000ff",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000b",
      }).releaseDir;
      await Deno.mkdir(recordDir, { recursive: true });
      await writeReleaseManifest(recordDir, {
        version: 1,
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c0000ff",
        composeServiceName: "web",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000b",
        sourceId: "src-1",
        commitSha: "pruned-commit",
        ref: "main",
        promotedAt: "2025-12-01T00:00:00.000Z",
      });
      await assertRejects(
        () =>
          applySourceReleases(
            layout,
            basePayload({
              sourceMaterial: [
                baseSource({
                  rollbackToReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000b",
                  principal: {
                    principalId: "pr-1",
                    username: "appuser",
                    uid: 2000,
                    gid: 2001,
                  },
                }),
              ],
            }),
            {
              logSink: log.sink,
              decryptSecrets: undefined,
              promoteExistingReleaseFn: async (params) => {
                const stat = await Deno.stat(params.paths.releaseDir).catch(
                  () => null,
                );
                if (!stat) {
                  throw new Error(
                    `release ${params.releaseId} is not present on this host`,
                  );
                }
                return params.paths.releaseDir;
              },
            },
          ),
        Error,
        "is not present on this host",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases rolls back image-build releases from daemon record manifests", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000c";
      const recordPaths = resolveDaemonReleasePaths(layout, {
        serviceId,
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000d",
      });
      await Deno.mkdir(recordPaths.releaseDir, { recursive: true });
      await writeReleaseManifest(recordPaths.releaseDir, {
        version: 1,
        serviceId,
        composeServiceName: "web",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000d",
        sourceId: "src-1",
        commitSha: "rail-commit",
        ref: "main",
        promotedAt: "2026-01-01T00:00:00.000Z",
        imageTag:
          "turbopanel-app/019e0a1b-7c3d-7a52-9b4e-3f1a2c00000c:019e0a1b-7c3d-7a52-9b4e-3f1a2c00000d",
        imageDigest: "sha256:abc",
        builderFrontendVersion: "0.2.0",
        builderPlanVersion: "0.1.0",
      });

      let promoteExistingCalled = false;
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-rail",
            composeServiceName: "web",
            serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000c",
            hostnames: ["rail.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              composeServiceName: "web",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000006",
              rollbackToReleaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000d",
              releaseServiceId: serviceId,
              build: { kind: "railpack" },
            }),
          ],
        }),
        {
          logSink: log.sink,
          decryptSecrets: undefined,
          promoteExistingReleaseFn: () => {
            promoteExistingCalled = true;
            return Promise.resolve(recordPaths.releaseDir);
          },
        },
      );

      assertEquals(promoteExistingCalled, false);
      assertEquals(applied.length, 1);
      const row = applied[0];
      if (!row) throw new TypeError("expected image-build rollback row");
      assertEquals(
        row.imageTag,
        "turbopanel-app/019e0a1b-7c3d-7a52-9b4e-3f1a2c00000c:019e0a1b-7c3d-7a52-9b4e-3f1a2c00000d",
      );
      assertEquals(row.commitSha, "rail-commit");
      assertEquals(row.builderFrontendVersion, "0.2.0");
      assertEquals(
        log.lines.some((line) =>
          line.message.includes("(image turbopanel-app")
        ),
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases builds image-build releases without a project principal", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000e";
      const paths = resolveDaemonReleasePaths(layout, {
        serviceId,
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000f",
      });

      let pruneCalled = false;
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [
            baseSource({
              composeServiceName: "api",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c00000f",
              releaseServiceId: serviceId,
              build: { kind: "image" },
            }),
          ],
        }),
        {
          logSink: log.sink,
          decryptSecrets: undefined,
          now: () => "2026-01-02T00:00:00.000Z",
          ensureDaemonReleaseRecordDirFn: async (treePaths) => {
            await Deno.mkdir(treePaths.releaseDir, { recursive: true });
          },
          checkoutReleaseFn: async (params) => {
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            return { workingDir, commitSha: "pack-commit" };
          },
          ensureBuildkitImageBuildFn: () =>
            Promise.resolve({
              planner: "/tmp/railpack",
              buildctl: "/tmp/buildctl",
              buildkitd: "/tmp/buildkitd",
              frontendLayoutDir: "/tmp/frontend",
              frontendDigest: "sha256:front",
            }),
          // A development host: the prepare step runs unsandboxed here.
          sandboxedBuilds: false,
          runImageBuildBuildFn: () =>
            Promise.resolve({
              imageTag:
                "turbopanel-app/api:019e0a1b-7c3d-7a52-9b4e-3f1a2c00000f",
              imageDigest: "sha256:pack",
              builderFrontendVersion: "0.3.0",
              builderPlanVersion: "0.2.0",
            }),
          recordImageBuildReleaseFn: async ({ paths: record, manifest }) => {
            await Deno.mkdir(
              join(record.releaseDir, RELEASE_METADATA_DIRNAME),
              { recursive: true },
            );
            await writeReleaseManifest(record.releaseDir, manifest);
            return record.releaseDir;
          },
          pruneReleasesFn: () => {
            pruneCalled = true;
            return Promise.resolve([]);
          },
        },
      );

      assertEquals(applied.length, 1);
      const row = applied[0];
      if (!row) throw new TypeError("expected image-build row");
      assertEquals(
        row.imageTag,
        "turbopanel-app/api:019e0a1b-7c3d-7a52-9b4e-3f1a2c00000f",
      );
      assertEquals(row.commitSha, "pack-commit");
      assertEquals(row.previousReleaseId, null);
      assertEquals(pruneCalled, true);
      try {
        await Deno.stat(paths.scratchDir);
        throw new Error("scratch dir should be removed");
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases propagates staticExport from native app build shaping", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c000010";
      const paths = resolveReleasePaths(layout, {
        username: "siteuser",
        serviceId,
        folder: folderOf(serviceId, "siteuser"),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000011",
      });

      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-static",
            composeServiceName: "web",
            serviceId,
            hostnames: ["static.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000011",
              principal: {
                principalId: "pr-2",
                username: "siteuser",
                uid: 2100,
                gid: 2101,
              },
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "web",
            serviceId,
            listenPort: 3001,
            framework: "next",
          }],
        }),
        {
          logSink: fakeLogSink().sink,
          decryptSecrets: undefined,
          runFn: folderRun,
          checkoutReleaseFn: async (params) => {
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            return { workingDir, commitSha: "static-commit" };
          },
          runReleaseBuildFn: () => Promise.resolve(),
          prepareNativeAppBuildOutputFn: () =>
            Promise.resolve({
              standaloneOutput: false,
              staticExport: true,
              outputDirectory: "out",
            }),
          promoteReleaseFn: async (params) => {
            await swapCurrentSymlink(params.paths);
            return params.paths.releaseDir;
          },
          pruneReleasesFn: () => Promise.resolve([]),
        },
      );

      assertEquals(applied[0]?.staticExport, true);
      assertEquals(applied[0]?.standaloneOutput, false);
      assertEquals(applied[0]?.commitSha, "static-commit");
      try {
        await Deno.stat(paths.scratchDir);
        throw new Error("scratch dir should be removed");
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

/**
 * Apply one Next release whose build produced a standalone tree, with the
 * author's `startCommand`. Returns what the apply did so a test can check
 * whether the release was promoted and what the build recorded.
 */
async function applyStandaloneRelease(
  layout: ReturnType<typeof layoutFromFixture>,
  startCommand: string | undefined,
  startupFile?: string,
): Promise<{
  result: ReturnType<typeof applySourceReleases>;
  promoted: () => boolean;
  detectStart: () => boolean | undefined;
}> {
  const serviceId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c000012";
  const log = fakeLogSink();
  let detectStart: boolean | undefined;
  let promoted = false;
  const result = applySourceReleases(
    layout,
    basePayload({
      hostings: [{
        hostingId: "host-standalone",
        composeServiceName: "web",
        serviceId,
        hostnames: ["standalone.example.com"],
      }],
      sourceMaterial: [
        baseSource({
          releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000013",
          principal: {
            principalId: "pr-3",
            username: "siteuser",
            uid: 2100,
            gid: 2101,
          },
          build: { kind: "native", startCommand },
        }),
      ],
      nativeAppServices: [{
        composeServiceName: "web",
        serviceId,
        listenPort: 3002,
        framework: "next",
        startupFile,
      }],
    }),
    {
      logSink: log.sink,
      decryptSecrets: undefined,
      runFn: folderRun,
      checkoutReleaseFn: async (params) => {
        const workingDir = join(params.scratchDir, "source");
        await Deno.mkdir(workingDir, { recursive: true });
        return { workingDir, commitSha: "standalone-commit" };
      },
      runReleaseBuildFn: () => Promise.resolve(),
      prepareNativeAppBuildOutputFn: (context) => {
        detectStart = context.detectStart;
        return Promise.resolve({
          standaloneOutput: true,
          staticExport: false,
          outputDirectory: ".next/standalone",
        });
      },
      promoteReleaseFn: async (params) => {
        promoted = true;
        await swapCurrentSymlink(params.paths);
        return params.paths.releaseDir;
      },
      pruneReleasesFn: () => Promise.resolve([]),
    },
  );
  // Settle before returning so a rejection is observed by the caller's
  // `assertRejects`, not reported as unhandled.
  await result.catch(() => undefined);
  return {
    result,
    promoted: () => promoted,
    detectStart: () => detectStart,
  };
}

const NO_NEXT_COMMAND = 'has no "next" command and no package scripts';
const NO_SUCH_PATH = "points at a path that does not exist there";

for (
  const [startCommand, reason] of [
    ["pnpm start", NO_NEXT_COMMAND],
    ["npm start -- -p 3000", NO_NEXT_COMMAND],
    ["corepack pnpm run start", NO_NEXT_COMMAND],
    ["npm run-script start", NO_NEXT_COMMAND],
    ["npx next start -p 3000", NO_NEXT_COMMAND],
    ["./node_modules/.bin/next start", NO_NEXT_COMMAND],
    ["node .next/standalone/server.js", NO_SUCH_PATH],
  ] as const
) {
  test(`a standalone build fails before promotion when the start command is "${startCommand}"`, async () => {
    await createTempLayout().then(async (fixture) => {
      try {
        const layout = layoutFromFixture(fixture);
        const apply = await applyStandaloneRelease(layout, startCommand);
        const err = await assertRejects(() => apply.result, Error);
        assertStringIncludes(err.message, `start command "${startCommand}"`);
        assertStringIncludes(err.message, reason);
        assertStringIncludes(
          err.message,
          "Clear the start command and the app starts with node server.js.",
        );
        assertEquals(apply.promoted(), false);
        // Nothing was promoted, so nothing was recorded for a rollback either.
        const record = await readReleaseManifest(
          resolveDaemonReleasePaths(layout, {
            serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000012",
            releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000013",
          }).releaseDir,
        );
        assertEquals(record, null);
      } finally {
        await fixture.cleanup();
      }
    });
  });
}

test("a standalone build fails before promotion when the startup file points under .next/standalone/", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const apply = await applyStandaloneRelease(
        layout,
        undefined,
        ".next/standalone/server.js",
      );
      const err = await assertRejects(() => apply.result, Error);
      assertStringIncludes(
        err.message,
        'startup file ".next/standalone/server.js"',
      );
      assertStringIncludes(err.message, NO_SUCH_PATH);
      assertEquals(apply.promoted(), false);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("a standalone build keeps an author start command that runs server.js, and records no detected start", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const apply = await applyStandaloneRelease(
        layout,
        "PORT=3002 node server.js",
      );
      const applied = await apply.result;
      assertEquals(apply.detectStart(), false);
      assertEquals(apply.promoted(), true);
      assertEquals(applied[0]?.nativeStart, undefined);
      // The author's start command is recorded, so a rollback to this
      // release would start it the same way.
      const record = await readReleaseManifest(
        resolveDaemonReleasePaths(layout, {
          serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000012",
          releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000013",
        }).releaseDir,
      );
      assertEquals(record?.startCommand, "PORT=3002 node server.js");
      assertEquals(record?.startupFile, undefined);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("shared principal keeps separate release trees per nativeAppServices serviceId", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const principal = {
        principalId: "pr-1",
        username: "appuser",
        uid: 2000,
        gid: 2001,
      };
      const serviceA = "019e0a1b-7c3d-7a52-9b4e-3f1a2c000014";
      const serviceB = "019e0a1b-7c3d-7a52-9b4e-3f1a2c000015";
      const pathsA = resolveReleasePaths(layout, {
        username: principal.username,
        serviceId: serviceA,
        folder: folderOf(serviceA),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000016",
      });
      const pathsB = resolveReleasePaths(layout, {
        username: principal.username,
        serviceId: serviceB,
        folder: folderOf(serviceB),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000017",
      });
      await mkdirReleaseTree(pathsA);
      await mkdirReleaseTree(pathsB);
      await mkdirReleaseTree(
        resolveReleasePaths(layout, {
          username: principal.username,
          serviceId: serviceB,
          folder: folderOf(serviceB),
          releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000018",
        }),
      );

      const sharedPromote = (
        marker: string,
        serviceId: string,
        releaseId: string,
        composeServiceName: string,
      ) =>
      async (params: {
        paths: ReturnType<typeof resolveReleasePaths>;
      }) => {
        await Deno.writeTextFile(
          join(params.paths.releaseDir, "branch.txt"),
          marker,
        );
        await writeReleaseManifest(params.paths.releaseDir, {
          version: 1,
          serviceId,
          composeServiceName,
          releaseId,
          sourceId: "src-1",
          commitSha: "commit",
          ref: "main",
          promotedAt: "2026-01-01T00:00:00.000Z",
          standaloneOutput: false,
          staticExport: false,
        });
        await swapCurrentSymlink(params.paths);
        return params.paths.releaseDir;
      };

      const baseDeps = () => ({
        logSink: fakeLogSink().sink,
        decryptSecrets: undefined as DecryptSecretsFn | undefined,
        now: () => "2026-01-01T00:00:00.000Z",
        runFn: folderRun,
        checkoutReleaseFn: async (params: { scratchDir: string }) => {
          const workingDir = join(params.scratchDir, "source");
          await Deno.mkdir(workingDir, { recursive: true });
          return { workingDir, commitSha: "commit" };
        },
        runReleaseBuildFn: () => Promise.resolve(),
        prepareNativeAppBuildOutputFn: () =>
          Promise.resolve({
            standaloneOutput: false,
            staticExport: false,
            outputDirectory: undefined,
          }),
        pruneReleasesFn: () => Promise.resolve([]),
      });

      await applySourceReleases(
        layout,
        basePayload({
          environmentId: "env-production",
          sourceMaterial: [
            baseSource({
              composeServiceName: "app",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000016",
              releaseServiceId: serviceA,
              principal,
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "app",
            serviceId: serviceA,
            listenPort: 18080,
            framework: "auto",
          }],
        }),
        {
          ...baseDeps(),
          promoteReleaseFn: sharedPromote(
            "main",
            serviceA,
            "019e0a1b-7c3d-7a52-9b4e-3f1a2c000016",
            "app",
          ),
        },
      );

      await applySourceReleases(
        layout,
        basePayload({
          environmentId: "env-staging",
          sourceMaterial: [
            baseSource({
              composeServiceName: "app",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000017",
              releaseServiceId: serviceB,
              principal,
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "app",
            serviceId: serviceB,
            listenPort: 18081,
            framework: "auto",
          }],
        }),
        {
          ...baseDeps(),
          promoteReleaseFn: sharedPromote(
            "branch-a",
            serviceB,
            "019e0a1b-7c3d-7a52-9b4e-3f1a2c000017",
            "app",
          ),
        },
      );

      assertEquals(
        await Deno.readTextFile(join(pathsA.releaseDir, "branch.txt")),
        "main",
      );
      assertEquals(
        await Deno.readTextFile(join(pathsB.releaseDir, "branch.txt")),
        "branch-a",
      );

      await applySourceReleases(
        layout,
        basePayload({
          environmentId: "env-staging",
          sourceMaterial: [
            baseSource({
              composeServiceName: "app",
              releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000018",
              releaseServiceId: serviceB,
              principal,
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "app",
            serviceId: serviceB,
            listenPort: 18081,
            framework: "auto",
          }],
        }),
        {
          ...baseDeps(),
          promoteReleaseFn: sharedPromote(
            "branch-b",
            serviceB,
            "019e0a1b-7c3d-7a52-9b4e-3f1a2c000018",
            "app",
          ),
        },
      );

      assertEquals(
        await Deno.readTextFile(join(pathsA.releaseDir, "branch.txt")),
        "main",
      );
      const pathsB2 = resolveReleasePaths(layout, {
        username: principal.username,
        serviceId: serviceB,
        folder: folderOf(serviceB),
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000018",
      });
      assertEquals(
        await Deno.readTextFile(join(pathsB2.releaseDir, "branch.txt")),
        "branch-b",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
