/**
 * A native Deno build: the commands it derives, the environment it runs in,
 * and how its release starts (`runtime: "deno"`). Node builds are covered by
 * `build-defaults.test.ts` and must not change.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  buildEnvironment,
  type NativeAppBuildContext,
  type NativeBuildRuntime,
  prepareNativeAppBuildOutput,
  runReleaseBuild,
  sandboxBuildEnvironment,
} from "./build.ts";
import type { BuildWork } from "./build-sandbox.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

const DENO_BIN_DIR = "/opt/turbopanel/vendor/deno-app/2/current/bin";
const DENO_RUNTIME: NativeBuildRuntime = {
  runtime: "deno",
  nodeBinDir: DENO_BIN_DIR,
  nodeEnv: "production",
  runtimeGroup: "tpdeno2",
};

async function withWorkingDir(
  fn: (workingDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-deno-build-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeFile(dir: string, relative: string, text = "") {
  await Deno.mkdir(join(dir, relative, ".."), { recursive: true });
  await Deno.writeTextFile(join(dir, relative), text);
}

/** What `runReleaseBuild` ran, and the environment of the first command. */
async function runDerived(workingDir: string, build = {}) {
  const ran: string[] = [];
  const envs: Array<Record<string, string>> = [];
  const lines: string[] = [];
  await runReleaseBuild({
    build: { kind: "native", ...build },
    workingDir,
    nativeRuntime: DENO_RUNTIME,
    runCommand: (command, _cwd, env) => {
      ran.push(command);
      envs.push(env);
      return Promise.resolve();
    },
    onOutput: (_stream, line) => lines.push(line),
  });
  return { ran, envs, lines };
}

test("a Deno build runs deno install then deno task build, with Deno on PATH and its own cache", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeFile(
      workingDir,
      "deno.json",
      '{"tasks":{"build":"deno task x","start":"deno run -A main.ts"}}',
    );
    await writeFile(workingDir, "deno.lock", "{}");
    const { ran, envs, lines } = await runDerived(workingDir);
    assertEquals(ran, ["deno install", "deno task build"]);
    const env = envs[0];
    assertEquals(env.PATH.startsWith(`${DENO_BIN_DIR}:`), true);
    assertEquals(env.DENO_DIR, join(workingDir, ".deno"));
    assertEquals(env.DENO_NO_UPDATE_CHECK, "1");
    assertEquals(env.DENO_NO_PROMPT, "1");
    assertEquals("COREPACK_HOME" in env, false);
    assertEquals(
      lines.includes(
        "derived build command from deno.json (it has a build task)",
      ),
      true,
    );
  });
});

test("a Deno build with only an entry file caches its imports, and after a derived install and build too", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeFile(workingDir, "server.ts");
    const { ran } = await runDerived(workingDir);
    assertEquals(ran, ["deno cache server.ts"]);
  });
  await withWorkingDir(async (workingDir) => {
    await writeFile(
      workingDir,
      "deno.json",
      '{"tasks":{"build":"x","start":"deno run -A main.ts"}}',
    );
    await writeFile(workingDir, "deno.lock", "{}");
    await writeFile(workingDir, "main.ts");
    const { ran } = await runDerived(workingDir);
    assertEquals(ran, [
      "deno install",
      "deno task build",
      "deno cache main.ts",
    ]);
  });
});

test("a Deno build with a start task and an entry file caches the entry; with nothing to cache it ships as-is; an explicit command is not rewritten", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeFile(
      workingDir,
      "deno.json",
      '{"tasks":{"start":"deno run -A main.ts"}}',
    );
    await writeFile(workingDir, "main.ts");
    assertEquals((await runDerived(workingDir)).ran, ["deno cache main.ts"]);
  });
  await withWorkingDir(async (workingDir) => {
    await writeFile(workingDir, "deno.json", '{"tasks":{"start":"x"}}');
    assertEquals((await runDerived(workingDir)).ran, []);
    // The Node package-manager rewrite does not apply: bare pnpm stays as typed.
    const explicit = await runDerived(workingDir, {
      installCommand: "deno install --allow-scripts",
      buildCommand: "pnpm build",
    });
    assertEquals(explicit.ran, ["deno install --allow-scripts", "pnpm build"]);
  });
});

