/**
 * The image builder's prepare step in the build sandbox: the daemon only
 * copies the tool in, writes a spec and reads back one checked plan file. The
 * spec is run here by the real `tp-build-runner` (as `tp-host build-run` would
 * have the unit run it), so the command, the environment and the plan path are
 * exactly what a build's throwaway user gets.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import type { DockerCliResult } from "../docker-cli.ts";
import type { BuildWork, SandboxedBuildParams } from "./build-sandbox.ts";
import {
  IMAGE_PLAN_MAX_BYTES,
  imagePrepareCommand,
  prepareImagePlanInSandbox,
  takePlan,
} from "./image-prepare-sandbox.ts";
import { readPlanVersion, runRailpackBuild } from "./railpack-build.ts";
import { UnsafeTreeError } from "./safe-copy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const RUNNER = join(
  dirname(fromFileUrl(import.meta.url)),
  "../../../orchestration/scripts/tp-build-runner",
);
const DIGEST = `sha256:${"ab".repeat(32)}`;
const PLAN = '{"version":"plan-3"}';

/** A stand-in tool: records argv, cwd and env, and writes the plan it is asked for. */
function fakeTool(captureDir: string): string {
  return `#!/bin/sh
printf '%s\\n' "$@" > '${captureDir}/args'
pwd -P > '${captureDir}/cwd'
env | sort > '${captureDir}/env'
plan=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--plan-out" ]; then plan="$arg"; fi
  prev="$arg"
done
printf '%s\\n' '${PLAN}' > "$plan"
echo prepared
`;
}

