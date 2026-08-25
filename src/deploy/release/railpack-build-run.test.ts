import { dirname, join } from "@std/path";
import { assertEquals, assertRejects } from "@std/assert";
import { resolveLayout } from "../../paths/layout.ts";
import { withTempLayout } from "../../testing/temp-layout.ts";
import {
  BUILDKIT_VERSION,
  type BuildkitRailpackTools,
  RAILPACK_FRONTEND_LAYOUT_NAME,
  RAILPACK_FRONTEND_VERSION,
  RAILPACK_VERSION,
  railpackCacheDir,
  railpackFrontendLayoutDir,
  railpackImageTag,
  runRailpackBuild,
} from "./railpack-build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const VALID_DIGEST = `sha256:${"ab".repeat(32)}`;
const IMAGE_ID =
  "sha256:loadedimage0123456789abcdef0123456789abcdef0123456789ab";

async function writeExec(path: string, body: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, body, { mode: 0o755 });
}

async function linkCurrent(toolDir: string, versionDir: string): Promise<void> {
  const currentLink = join(toolDir, "current");
  try {
    await Deno.remove(currentLink);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.symlink(versionDir, currentLink);
}

async function plantFakeTools(
  runtimesDir: string,
  scripts: { railpack: string; buildctl: string; buildkitd: string },
): Promise<BuildkitRailpackTools> {
  const railpackDir = join(runtimesDir, "railpack", RAILPACK_VERSION);
  const buildkitDir = join(runtimesDir, "buildkit", BUILDKIT_VERSION);
  const frontendDir = join(
    runtimesDir,
    "railpack-frontend",
    RAILPACK_FRONTEND_VERSION,
  );
  await writeExec(join(railpackDir, "railpack"), scripts.railpack);
  await writeExec(join(buildkitDir, "buildctl"), scripts.buildctl);
  await writeExec(join(buildkitDir, "buildkitd"), scripts.buildkitd);
  await Deno.mkdir(join(frontendDir, "image"), { recursive: true });
  await Deno.writeTextFile(
    join(frontendDir, "image", "index.json"),
    JSON.stringify({ manifests: [{ digest: VALID_DIGEST }] }),
  );
  await Deno.writeTextFile(join(frontendDir, "digest"), `${VALID_DIGEST}\n`);
  await linkCurrent(join(runtimesDir, "railpack"), railpackDir);
  await linkCurrent(join(runtimesDir, "buildkit"), buildkitDir);
  await linkCurrent(join(runtimesDir, "railpack-frontend"), frontendDir);
  return {
    railpack: join(runtimesDir, "railpack", "current", "railpack"),
    buildctl: join(runtimesDir, "buildkit", "current", "buildctl"),
    buildkitd: join(runtimesDir, "buildkit", "current", "buildkitd"),
    frontendLayoutDir: railpackFrontendLayoutDir(runtimesDir),
    frontendDigest: VALID_DIGEST,
  };
}

function shLiteral(value: string): string {
  return JSON.stringify(value);
}

function railpackPrepareScript(captureDir: string, planBody: string): string {
  return `#!/bin/sh
printf '%s\\n' "$@" > ${shLiteral(join(captureDir, "railpack.args"))}
env | sort > ${shLiteral(join(captureDir, "railpack.env"))}
plan=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--plan-out" ]; then plan="$arg"; fi
  prev="$arg"
done
if [ -n "$plan" ]; then
  printf '%s\\n' ${shLiteral(planBody)} > "$plan"
fi
echo "prepare ok"
`;
}

function buildctlScript(
  captureDir: string,
  imageTarPath: string,
  opts: { readyMarker?: string } = {},
): string {
  const debugGate = opts.readyMarker
    ? `
if echo "$*" | grep -q debug; then
  if [ -f ${shLiteral(opts.readyMarker)} ]; then exit 0; fi
  exit 1
fi
`
    : `
if echo "$*" | grep -q debug; then exit 0; fi
`;
  return `#!/bin/sh
printf '%s\\n' "$@" > ${shLiteral(join(captureDir, "buildctl.args"))}
${debugGate}: > ${shLiteral(imageTarPath)}
echo "build ok"
`;
}

function dockerScript(
  captureDir: string,
  opts: { failLoad?: boolean; emptyInspect?: boolean; failInspect?: boolean } =
    {},
): string {
  const load = opts.failLoad === true
    ? `echo "token=supersecret" >&2
exit 1
`
    : "exit 0\n";
  let inspect = `echo ${shLiteral(IMAGE_ID)}\nexit 0\n`;
  if (opts.emptyInspect === true) inspect = "exit 0\n";
  if (opts.failInspect === true) inspect = "exit 1\n";
  return `#!/bin/sh
printf '%s\\n' "$@" > ${shLiteral(join(captureDir, "docker.args"))}
if [ "$1" = "load" ]; then
${load}
fi
if [ "$1" = "image" ]; then
${inspect}
fi
exit 0
`;
}

async function withPath<T>(
  prefix: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${prefix}:${previous}`);
  try {
    return await fn();
  } finally {
    Deno.env.set("PATH", previous);
  }
}

test({
  name:
    "runRailpackBuild prepares, builds, and loads with reserved env skipped",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      const captureDir = join(scratchDir, "capture");
      const projectId = "proj-railpack-1";
      const cacheDir = railpackCacheDir(layout, projectId);
      const imageTag = railpackImageTag("web-api", "rel-9");
      const imageTarPath = join(scratchDir, "railpack-image.tar");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(captureDir, { recursive: true });

      const tools = await plantFakeTools(layout.runtimesDir, {
        railpack: railpackPrepareScript(captureDir, '{"version":"plan-7"}'),
        buildctl: buildctlScript(captureDir, imageTarPath),
        buildkitd: "#!/bin/sh\nexit 0\n",
      });
      await writeExec(
        join(scratchDir, "bin", "docker"),
        dockerScript(captureDir),
      );

      const lines: string[] = [];
      const result = await withPath(
        join(scratchDir, "bin"),
        () =>
          runRailpackBuild({
            build: {
              kind: "railpack",
              installCommand: "npm ci",
              buildCommand: "npm run build",
              startCommand: "node server.js",
              env: {
                FOO: "bar",
                GIT_ASKPASS: "should-not-leak",
                GIT_SSH_COMMAND: "ssh -i /evil",
                LD_PRELOAD: "/evil.so",
                LD_LIBRARY_PATH: "/evil",
                PATH: "/evil/bin",
                HOME: "/evil/home",
                NODE_ENV: "from-payload",
              },
            },
            workingDir,
            scratchDir,
            cacheDir,
            imageTag,
            tools,
            layout,
            onOutput: (stream, line) => lines.push(`${stream}:${line}`),
          }),
      );

      assertEquals(result.imageTag, imageTag);
      assertEquals(result.imageDigest, IMAGE_ID);
      assertEquals(result.railpackFrontendVersion, RAILPACK_FRONTEND_VERSION);
      assertEquals(result.railpackPlanVersion, "plan-7");
      assertEquals((await Deno.stat(cacheDir)).isDirectory, true);
      await assertRejects(() => Deno.stat(imageTarPath), Deno.errors.NotFound);

      const railpackEnv = await Deno.readTextFile(
        join(captureDir, "railpack.env"),
      );
      assertEquals(railpackEnv.includes("FOO=bar"), true);
      assertEquals(railpackEnv.includes("RAILPACK_INSTALL_CMD=npm ci"), true);
      assertEquals(
        railpackEnv.includes("RAILPACK_BUILD_CMD=npm run build"),
        true,
      );
      assertEquals(
        railpackEnv.includes("RAILPACK_START_CMD=node server.js"),
        true,
      );
      assertEquals(railpackEnv.includes("CI=1"), true);
      assertEquals(railpackEnv.includes("NODE_ENV=from-payload"), true);
      assertEquals(railpackEnv.includes("GIT_ASKPASS=should-not-leak"), false);
      assertEquals(railpackEnv.includes("GIT_SSH_COMMAND="), false);
      assertEquals(railpackEnv.includes("LD_PRELOAD="), false);
      assertEquals(railpackEnv.includes("LD_LIBRARY_PATH="), false);
      assertEquals(railpackEnv.includes("PATH=/evil/bin"), false);
      assertEquals(railpackEnv.includes(`HOME=${workingDir}`), true);

      const buildArgs = await Deno.readTextFile(
        join(captureDir, "buildctl.args"),
      );
      assertEquals(
        buildArgs.includes(
          `source=oci-layout://${RAILPACK_FRONTEND_LAYOUT_NAME}@${VALID_DIGEST}`,
        ),
        true,
      );
      assertEquals(
        buildArgs.includes(
          `${RAILPACK_FRONTEND_LAYOUT_NAME}=${tools.frontendLayoutDir}`,
        ),
        true,
      );
      assertEquals(buildArgs.includes("env:FOO=bar"), true);
      assertEquals(buildArgs.includes("env:NODE_ENV=from-payload"), true);
      assertEquals(buildArgs.includes("env:GIT_ASKPASS="), false);
      assertEquals(buildArgs.includes("env:PATH="), false);
      assertEquals(buildArgs.includes("env:HOME="), false);
      assertEquals(buildArgs.includes(`type=local,src=${cacheDir}`), true);
      assertEquals(
        lines.some((line) => line.includes("$ railpack prepare")),
        true,
      );
      assertEquals(
        lines.some((line) => line.includes("$ buildctl build")),
        true,
      );
      assertEquals(lines.some((line) => line.includes("$ docker load")), true);
    });
  },
});

