import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  BUILD_TIMEOUT_MS,
  buildEnvironment,
  buildInvocation,
  deriveNodeInstallCommand,
  NEXT_EXPORT_DIR,
  NEXT_STANDALONE_DIR,
  normalizeNodeBuildCommand,
  prepareNativeAppBuildOutput,
  runReleaseBuild,
} from "./build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

async function withWorkingDir(
  fn: (workingDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-native-build-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The tree `next build` leaves behind for `output: 'export'`. */
async function seedStaticExport(workingDir: string): Promise<void> {
  const out = join(workingDir, NEXT_EXPORT_DIR);
  await Deno.mkdir(join(out, "_next"), { recursive: true });
  await Deno.writeTextFile(join(out, "index.html"), "<!doctype html>");
}

/** The tree `next build` leaves behind for `output: 'standalone'`. */
async function seedStandalone(workingDir: string): Promise<void> {
  await Deno.mkdir(join(workingDir, NEXT_STANDALONE_DIR), { recursive: true });
  await Deno.writeTextFile(
    join(workingDir, NEXT_STANDALONE_DIR, "server.js"),
    "// server",
  );
  await Deno.mkdir(join(workingDir, ".next", "static"), { recursive: true });
  await Deno.writeTextFile(
    join(workingDir, ".next", "static", "app.js"),
    "// static",
  );
}

test("a statically exported Next build publishes out/ and reports staticExport", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStaticExport(workingDir);
    const lines: string[] = [];
    const output = await prepareNativeAppBuildOutput({
      framework: "next",
      workingDir,
      onOutput: (_stream, line) => lines.push(line),
    });

    assertEquals(output.staticExport, true);
    assertEquals(output.standaloneOutput, false);
    // `out/` becomes the release root, so a vhost can serve `current` directly.
    assertEquals(output.outputDirectory, NEXT_EXPORT_DIR);
    assertEquals(
      lines.some((line) => line.includes("statically exported")),
      true,
    );
    // No "re-declare the service yourself" instruction survives.
    assertEquals(
      lines.some((line) => line.includes("declare the service as")),
      false,
    );
  });
});

test("framework auto also detects a static export", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStaticExport(workingDir);
    const output = await prepareNativeAppBuildOutput({
      framework: "auto",
      workingDir,
    });
    assertEquals(output.staticExport, true);
    assertEquals(output.outputDirectory, NEXT_EXPORT_DIR);
  });
});

test("a standalone build is a server build, never a static export", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStandalone(workingDir);
    // Even with an `out/` tree alongside it, a standalone server wins.
    await seedStaticExport(workingDir);
    const output = await prepareNativeAppBuildOutput({
      framework: "next",
      workingDir,
    });
    assertEquals(output.standaloneOutput, true);
    assertEquals(output.staticExport, false);
    assertEquals(output.outputDirectory, NEXT_STANDALONE_DIR);
    // `.next/static` is folded into the standalone tree, as Next documents.
    await Deno.stat(
      join(workingDir, NEXT_STANDALONE_DIR, ".next", "static", "app.js"),
    );
  });
});

test("a bare out/ directory with no index.html is not treated as an export", async () => {
  await withWorkingDir(async (workingDir) => {
    // A plain Node service whose build happens to emit `out/`.
    await Deno.mkdir(join(workingDir, "out"), { recursive: true });
    await Deno.writeTextFile(join(workingDir, "out", "main.js"), "// bundle");
    const output = await prepareNativeAppBuildOutput({
      framework: "auto",
      workingDir,
    });
    assertEquals(output.staticExport, false);
    assertEquals(output.outputDirectory, undefined);
  });
});

test("framework node never inspects the build tree", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStaticExport(workingDir);
    const output = await prepareNativeAppBuildOutput({
      framework: "node",
      workingDir,
    });
    assertEquals(output.staticExport, false);
    assertEquals(output.standaloneOutput, false);
    assertEquals(output.outputDirectory, undefined);
  });
});

