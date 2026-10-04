import { dirname, join } from "@std/path";
import { assertEquals, assertRejects } from "@std/assert";
import { resolveLayout } from "../../paths/layout.ts";
import { withTempLayout } from "../../testing/temp-layout.ts";
import { forEachSequential } from "../../util/sequential.ts";
import {
  type DockerCliResult,
  type RunDockerStreamedOptions,
  setDockerCliIoForTest,
} from "../docker-cli.ts";
import {
  type BuildkitRailpackTools,
  RAILPACK_FRONTEND_IMAGE,
  RAILPACK_FRONTEND_VERSION,
  RAILPACK_VERSION,
  railpackBuildxArgs,
  railpackCacheKey,
  railpackFrontendLayoutDir,
  railpackFrontendRef,
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
const FRONTEND_REF = `${RAILPACK_FRONTEND_IMAGE}@${VALID_DIGEST}`;

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
  railpackScript: string,
): Promise<BuildkitRailpackTools> {
  const railpackDir = join(runtimesDir, "railpack", RAILPACK_VERSION);
  const frontendDir = join(
    runtimesDir,
    "railpack-frontend",
    RAILPACK_FRONTEND_VERSION,
  );
  await writeExec(join(railpackDir, "railpack"), railpackScript);
  await Deno.mkdir(join(frontendDir, "image"), { recursive: true });
  await Deno.writeTextFile(
    join(frontendDir, "image", "index.json"),
    JSON.stringify({ manifests: [{ digest: VALID_DIGEST }] }),
  );
  await Deno.writeTextFile(join(frontendDir, "digest"), `${VALID_DIGEST}\n`);
  await linkCurrent(join(runtimesDir, "railpack"), railpackDir);
  await linkCurrent(join(runtimesDir, "railpack-frontend"), frontendDir);
  return {
    railpack: join(runtimesDir, "railpack", "current", "railpack"),
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

type DockerCall = { args: string[]; options?: RunDockerStreamedOptions };

const ok = (stdout = ""): DockerCliResult => ({
  success: true,
  code: 0,
  stdout,
  stderr: "",
});
const fail = (stderr: string, stdout = ""): DockerCliResult => ({
  success: false,
  code: 1,
  stdout,
  stderr,
});

/**
 * Fake `runDocker`: records every call and answers by subcommand. `overrides`
 * replaces the answer for `buildx version`, `buildx build`, `image inspect` of
 * the frontend, `image inspect` of the built tag, or `load`.
 */
function fakeDocker(
  overrides: Partial<
    Record<
      "probe" | "build" | "frontend" | "inspect" | "load",
      DockerCliResult
    >
  > = {},
) {
  const calls: DockerCall[] = [];
  const run = (args: string[], options?: RunDockerStreamedOptions) => {
    calls.push(options === undefined ? { args } : { args, options });
    let answer: DockerCliResult = ok();
    if (args[0] === "buildx" && args[1] === "version") {
      answer = overrides.probe ?? ok("github.com/docker/buildx v0.37.1");
    } else if (args[0] === "buildx") {
      options?.onLine?.({ stream: "stderr", line: "#1 building" });
      answer = overrides.build ?? ok();
    } else if (args[0] === "image" && args.includes(FRONTEND_REF)) {
      answer = overrides.frontend ?? ok("sha256:frontend");
    } else if (args[0] === "image") {
      answer = overrides.inspect ?? ok(IMAGE_ID);
    } else if (args[0] === "load") {
      answer = overrides.load ?? ok();
    }
    return Promise.resolve(answer);
  };
  return { calls, run };
}

async function setup(
  fixture: Parameters<
    Parameters<typeof withTempLayout>[0]
  >[0],
) {
  const layout = resolveLayout(fixture.env, {
    skipDiscovery: true,
    forceMode: "production",
  });
  const workingDir = join(fixture.dirs.stateDir, "checkout");
  const scratchDir = join(fixture.dirs.stateDir, "scratch");
  const captureDir = join(scratchDir, "capture");
  await Deno.mkdir(workingDir, { recursive: true });
  await Deno.mkdir(captureDir, { recursive: true });
  return { layout, workingDir, scratchDir, captureDir };
}

const SEAM_TOOLS: BuildkitRailpackTools = {
  railpack: "/missing/railpack",
  frontendLayoutDir: "/missing/image",
  frontendDigest: VALID_DIGEST,
};

test("railpackBuildxArgs targets the Engine builder with the pinned frontend", () => {
  const args = railpackBuildxArgs({
    workingDir: "/w/checkout",
    cacheKey: "proj-1",
    imageTag: "turbopanel-app/web:rel-1",
    tools: SEAM_TOOLS,
  }, "/w/scratch/railpack-plan.json");
  assertEquals(args, [
    "buildx",
    "build",
    "--builder",
    "default",
    "--progress=plain",
    "--provenance=false",
    "--sbom=false",
    "--build-arg",
    `BUILDKIT_SYNTAX=${FRONTEND_REF}`,
    "--build-arg",
    "cache-key=proj-1",
    "--file",
    "/w/scratch/railpack-plan.json",
    "--tag",
    "turbopanel-app/web:rel-1",
    "--load",
    "/w/checkout",
  ]);
  // Never a host network or an insecure entitlement: the gate's strict profile
  // refuses host-network builds.
  assertEquals(args.some((arg) => arg.startsWith("--network")), false);
  assertEquals(args.some((arg) => arg.startsWith("--allow")), false);
});

test("railpackFrontendRef names the frontend by digest only", () => {
  assertEquals(railpackFrontendRef(VALID_DIGEST), FRONTEND_REF);
});

test("railpackCacheKey is the project id and refuses unsafe ones", () => {
  assertEquals(railpackCacheKey("proj-1"), "proj-1");
  for (const bad of ["", "-lead", "../other", "a/b", "x".repeat(65)]) {
    let threw = false;
    try {
      railpackCacheKey(bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, bad);
  }
});

test({
  name:
    "runRailpackBuild prepares with build env, then builds via docker buildx without it",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { layout, workingDir, scratchDir, captureDir } = await setup(
        fixture,
      );
      const imageTag = railpackImageTag("web-api", "rel-9");
      const tools = await plantFakeTools(
        layout.runtimesDir,
        railpackPrepareScript(captureDir, '{"version":"plan-7"}'),
      );
      const docker = fakeDocker();
      const lines: string[] = [];
      const result = await runRailpackBuild({
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
        cacheKey: railpackCacheKey("proj-railpack-1"),
        imageTag,
        tools,
        onOutput: (stream, line) => lines.push(`${stream}:${line}`),
      }, { runDocker: docker.run });

      assertEquals(result.imageTag, imageTag);
      assertEquals(result.imageDigest, IMAGE_ID);
      assertEquals(result.railpackFrontendVersion, RAILPACK_FRONTEND_VERSION);
      assertEquals(result.railpackPlanVersion, "plan-7");

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

      // Order: buildx probe, frontend presence, build, built-image inspect.
      assertEquals(docker.calls.map((call) => call.args.slice(0, 2)), [
        ["buildx", "version"],
        ["image", "inspect"],
        ["buildx", "build"],
        ["image", "inspect"],
      ]);
      const build = docker.calls[2];
      assertEquals(
        build?.args,
        railpackBuildxArgs({
          workingDir,
          cacheKey: "proj-railpack-1",
          imageTag,
          tools,
        }, join(scratchDir, "railpack-plan.json")),
      );
      // Tenant build env never reaches the docker CLI's argv.
      for (const value of ["bar", "should-not-leak", "from-payload", "/evil"]) {
        assertEquals(
          build?.args.some((arg) => arg.includes(value)),
          false,
          value,
        );
      }
      assertEquals(build?.options?.signal instanceof AbortSignal, true);
      assertEquals(docker.calls[3]?.args.includes(imageTag), true);
      assertEquals(
        lines.some((line) => line.includes("$ railpack prepare")),
        true,
      );
      assertEquals(
        lines.some((line) =>
          line.includes(`$ docker buildx build (${FRONTEND_REF})`)
        ),
        true,
      );
      assertEquals(lines.includes("stderr:#1 building"), true);
    });
  },
});

