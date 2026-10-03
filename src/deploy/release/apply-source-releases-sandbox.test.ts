import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  applySourceReleases,
  type ApplySourceReleasesDeps,
} from "./apply-source-releases.ts";
import type { SandboxedBuildParams } from "./build-sandbox.ts";
import {
  prepareNativeAppBuildOutput,
  runReleaseBuild,
  sandboxBuildEnvironment,
} from "./build.ts";
import { stageRelease, type StageReleaseParams } from "./promote.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

const PROJECT = "01a0e39d-0418-7852-bc47-bc2f8422d404";
/** What a hostile project member can put in a build command. */
const HOSTILE = "cat /var/lib/turbopanel/daemon.env; " +
  "curl --unix-socket /run/docker.sock http://x/containers/json; " +
  "curl http://169.254.169.254/; :(){ :|:& };:";

function payload(
  source: Partial<EnvironmentDeploySource> = {},
): EnvironmentDeployPayload {
  return {
    environmentId: "env-1",
    projectId: PROJECT,
    organizationId: "org-1",
    projectName: "test",
    composeFiles: [],
    hostings: [{
      hostingId: "host-1",
      composeServiceName: "web",
      serviceId: "svc1",
      hostnames: ["app.example.com"],
    }],
    nativeAppServices: [{
      composeServiceName: "web",
      serviceId: "svc1",
      listenPort: 3000,
      framework: "next",
    }],
    sourceMaterial: [{
      sourceId: "src-1",
      composeServiceName: "web",
      provider: "github",
      cloneUrl: "https://github.com/example/repo.git",
      ref: "main",
      commitSha: "abc123",
      releaseId: "rel-1",
      principal: {
        principalId: "pr-1",
        username: "appuser",
        uid: 2000,
        gid: 2001,
      },
      build: {
        kind: "native",
        installCommand: "npm ci",
        buildCommand: HOSTILE,
        env: { PATH: "/evil", LD_PRELOAD: "/evil.so", GOOD: "yes" },
      },
      ...source,
    }],
  };
}

type Captured = {
  checkoutDir?: string;
  sandboxRuns: SandboxedBuildParams[];
  spawnedSh: number;
  foldRoot?: string;
  stage?: StageReleaseParams;
};

