/**
 * Extra apply-source-releases branches: rollback metadata, railpack prune,
 * subdirectory checkout, decrypted credentials, and principal-less skip.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../instance/commands/contracts.ts";
import type { DecryptSecretsFn } from "../materialize-tls.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import { writeReleaseManifest } from "./deployment-json.ts";
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

test("applySourceReleases skips a railpack rollback with no record and no principal", async () => {
  await createTempLayout().then(async (fixture) => {
    try {
      const layout = layoutFromFixture(fixture);
      const log = fakeLogSink();
      const applied = await applySourceReleases(
        layout,
        basePayload({
          sourceMaterial: [
            baseSource({
              rollbackToReleaseId: "rel-missing",
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
      await writeReleaseManifest(paths.releaseDir, {
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