test({
  name:
    "runRailpackBuild loads the vendored frontend when Docker's store lost it",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { layout, workingDir, scratchDir, captureDir } = await setup(
        fixture,
      );
      const tools = await plantFakeTools(
        layout.runtimesDir,
        railpackPrepareScript(captureDir, "{}"),
      );
      const docker = fakeDocker({ frontend: fail("No such image") });
      const commands: string[][] = [];
      const lines: string[] = [];
      await runRailpackBuild({
        build: { kind: "railpack" },
        workingDir,
        scratchDir,
        cacheKey: "proj-load",
        imageTag: "turbopanel-app/web:rel-1",
        tools,
        onOutput: (_stream, line) => lines.push(line),
      }, {
        runDocker: docker.run,
        runCommand: (command, args) => {
          commands.push([command, ...args]);
          return Promise.resolve({ success: true, stderr: "" });
        },
      });
      const tarball = join(scratchDir, "railpack-frontend.tar");
      assertEquals(commands, [[
        "/usr/bin/tar",
        "-cf",
        tarball,
        "-C",
        tools.frontendLayoutDir,
        ".",
      ]]);
      assertEquals(
        docker.calls.some((call) =>
          call.args.join(" ") === `load -i ${tarball}`
        ),
        true,
      );
      assertEquals(
        lines.some((line) => line.includes("loading vendored Railpack")),
        true,
      );
    });
  },
});

