/**
 * Sites built from a Git source: the Node their build runs on, the folder they
 * serve, and a missing folder failing before anything is promoted.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySite,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import { applySourceReleases } from "./apply-source-releases.ts";
import {
  releaseSiteRoot,
  siteBuildRuntimes,
  sitesWithReleaseRoots,
} from "./site-release.ts";

const test = Deno.test.bind(Deno);

const SERVICE_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c0000aa";

const SITE: EnvironmentDeploySite = {
  composeServiceName: "blog",
  engine: "caddy",
  root: "public",
  listenPort: 18080,
};

function source(
  build: EnvironmentDeploySource["build"],
): EnvironmentDeploySource {
  return {
    sourceId: "src-1",
    composeServiceName: "blog",
    releaseServiceId: SERVICE_ID,
    provider: "github",
    cloneUrl: "https://github.com/example/repo.git",
    ref: "main",
    commitSha: "abc123def456",
    releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c000001",
    build,
    principal: {
      principalId: "pr-1",
      username: "appuser",
      uid: 2000,
      gid: 2001,
    },
  };
}

function payload(
  build: EnvironmentDeploySource["build"],
  sites: EnvironmentDeploySite[] = [SITE],
): EnvironmentDeployPayload {
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "test",
    composeFiles: [],
    hostings: [],
    sites,
    sourceMaterial: [source(build)],
    serviceFolders: [{
      serviceId: SERVICE_ID,
      folder: { owner: "appuser", scope: "production", slug: SERVICE_ID },
    }],
  };
}

const sink = {
  onLine() {},
  setPhase() {},
  addSecrets() {},
  redactSummary: (text: string) => text,
  finalize: () => Promise.resolve(),
};

/** Runs one site release with fakes; `emit` makes the files the build wrote. */
async function runSiteRelease(
  build: EnvironmentDeploySource["build"],
  emit: (workingDir: string) => Promise<void>,
  sites?: EnvironmentDeploySite[],
) {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout({
      ...fixture.env,
      TURBOPANEL_PRINCIPAL_HOME_ROOT: join(
        fixture.dirs.stateDir,
        "principal-homes",
      ),
    });
    const seen = { promoted: 0, binDir: undefined as string | undefined };
    const run = (_command: string, args: string[]) => {
      if (args.includes("install") && args.includes("-d")) {
        Deno.mkdirSync(args[args.length - 1] ?? "", { recursive: true });
      }
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    };
    await applySourceReleases(layout, payload(build, sites), {
      logSink: sink,
      decryptSecrets: undefined,
      runFn: run,
      checkoutReleaseFn: async (params) => {
        const workingDir = join(params.scratchDir, "source");
        await Deno.mkdir(workingDir, { recursive: true });
        await emit(workingDir);
        return { workingDir, commitSha: "site-commit" };
      },
      runReleaseBuildFn: (params) => {
        seen.binDir = params.nativeRuntime?.nodeBinDir;
        return Promise.resolve();
      },
      promoteReleaseFn: (params) => {
        seen.promoted++;
        return Promise.resolve(params.paths.releaseDir);
      },
      pruneReleasesFn: () => Promise.resolve([]),
    });
    return seen;
  } finally {
    await fixture.cleanup();
  }
}

test("a site build runs with the default Node on its PATH", async () => {
  const seen = await runSiteRelease(
    { kind: "native", buildCommand: "npm run build" },
    (dir) => Deno.mkdir(join(dir, "public")),
  );
  assert(seen.binDir?.includes("node-app"), `PATH dir was ${seen.binDir}`);
  assertEquals(seen.promoted, 1);
});

test("a site that builds into its output folder serves that folder", async () => {
  const seen = await runSiteRelease(
    { kind: "native", buildCommand: "npm run build", outputDirectory: "out" },
    (dir) => Deno.mkdir(join(dir, "out")),
  );
  assertEquals(seen.promoted, 1);
});

test("a site whose folder is missing fails before anything is promoted", async () => {
  const seen = { promoted: -1 };
  const error = await assertRejects(
    async () => {
      const result = await runSiteRelease(
        { kind: "native", buildCommand: "npm run build" },
        () => Promise.resolve(),
      );
      seen.promoted = result.promoted;
    },
    Error,
    'serves the folder "public"',
  );
  assert(error.message.includes('"outputDirectory"'));
  assert(error.message.includes('"root"'));
  assertEquals(seen.promoted, -1);
});

test("a missing output folder names the output folder", async () => {
  const error = await assertRejects(
    () =>
      runSiteRelease(
        { kind: "native", outputDirectory: "out" },
        (dir) => Deno.mkdir(join(dir, "out")).then(() => {}),
        [{ ...SITE, root: "dist" }],
      ),
    Error,
  );
  assert(error.message.includes('"dist" of the published output folder "out"'));
});

test("releaseSiteRoot keeps a named root and follows the output folder otherwise", () => {
  assertEquals(releaseSiteRoot(SITE, undefined), "public");
  assertEquals(releaseSiteRoot(SITE, "out"), ".");
  assertEquals(releaseSiteRoot({ root: "dist" }, "out"), "dist");
});

test("sitesWithReleaseRoots and siteBuildRuntimes follow the site sources", () => {
  const withOutput = payload({ kind: "native", outputDirectory: "out" });
  assertEquals(sitesWithReleaseRoots(withOutput, [SITE])[0]?.root, ".");
  assertEquals(siteBuildRuntimes(withOutput).length, 1);
  assertEquals(siteBuildRuntimes(payload({ kind: "railpack" })).length, 0);
  assertEquals(siteBuildRuntimes(payload({ kind: "native" }, [])).length, 0);
});