test("framework next without standalone or export ships the tree with a warning", async () => {
  await withWorkingDir(async (workingDir) => {
    const lines: string[] = [];
    const output = await prepareNativeAppBuildOutput({
      framework: "next",
      workingDir,
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(output.standaloneOutput, false);
    assertEquals(output.staticExport, false);
    assertEquals(output.outputDirectory, undefined);
    assertEquals(
      lines.some((line) => line.includes("shipping the build tree as-is")),
      true,
    );
  });
});

test("the Next fold refuses links the build planted at either end", async () => {
  const cases: Array<(workingDir: string, outside: string) => Promise<void>> = [
    // A link at the fold's destination directory.
    async (workingDir, outside) => {
      await seedStandalone(workingDir);
      await Deno.symlink(
        outside,
        join(workingDir, NEXT_STANDALONE_DIR, ".next"),
      );
    },
    // A link as the fold's source.
    async (workingDir, outside) => {
      await seedStandalone(workingDir);
      await Deno.remove(join(workingDir, ".next", "static"), {
        recursive: true,
      });
      await Deno.symlink(outside, join(workingDir, ".next", "static"));
    },
    // The standalone tree or the export itself is a link.
    async (workingDir, outside) => {
      await Deno.mkdir(join(workingDir, ".next"));
      await Deno.symlink(outside, join(workingDir, NEXT_STANDALONE_DIR));
    },
    async (workingDir, outside) => {
      await Deno.symlink(outside, join(workingDir, NEXT_EXPORT_DIR));
    },
  ];
  for (const plant of cases) {
    await withWorkingDir(async (root) => {
      const workingDir = join(root, "build");
      const outside = join(root, "daemon-state");
      await Deno.mkdir(workingDir);
      await Deno.mkdir(outside);
      await Deno.writeTextFile(join(outside, "index.html"), "secret");
      await plant(workingDir, outside);
      await assertRejects(
        () => prepareNativeAppBuildOutput({ framework: "next", workingDir }),
        Error,
        "symlink",
      );
      assertEquals(
        [...Deno.readDirSync(outside)].map((entry) => entry.name),
        ["index.html"],
      );
    });
  }
});

test("standalone fold also copies public/ when present", async () => {
  await withWorkingDir(async (workingDir) => {
    await seedStandalone(workingDir);
    await Deno.mkdir(join(workingDir, "public"), { recursive: true });
    await Deno.writeTextFile(join(workingDir, "public", "favicon.ico"), "ico");
    const output = await prepareNativeAppBuildOutput({
      framework: "next",
      workingDir,
    });
    assertEquals(output.standaloneOutput, true);
    await Deno.stat(
      join(workingDir, NEXT_STANDALONE_DIR, "public", "favicon.ico"),
    );
  });
});

test("buildEnvironment drops reserved sandbox keys from payload env", () => {
  const env = buildEnvironment(
    {
      kind: "native",
      env: {
        GIT_ASKPASS: "/evil",
        GIT_SSH_COMMAND: "ssh -i /evil",
        LD_PRELOAD: "/evil.so",
        LD_LIBRARY_PATH: "/evil",
        LD_AUDIT: "/evil.so",
        BASH_ENV: "/evil.sh",
        ENV: "/evil.sh",
        GIT_EXEC_PATH: "/evil",
        "-S": "x",
        "BAD NAME": "x",
        PATH: "/evil/bin",
        HOME: "/evil/home",
        APP_SECRET_NAME: "ok-name",
        NODE_OPTIONS: "--max-old-space-size=512",
      },
    },
    "/work",
  );
  assertEquals(env.GIT_ASKPASS, undefined);
  assertEquals(env.GIT_SSH_COMMAND, undefined);
  assertEquals(env.LD_PRELOAD, undefined);
  assertEquals(env.LD_LIBRARY_PATH, undefined);
  assertEquals(env.LD_AUDIT, undefined);
  assertEquals(env.BASH_ENV, undefined);
  assertEquals(env.ENV, undefined);
  assertEquals(env.GIT_EXEC_PATH, undefined);
  assertEquals(env["-S"], undefined);
  assertEquals(env["BAD NAME"], undefined);
  assertEquals(env.PATH?.includes("/evil"), false);
  assertEquals(env.HOME, "/work");
  assertEquals(env.CI, "1");
  assertEquals(env.NODE_ENV, "production");
  assertEquals(env.APP_SECRET_NAME, "ok-name");
  assertEquals(env.NODE_OPTIONS, "--max-old-space-size=512");
});

test("buildInvocation is a bare sh -c without a runtime group", () => {
  assertEquals(buildInvocation("npm run build"), {
    bin: "sh",
    args: ["-c", "npm run build"],
  });
});

test("buildInvocation enters the tenant Node entitlement group via sudo -u self", () => {
  const identity = {
    username: "tp",
    env: {
      PATH: "/opt/turbopanel/vendor/node-app/24/current/bin:/usr/bin:/bin",
      HOME: "/tmp/release-build",
    },
  };
  const invoked = buildInvocation(
    "corepack pnpm install",
    "tpnode24",
    identity,
  );
  assertEquals(invoked.bin, "/usr/bin/sudo");
  assertEquals(invoked.args.slice(0, 4), ["-n", "-u", "tp", "--"]);
  assertEquals(invoked.args.includes("/usr/bin/sg"), false);
  assertEquals(invoked.args.includes("/usr/bin/env"), true);
  // `env` gets `--` so no variable name can be read as one of its options.
  assertEquals(invoked.args[invoked.args.indexOf("/usr/bin/env") + 1], "--");
  assertEquals(
    invoked.args.includes(
      "PATH=/opt/turbopanel/vendor/node-app/24/current/bin:/usr/bin:/bin",
    ),
    true,
  );
  assertEquals(invoked.args.slice(-3), ["sh", "-c", "corepack pnpm install"]);
});

test("buildInvocation refuses a native group wrap without the daemon username", () => {
  assertThrows(
    () => buildInvocation("corepack pnpm install", "tpnode24"),
    TypeError,
    "daemon username",
  );
});

test("runReleaseBuild skips empty commands and runs the rest in order", async () => {
  await withWorkingDir(async (workingDir) => {
    const lines: string[] = [];
    const ran: string[] = [];
    await runReleaseBuild({
      build: { kind: "native" },
      workingDir,
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran, []);
    assertEquals(lines, [
      "no install or build command — shipping the checkout as-is",
    ]);

    await runReleaseBuild({
      build: {
        kind: "native",
        installCommand: "npm ci",
        buildCommand: "npm run build",
      },
      workingDir,
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran, ["npm ci", "npm run build"]);
  });
});

test("buildEnvironment uses an empty payload env map", () => {
  const env = buildEnvironment({ kind: "native" }, "/work");
  assertEquals(env.HOME, "/work");
  assertEquals(env.CI, "1");
  assertEquals(env.NODE_ENV, "production");
  // Without a native runtime nothing corepack-shaped is set.
  assertEquals(env.COREPACK_HOME, undefined);
  assertEquals(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, undefined);
});

test("buildEnvironment threads the native runtime onto PATH, NODE_ENV, and corepack", () => {
  const nodeBinDir = "/opt/turbopanel/vendor/node-app/24/current/bin";
  const env = buildEnvironment({ kind: "native" }, "/work", {
    nodeBinDir,
    nodeEnv: "development",
  });
  // Tenant Node leads PATH; the daemon PATH is not inherited (Deno's
  // node_compat_bin and unreadable /usr/local/sbin both break installs).
  assertEquals(env.PATH, `${nodeBinDir}:/usr/bin:/bin`);
  assertEquals(env.NODE_ENV, "development");
  assertEquals(env.COREPACK_HOME, join("/work", ".corepack"));
  assertEquals(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0");
});

test("deriveNodeInstallCommand returns undefined without a package.json", async () => {
  await withWorkingDir(async (workingDir) => {
    assertEquals(await deriveNodeInstallCommand({ workingDir }), undefined);
    // A lockfile without a package.json still derives nothing to install.
    await Deno.writeTextFile(join(workingDir, "package-lock.json"), "{}");
    assertEquals(await deriveNodeInstallCommand({ workingDir }), undefined);
  });
});

test("deriveNodeInstallCommand detects the manager from the lockfile", async () => {
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(join(workingDir, "package.json"), "{}");
    // Bare npm: no lockfile at all.
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "npm install --include=dev",
    );
    await Deno.writeTextFile(join(workingDir, "package-lock.json"), "{}");
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "npm ci --include=dev",
    );
    // yarn.lock outranks package-lock.json; classic yarn keeps its dev flag.
    await Deno.writeTextFile(join(workingDir, "yarn.lock"), "");
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "corepack yarn install --frozen-lockfile --production=false",
    );
    // pnpm-lock.yaml outranks both.
    await Deno.writeTextFile(join(workingDir, "pnpm-lock.yaml"), "");
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "corepack pnpm install --frozen-lockfile --prod=false",
    );
  });
});