test({
  name:
    "runRailpackBuild still builds when the vendored frontend cannot be loaded",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { layout, workingDir, scratchDir, captureDir } = await setup(
        fixture,
      );
      const tools = await plantFakeTools(
        layout.runtimesDir,
        railpackPrepareScript(captureDir, "{}"),
      );
      const variants = [
        { tarOk: false, load: ok() },
        { tarOk: true, load: fail("") },
      ];
      await forEachSequential(variants, async (variant) => {
        const docker = fakeDocker({
          frontend: fail("No such image"),
          load: variant.load,
        });
        const result = await runRailpackBuild({
          build: { kind: "railpack" },
          workingDir,
          scratchDir,
          cacheKey: "proj-noload",
          imageTag: "turbopanel-app/web:rel-1",
          tools,
        }, {
          runDocker: docker.run,
          runCommand: () =>
            Promise.resolve({ success: variant.tarOk, stderr: "tar: denied" }),
        });
        assertEquals(result.imageDigest, IMAGE_ID);
        assertEquals(
          docker.calls.some((call) => call.args[0] === "load"),
          variant.tarOk,
        );
        assertEquals(
          docker.calls.some((call) => call.args[1] === "build"),
          true,
        );
      });
    });
  },
});

test({
  name: "runRailpackBuild names the missing buildx plugin before preparing",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { layout, workingDir, scratchDir, captureDir } = await setup(
        fixture,
      );
      const tools = await plantFakeTools(
        layout.runtimesDir,
        railpackPrepareScript(captureDir, "{}"),
      );
      const docker = fakeDocker({
        probe: fail("docker: 'buildx' is not a docker command."),
      });
      await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheKey: "proj-nobuildx",
            imageTag: "turbopanel-app/web:rel-1",
            tools,
          }, { runDocker: docker.run }),
        Error,
        "docker-buildx-plugin); `docker buildx version` failed: docker: 'buildx' is not a docker command.",
      );
      await assertRejects(
        () => Deno.stat(join(captureDir, "railpack.args")),
        Deno.errors.NotFound,
      );
      // A probe that says nothing still names its exit code.
      await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheKey: "proj-nobuildx",
            imageTag: "turbopanel-app/web:rel-1",
            tools,
          }, { runDocker: fakeDocker({ probe: fail("") }).run }),
        Error,
        "failed: exit code 1",
      );
    });
  },
});

