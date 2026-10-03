/**
 * Extra apply-source-releases branches: rollback metadata, railpack prune,
 * subdirectory checkout, decrypted credentials, and principal-less skip.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import type { DecryptSecretsFn } from "../materialize-tls.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import {
  readReleaseManifest,
  type ReleaseManifestV1,
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
  lines: Array<{ stream: "stdout" | "stderr"; message: string }>;
  sink: {
    onLine: (stream: "stdout" | "stderr", message: string) => void;
    setPhase: (phase: string) => void;
    addSecrets: (values: string[]) => void;
    redactSummary: (text: string) => string;
    finalize: () => Promise<void>;
  };
} {
  const lines: Array<{ stream: "stdout" | "stderr"; message: string }> = [];
  return {
    lines,
    sink: {
      onLine(stream, message) {
        lines.push({ stream, message });
      },
      setPhase() {},
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

const PRINCIPAL = {
  principalId: "pr-1",
  username: "appuser",
  uid: 2000,
  gid: 2001,
} as const;

function recordManifest(
  serviceId: string,
  releaseId: string,
): ReleaseManifestV1 {
  return {
    version: 1,
    serviceId,
    composeServiceName: "web",
    releaseId,
    sourceId: "src-1",
    commitSha: "recorded-commit",
    ref: "main",
    promotedAt: "2025-12-01T00:00:00.000Z",
  };
}

/** Seed the daemon-owned record a promote leaves behind. */
async function seedRecord(
  layout: ReturnType<typeof layoutFromFixture>,
  ids: { serviceId: string; releaseId: string },
): Promise<void> {
  const recordDir = resolveDaemonReleasePaths(layout, ids).releaseDir;
  await Deno.mkdir(recordDir, { recursive: true });
  await writeReleaseManifest(
    recordDir,
    recordManifest(ids.serviceId, ids.releaseId),
  );
}

function nativeDeps(sink: ReturnType<typeof fakeLogSink>["sink"]) {
  return {
    logSink: sink,
    decryptSecrets: undefined,
    ensureReleaseTreeFn: mkdirReleaseTree,
    checkoutReleaseFn: async (params: { scratchDir: string }) => {
      const workingDir = join(params.scratchDir, "source");
      await Deno.mkdir(workingDir, { recursive: true });
      return { workingDir, commitSha: "site-commit" };
    },
    runReleaseBuildFn: () => Promise.resolve(),
    promoteReleaseFn: (params: { paths: { releaseDir: string } }) =>
      Promise.resolve(params.paths.releaseDir),
    pruneReleasesFn: () => Promise.resolve([]),
  };
}

test("resolveReleaseServiceId skips a hosting with an empty serviceId", () => {
  const payload = basePayload({
    hostings: [{
      hostingId: "host-empty",
      composeServiceName: "web",
      serviceId: "",
      hostnames: ["app.example.com"],
    }],
    ingressServices: [{
      composeServiceName: "web",
      serviceId: "svc-ingress",
      containerName: "svc-ingress-in",
    }],
  });
  assertEquals(resolveReleaseServiceId(payload, "web"), "svc-ingress");
});

