import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  CANCELLED_PREFIX,
  createDeployCancelToken,
  DeployCancelledError,
} from "../deploy-cancel.ts";
import {
  applySourceReleases,
  type ApplySourceReleasesDeps,
} from "./apply-source-releases.ts";
import {
  type BuildWork,
  resolveBuildWork,
  runSandboxedBuild,
  type SandboxSpawn,
} from "./build-sandbox.ts";
import { runReleaseBuild } from "./build.ts";
import { checkoutRelease, type GitRunner } from "./checkout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

const PROJECT = "01a0e39d-0418-7852-bc47-bc2f8422d404";

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
      build: { kind: "native", installCommand: "npm ci", buildCommand: "x" },
      ...source,
    }],
  };
}

const okRun: RunFn = () =>
  Promise.resolve({ success: true, stdout: "", stderr: "" });

type Seen = { promoted: number; scratchDir?: string };

function releaseDeps(
  seen: Seen,
  overrides: Partial<ApplySourceReleasesDeps> = {},
): ApplySourceReleasesDeps {
  return {
    logSink: {
      onLine() {},
      setPhase() {},
      addSecrets() {},
      redactSummary: (text) => text,
      finalize: () => Promise.resolve(),
    },
    decryptSecrets: undefined,
    runFn: okRun,
    sandboxedBuilds: false,
    ensureReleaseTreeFn: () => Promise.resolve(),
    checkoutReleaseFn: async (params) => {
      seen.scratchDir = params.scratchDir;
      const workingDir = join(params.scratchDir, "source");
      await Deno.mkdir(workingDir, { recursive: true });
      return { workingDir, commitSha: "abc123" };
    },
    runReleaseBuildFn: () => Promise.resolve(),
    prepareNativeAppBuildOutputFn: () =>
      Promise.resolve({ standaloneOutput: false, staticExport: false }),
    promoteReleaseFn: (params) => {
      seen.promoted += 1;
      return Promise.resolve(params.paths.releaseDir);
    },
    pruneReleasesFn: () => Promise.resolve([]),
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

test("a cancel after the build never promotes, and the scratch checkout is removed", async () => {
  const fixture = await createTempLayout();
  try {
    const token = createDeployCancelToken();
    const seen: Seen = { promoted: 0 };
    const deps = releaseDeps(seen, {
      cancel: token,
      // The cancel lands as the build finishes.
      runReleaseBuildFn: () => {
        token.cancel();
        return Promise.resolve();
      },
    });
    const err = await assertRejects(
      () => applySourceReleases(resolveLayout(fixture.env), payload(), deps),
      DeployCancelledError,
    );
    assert(err.message.startsWith(CANCELLED_PREFIX));
    assertEquals(seen.promoted, 0);
    assertEquals(token.committed, false);
    assert(seen.scratchDir !== undefined);
    assertEquals(await exists(seen.scratchDir), false);
  } finally {
    await fixture.cleanup();
  }
});

test("a cancel that lands after the promote is too late and the release stays", async () => {
  const fixture = await createTempLayout();
  try {
    const token = createDeployCancelToken();
    const seen: Seen = { promoted: 0 };
    let outcome: string | undefined;
    const deps = releaseDeps(seen, {
      cancel: token,
      promoteReleaseFn: (params) => {
        seen.promoted += 1;
        outcome = token.cancel();
        return Promise.resolve(params.paths.releaseDir);
      },
    });
    const applied = await applySourceReleases(
      resolveLayout(fixture.env),
      payload(),
      deps,
    );
    assertEquals(outcome, "too_late");
    assertEquals(applied.length, 1);
    assertEquals(seen.promoted, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a cancel while the checkout runs stops before anything is built", async () => {
  const fixture = await createTempLayout();
  try {
    const token = createDeployCancelToken();
    const seen: Seen = { promoted: 0 };
    let built = 0;
    const deps = releaseDeps(seen, {
      cancel: token,
      checkoutReleaseFn: (params) => {
        // What the real checkout does when the signal fires mid-clone.
        token.cancel();
        throw new DeployCancelledError(
          `stopped while ${params.cloneUrl} was fetched`,
        );
      },
      runReleaseBuildFn: () => {
        built += 1;
        return Promise.resolve();
      },
    });
    await assertRejects(
      () => applySourceReleases(resolveLayout(fixture.env), payload(), deps),
      DeployCancelledError,
    );
    assertEquals(built, 0);
    assertEquals(seen.promoted, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a cancel during the first service never starts the second", async () => {
  const fixture = await createTempLayout();
  try {
    const token = createDeployCancelToken();
    const seen: Seen = { promoted: 0 };
    const body = payload();
    const first = body.sourceMaterial?.[0];
    assert(first !== undefined);
    body.sourceMaterial = [first, {
      ...first,
      sourceId: "src-2",
      composeServiceName: "api",
      releaseId: "rel-2",
    }];
    let checkouts = 0;
    const deps = releaseDeps(seen, {
      cancel: token,
      checkoutReleaseFn: (params) => {
        checkouts += 1;
        // Cancelled while the first service is still being fetched: nothing
        // is promoted, and the second service never starts.
        token.cancel();
        const workingDir = join(params.scratchDir, "source");
        return Deno.mkdir(workingDir, { recursive: true }).then(() => ({
          workingDir,
          commitSha: "abc123",
        }));
      },
    });
    await assertRejects(
      () => applySourceReleases(resolveLayout(fixture.env), body, deps),
      DeployCancelledError,
    );
    assertEquals(checkouts, 1);
    assertEquals(seen.promoted, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("checkout: a cancel mid-clone is a cancel, not a clone failure", async () => {
  const controller = new AbortController();
  let sawSignal = false;
  const runGit: GitRunner = (_args, _cwd, _env, _onOutput, signal) => {
    sawSignal = signal === controller.signal;
    controller.abort();
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "git was killed",
    });
  };
  const scratch = await Deno.makeTempDir({ prefix: "tp-cancel-checkout-" });
  try {
    const err = await assertRejects(
      () =>
        checkoutRelease({
          cloneUrl: "https://example.com/r.git",
          ref: "main",
          commitSha: "abc",
          scratchDir: scratch,
          runGit,
          signal: controller.signal,
        }),
      DeployCancelledError,
    );
    assert(sawSignal);
    assert(!err.message.includes("git was killed"));
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

test("checkout: a cancel that is already in is refused before git runs", async () => {
  const controller = new AbortController();
  controller.abort();
  let ran = 0;
  const scratch = await Deno.makeTempDir({ prefix: "tp-cancel-checkout-" });
  try {
    await assertRejects(
      () =>
        checkoutRelease({
          cloneUrl: "https://example.com/r.git",
          ref: "main",
          commitSha: "abc",
          scratchDir: scratch,
          runGit: () => {
            ran += 1;
            return Promise.resolve({ success: true, stdout: "", stderr: "" });
          },
          signal: controller.signal,
        }),
      DeployCancelledError,
    );
    assertEquals(ran, 0);
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

test("an unsandboxed build is killed by a cancel, quickly, as a cancel", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-cancel-build-" });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await assertRejects(
      () =>
        runReleaseBuild({
          build: { kind: "native", buildCommand: "exec sleep 30" },
          workingDir: dir,
          signal: controller.signal,
        }),
      DeployCancelledError,
    );
    assert(Date.now() - started < 10_000, "the build was not killed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function sandboxWork(): Promise<BuildWork> {
  return await resolveBuildWork(
    { serviceId: "svc1", releaseId: "20260927-120000", projectId: PROJECT },
    "/var/lib/turbopanel-build",
  );
}

test("a sandboxed build cancelled mid-run stops its unit and takes the tree back", async () => {
  const target = await sandboxWork();
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const killed: string[] = [];
  const spawn: SandboxSpawn = () =>
    ({
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate;
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate;
          controller.close();
        },
      }),
      status: gate.then(() => ({ success: false, code: 143, signal: null })),
      kill: (signal: string) => {
        killed.push(signal);
        finish();
      },
    }) as unknown as Deno.ChildProcess;
  const calls: string[][] = [];
  const runFn: RunFn = (_command, args) => {
    calls.push(args);
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assertRejects(
    () =>
      runSandboxedBuild({
        work: target,
        spec: "",
        spawn,
        runFn,
        signal: controller.signal,
      }),
    DeployCancelledError,
  );
  assertEquals(killed, ["SIGTERM"]);
  const verbs = calls.map((args) => args.filter((arg) => arg.length > 0));
  assert(verbs.some((args) => args.includes("stop")), "unit was stopped");
  assert(
    verbs.some((args) => args.includes("build-return")),
    "tree was taken back",
  );
});

test("a sandboxed build already cancelled never starts", async () => {
  const target = await sandboxWork();
  let spawned = 0;
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () =>
      runSandboxedBuild({
        work: target,
        spec: "",
        spawn: () => {
          spawned += 1;
          throw new TypeError("must not spawn");
        },
        runFn: okRun,
        signal: controller.signal,
      }),
    DeployCancelledError,
  );
  assertEquals(spawned, 0);
});