test({
  name:
    "runRailpackBuild reports the redacted tail of BuildKit's own failure output",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { layout, workingDir, scratchDir, captureDir } = await setup(
        fixture,
      );
      const tools = await plantFakeTools(
        layout.runtimesDir,
        railpackPrepareScript(captureDir, "{}"),
      );
      const noise = Array.from({ length: 40 }, (_, i) => `#${i} step`);
      const stderr = [...noise, "", "ERROR: token=supersecret denied"].join(
        "\n",
      );
      const failing = fakeDocker({ build: fail(stderr) });
      const err = await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheKey: "proj-fail",
            imageTag: "turbopanel-app/web:rel-1",
            tools,
            redactSummary: (text) => text.replaceAll("supersecret", "***"),
          }, { runDocker: failing.run }),
        Error,
        "docker buildx build failed: ",
      );
      assertEquals(err.message.includes("token=***"), true);
      assertEquals(err.message.includes("supersecret"), false);
      assertEquals(err.message.includes("#0 step"), false);
      assertEquals(err.message.includes("#39 step"), true);

      // Silent stderr falls back to stdout, then to the exit code.
      await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheKey: "proj-fail",
            imageTag: "turbopanel-app/web:rel-1",
            tools,
          }, { runDocker: fakeDocker({ build: fail("", "on stdout") }).run }),
        Error,
        "docker buildx build failed: on stdout",
      );
      await assertRejects(
        () =>
          runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheKey: "proj-fail",
            imageTag: "turbopanel-app/web:rel-1",
            tools,
          }, { runDocker: fakeDocker({ build: fail("") }).run }),
        Error,
        "docker buildx build failed: exit code 1",
      );
    });
  },
});

test({
  name:
    "runRailpackBuild records a numeric plan version and omits a blank inspect",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { layout, workingDir, scratchDir, captureDir } = await setup(
        fixture,
      );
      const tools = await plantFakeTools(
        layout.runtimesDir,
        railpackPrepareScript(captureDir, '{"version":3}'),
      );
      const result = await runRailpackBuild({
        build: { kind: "railpack" },
        workingDir,
        scratchDir,
        cacheKey: "proj-num",
        imageTag: "turbopanel-app/web:rel-1",
        tools,
      }, { runDocker: fakeDocker({ inspect: ok("  ") }).run });
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
      const { layout, workingDir, scratchDir, captureDir } = await setup(
        fixture,
      );
      await forEachSequential(
        ['{"version":""}', "not-json"],
        async (planBody) => {
          const tools = await plantFakeTools(
            layout.runtimesDir,
            railpackPrepareScript(captureDir, planBody),
          );
          const result = await runRailpackBuild({
            build: { kind: "railpack" },
            workingDir,
            scratchDir,
            cacheKey: "proj-fallback",
            imageTag: "turbopanel-app/web:rel-1",
            tools,
          }, { runDocker: fakeDocker({ inspect: fail("no such image") }).run });
          assertEquals(result.railpackPlanVersion, RAILPACK_VERSION);
          assertEquals(result.imageDigest, undefined);
        },
      );
    });
  },
});

test({
  name:
    "runRailpackBuild uses stdout then the label when railpack prepare fails silently",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { layout, workingDir, scratchDir } = await setup(fixture);
      const tools = await plantFakeTools(
        layout.runtimesDir,
        "#!/bin/sh\necho 'visible on stdout'\nexit 1\n",
      );
      const params = {
        build: { kind: "railpack" as const },
        workingDir,
        scratchDir,
        cacheKey: "proj-stdout",
        imageTag: "turbopanel-app/web:rel-1",
        tools,
      };
      await assertRejects(
        () => runRailpackBuild(params, { runDocker: fakeDocker().run }),
        Error,
        "visible on stdout",
      );
      await writeExec(tools.railpack, "#!/bin/sh\nexit 1\n");
      await assertRejects(
        () => runRailpackBuild(params, { runDocker: fakeDocker().run }),
        Error,
        "railpack prepare failed",
      );
    });
  },
});

test({
  name: "runRailpackBuild injected seams skip real spawns",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { workingDir, scratchDir } = await setup(fixture);
      await Deno.writeTextFile(
        join(scratchDir, "railpack-plan.json"),
        JSON.stringify({ version: "from-file" }),
      );
      const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
      const result = await runRailpackBuild({
        build: {
          kind: "railpack",
          env: { GIT_ASKPASS: "leak", VISIBLE: "ok" },
        },
        workingDir,
        scratchDir,
        cacheKey: "proj-inject",
        imageTag: "turbopanel-app/web:rel-2",
        tools: SEAM_TOOLS,
      }, {
        runDocker: fakeDocker().run,
        inspectImage: (tag) => {
          assertEquals(tag, "turbopanel-app/web:rel-2");
          return Promise.resolve(IMAGE_ID);
        },
        runTool: (_bin, args, options) => {
          calls.push({ args, env: options.env });
          return Promise.resolve();
        },
      });
      assertEquals(result.imageDigest, IMAGE_ID);
      assertEquals(result.railpackPlanVersion, "from-file");
      assertEquals(calls.length, 1);
      assertEquals(calls[0]?.env.GIT_ASKPASS, undefined);
      assertEquals(calls[0]?.env.VISIBLE, "ok");
    });
  },
});