test({
  name:
    "runRailpackBuild records a numeric plan version and omits a blank inspect",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      const captureDir = join(scratchDir, "capture");
      const cacheDir = railpackCacheDir(layout, "proj-num");
      const imageTarPath = join(scratchDir, "railpack-image.tar");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(captureDir, { recursive: true });
      const tools = await plantFakeTools(layout.runtimesDir, {
        railpack: railpackPrepareScript(captureDir, '{"version":3}'),
        buildctl: buildctlScript(captureDir, imageTarPath),
        buildkitd: "#!/bin/sh\nexit 0\n",
      });
      await writeExec(
        join(scratchDir, "bin", "docker"),
        dockerScript(captureDir, { emptyInspect: true }),
      );
      const result = await withPath(
        join(scratchDir, "bin"),
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheDir,
            imageTag: "turbopanel-app/web:rel-1",
            tools,
            layout,
          }),
      );
      assertEquals(result.railpackPlanVersion, "3");
      assertEquals("imageDigest" in result, false);
    });
  },
});

test({
  name: "runRailpackBuild falls back to the CLI version when the plan has none",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      const captureDir = join(scratchDir, "capture");
      const cacheDir = railpackCacheDir(layout, "proj-fallback");
      const imageTarPath = join(scratchDir, "railpack-image.tar");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(captureDir, { recursive: true });
      const tools = await plantFakeTools(layout.runtimesDir, {
        railpack: railpackPrepareScript(captureDir, '{"version":""}'),
        buildctl: buildctlScript(captureDir, imageTarPath),
        buildkitd: "#!/bin/sh\nexit 0\n",
      });
      await writeExec(
        join(scratchDir, "bin", "docker"),
        dockerScript(captureDir, { failInspect: true }),
      );
      const result = await withPath(
        join(scratchDir, "bin"),
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheDir,
            imageTag: "turbopanel-app/web:rel-1",
            tools,
            layout,
          }),
      );
      assertEquals(result.railpackPlanVersion, RAILPACK_VERSION);
    });
  },
});

