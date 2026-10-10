import { assertEquals, assertRejects } from "@std/assert";
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
import { swapCurrentSymlink } from "./promote.ts";
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
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "test",
    composeFiles: [],
    hostings: [],
    ...overrides,
  };
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
    releaseId: "rel-1",
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
  for (
    const dir of [
      paths.sitesDir,
      paths.siteDir,
      paths.releasesDir,
      paths.sharedDir,
      paths.releaseDir,
    ]
  ) {
    await Deno.mkdir(dir, { recursive: true });
  }
}

test("resolveReleaseServiceId prefers sourceMaterial releaseServiceId", () => {
  const payload = basePayload({
    hostings: [{
      hostingId: "host-1",
      composeServiceName: "web",
      serviceId: "svc-hosting",
      hostnames: ["app.example.com"],
    }],
    sourceMaterial: [
      baseSource({
        composeServiceName: "web",
        releaseServiceId: "svc-canonical",
      }),
    ],
  });
  assertEquals(resolveReleaseServiceId(payload, "web"), "svc-canonical");
});

test("resolveReleaseServiceId uses nativeAppServices when releaseServiceId absent", () => {
  const payload = basePayload({
    nativeAppServices: [{
      composeServiceName: "app",
      serviceId: "svc-env-a",
      listenPort: 18080,
      framework: "auto",
    }],
  });
  assertEquals(resolveReleaseServiceId(payload, "app"), "svc-env-a");
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
      const serviceId = "svc-native";
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId,
        releaseId: "rel-new",
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
              releaseId: "rel-new",
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
          ensureReleaseTreeFn: async (treePaths) => {
            await mkdirReleaseTree(treePaths);
          },
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
              releaseId: "rel-new",
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
            return Promise.resolve(["rel-old"]);
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

test("applySourceReleases removes scratch dir after a failed native promote", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId: "svc-fail",
        releaseId: "rel-fail",
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
                serviceId: "svc-fail",
                hostnames: ["fail.example.com"],
              }],
              sourceMaterial: [
                baseSource({
                  composeServiceName: "web",
                  releaseId: "rel-fail",
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
              ensureReleaseTreeFn: async (treePaths) => {
                await mkdirReleaseTree(treePaths);
              },
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
              ensureReleaseTreeFn: mkdirReleaseTree,
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
              ensureReleaseTreeFn: mkdirReleaseTree,
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
      const serviceId = "svc-roll";
      const paths = resolveReleasePaths(layout, {
        username: "appuser",
        serviceId,
        releaseId: "rel-old",
      });
      await mkdirReleaseTree(paths);
      await Deno.writeTextFile(join(paths.releaseDir, "index.html"), "old");
      const recordDir = resolveDaemonReleasePaths(layout, {
        serviceId,
        releaseId: "rel-old",
      }).releaseDir;
      await Deno.mkdir(recordDir, { recursive: true });
      await writeReleaseManifest(recordDir, {
        version: 1,
        serviceId,
        composeServiceName: "web",
        releaseId: "rel-old",
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
              releaseId: "rel-new",
              rollbackToReleaseId: "rel-old",
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
      assertEquals(row.releaseId, "rel-old");
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
        serviceId: "web",
        releaseId: "rel-missing",
      }).releaseDir;
      await Deno.mkdir(recordDir, { recursive: true });
      await writeReleaseManifest(recordDir, {
        version: 1,
        serviceId: "web",
        composeServiceName: "web",
        releaseId: "rel-missing",
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
                  rollbackToReleaseId: "rel-missing",
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

test("applySourceReleases rolls back railpack releases from daemon record manifests", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "svc-rail";
      const recordPaths = resolveDaemonReleasePaths(layout, {
        serviceId,
        releaseId: "rel-rail",
      });
      await Deno.mkdir(recordPaths.releaseDir, { recursive: true });
      await writeReleaseManifest(recordPaths.releaseDir, {
        version: 1,
        serviceId,
        composeServiceName: "web",
        releaseId: "rel-rail",
        sourceId: "src-1",
        commitSha: "rail-commit",
        ref: "main",
        promotedAt: "2026-01-01T00:00:00.000Z",
        imageTag: "turbopanel-app/svc-rail:rel-rail",
        imageDigest: "sha256:abc",
        railpackFrontendVersion: "0.2.0",
        railpackPlanVersion: "0.1.0",
      });

      let promoteExistingCalled = false;
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-rail",
            composeServiceName: "web",
            serviceId: "svc-rail",
            hostnames: ["rail.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              composeServiceName: "web",
              releaseId: "rel-new",
              rollbackToReleaseId: "rel-rail",
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
      if (!row) throw new TypeError("expected railpack rollback row");
      assertEquals(row.imageTag, "turbopanel-app/svc-rail:rel-rail");
      assertEquals(row.commitSha, "rail-commit");
      assertEquals(row.railpackFrontendVersion, "0.2.0");
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

test("applySourceReleases builds railpack releases without a project principal", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "svc-railpack";
      const paths = resolveDaemonReleasePaths(layout, {
        serviceId,
        releaseId: "rel-pack",
      });

      let pruneCalled = false;
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [
            baseSource({
              composeServiceName: "api",
              releaseId: "rel-pack",
              releaseServiceId: serviceId,
              build: { kind: "railpack" },
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
          ensureBuildkitRailpackFn: () =>
            Promise.resolve({
              railpack: "/tmp/railpack",
              buildctl: "/tmp/buildctl",
              buildkitd: "/tmp/buildkitd",
              frontendLayoutDir: "/tmp/frontend",
              frontendDigest: "sha256:front",
            }),
          // A development host: the prepare step runs unsandboxed here.
          sandboxedBuilds: false,
          runRailpackBuildFn: () =>
            Promise.resolve({
              imageTag: "turbopanel-app/api:rel-pack",
              imageDigest: "sha256:pack",
              railpackFrontendVersion: "0.3.0",
              railpackPlanVersion: "0.2.0",
            }),
          recordRailpackReleaseFn: async ({ paths: record, manifest }) => {
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
      if (!row) throw new TypeError("expected railpack row");
      assertEquals(row.imageTag, "turbopanel-app/api:rel-pack");
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
      const serviceId = "svc-static";
      const paths = resolveReleasePaths(layout, {
        username: "siteuser",
        serviceId,
        releaseId: "rel-static",
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
              releaseId: "rel-static",
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
          ensureReleaseTreeFn: async (treePaths) => {
            await mkdirReleaseTree(treePaths);
          },
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

test("a standalone build with a start command that needs package scripts warns, and records no detected start", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "svc-standalone";
      const log = fakeLogSink();
      let detectStart: boolean | undefined;
      const applied = await applySourceReleases(
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
              releaseId: "rel-standalone",
              principal: {
                principalId: "pr-3",
                username: "siteuser",
                uid: 2100,
                gid: 2101,
              },
              build: { kind: "native", startCommand: "pnpm start" },
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "web",
            serviceId,
            listenPort: 3002,
            framework: "next",
          }],
        }),
        {
          logSink: log.sink,
          decryptSecrets: undefined,
          ensureReleaseTreeFn: mkdirReleaseTree,
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
            await swapCurrentSymlink(params.paths);
            return params.paths.releaseDir;
          },
          pruneReleasesFn: () => Promise.resolve([]),
        },
      );
      assertEquals(detectStart, false);
      assertEquals(applied[0]?.nativeStart, undefined);
      // The author's start command is recorded, so a rollback to this
      // release would start it the same way.
      const record = await readReleaseManifest(
        resolveDaemonReleasePaths(layout, {
          serviceId,
          releaseId: "rel-standalone",
        }).releaseDir,
      );
      assertEquals(record?.startCommand, "pnpm start");
      assertEquals(record?.startupFile, undefined);
      assertEquals(
        log.lines.some(({ stream, message }) =>
          stream === "stderr" &&
          message.includes(
            'start command "pnpm start" will likely fail. Remove the start command',
          )
        ),
        true,
      );
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
      const serviceA = "svc-env-production";
      const serviceB = "svc-env-staging";
      const pathsA = resolveReleasePaths(layout, {
        username: principal.username,
        serviceId: serviceA,
        releaseId: "rel-a",
      });
      const pathsB = resolveReleasePaths(layout, {
        username: principal.username,
        serviceId: serviceB,
        releaseId: "rel-b",
      });

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
        ensureReleaseTreeFn: async (
          treePaths: Parameters<typeof mkdirReleaseTree>[0],
        ) => {
          await mkdirReleaseTree(treePaths);
        },
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
              releaseId: "rel-a",
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
          promoteReleaseFn: sharedPromote("main", serviceA, "rel-a", "app"),
        },
      );

      await applySourceReleases(
        layout,
        basePayload({
          environmentId: "env-staging",
          sourceMaterial: [
            baseSource({
              composeServiceName: "app",
              releaseId: "rel-b",
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
          promoteReleaseFn: sharedPromote("branch-a", serviceB, "rel-b", "app"),
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
              releaseId: "rel-b2",
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
            "rel-b2",
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
        releaseId: "rel-b2",
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