test("sandboxed Deno builds keep DENO_DIR in the project cache and never set Corepack", () => {
  const work = {
    buildId: "b1",
    projectKey: "p1",
    owner: "alice",
    workDir: "/var/lib/turbopanel/build/work/b1",
    checkoutDir: "/var/lib/turbopanel/build/work/b1/source",
    cacheDir: "/var/lib/turbopanel/build/cache/alice/p1",
  } as unknown as BuildWork;
  const env = sandboxBuildEnvironment({ kind: "native" }, work, DENO_RUNTIME);
  assertEquals(env.DENO_DIR, "/var/lib/turbopanel/build/cache/alice/p1/deno");
  assertEquals(env.PATH.startsWith(DENO_BIN_DIR), true);
  assertEquals(env.DENO_NO_PROMPT, "1");
  assertEquals("COREPACK_HOME" in env, false);
  // Node unchanged.
  const node = sandboxBuildEnvironment({ kind: "native" }, work, {
    nodeBinDir: "/n/bin",
    nodeEnv: "production",
  });
  assertStringIncludes(node.COREPACK_HOME, "/corepack");
  assertEquals("DENO_DIR" in node, false);
  assertEquals(
    "DENO_DIR" in buildEnvironment({ kind: "native" }, "/w", {
      nodeBinDir: "/n/bin",
      nodeEnv: "production",
    }),
    false,
  );
});

async function detect(
  workingDir: string,
  overrides: Partial<NativeAppBuildContext> = {},
) {
  const lines: string[] = [];
  const output = await prepareNativeAppBuildOutput({
    framework: "auto",
    runtime: "deno",
    workingDir,
    detectStart: true,
    onOutput: (_stream, line) => lines.push(line),
    ...overrides,
  });
  return { output, lines };
}

test("the fixture Deno project starts with deno task start and says where to listen", async () => {
  const fixture = fromFileUrl(new URL("./testdata/deno-app", import.meta.url));
  const { output, lines } = await detect(fixture);
  assertEquals(output.start, { kind: "deno-task" });
  assertEquals(output.standaloneOutput, false);
  assertEquals(output.staticExport, false);
  assertEquals(
    lines.includes(
      "no start command set — the app will start with the deno.json start task (deno task start)",
    ),
    true,
  );
  assertEquals(
    lines.some((line) => line.includes("pass Deno.serve the hostname")),
    true,
  );
});

test("a Deno release without a start task starts from its entry file", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeFile(workingDir, "deno.json", '{"main":"./src/app.ts"}');
    await writeFile(workingDir, "src/app.ts");
    const { output } = await detect(workingDir);
    assertEquals(output.start, { kind: "deno-file", path: "src/app.ts" });
  });
  await withWorkingDir(async (workingDir) => {
    // No config at all: a conventional file, with a note.
    await writeFile(workingDir, "mod.ts");
    const { output, lines } = await detect(workingDir);
    assertEquals(output.start, { kind: "deno-file", path: "mod.ts" });
    assertEquals(lines.some((l) => l.includes("no deno.json")), true);
  });
});

test("a Deno release is never read as a Next.js build, and links are not entries", async () => {
  await withWorkingDir(async (workingDir) => {
    await Deno.mkdir(join(workingDir, ".next", "standalone"), {
      recursive: true,
    });
    await writeFile(workingDir, "main.ts");
    const { output } = await detect(workingDir, { framework: "next" });
    assertEquals(output.standaloneOutput, false);
    assertEquals(output.outputDirectory, undefined);
    assertEquals(output.start, { kind: "deno-file", path: "main.ts" });
  });
  await withWorkingDir(async (workingDir) => {
    const outside = await Deno.makeTempDir({ prefix: "tp-outside-" });
    try {
      await writeFile(outside, "main.ts");
      await Deno.symlink(join(outside, "main.ts"), join(workingDir, "main.ts"));
      await assertRejects(
        () => detect(workingDir),
        Error,
        "no start command: the release has no start task in deno.json",
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

test("a Deno release with a broken config fails naming the file", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeFile(workingDir, "deno.jsonc", "{ not json");
    await writeFile(workingDir, "main.ts");
    await assertRejects(
      () => detect(workingDir),
      Error,
      "deno.jsonc is not valid JSON",
    );
  });
});

test("a Deno build in a declared output directory looks for its start there", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeFile(workingDir, "dist/deno.json", '{"tasks":{"start":"x"}}');
    const { output } = await detect(workingDir, { outputDirectory: "dist" });
    assertEquals(output.start, { kind: "deno-task" });
  });
});