test({
  name: "runRailpackBuild falls back when the plan is missing or unreadable",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      const captureDir = join(scratchDir, "capture");
      const cacheDir = railpackCacheDir(layout, "proj-noplan");
      const imageTarPath = join(scratchDir, "railpack-image.tar");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(captureDir, { recursive: true });
      const tools = await plantFakeTools(layout.runtimesDir, {
        railpack: railpackPrepareScript(captureDir, "not-json"),
        buildctl: buildctlScript(captureDir, imageTarPath),
        buildkitd: "#!/bin/sh\nexit 0\n",
      });
      await writeExec(
        join(scratchDir, "bin", "docker"),
        dockerScript(captureDir),
      );
      const result = await withPath(
        join(scratchDir, "bin"),
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheDir,
            imageTag: "turbopanel-app/web:rel-1",
            tools,
            layout,
          }),
      );
      assertEquals(result.railpackPlanVersion, RAILPACK_VERSION);
    });
  },
});

test({
  name: "runRailpackBuild redacts a failed docker load",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      const captureDir = join(scratchDir, "capture");
      const cacheDir = railpackCacheDir(layout, "proj-loadfail");
      const imageTarPath = join(scratchDir, "railpack-image.tar");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(captureDir, { recursive: true });
      const tools = await plantFakeTools(layout.runtimesDir, {
        railpack: railpackPrepareScript(captureDir, "{}"),
        buildctl: buildctlScript(captureDir, imageTarPath),
        buildkitd: "#!/bin/sh\nexit 0\n",
      });
      await writeExec(
        join(scratchDir, "bin", "docker"),
        dockerScript(captureDir, { failLoad: true }),
      );
      await assertRejects(
        () =>
          withPath(join(scratchDir, "bin"), () =>
            runRailpackBuild({
              build: { kind: "railpack" },
              workingDir,
              scratchDir,
              cacheDir,
              imageTag: "turbopanel-app/web:rel-1",
              tools,
              layout,
              redactSummary: (text) => text.replaceAll("supersecret", "***"),
            })),
        Error,
        "token=***",
      );
    });
  },
});