test({
  name: "runRailpackBuild reports a streamed-tool AbortError as a timeout",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { workingDir, scratchDir } = await setup(fixture);
      const original = Deno.Command;
      Deno.Command = class {
        spawn() {
          throw new DOMException("The signal has been aborted", "AbortError");
        }
      } as unknown as typeof Deno.Command;
      try {
        await assertRejects(
          () =>
            runRailpackBuild({
              build: { kind: "railpack" },
              workingDir,
              scratchDir,
              cacheKey: "proj-abort",
              imageTag: "turbopanel-app/web:rel-1",
              tools: SEAM_TOOLS,
            }, { runDocker: fakeDocker().run }),
          Error,
          "railpack prepare timed out",
        );
      } finally {
        Deno.Command = original;
      }
    });
  },
});

/**
 * End to end through the real shared docker CLI path (`runDockerStreamed`),
 * with a fake `docker` binary that records its own environment: tenant build
 * env and the checkout `HOME` must not reach it, and the build timeout must
 * actually kill it.
 */
test({
  name:
    "runRailpackBuild drives the shared docker CLI path without tenant env and kills it on timeout",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const { layout, workingDir, scratchDir, captureDir } = await setup(
        fixture,
      );
      const tools = await plantFakeTools(
        layout.runtimesDir,
        railpackPrepareScript(captureDir, "{}"),
      );
      const dockerBin = join(scratchDir, "bin", "docker");
      const marker = join(captureDir, "slow");
      await writeExec(
        dockerBin,
        `#!/bin/sh
if [ "$1" = "buildx" ] && [ "$2" = "build" ]; then
  env | sort > ${shLiteral(join(captureDir, "docker.env"))}
  printf '%s\\n' "$@" > ${shLiteral(join(captureDir, "docker.args"))}
  if [ -f ${shLiteral(marker)} ]; then exec sleep 30; fi
  echo "#1 DONE" >&2
  exit 0
fi
if [ "$1" = "image" ]; then echo ${shLiteral(IMAGE_ID)}; fi
exit 0
`,
      );
      const restore = setDockerCliIoForTest({ dockerBin });
      try {
        const params = {
          build: {
            kind: "railpack" as const,
            env: { FOO: "tenant-value", DOCKER_CONFIG: "/evil/config" },
          },
          workingDir,
          scratchDir,
          cacheKey: "proj-e2e",
          imageTag: "turbopanel-app/web:rel-1",
          tools,
        };
        const result = await runRailpackBuild(params);
        assertEquals(result.imageDigest, IMAGE_ID);
        const dockerEnv = await Deno.readTextFile(
          join(captureDir, "docker.env"),
        );
        assertEquals(dockerEnv.includes("tenant-value"), false);
        assertEquals(dockerEnv.includes("/evil/config"), false);
        assertEquals(dockerEnv.includes(`HOME=${workingDir}\n`), false);
        assertEquals(dockerEnv.includes(`DOCKER_CONFIG=${workingDir}`), false);
        const dockerArgs = await Deno.readTextFile(
          join(captureDir, "docker.args"),
        );
        assertEquals(
          dockerArgs.includes(`BUILDKIT_SYNTAX=${FRONTEND_REF}`),
          true,
        );

        await Deno.writeTextFile(marker, "");
        const started = Date.now();
        await assertRejects(
          () => runRailpackBuild(params, { toolTimeoutMs: 300 }),
          Error,
          "docker buildx build timed out after 300ms",
        );
        assertEquals(Date.now() - started < 10_000, true);
      } finally {
        restore();
      }
    });
  },
});
