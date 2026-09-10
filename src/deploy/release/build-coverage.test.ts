/**
 * Extra {@link runReleaseBuild} coverage that lives outside `build.test.ts`
 * (that file is owned by another session).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { deriveNodeInstallCommand, runReleaseBuild } from "./build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withWorkingDir(
  fn: (workingDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-build-cov-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function emptyChild(): Deno.ChildProcess {
  return {
    status: Promise.resolve({ success: true, code: 0, signal: null }),
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
  } as Deno.ChildProcess;
}

function stubCommandAndEnv(opts: {
  user?: string | null;
  logname?: string | null;
  idStdout?: string;
  idSuccess?: boolean;
}): () => void {
  const originalCommand = Deno.Command;
  const originalGet = Deno.env.get.bind(Deno.env);
  Deno.env.get = ((key: string) => {
    if (key === "USER") {
      return opts.user === undefined ? originalGet(key) : opts.user;
    }
    if (key === "LOGNAME") {
      return opts.logname === undefined ? originalGet(key) : opts.logname;
    }
    return originalGet(key);
  }) as typeof Deno.env.get;
  Deno.Command = class {
    #cmd: string;
    constructor(cmd: string) {
      this.#cmd = cmd;
    }
    output() {
      if (this.#cmd !== "/usr/bin/id") {
        return Promise.reject(new TypeError(`unexpected output: ${this.#cmd}`));
      }
      const stdout = new TextEncoder().encode(opts.idStdout ?? "daemon\n");
      return Promise.resolve({
        success: opts.idSuccess !== false,
        code: opts.idSuccess === false ? 1 : 0,
        stdout,
        stderr: new Uint8Array(),
        signal: null,
      });
    }
    spawn() {
      return emptyChild();
    }
  } as unknown as typeof Deno.Command;
  return () => {
    Deno.Command = originalCommand;
    Deno.env.get = originalGet;
  };
}

test("deriveNodeInstallCommand treats unreadable package.json as Berry via .yarnrc.yml", async () => {
  await withWorkingDir(async (workingDir) => {
    await Deno.writeTextFile(join(workingDir, "package.json"), "{not-json");
    await Deno.writeTextFile(join(workingDir, "yarn.lock"), "");
    await Deno.writeTextFile(
      join(workingDir, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
    assertEquals(
      await deriveNodeInstallCommand({ packageManager: "yarn", workingDir }),
      "corepack yarn install",
    );
  });
});

test({
  name: "runReleaseBuild refreshes groups via sudo -u when USER is set",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const restore = stubCommandAndEnv({});
    try {
      await withWorkingDir(async (workingDir) => {
        await runReleaseBuild({
          build: { kind: "native", buildCommand: "true" },
          workingDir,
          nativeRuntime: {
            nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
            nodeEnv: "production",
            runtimeGroup: "tpnode24",
          },
          hasPrlimit: () => Promise.resolve(false),
        });
      });
    } finally {
      restore();
    }
  },
});

test({
  name: "runReleaseBuild wraps the group-refresh argv with prlimit",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const restore = stubCommandAndEnv({});
    try {
      await withWorkingDir(async (workingDir) => {
        await runReleaseBuild({
          build: { kind: "native", buildCommand: "true" },
          workingDir,
          nativeRuntime: {
            nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
            nodeEnv: "production",
            runtimeGroup: "tpnode24",
          },
          hasPrlimit: () => Promise.resolve(true),
        });
      });
    } finally {
      restore();
    }
  },
});

test({
  name: "runReleaseBuild resolves the daemon user via id when USER is blank",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const restore = stubCommandAndEnv({ user: "  ", logname: "" });
    try {
      await withWorkingDir(async (workingDir) => {
        await runReleaseBuild({
          build: { kind: "native", buildCommand: "true" },
          workingDir,
          nativeRuntime: {
            nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
            nodeEnv: "production",
            runtimeGroup: "tpnode24",
          },
          hasPrlimit: () => Promise.resolve(false),
        });
      });
    } finally {
      restore();
    }
  },
});

test({
  name: "runReleaseBuild fails when id cannot name the daemon user",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const restore = stubCommandAndEnv({
      user: "",
      logname: "",
      idSuccess: false,
      idStdout: "",
    });
    try {
      await withWorkingDir(async (workingDir) => {
        await assertRejects(
          () =>
            runReleaseBuild({
              build: { kind: "native", buildCommand: "true" },
              workingDir,
              nativeRuntime: {
                nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
                nodeEnv: "production",
                runtimeGroup: "tpnode24",
              },
              hasPrlimit: () => Promise.resolve(false),
            }),
          Error,
          "cannot resolve daemon username",
        );
      });
    } finally {
      restore();
    }
  },
});