test({
  name:
    "runRailpackBuild uses stdout then the label when a tool fails silently",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(scratchDir, { recursive: true });
      const tools = await plantFakeTools(layout.runtimesDir, {
        railpack: "#!/bin/sh\necho 'visible on stdout'\nexit 1\n",
        buildctl: "#!/bin/sh\nexit 0\n",
        buildkitd: "#!/bin/sh\nexit 0\n",
      });
      await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheDir: railpackCacheDir(layout, "proj-stdout"),
            imageTag: "turbopanel-app/web:rel-1",
            tools,
            layout,
          }),
        Error,
        "visible on stdout",
      );

      await writeExec(tools.railpack, "#!/bin/sh\nexit 1\n");
      await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheDir: railpackCacheDir(layout, "proj-silent"),
            imageTag: "turbopanel-app/web:rel-1",
            tools,
            layout,
          }),
        Error,
        "railpack prepare failed",
      );
    });
  },
});

test({
  name: "runRailpackBuild starts buildkitd and reuses it once it answers",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      const captureDir = join(scratchDir, "capture");
      const readyMarker = join(scratchDir, "buildkitd-ready");
      const imageTarPath = join(scratchDir, "railpack-image.tar");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(captureDir, { recursive: true });
      const tools = await plantFakeTools(layout.runtimesDir, {
        railpack: railpackPrepareScript(captureDir, "{}"),
        buildctl: buildctlScript(captureDir, imageTarPath, { readyMarker }),
        buildkitd: `#!/bin/sh\n: > ${shLiteral(readyMarker)}\n`,
      });
      await writeExec(
        join(scratchDir, "bin", "docker"),
        dockerScript(captureDir),
      );
      const lines: string[] = [];
      const result = await withPath(
        join(scratchDir, "bin"),
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheDir: railpackCacheDir(layout, "proj-daemon"),
            imageTag: "turbopanel-app/web:rel-1",
            tools,
            layout,
            onOutput: (_stream, line) => lines.push(line),
          }, { buildkitdPollIntervalMs: 20 }),
      );
      assertEquals(result.imageTag, "turbopanel-app/web:rel-1");
      assertEquals(
        lines.some((line) => line.includes("starting vendored buildkitd")),
        true,
      );
    });
  },
});

test({
  name: "runRailpackBuild fails when buildkitd never becomes ready",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(scratchDir, { recursive: true });
      const tools = await plantFakeTools(layout.runtimesDir, {
        railpack: "#!/bin/sh\nexit 0\n",
        buildctl: "#!/bin/sh\nexit 1\n",
        buildkitd: "#!/bin/sh\nexit 0\n",
      });
      await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheDir: railpackCacheDir(layout, "proj-unready"),
            imageTag: "turbopanel-app/web:rel-1",
            tools,
            layout,
          }, { buildkitdReadyTimeoutMs: 80, buildkitdPollIntervalMs: 20 }),
        Error,
        "buildkitd did not become ready",
      );
    });
  },
});