/** `runSandboxedBuild` as the unit runs it: the real runner, spec on stdin. */
function runnerSeam(seen: SandboxedBuildParams[]) {
  return async (params: SandboxedBuildParams): Promise<void> => {
    seen.push(params);
    const child = new Deno.Command("sh", {
      args: [RUNNER, params.work.workDir],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin" },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(params.spec));
    await writer.close();
    const out = await child.output();
    if (!out.success) {
      throw new Error(new TextDecoder().decode(out.stderr));
    }
  };
}

async function withWork(
  fn: (dirs: { root: string; work: BuildWork; capture: string }) => Promise<
    void
  >,
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-image-prepare-" }),
  );
  try {
    const workDir = join(root, "work", "b1");
    await Deno.mkdir(join(workDir, "source", "app"), { recursive: true });
    const capture = join(root, "capture");
    await Deno.mkdir(capture);
    await Deno.mkdir(join(root, "scratch"));
    const work: BuildWork = {
      buildId: "b1",
      projectKey: "p1",
      owner: "alice",
      workDir,
      checkoutDir: join(workDir, "source"),
      cacheDir: join(root, "caches", "alice", "p1"),
    };
    await fn({ root, work, capture });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const ok = (stdout = ""): DockerCliResult => ({
  success: true,
  code: 0,
  stdout,
  stderr: "",
});

test("the prepare command runs the tool copy in the work tree and writes the plan beside it", () => {
  assertEquals(
    imagePrepareCommand("image-builder", ["prepare", "."], "--plan-out"),
    `"$HOME"/tools/'image-builder' 'prepare' '.' '--plan-out' "$HOME"/image-plan.json`,
  );
  assertEquals(
    imagePrepareCommand("x", ["it's"], "--p"),
    `"$HOME"/tools/'x' 'it'\\''s' '--p' "$HOME"/image-plan.json`,
  );
});

test("the prepare step runs as the build, from the work tree's tool copy, and the plan comes back", async () => {
  await withWork(async ({ root, work, capture }) => {
    const tool = join(root, "vendor-tool");
    await Deno.writeTextFile(tool, fakeTool(capture), { mode: 0o750 });
    const seen: SandboxedBuildParams[] = [];
    const dest = join(root, "scratch", "plan.json");
    await prepareImagePlanInSandbox({
      sandbox: { work, cwd: "source/app", run: runnerSeam(seen) },
      tool,
      toolName: "image-builder",
      args: ["prepare", "."],
      planFlag: "--plan-out",
      env: { FOO: "bar" },
      planDest: dest,
    });
    assertEquals(seen.length, 1);
    assertEquals(seen[0]?.work, work);
    const copy = await Deno.stat(join(work.workDir, "tools", "image-builder"));
    assertEquals((copy.mode ?? 0) & 0o777, 0o700);
    assertEquals(
      (await Deno.readTextFile(join(capture, "args"))).trim().split("\n"),
      ["prepare", ".", "--plan-out", join(work.workDir, "image-plan.json")],
    );
    assertEquals(
      (await Deno.readTextFile(join(capture, "cwd"))).trim(),
      join(work.workDir, "source", "app"),
    );
    const env = await Deno.readTextFile(join(capture, "env"));
    assertStringIncludes(env, "FOO=bar\n");
    assertStringIncludes(env, `HOME=${work.workDir}\n`);
    assertStringIncludes(env, `TMPDIR=${work.workDir}/tmp\n`);
    assertEquals((await Deno.readTextFile(dest)).trim(), PLAN);
  });
});

test("a plan the build left as a link, a directory, too big or missing is never read", async () => {
  await withWork(async ({ root, work }) => {
    const plan = join(work.workDir, "image-plan.json");
    const dest = join(root, "scratch", "plan.json");
    const secret = join(root, "daemon-secret");
    await Deno.writeTextFile(secret, "not for the build\n");

    await assertRejects(
      () => takePlan(plan, dest),
      Error,
      "wrote no build plan",
    );
    await Deno.symlink(secret, plan);
    await assertRejects(() => takePlan(plan, dest), UnsafeTreeError);
    await Deno.remove(plan);
    await Deno.mkdir(plan);
    await assertRejects(() => takePlan(plan, dest), UnsafeTreeError);
    await Deno.remove(plan);
    await Deno.writeTextFile(plan, "x".repeat(IMAGE_PLAN_MAX_BYTES + 1));
    await assertRejects(() => takePlan(plan, dest), UnsafeTreeError);
    await assertRejects(() => Deno.stat(dest), Deno.errors.NotFound);
  });
});

test("an image build on a managed host prepares in the sandbox with the build's filtered variables, never as the daemon", async () => {
  await withWork(async ({ root, work, capture }) => {
    const tool = join(root, "vendor-tool");
    await Deno.writeTextFile(tool, fakeTool(capture), { mode: 0o750 });
    const seen: SandboxedBuildParams[] = [];
    const docker: string[][] = [];
    let daemonRan = 0;
    const scratchDir = join(root, "scratch");
    const result = await runRailpackBuild({
      build: {
        kind: "railpack",
        installCommand: "npm ci",
        env: {
          FOO: "bar",
          LD_PRELOAD: "/evil.so",
          BASH_ENV: "/evil.sh",
          GIT_ASKPASS: "/evil",
          PATH: "/evil/bin",
          HOME: "/evil/home",
        },
      },
      workingDir: work.checkoutDir,
      scratchDir,
      cacheKey: "p1",
      imageTag: "turbopanel-app/web:r1",
      tools: {
        railpack: tool,
        frontendLayoutDir: "/x",
        frontendDigest: DIGEST,
      },
      sandbox: { work, cwd: "source", run: runnerSeam(seen) },
    }, {
      runTool: () => {
        daemonRan += 1;
        return Promise.resolve();
      },
      runDocker: (args) => {
        docker.push(args);
        return Promise.resolve(
          args[0] === "image" && args[1] === "inspect" &&
            args.at(-1) !== "{{.Id}}"
            ? ok("sha256:frontend")
            : ok(args[0] === "buildx" && args[1] === "version" ? "v0.37" : ""),
        );
      },
      inspectImage: () => Promise.resolve("sha256:image"),
    });
    assertEquals(daemonRan, 0);
    assertEquals(seen.length, 1);
    assertEquals(result.railpackPlanVersion, "plan-3");
    const env = await Deno.readTextFile(join(capture, "env"));
    for (const leaked of ["LD_PRELOAD", "BASH_ENV", "GIT_ASKPASS", "/evil"]) {
      assertEquals(env.includes(leaked), false, leaked);
    }
    assertStringIncludes(env, "FOO=bar\n");
    assertStringIncludes(env, "=npm ci\n");
    assertStringIncludes(env, "PATH=/usr/local/bin:/usr/bin:/bin\n");
    // The image build reads the daemon's own copy of the plan and the
    // returned checkout.
    const build = docker.find((args) =>
      args[0] === "buildx" && args[1] === "build"
    );
    assert(build, "expected docker buildx build");
    const plan = build[build.indexOf("--file") + 1] ?? "";
    assert(plan.startsWith(scratchDir), plan);
    assertEquals((await Deno.readTextFile(plan)).trim(), PLAN);
    assertEquals(build.at(-1), work.checkoutDir);
  });
});

test("only a short, plain plan version is recorded from a plan the build wrote", async () => {
  await withWork(async ({ root }) => {
    const read = async (version: unknown, index: number) => {
      const plan = join(root, `plan-${index}.json`);
      await Deno.writeTextFile(plan, JSON.stringify({ version }));
      return await readPlanVersion(plan);
    };
    assertEquals(await read("1.2.3+build.4", 0), "1.2.3+build.4");
    assertEquals(await read(7, 1), "7");
    const fallback = await read("x".repeat(65), 2);
    assertEquals(fallback.length < 65, true);
    const hostile = ["a b", "v1\nforged", "$(id)", "", "x".repeat(4096)];
    const seen = await Promise.all(hostile.map((v, i) => read(v, i + 3)));
    assertEquals(seen, hostile.map(() => fallback));
  });
});
