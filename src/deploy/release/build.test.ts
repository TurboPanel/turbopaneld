import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  BUILD_TIMEOUT_MS,
  buildEnvironment,
  buildInvocation,
  NEXT_EXPORT_DIR,
  NEXT_STANDALONE_DIR,
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
  assertEquals(env.PATH?.includes("/evil"), false);
  assertEquals(env.HOME, "/work");
  assertEquals(env.CI, "1");
  assertEquals(env.NODE_ENV, "production");
  assertEquals(env.APP_SECRET_NAME, "ok-name");
  assertEquals(env.NODE_OPTIONS, "--max-old-space-size=512");
});

test("buildInvocation wraps with prlimit or falls back to bare sh -c", () => {
  assertEquals(buildInvocation("npm run build", false), {
    bin: "sh",
    args: ["-c", "npm run build"],
  });
  const wrapped = buildInvocation("npm run build", true);
  assertEquals(wrapped.bin, "/usr/bin/prlimit");
  assertEquals(wrapped.args.includes("--"), true);
  assertEquals(wrapped.args.includes("sh"), true);
  assertEquals(wrapped.args.at(-1), "npm run build");
});

test("runReleaseBuild notes when prlimit is unavailable and skips empty commands", async () => {
  await withWorkingDir(async (workingDir) => {
    const lines: string[] = [];
    const ran: string[] = [];
    await runReleaseBuild({
      build: { kind: "native" },
      workingDir,
      hasPrlimit: () => Promise.resolve(false),
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran, []);
    assertEquals(lines, []);

    await runReleaseBuild({
      build: {
        kind: "native",
        installCommand: "npm ci",
        buildCommand: "npm run build",
      },
      workingDir,
      hasPrlimit: () => Promise.resolve(false),
      runCommand: (command, _cwd, _env, withPrlimit) => {
        ran.push(`${withPrlimit ? "cap" : "bare"}:${command}`);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(
      lines.some((line) => line.includes("prlimit unavailable")),
      true,
    );
    assertEquals(ran, ["bare:npm ci", "bare:npm run build"]);
  });
});

test("runReleaseBuild uses prlimit when the host reports it available", async () => {
  await withWorkingDir(async (workingDir) => {
    const ran: Array<{ command: string; withPrlimit: boolean }> = [];
    await runReleaseBuild({
      build: { kind: "native", buildCommand: "make" },
      workingDir,
      hasPrlimit: () => Promise.resolve(true),
      runCommand: (command, _cwd, _env, withPrlimit) => {
        ran.push({ command, withPrlimit });
        return Promise.resolve();
      },
    });
    assertEquals(ran, [{ command: "make", withPrlimit: true }]);
  });
});

test("buildEnvironment uses an empty payload env map", () => {
  const env = buildEnvironment({ kind: "native" }, "/work");
  assertEquals(env.HOME, "/work");
  assertEquals(env.CI, "1");
  assertEquals(env.NODE_ENV, "production");
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
        hasPrlimit: () => Promise.resolve(false),
        onOutput: (_stream, line) => lines.push(line),
      });
      assertEquals(lines.some((line) => line.includes("built-ok")), true);

      await assertRejects(
        () =>
          runReleaseBuild({
            build: { kind: "native", buildCommand: "printf 'boom\\n' >&2; exit 7" },
            workingDir,
            hasPrlimit: () => Promise.resolve(false),
          }),
        Error,
        "boom",
      );
    });
  },
});

test({
  name: "runReleaseBuild default runner uses a generic error when output is empty",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withWorkingDir(async (workingDir) => {
      await assertRejects(
        () =>
          runReleaseBuild({
            build: { kind: "native", buildCommand: "exit 3" },
            workingDir,
            hasPrlimit: () => Promise.resolve(false),
          }),
        Error,
        "build command failed: exit 3",
      );
    });
  },
});

test({
  name: "runReleaseBuild probes prlimit availability on the host",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withWorkingDir(async (workingDir) => {
      await runReleaseBuild({
        build: { kind: "native", buildCommand: "true" },
        workingDir,
      });
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
              hasPrlimit: () => Promise.resolve(false),
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
              hasPrlimit: () => Promise.resolve(false),
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
              hasPrlimit: () => Promise.resolve(false),
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
  name: "runReleaseBuild default runner rethrows a prlimit spawn failure",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const restore = stubDenoCommand((cmd) => {
      if (cmd === "/usr/bin/prlimit") {
        throw new Error("prlimit denied");
      }
      throw new Error(`unexpected bin ${cmd}`);
    });
    try {
      await withWorkingDir(async (workingDir) => {
        await assertRejects(
          () =>
            runReleaseBuild({
              build: { kind: "native", buildCommand: "true" },
              workingDir,
              hasPrlimit: () => Promise.resolve(true),
            }),
          Error,
          "prlimit denied",
        );
      });
    } finally {
      restore();
    }
  },
});

test({
  name: "runReleaseBuild default runner succeeds under prlimit with a cleared env",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withWorkingDir(async (workingDir) => {
      const lines: string[] = [];
      await runReleaseBuild({
        build: { kind: "native", buildCommand: "printf 'prlimit-ok\\n'" },
        workingDir,
        hasPrlimit: () => Promise.resolve(true),
        onOutput: (_stream, line) => lines.push(line),
      });
      assertEquals(lines.some((line) => line.includes("prlimit-ok")), true);
    });
  },
});

test({
  name: "runReleaseBuild treats a missing prlimit binary as unavailable",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const originalStat = Deno.stat;
    Deno.stat = (path) => {
      if (String(path) === "/usr/bin/prlimit") {
        return Promise.reject(new Deno.errors.NotFound("missing"));
      }
      return originalStat(path);
    };
    try {
      await withWorkingDir(async (workingDir) => {
        const lines: string[] = [];
        await runReleaseBuild({
          build: { kind: "native", buildCommand: "true" },
          workingDir,
          onOutput: (_stream, line) => lines.push(line),
        });
        assertEquals(
          lines.some((line) => line.includes("prlimit unavailable")),
          true,
        );
      });
    } finally {
      Deno.stat = originalStat;
    }
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