test({
  name:
    "runRailpackBuild injectable seams skip real spawn and drop reserved env",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      const cacheDir = railpackCacheDir(layout, "proj-inject");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(scratchDir, { recursive: true });
      const tools: BuildkitRailpackTools = {
        railpack: "/opt/missing/railpack",
        buildctl: "/opt/missing/buildctl",
        buildkitd: "/opt/missing/buildkitd",
        frontendLayoutDir: railpackFrontendLayoutDir(layout.runtimesDir),
        frontendDigest: VALID_DIGEST,
      };
      const calls: Array<
        { bin: string; args: string[]; env: Record<string, string> }
      > = [];
      const result = await runRailpackBuild({
        build: {
          kind: "railpack",
          env: { GIT_ASKPASS: "leak", VISIBLE: "ok" },
        },
        workingDir,
        scratchDir,
        cacheDir,
        imageTag: "turbopanel-app/web:rel-1",
        tools,
        layout,
      }, {
        ensureDaemon: () => Promise.resolve("unix:///tmp/fake.sock"),
        inspectImage: () => Promise.resolve(undefined),
        runTool: (bin, args, options) => {
          calls.push({ bin, args, env: options.env });
          return Promise.resolve();
        },
      });
      assertEquals(result.imageTag, "turbopanel-app/web:rel-1");
      assertEquals(calls[0]?.env.GIT_ASKPASS, undefined);
      assertEquals(calls[0]?.env.VISIBLE, "ok");
      assertEquals(calls[1]?.args.includes("env:VISIBLE=ok"), true);
      assertEquals(
        calls[1]?.args.some((arg) => arg.includes("env:GIT_ASKPASS=")),
        false,
      );
    });
  },
});

test({
  name:
    "runRailpackBuild injectable success records inspect digest and frontend source",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      const cacheDir = railpackCacheDir(layout, "proj-ok");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(scratchDir, { recursive: true });
      await Deno.writeTextFile(
        join(scratchDir, "railpack-plan.json"),
        JSON.stringify({ version: "from-file" }),
      );
      const tools: BuildkitRailpackTools = {
        railpack: join(scratchDir, "railpack"),
        buildctl: join(scratchDir, "buildctl"),
        buildkitd: join(scratchDir, "buildkitd"),
        frontendLayoutDir: "/vendor/railpack-frontend/current/image",
        frontendDigest: VALID_DIGEST,
      };
      const buildArgs: string[] = [];
      const result = await runRailpackBuild({
        build: { kind: "railpack", env: { VISIBLE: "1" } },
        workingDir,
        scratchDir,
        cacheDir,
        imageTag: "turbopanel-app/web:rel-2",
        tools,
        layout,
      }, {
        ensureDaemon: () => Promise.resolve("unix:///run/buildkitd.sock"),
        inspectImage: (tag) => {
          assertEquals(tag, "turbopanel-app/web:rel-2");
          return Promise.resolve(IMAGE_ID);
        },
        runTool: (_bin, args, options) => {
          if (options.label === "buildctl build") buildArgs.push(...args);
          return Promise.resolve();
        },
      });
      assertEquals(result.imageDigest, IMAGE_ID);
      assertEquals(result.railpackPlanVersion, "from-file");
      assertEquals(buildArgs[0], "--addr");
      assertEquals(buildArgs[1], "unix:///run/buildkitd.sock");
      assertEquals(
        buildArgs.includes(
          `source=oci-layout://${RAILPACK_FRONTEND_LAYOUT_NAME}@${VALID_DIGEST}`,
        ),
        true,
      );
      assertEquals((await Deno.stat(cacheDir)).isDirectory, true);
    });
  },
});

test({
  name:
    "runRailpackBuild injected runTool failure uses the default label when empty",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const workingDir = join(fixture.dirs.stateDir, "checkout");
      const scratchDir = join(fixture.dirs.stateDir, "scratch");
      await Deno.mkdir(workingDir, { recursive: true });
      await Deno.mkdir(scratchDir, { recursive: true });
      await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheDir: railpackCacheDir(layout, "proj-label"),
            imageTag: "turbopanel-app/web:rel-1",
            tools: {
              railpack: "/missing",
              buildctl: "/missing",
              buildkitd: "/missing",
              frontendLayoutDir: "/missing",
              frontendDigest: VALID_DIGEST,
            },
            layout,
          }, {
            ensureDaemon: () => Promise.resolve("unix:///tmp/x.sock"),
            runTool: (_bin, _args, options) =>
              Promise.reject(new Error(`${options.label} failed`)),
          }),
        Error,
        "railpack prepare failed",
      );
    });
  },
});