test("deriveNodeInstallCommand lets an explicit packageManager override the lockfile", async () => {
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(join(workingDir, "package.json"), "{}");
    await Deno.writeTextFile(join(workingDir, "pnpm-lock.yaml"), "");
    assertEquals(
      await deriveNodeInstallCommand({ packageManager: "npm", workingDir }),
      "npm install --include=dev",
    );
    // The declared manager without its lockfile drops the frozen flag.
    assertEquals(
      await deriveNodeInstallCommand({ packageManager: "yarn", workingDir }),
      "corepack yarn install --production=false",
    );
    await Deno.remove(join(workingDir, "pnpm-lock.yaml"));
    assertEquals(
      await deriveNodeInstallCommand({ packageManager: "pnpm", workingDir }),
      "corepack pnpm install --prod=false",
    );
  });
});

test("deriveNodeInstallCommand treats Yarn Berry as immutable-by-CI", async () => {
  // Berry via the package.json packageManager pin.
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(
      join(workingDir, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.5.0" }),
    );
    await Deno.writeTextFile(join(workingDir, "yarn.lock"), "");
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "corepack yarn install",
    );
  });
  // Berry via a .yarnrc.yml when package.json pins nothing.
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(join(workingDir, "package.json"), "{}");
    await Deno.writeTextFile(join(workingDir, "yarn.lock"), "");
    await Deno.writeTextFile(
      join(workingDir, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "corepack yarn install",
    );
  });
  // A yarn@1 pin stays classic.
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(
      join(workingDir, "package.json"),
      JSON.stringify({ packageManager: "yarn@1.22.22" }),
    );
    await Deno.writeTextFile(join(workingDir, "yarn.lock"), "");
    assertEquals(
      await deriveNodeInstallCommand({ workingDir }),
      "corepack yarn install --frozen-lockfile --production=false",
    );
  });
});

