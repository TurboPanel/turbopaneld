/**
 * The defaults a native Node build gets when its author typed no command:
 * the `build` script is run (`deriveNodeBuildCommand`), and how the release
 * starts is worked out from the built tree (`prepareNativeAppBuildOutput`
 * with `detectStart`), following the usual Node conventions.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  deriveNodeBuildCommand,
  deriveNodeInstallCommand,
  type NativeAppBuildContext,
  NEXT_STANDALONE_DIR,
  prepareNativeAppBuildOutput,
  runReleaseBuild,
} from "./build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

const NATIVE_RUNTIME = {
  nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
  nodeEnv: "production" as const,
};

async function withWorkingDir(
  fn: (workingDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-native-defaults-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(value));
}

async function writeFile(dir: string, relative: string, text = "") {
  await Deno.mkdir(join(dir, relative, ".."), { recursive: true });
  await Deno.writeTextFile(join(dir, relative), text);
}

const WITH_BUILD_SCRIPT = { scripts: { build: "next build" } };

test("deriveNodeBuildCommand runs the build script through the detected manager", async () => {
  const cases: Array<[string | undefined, string]> = [
    ["pnpm-lock.yaml", "corepack pnpm run build"],
    ["yarn.lock", "corepack yarn run build"],
    ["package-lock.json", "npm run build"],
    [undefined, "npm run build"],
  ];
  await Promise.all(
    cases.map(([lockfile, expected]) =>
      withWorkingDir(async (workingDir) => {
        await writeJson(join(workingDir, "package.json"), WITH_BUILD_SCRIPT);
        if (lockfile) await writeFile(workingDir, lockfile);
        assertEquals(await deriveNodeBuildCommand({ workingDir }), expected);
      })
    ),
  );
});

test("deriveNodeBuildCommand follows the packageManager pin, then the operator", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeJson(join(workingDir, "package.json"), {
      ...WITH_BUILD_SCRIPT,
      packageManager: "pnpm@10.20.0",
    });
    await writeFile(workingDir, "package-lock.json", "{}");
    assertEquals(
      await deriveNodeBuildCommand({ workingDir }),
      "corepack pnpm run build",
    );
    assertEquals(
      await deriveNodeBuildCommand({ packageManager: "yarn", workingDir }),
      "corepack yarn run build",
    );
  });
});

test("deriveNodeBuildCommand derives nothing without a build script", async () => {
  await withWorkingDir(async (workingDir) => {
    assertEquals(await deriveNodeBuildCommand({ workingDir }), undefined);
    await writeJson(join(workingDir, "package.json"), {
      scripts: { start: "node server.js", build: "  " },
    });
    assertEquals(await deriveNodeBuildCommand({ workingDir }), undefined);
    // Unparseable package.json: still installable, but no script to run.
    await Deno.writeTextFile(join(workingDir, "package.json"), "{nope");
    assertEquals(await deriveNodeBuildCommand({ workingDir }), undefined);
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "npm install --include=dev",
    );
  });
});

test("an npm-shrinkwrap.json is a lockfile for npm ci", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeJson(join(workingDir, "package.json"), {});
    await writeFile(workingDir, "npm-shrinkwrap.json", "{}");
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "npm ci --include=dev",
    );
  });
});

test("runReleaseBuild derives the build after the install for a native app", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeJson(join(workingDir, "package.json"), WITH_BUILD_SCRIPT);
    await writeFile(workingDir, "pnpm-lock.yaml");
    const lines: string[] = [];
    const ran: string[] = [];
    await runReleaseBuild({
      build: { kind: "native" },
      workingDir,
      nativeRuntime: NATIVE_RUNTIME,
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran, [
      "corepack pnpm install --frozen-lockfile --config.production=false",
      "corepack pnpm run build",
    ]);
    assertEquals(
      lines.includes(
        "derived build command from lockfile detection (package.json has a build script)",
      ),
      true,
    );
  });
});

test("runReleaseBuild keeps an explicit build command and derives none elsewhere", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeJson(join(workingDir, "package.json"), WITH_BUILD_SCRIPT);
    await writeFile(workingDir, "package-lock.json", "{}");
    const ran: string[] = [];
    const runCommand = (command: string) => {
      ran.push(command);
      return Promise.resolve();
    };
    // Explicit wins.
    await runReleaseBuild({
      build: { kind: "native", buildCommand: "npm run compile" },
      workingDir,
      nativeRuntime: NATIVE_RUNTIME,
      runCommand,
    });
    assertEquals(ran, ["npm ci --include=dev", "npm run compile"]);
    // Not a native app (a static site build): nothing is derived.
    ran.length = 0;
    await runReleaseBuild({
      build: { kind: "native" },
      workingDir,
      runCommand,
    });
    assertEquals(ran, []);
  });
});

/** Run start detection on `workingDir` the way a native build does. */
async function detect(
  workingDir: string,
  overrides: Partial<NativeAppBuildContext> = {},
) {
  const lines: string[] = [];
  const output = await prepareNativeAppBuildOutput({
    framework: "auto",
    workingDir,
    detectStart: true,
    onOutput: (_stream, line) => lines.push(line),
    ...overrides,
  });
  return { output, lines };
}