async function withSandboxRoot(
  fn: (root: string, deps: ApplySourceReleasesDeps, seen: Captured) => Promise<
    void
  >,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-build-sandbox-" });
  await Deno.mkdir(join(root, "work"));
  const seen: Captured = { sandboxRuns: [], spawnedSh: 0 };
  const runFn: RunFn = () =>
    Promise.resolve({ success: true, stdout: "", stderr: "" });
  const deps: ApplySourceReleasesDeps = {
    logSink: {
      onLine() {},
      setPhase() {},
      addSecrets() {},
      redactSummary: (text) => text,
      finalize: () => Promise.resolve(),
    },
    decryptSecrets: undefined,
    runFn,
    sandboxedBuilds: true,
    buildSandboxRoot: root,
    ensureReleaseTreeFn: () => Promise.resolve(),
    checkoutReleaseFn: async (params) => {
      seen.checkoutDir = params.checkoutDir;
      const workingDir = params.checkoutDir ?? "";
      await Deno.mkdir(workingDir);
      await Deno.writeTextFile(join(workingDir, "package.json"), "{}");
      return { workingDir, commitSha: "abc123" };
    },
    runReleaseBuildFn: (params) =>
      runReleaseBuild({
        ...params,
        runCommand: () => {
          seen.spawnedSh += 1;
          return Promise.resolve();
        },
        ...(params.sandbox
          ? {
            sandbox: {
              ...params.sandbox,
              run: (run) => {
                seen.sandboxRuns.push(run);
                return Promise.resolve();
              },
            },
          }
          : {}),
      }),
    prepareNativeAppBuildOutputFn: (context) => {
      seen.foldRoot = context.containmentRoot;
      return Promise.resolve({ standaloneOutput: false, staticExport: false });
    },
    promoteReleaseFn: (params) => {
      seen.stage = params;
      return Promise.resolve(params.paths.releaseDir);
    },
    pruneReleasesFn: () => Promise.resolve([]),
  };
  try {
    await fn(root, deps, seen);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function specLines(spec: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const line of spec.split("\n")) {
    const [key, ...rest] = line.split(" ");
    if (!key) continue;
    fields.set(key, [...(fields.get(key) ?? []), rest.join(" ")]);
  }
  return fields;
}

const decode = (value: string) => new TextDecoder().decode(decodeBase64(value));

test("a managed host builds tenant commands only in the sandbox, never as the daemon", async () => {
  const fixture = await createTempLayout();
  try {
    await withSandboxRoot(async (root, deps, seen) => {
      const applied = await applySourceReleases(
        resolveLayout(fixture.env),
        payload(),
        deps,
      );
      assertEquals(applied.length, 1);
      // Nothing tenant-defined was spawned by the daemon itself.
      assertEquals(seen.spawnedSh, 0);
      assertEquals(seen.sandboxRuns.length, 1);
      const run = seen.sandboxRuns[0];
      if (!run) throw new TypeError("expected a sandboxed run");
      const workDir = join(root, "work", run.work.buildId);
      assertEquals(run.work.workDir, workDir);
      assertEquals(run.work.projectKey, PROJECT);
      assertEquals(seen.checkoutDir, join(workDir, "source"));

      const fields = specLines(run.spec);
      assertEquals(fields.get("tp-build-spec"), ["1"]);
      assertEquals(fields.get("cwd"), ["source"]);
      assertEquals(
        (fields.get("run") ?? []).map(decode),
        ["npm ci", HOSTILE],
      );
      const env = Object.fromEntries(
        (fields.get("env") ?? []).map((line) => {
          const [name = "", value = ""] = line.split(" ");
          return [name, decode(value)];
        }),
      );
      assertEquals(env.LD_PRELOAD, undefined);
      assertEquals(env.HOME, undefined);
      assert(!env.PATH?.includes("/evil"));
      assertEquals(env.GOOD, "yes");

      // The hand-off reads the returned tree from work/<id> down.
      assertEquals(seen.foldRoot, workDir);
      assertEquals(seen.stage?.containmentRoot, workDir);
      assertEquals(seen.stage?.workingDir, join(workDir, "source"));
      // And the tree is gone afterwards.
      assertEquals(
        await Deno.lstat(workDir).then(() => true, () => false),
        false,
      );
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a clone credential still on disk stops the build before the sandbox sees the tree", async () => {
  const fixture = await createTempLayout();
  try {
    await withSandboxRoot(async (_root, deps, seen) => {
      const checkout = deps.checkoutReleaseFn;
      if (!checkout) throw new TypeError("expected a checkout seam");
      deps.checkoutReleaseFn = async (params) => {
        await Deno.writeTextFile(join(params.scratchDir, ".git-askpass"), "x");
        return await checkout(params);
      };
      await assertRejects(
        () => applySourceReleases(resolveLayout(fixture.env), payload(), deps),
        Error,
        "still on disk; refusing to build",
      );
      assertEquals(seen.sandboxRuns.length, 0);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a subdirectory build runs there, and an escaping one is refused", async () => {
  const fixture = await createTempLayout();
  try {
    await withSandboxRoot(async (_root, deps, seen) => {
      const checkout = deps.checkoutReleaseFn;
      if (!checkout) throw new TypeError("expected a checkout seam");
      deps.checkoutReleaseFn = async (params) => {
        const result = await checkout(params);
        await Deno.mkdir(join(result.workingDir, "apps/web"), {
          recursive: true,
        });
        return result;
      };
      await applySourceReleases(
        resolveLayout(fixture.env),
        payload({ subdirectory: "apps/web" }),
        deps,
      );
      assertEquals(specLines(seen.sandboxRuns[0]?.spec ?? "").get("cwd"), [
        "source/apps/web",
      ]);
      await assertRejects(
        () =>
          applySourceReleases(
            resolveLayout(fixture.env),
            payload({ subdirectory: "../../../etc" }),
            deps,
          ),
        Error,
        "cannot be built in the build sandbox",
      );
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a sandboxed build's caches live in the project's cache directory, not the checkout", () => {
  const root = "/var/lib/turbopanel-build";
  const work = {
    buildId: "b1",
    projectKey: PROJECT,
    workDir: `${root}/work/b1`,
    checkoutDir: `${root}/work/b1/source`,
    cacheDir: `${root}/cache/${PROJECT}`,
  };
  const skipped: string[] = [];
  const env = sandboxBuildEnvironment(
    { kind: "native", env: { "NOT-A-NAME": "x", NODE_ENV: "development" } },
    work,
    {
      nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
      nodeEnv: "production",
    },
    (_stream, line) => skipped.push(line),
  );
  assertEquals(
    env.PATH,
    "/opt/turbopanel/vendor/node-app/24/current/bin:/usr/bin:/bin",
  );
  assertEquals(env.COREPACK_HOME, `${work.cacheDir}/corepack`);
  assertEquals(env.npm_config_cache, `${work.cacheDir}/npm`);
  assertEquals(env.XDG_CACHE_HOME, `${work.cacheDir}/xdg`);
  assertEquals(env.NODE_ENV, "development");
  assertEquals(env["NOT-A-NAME"], undefined);
  assertEquals(skipped, [
    "skipping build variable NOT-A-NAME: not a shell name",
  ]);
  const plain = sandboxBuildEnvironment({ kind: "static" }, work);
  // A static build keeps the runner's fixed PATH.
  assertEquals(plain.PATH, undefined);
  assertEquals(plain.COREPACK_HOME, undefined);
});

test("a build that swapped its checkout for a link is refused at hand-off", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-build-swap-" }),
  );
  try {
    const workDir = join(root, "work", "b1");
    const secrets = join(root, "daemon-state");
    await Deno.mkdir(workDir, { recursive: true });
    await Deno.mkdir(secrets);
    await Deno.writeTextFile(join(secrets, "daemon.env"), "TOKEN=x\n");
    await Deno.symlink(secrets, join(workDir, "source"));
    const releaseDir = join(root, "release");
    await Deno.mkdir(releaseDir);
    const paths = {
      principalHome: root,
      sitesDir: root,
      siteDir: root,
      releasesDir: root,
      releaseDir,
      currentLink: join(root, "current"),
      sharedDir: join(root, "shared"),
      scratchDir: join(root, "scratch"),
      handoffDir: join(root, "handoff"),
    };
    await assertRejects(
      () =>
        stageRelease({
          paths,
          workingDir: join(workDir, "source"),
          containmentRoot: workDir,
        }),
      Error,
      "is a symlink",
    );
    assertEquals([...Deno.readDirSync(releaseDir)], []);
    await assertRejects(
      () =>
        prepareNativeAppBuildOutput({
          framework: "next",
          workingDir: join(workDir, "source"),
          containmentRoot: workDir,
        }),
      Error,
      "is a symlink",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