test("normalizeNodeBuildCommand prefixes bare pnpm and yarn with corepack", () => {
  assertEquals(
    normalizeNodeBuildCommand("pnpm run build"),
    "corepack pnpm run build",
  );
  assertEquals(normalizeNodeBuildCommand("pnpm build"), "corepack pnpm build");
  assertEquals(
    normalizeNodeBuildCommand("yarn run build"),
    "corepack yarn run build",
  );
  assertEquals(
    normalizeNodeBuildCommand("corepack pnpm run build"),
    "corepack pnpm run build",
  );
  assertEquals(normalizeNodeBuildCommand("npm run build"), "npm run build");
});

test("runReleaseBuild derives the install command for a native-app build", async () => {
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(join(workingDir, "package.json"), "{}");
    await Deno.writeTextFile(join(workingDir, "pnpm-lock.yaml"), "");
    const lines: string[] = [];
    const ran: string[] = [];
    await runReleaseBuild({
      build: { kind: "native", buildCommand: "npm run build" },
      workingDir,
      nativeRuntime: {
        nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
        nodeEnv: "production",
      },
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    // The derived install runs before the build command.
    assertEquals(ran, [
      "corepack pnpm install --frozen-lockfile --prod=false",
      "npm run build",
    ]);
    assertEquals(
      lines.some((line) => line.includes("derived install command")),
      true,
    );
  });
});

test("runReleaseBuild normalizes bare pnpm build commands for native-app builds", async () => {
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(join(workingDir, "package.json"), "{}");
    await Deno.writeTextFile(join(workingDir, "pnpm-lock.yaml"), "");
    const lines: string[] = [];
    const ran: string[] = [];
    await runReleaseBuild({
      build: { kind: "native", buildCommand: "pnpm run build" },
      workingDir,
      nativeRuntime: {
        nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
        nodeEnv: "production",
      },
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran, [
      "corepack pnpm install --frozen-lockfile --prod=false",
      "corepack pnpm run build",
    ]);
    assertEquals(
      lines.some((line) =>
        line.includes("normalized build command for Corepack")
      ),
      true,
    );
  });
});

test("runReleaseBuild prefers an explicit installCommand over the derived one", async () => {
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(join(workingDir, "package.json"), "{}");
    await Deno.writeTextFile(join(workingDir, "pnpm-lock.yaml"), "");
    const lines: string[] = [];
    const ran: string[] = [];
    await runReleaseBuild({
      build: { kind: "native", installCommand: "npm ci --ignore-scripts" },
      workingDir,
      nativeRuntime: {
        nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
        nodeEnv: "production",
      },
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran, ["npm ci --ignore-scripts"]);
    assertEquals(
      lines.some((line) => line.includes("derived install command")),
      false,
    );
  });
});