test("a Next standalone build still starts with node server.js", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeJson(join(workingDir, "package.json"), {
      scripts: { start: "next start" },
    });
    await writeFile(workingDir, join(NEXT_STANDALONE_DIR, "server.js"));
    const { output, lines } = await detect(workingDir, { framework: "next" });
    assertEquals(output.standaloneOutput, true);
    assertEquals(output.start, { kind: "file", path: "server.js" });
    assertEquals(
      lines.includes(
        "no start command set — the app will start with node server.js",
      ),
      true,
    );
  });
});

test("a Next build without standalone output starts with next start", async () => {
  await withWorkingDir(async (workingDir) => {
    // The common shape: `start: "next start"` (its own -p is replaced).
    await writeJson(join(workingDir, "package.json"), {
      scripts: { build: "next build", start: "next start -p 3000" },
    });
    await Deno.mkdir(join(workingDir, ".next"));
    const { output } = await detect(workingDir, { framework: "next" });
    assertEquals(output.standaloneOutput, false);
    assertEquals(output.start, { kind: "next-start" });
  });
  await withWorkingDir(async (workingDir) => {
    // No start script at all: framework next is enough.
    await writeJson(join(workingDir, "package.json"), {});
    const { output } = await detect(workingDir, { framework: "next" });
    assertEquals(output.start, { kind: "next-start" });
  });
  await withWorkingDir(async (workingDir) => {
    // framework auto: a .next/ build tree identifies it.
    await Deno.mkdir(join(workingDir, ".next"));
    const { output } = await detect(workingDir);
    assertEquals(output.start, { kind: "next-start" });
  });
});

test("the package start script wins over every file", async () => {
  const scripts = [
    "node dist/main.js",
    // Chained commands are the author's: run as written.
    "prisma migrate deploy && next start",
  ];
  await Promise.all(
    scripts.map((start) =>
      withWorkingDir(async (workingDir) => {
        await writeJson(join(workingDir, "package.json"), {
          main: "index.js",
          scripts: { start },
        });
        await writeFile(workingDir, "server.js");
        await writeFile(workingDir, "index.js");
        const { output } = await detect(workingDir);
        assertEquals(output.start, { kind: "start-script" });
      })
    ),
  );
  await withWorkingDir(async (workingDir) => {
    // framework node never treats anything as Next.
    await writeJson(join(workingDir, "package.json"), {
      scripts: { start: "next start" },
    });
    const { output } = await detect(workingDir, { framework: "node" });
    assertEquals(output.start, { kind: "start-script" });
  });
});

test("a plain Node app starts from main, then index.js, then server.js", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeJson(join(workingDir, "package.json"), {
      main: "./dist/app.js",
    });
    await writeFile(workingDir, "dist/app.js");
    await writeFile(workingDir, "server.js");
    const { output } = await detect(workingDir, { framework: "node" });
    assertEquals(output.start, { kind: "file", path: "dist/app.js" });
  });
  await withWorkingDir(async (workingDir) => {
    // A main that is unsafe in a unit line, or missing, is passed over.
    await writeJson(join(workingDir, "package.json"), { main: "../x.js" });
    await writeFile(workingDir, "index.js");
    await writeFile(workingDir, "server.js");
    const { output } = await detect(workingDir, { framework: "node" });
    assertEquals(output.start, { kind: "file", path: "index.js" });
  });
  await withWorkingDir(async (workingDir) => {
    // The historical default: a server.js and nothing else.
    await writeFile(workingDir, "server.js");
    const { output } = await detect(workingDir, { framework: "node" });
    assertEquals(output.start, { kind: "file", path: "server.js" });
  });
});

test("a build with nothing to start fails with the fix spelled out", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeJson(join(workingDir, "package.json"), { main: "gone.js" });
    await assertRejects(
      () => detect(workingDir, { framework: "node" }),
      Error,
      "no start command: the release has no package.json start script",
    );
  });
});

test("start detection is off when the author chose how the app starts", async () => {
  await withWorkingDir(async (workingDir) => {
    const { output } = await detect(workingDir, {
      framework: "node",
      detectStart: false,
    });
    assertEquals(output.start, undefined);
  });
});

test("a declared output directory is where the start is looked for", async () => {
  await withWorkingDir(async (workingDir) => {
    await writeJson(join(workingDir, "package.json"), {
      scripts: { start: "node server.js" },
    });
    await writeFile(workingDir, "dist/index.js");
    const { output } = await detect(workingDir, {
      framework: "next",
      outputDirectory: "dist",
    });
    // Never folded or re-pointed: the author's directory is the release.
    assertEquals(output.outputDirectory, undefined);
    assertEquals(output.standaloneOutput, false);
    assertEquals(output.start, { kind: "file", path: "index.js" });
  });
  await withWorkingDir(async (workingDir) => {
    // A declared directory that is a link the build planted is refused.
    const outside = await Deno.makeTempDir({ prefix: "tp-outside-" });
    try {
      await writeFile(outside, "index.js");
      await Deno.symlink(outside, join(workingDir, "dist"));
      await assertRejects(
        () =>
          detect(workingDir, { framework: "node", outputDirectory: "dist" }),
        Error,
        "it is a symlink",
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});