test("applySourceReleases fails a railpack rollback with no release record", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      await assertRejects(
        () =>
          applySourceReleases(
            layout,
            basePayload({
              sourceMaterial: [
                baseSource({
                  rollbackToReleaseId: "rel-missing",
                  build: { kind: "railpack" },
                }),
              ],
            }),
            { logSink: fakeLogSink().sink, decryptSecrets: undefined },
          ),
        Error,
        "this host has no release record for it — redeploy that release",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases skips a rollback to a native release once no principal owns it", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      await seedRecord(layout, { serviceId: "web", releaseId: "rel-old" });
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [
            baseSource({
              rollbackToReleaseId: "rel-old",
              build: { kind: "railpack" },
            }),
          ],
        }),
        { logSink: log.sink, decryptSecrets: undefined },
      );
      assertEquals(applied, []);
      assertEquals(
        log.lines.some((line) =>
          line.stream === "stderr" &&
          line.message.includes(
            "rollback skipped for web: no project principal assigned",
          )
        ),
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases never trusts a manifest planted in the principal tree", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "svc-forged";
      const paths = resolveReleasePaths(layout, {
        username: PRINCIPAL.username,
        serviceId,
        releaseId: "rel-forged",
      });
      // A tree the principal could build in its own home: a sealed-looking
      // release whose manifest names another service's image.
      await mkdirReleaseTree(paths);
      await writeReleaseManifest(paths.releaseDir, {
        ...recordManifest(serviceId, "rel-forged"),
        imageTag: "turbopanel-app/other-svc:rel-1",
      });
      await Deno.chmod(paths.releaseDir, 0o550);

      const privileged: string[][] = [];
      let promoteExistingCalled = false;
      try {
        await assertRejects(
          () =>
            applySourceReleases(
              layout,
              basePayload({
                sourceMaterial: [
                  baseSource({
                    rollbackToReleaseId: "rel-forged",
                    principal: PRINCIPAL,
                  }),
                ],
                hostings: [{
                  hostingId: "host-forged",
                  composeServiceName: "web",
                  serviceId,
                  hostnames: ["forged.example.com"],
                }],
              }),
              {
                logSink: fakeLogSink().sink,
                decryptSecrets: undefined,
                runFn: (_command, args) => {
                  privileged.push(args);
                  return Promise.resolve({
                    success: true,
                    stdout: "",
                    stderr: "",
                  });
                },
                promoteExistingReleaseFn: (params) => {
                  promoteExistingCalled = true;
                  return Promise.resolve(params.paths.releaseDir);
                },
              },
            ),
          Error,
          "no release record",
        );
      } finally {
        await Deno.chmod(paths.releaseDir, 0o750);
      }
      assertEquals(promoteExistingCalled, false);
      assertEquals(privileged, []);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases refuses a release record for another service", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const recordDir = resolveDaemonReleasePaths(layout, {
        serviceId: "web",
        releaseId: "rel-old",
      }).releaseDir;
      await Deno.mkdir(recordDir, { recursive: true });
      await writeReleaseManifest(
        recordDir,
        recordManifest("other-svc", "rel-old"),
      );
      await assertRejects(
        () =>
          applySourceReleases(
            layout,
            basePayload({
              sourceMaterial: [
                baseSource({
                  rollbackToReleaseId: "rel-old",
                  principal: PRINCIPAL,
                }),
              ],
            }),
            { logSink: fakeLogSink().sink, decryptSecrets: undefined },
          ),
        Error,
        "no release record",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases rollback restores standaloneOutput and commit metadata", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "svc-meta";
      const paths = resolveReleasePaths(layout, {
        username: PRINCIPAL.username,
        serviceId,
        releaseId: "rel-old",
      });
      await mkdirReleaseTree(paths);
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
        commitMessage: "ship it",
        commitAuthor: "ops@example.com",
        ref: "main",
        promotedAt: "2025-12-01T00:00:00.000Z",
        standaloneOutput: true,
        staticExport: true,
      });

      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-meta",
            composeServiceName: "web",
            serviceId,
            hostnames: ["meta.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              releaseId: "rel-new",
              rollbackToReleaseId: "rel-old",
              principal: PRINCIPAL,
            }),
          ],
        }),
        {
          logSink: fakeLogSink().sink,
          decryptSecrets: undefined,
          promoteExistingReleaseFn: async (params) => {
            await swapCurrentSymlink(params.paths);
            return params.paths.releaseDir;
          },
        },
      );

      const row = applied[0];
      if (!row) throw new TypeError("expected rollback row");
      assertEquals(row.standaloneOutput, true);
      assertEquals(row.staticExport, true);
      assertEquals(row.commitMessage, "ship it");
      assertEquals(row.commitAuthor, "ops@example.com");
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases railpack rollback omits optional image fields when absent", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "web";
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
        commitSha: "rail-min",
        ref: "main",
        promotedAt: "2026-01-01T00:00:00.000Z",
        imageTag: "turbopanel-app/web:rel-rail",
      });

      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [
            baseSource({
              rollbackToReleaseId: "rel-rail",
              build: { kind: "railpack" },
            }),
          ],
        }),
        { logSink: fakeLogSink().sink, decryptSecrets: undefined },
      );

      const row = applied[0];
      if (!row) throw new TypeError("expected railpack rollback row");
      assertEquals(row.imageTag, "turbopanel-app/web:rel-rail");
      assertEquals("imageDigest" in row, false);
      assertEquals("commitMessage" in row, false);
      assertEquals("commitAuthor" in row, false);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases railpack prune logs superseded releases and optional metadata", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [
            baseSource({
              composeServiceName: "api",
              releaseId: "rel-pack",
              commitMessage: "image ship",
              commitAuthor: "bot@example.com",
              build: { kind: "railpack" },
            }),
          ],
        }),
        {
          logSink: log.sink,
          decryptSecrets: undefined,
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
          runRailpackBuildFn: (params) => {
            assertEquals(params.redactSummary?.("token"), "token");
            return Promise.resolve({
              imageTag: "turbopanel-app/api:rel-pack",
              railpackFrontendVersion: "0.3.0",
              railpackPlanVersion: "0.2.0",
            });
          },
          recordRailpackReleaseFn: async ({ paths: record, manifest }) => {
            await Deno.mkdir(
              join(record.releaseDir, RELEASE_METADATA_DIRNAME),
              { recursive: true },
            );
            await writeReleaseManifest(record.releaseDir, manifest);
            return record.releaseDir;
          },
          pruneReleasesFn: () => Promise.resolve(["rel-old"]),
        },
      );

      const row = applied[0];
      if (!row) throw new TypeError("expected railpack row");
      assertEquals(row.commitMessage, "image ship");
      assertEquals(row.commitAuthor, "bot@example.com");
      assertEquals("imageDigest" in row, false);
      assertEquals(
        log.lines.some((line) => line.message.includes("pruned 1 superseded")),
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases native builds honor subdirectory, credentials, and current", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "svc-sub";
      const previous = resolveReleasePaths(layout, {
        username: PRINCIPAL.username,
        serviceId,
        releaseId: "rel-old",
      });
      await mkdirReleaseTree(previous);
      await Deno.symlink(join("releases", "rel-old"), previous.currentLink);

      let capturedWorkingDir = "";
      let capturedCredential: string | undefined;
      let capturedKind: string | undefined;
      let capturedUsername: string | undefined;
      let capturedSubdirectory: string | undefined;
      let capturedOutput: string | undefined;
      let capturedNodeEnv: string | undefined;
      let prepareCalled = false;
      const decryptSecrets: DecryptSecretsFn = () =>
        Promise.resolve(["ghs_decrypted"]);

      const applied = await applySourceReleases(
        layout,
        basePayload({
          hostings: [{
            hostingId: "host-sub",
            composeServiceName: "web",
            serviceId,
            hostnames: ["sub.example.com"],
          }],
          sourceMaterial: [
            baseSource({
              composeServiceName: "web",
              releaseId: "rel-new",
              subdirectory: "apps/web",
              credential: "tpdaemon.sealed",
              credentialKind: "token",
              credentialUsername: "oauth2",
              commitMessage: "feat",
              commitAuthor: "dev@example.com",
              principal: PRINCIPAL,
              build: { kind: "native", outputDirectory: "dist" },
            }),
          ],
          nativeAppServices: [{
            composeServiceName: "web",
            serviceId,
            listenPort: 3000,
            framework: "next",
            nodeVersion: "24",
            appMode: "development",
          }],
        }),
        {
          logSink: fakeLogSink().sink,
          decryptSecrets,
          ensureReleaseTreeFn: mkdirReleaseTree,
          checkoutReleaseFn: async (params) => {
            capturedCredential = params.credential;
            capturedKind = params.credentialKind;
            capturedUsername = params.credentialUsername;
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            return { workingDir, commitSha: "new-commit" };
          },
          runReleaseBuildFn: (params) => {
            capturedWorkingDir = params.workingDir;
            capturedNodeEnv = params.nativeRuntime?.nodeEnv;
            assertEquals(params.redactSummary?.("secret"), "secret");
            return Promise.resolve();
          },
          prepareNativeAppBuildOutputFn: () => {
            prepareCalled = true;
            return Promise.resolve({
              standaloneOutput: false,
              staticExport: false,
              outputDirectory: undefined,
            });
          },
          promoteReleaseFn: async (params) => {
            capturedSubdirectory = params.subdirectory;
            capturedOutput = params.outputDirectory;
            await swapCurrentSymlink(params.paths);
            return params.paths.releaseDir;
          },
          pruneReleasesFn: () => Promise.resolve([]),
        },
      );

      const row = applied[0];
      if (!row) throw new TypeError("expected native row");
      assertEquals(capturedCredential, "ghs_decrypted");
      assertEquals(capturedKind, "token");
      assertEquals(capturedUsername, "oauth2");
      assertEquals(capturedWorkingDir.endsWith("apps/web"), true);
      assertEquals(capturedSubdirectory, "apps/web");
      assertEquals(capturedOutput, "dist");
      assertEquals(capturedNodeEnv, "development");
      assertEquals(prepareCalled, false);
      assertEquals(row.previousReleaseId, "rel-old");
      assertEquals(row.commitMessage, "feat");
      assertEquals(row.commitAuthor, "dev@example.com");
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases native without nativeAppServices ships the tree as-is", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      let nativeRuntimePresent = false;
      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [
            baseSource({
              principal: PRINCIPAL,
            }),
          ],
        }),
        {
          logSink: fakeLogSink().sink,
          decryptSecrets: undefined,
          ensureReleaseTreeFn: mkdirReleaseTree,
          checkoutReleaseFn: async (params) => {
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            return { workingDir, commitSha: "site-commit" };
          },
          runReleaseBuildFn: (params) => {
            nativeRuntimePresent = params.nativeRuntime !== undefined;
            return Promise.resolve();
          },
          promoteReleaseFn: (params) =>
            Promise.resolve(params.paths.releaseDir),
          pruneReleasesFn: () => Promise.resolve([]),
        },
      );
      const row = applied[0];
      if (!row) throw new TypeError("expected site row");
      assertEquals(nativeRuntimePresent, false);
      assertEquals(row.standaloneOutput, false);
      assertEquals(row.staticExport, false);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases records a promoted native release for rollback", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [baseSource({ principal: PRINCIPAL })],
        }),
        nativeDeps(fakeLogSink().sink),
      );
      assertEquals(applied.length, 1);
      const record = await readReleaseManifest(
        resolveDaemonReleasePaths(layout, {
          serviceId: "web",
          releaseId: "rel-1",
        }).releaseDir,
      );
      assertEquals(record?.serviceId, "web");
      assertEquals(record?.releaseId, "rel-1");
      assertEquals(record?.commitSha, "site-commit");
      assertEquals(record?.imageTag, undefined);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases fails a native deploy before cutover when its record cannot be written", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      let promoted = false;
      await assertRejects(
        () =>
          applySourceReleases(
            layout,
            basePayload({
              sourceMaterial: [baseSource({ principal: PRINCIPAL })],
            }),
            {
              ...nativeDeps(fakeLogSink().sink),
              ensureDaemonReleaseRecordDirFn: () =>
                Promise.reject(new Error("disk full")),
              promoteReleaseFn: (params) => {
                promoted = true;
                return Promise.resolve(params.paths.releaseDir);
              },
            },
          ),
        Error,
        "rollback record could not be written: disk full",
      );
      assertEquals(promoted, false);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases removes the record again when the promote fails", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      await assertRejects(
        () =>
          applySourceReleases(
            layout,
            basePayload({
              sourceMaterial: [baseSource({ principal: PRINCIPAL })],
            }),
            {
              ...nativeDeps(fakeLogSink().sink),
              promoteReleaseFn: () => Promise.reject(new Error("link escape")),
            },
          ),
        Error,
        "link escape",
      );
      const record = await readReleaseManifest(
        resolveDaemonReleasePaths(layout, {
          serviceId: "web",
          releaseId: "rel-1",
        }).releaseDir,
      );
      assertEquals(record, null);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases prunes the records of the native releases it prunes", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const old = resolveDaemonReleasePaths(layout, {
        serviceId: "web",
        releaseId: "rel-old",
      });
      await Deno.mkdir(old.releaseDir, { recursive: true });
      await Deno.writeTextFile(join(old.releaseDir, "release.json"), "{}");
      await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [baseSource({ principal: PRINCIPAL })],
        }),
        {
          ...nativeDeps(fakeLogSink().sink),
          pruneReleasesFn: () => Promise.resolve(["rel-old"]),
        },
      );
      await assertRejects(
        () => Deno.stat(old.releaseDir),
        Deno.errors.NotFound,
      );
      const kept = await readReleaseManifest(
        resolveDaemonReleasePaths(layout, {
          serviceId: "web",
          releaseId: "rel-1",
        }).releaseDir,
      );
      assertEquals(kept?.releaseId, "rel-1");
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases stamps promotedAt when now is omitted", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      let promotedAt = "";
      await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [
            baseSource({ principal: PRINCIPAL }),
          ],
        }),
        {
          logSink: fakeLogSink().sink,
          decryptSecrets: undefined,
          ensureReleaseTreeFn: mkdirReleaseTree,
          checkoutReleaseFn: async (params) => {
            const workingDir = join(params.scratchDir, "source");
            await Deno.mkdir(workingDir, { recursive: true });
            return { workingDir, commitSha: "now-commit" };
          },
          runReleaseBuildFn: () => Promise.resolve(),
          promoteReleaseFn: (params) => {
            promotedAt = params.manifest?.promotedAt ?? "";
            return Promise.resolve(params.paths.releaseDir);
          },
          pruneReleasesFn: () => Promise.resolve([]),
        },
      );
      assertEquals(promotedAt.length > 0, true);
      assertEquals(Number.isNaN(Date.parse(promotedAt)), false);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("applySourceReleases rejects a clone credential decrypt that returns nothing", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      await assertRejects(
        () =>
          applySourceReleases(
            layoutFromFixture(fixture),
            basePayload({
              sourceMaterial: [
                baseSource({
                  credential: "tpdaemon.sealed",
                  principal: PRINCIPAL,
                }),
              ],
            }),
            {
              logSink: fakeLogSink().sink,
              decryptSecrets: () => Promise.resolve([]),
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

test("applySourceReleases cuts over to a re-sent release this host already published", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const serviceId = "svc-resent";
      const paths = resolveReleasePaths(layout, {
        username: PRINCIPAL.username,
        serviceId,
        releaseId: "rel-1",
      });
      await mkdirReleaseTree(paths);
      await seedRecord(layout, { serviceId, releaseId: "rel-1" });
      const payload = (commitSha: string) =>
        basePayload({
          hostings: [{
            hostingId: "host-resent",
            composeServiceName: "web",
            serviceId,
            hostnames: ["resent.example.com"],
          }],
          sourceMaterial: [baseSource({ commitSha, principal: PRINCIPAL })],
        });
      const calls: string[] = [];
      const deps = {
        ...nativeDeps(fakeLogSink().sink),
        promoteReleaseFn: (params: { paths: { releaseDir: string } }) => {
          calls.push("promote");
          return Promise.resolve(params.paths.releaseDir);
        },
        promoteExistingReleaseFn: (
          params: { paths: { releaseDir: string } },
        ) => {
          calls.push("existing");
          return Promise.resolve(params.paths.releaseDir);
        },
      };

      // Same id, same commit: no rebuild, no publish over the live release.
      const [row] = await applySourceReleases(
        layout,
        payload("recorded-commit"),
        deps,
      );
      assertEquals(calls, ["existing"]);
      assertEquals(row?.commitSha, "recorded-commit");

      // Same id, another commit: built and published as before (and refused
      // by tp-host there, never merged in).
      calls.length = 0;
      await applySourceReleases(layout, payload("other-commit"), deps);
      assertEquals(calls, ["promote"]);
    } finally {
      await fixture.cleanup();
    }
  });
});