test("runReleaseBuild does not derive an install without a native runtime", async () => {
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(join(workingDir, "package.json"), "{}");
    await Deno.writeTextFile(join(workingDir, "pnpm-lock.yaml"), "");
    const lines: string[] = [];
    const ran: string[] = [];
    await runReleaseBuild({
      build: { kind: "native", buildCommand: "npm run build" },
      workingDir,
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran, ["npm run build"]);
    assertEquals(
      lines.some((line) => line.includes("derived install command")),
      false,
    );
  });
});

test({
  name: "runReleaseBuild default runner succeeds and fails through sh -c",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withWorkingDir(async (workingDir) => {
      const lines: string[] = [];
      await runReleaseBuild({
        build: { kind: "native", buildCommand: "printf 'built-ok\\n'" },
        workingDir,
        onOutput: (_stream, line) => lines.push(line),
      });
      assertEquals(lines.some((line) => line.includes("built-ok")), true);

      await assertRejects(
        () =>
          runReleaseBuild({
            build: {
              kind: "native",
              buildCommand: "printf 'boom\\n' >&2; exit 7",
            },
            workingDir,
          }),
        Error,
        "boom",
      );
    });
  },
});

test({
  name:
    "runReleaseBuild default runner uses a generic error when output is empty",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withWorkingDir(async (workingDir) => {
      await assertRejects(
        () =>
          runReleaseBuild({
            build: { kind: "native", buildCommand: "exit 3" },
            workingDir,
          }),
        Error,
        "build command failed: exit 3",
      );
    });
  },
});

function abortError(): DOMException {
  return new DOMException("The signal has been aborted", "AbortError");
}

function stubDenoCommand(
  spawn: (cmd: string) => Deno.ChildProcess,
): () => void {
  const original = Deno.Command;
  Deno.Command = class {
    #cmd: string;
    constructor(cmd: string) {
      this.#cmd = cmd;
    }
    spawn() {
      return spawn(this.#cmd);
    }
  } as unknown as typeof Deno.Command;
  return () => {
    Deno.Command = original;
  };
}

test({
  name: "runReleaseBuild default runner reports a build timeout",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const restore = stubDenoCommand(() => {
      throw abortError();
    });
    try {
      await withWorkingDir(async (workingDir) => {
        await assertRejects(
          () =>
            runReleaseBuild({
              build: { kind: "native", buildCommand: "true" },
              workingDir,
            }),
          Error,
          `build command timed out after ${BUILD_TIMEOUT_MS}ms`,
        );
      });
    } finally {
      restore();
    }
  },
});

test({
  name: "runReleaseBuild default runner reports AbortError from child status",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const restore = stubDenoCommand(() => ({
      status: Promise.reject(abortError()),
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    } as Deno.ChildProcess));
    try {
      await withWorkingDir(async (workingDir) => {
        await assertRejects(
          () =>
            runReleaseBuild({
              build: { kind: "native", buildCommand: "true" },
              workingDir,
            }),
          Error,
          `build command timed out after ${BUILD_TIMEOUT_MS}ms`,
        );
      });
    } finally {
      restore();
    }
  },
});

test({
  name: "runReleaseBuild default runner rethrows a spawn failure",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const restore = stubDenoCommand(() => {
      throw new Error("sh missing");
    });
    try {
      await withWorkingDir(async (workingDir) => {
        await assertRejects(
          () =>
            runReleaseBuild({
              build: { kind: "native", buildCommand: "true" },
              workingDir,
            }),
          Error,
          "sh missing",
        );
      });
    } finally {
      restore();
    }
  },
});

test({
  name: "runReleaseBuild default runner succeeds with a cleared env",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withWorkingDir(async (workingDir) => {
      const lines: string[] = [];
      await runReleaseBuild({
        build: { kind: "native", buildCommand: "printf 'build-ok\\n'" },
        workingDir,
        onOutput: (_stream, line) => lines.push(line),
      });
      assertEquals(lines.some((line) => line.includes("build-ok")), true);
    });
  },
});

test("buildEnvironment falls back when PATH is unset", () => {
  const previous = Deno.env.get("PATH");
  try {
    Deno.env.delete("PATH");
    const env = buildEnvironment({ kind: "native" }, "/work");
    assertEquals(env.PATH, "/usr/local/bin:/usr/bin:/bin");
  } finally {
    if (previous === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", previous);
  }
});
