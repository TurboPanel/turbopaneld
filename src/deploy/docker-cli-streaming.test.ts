import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createStreamedRunner,
  type DockerCliResult,
  type DockerStreamEvent,
  emitBufferedDockerLines,
  runDockerStreamed,
  setDockerCliIoForTest,
} from "./docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "./compose-files.ts";
import { handleEnvironmentStop } from "../instance/commands/stop-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Host-free stand-in for docker: `/bin/sh -c` writing to both streams. */
function shellChild(script: string): Deno.ChildProcess {
  return new Deno.Command("/bin/sh", {
    args: ["-c", script],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

test("runDockerStreamed tees lines while buffering the same result", async () => {
  const seen: DockerStreamEvent[] = [];
  const restore = setDockerCliIoForTest({
    runRaw: () =>
      Promise.resolve({ success: true, code: 0, stdout: "24.0.0", stderr: "" }),
    spawnStreaming: () =>
      Promise.resolve(
        shellChild("printf 'one\\ntwo\\n'; printf 'warn\\n' >&2"),
      ),
  });
  try {
    const result = await runDockerStreamed(["compose", "up", "-d"], {
      onLine: (event) => seen.push(event),
    });
    assertEquals(result.success, true);
    assertEquals(result.stdout, "one\ntwo");
    assertEquals(result.stderr, "warn");
    assertEquals(
      seen.filter((e) => e.stream === "stdout").map((e) => e.line),
      ["one", "two"],
    );
    assertEquals(
      seen.filter((e) => e.stream === "stderr").map((e) => e.line),
      ["warn"],
    );
  } finally {
    restore();
  }
});

test("runDockerStreamed emits a trailing line without a newline", async () => {
  const seen: string[] = [];
  const restore = setDockerCliIoForTest({
    runRaw: () =>
      Promise.resolve({ success: true, code: 0, stdout: "24.0.0", stderr: "" }),
    spawnStreaming: () => Promise.resolve(shellChild("printf 'no-newline'")),
  });
  try {
    const result = await runDockerStreamed(["ps"], {
      onLine: (event) => seen.push(event.line),
    });
    assertEquals(result.stdout, "no-newline");
    assertEquals(seen, ["no-newline"]);
  } finally {
    restore();
  }
});

test("runDockerStreamed reports a failing exit code", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: () =>
      Promise.resolve({ success: true, code: 0, stdout: "24.0.0", stderr: "" }),
    spawnStreaming: () =>
      Promise.resolve(shellChild("printf 'boom\\n' >&2; exit 3")),
  });
  try {
    const result = await runDockerStreamed(["compose", "up"]);
    assertEquals(result.success, false);
    assertEquals(result.code, 3);
    assertEquals(result.stderr, "boom");
  } finally {
    restore();
  }
});

test("createStreamedRunner replays a buffered test seam through onLine", async () => {
  const seen: DockerStreamEvent[] = [];
  const runStreamed = createStreamedRunner(() =>
    Promise.resolve({
      success: true,
      code: 0,
      stdout: "built a\nbuilt b",
      stderr: "hint",
    })
  );
  const result = await runStreamed(["compose", "build"], {
    onLine: (event) => seen.push(event),
  });
  assertEquals(result.stdout, "built a\nbuilt b");
  assertEquals(seen.map((e) => `${e.stream}:${e.line}`), [
    "stdout:built a",
    "stdout:built b",
    "stderr:hint",
  ]);
});

test("createStreamedRunner without an override returns runDockerStreamed", () => {
  assertEquals(createStreamedRunner(), runDockerStreamed);
});

test("emitBufferedDockerLines is a no-op without onLine", () => {
  emitBufferedDockerLines("ignored\n", "stdout");
});

test("createStreamedRunner forwards stdin on the buffered seam", async () => {
  let seenInput: string | undefined;
  const runStreamed = createStreamedRunner((_args, options) => {
    seenInput = options?.input;
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: "ok",
      stderr: "",
    });
  });
  const result = await runStreamed(["compose", "config"], { input: "yaml" });
  assertEquals(seenInput, "yaml");
  assertEquals(result.stdout, "ok");
});

test("runDockerStreamed writes stdin to the child", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: () =>
      Promise.resolve({ success: true, code: 0, stdout: "24.0.0", stderr: "" }),
    spawnStreaming: () =>
      Promise.resolve(
        new Deno.Command("/bin/sh", {
          args: ["-c", "cat"],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn(),
      ),
  });
  try {
    const result = await runDockerStreamed(["compose", "config"], {
      input: "hello-stdin",
    });
    assertEquals(result.success, true);
    assertEquals(result.stdout, "hello-stdin");
  } finally {
    restore();
  }
});

test("runDockerStreamed reports a spawn failure", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: () =>
      Promise.resolve({ success: true, code: 0, stdout: "24.0.0", stderr: "" }),
    spawnStreaming: () => Promise.reject(new Error("no docker")),
  });
  try {
    const result = await runDockerStreamed(["ps"]);
    assertEquals(result.success, false);
    assertEquals(result.code, 127);
    assertEquals(result.stderr.includes("no docker"), true);
  } finally {
    restore();
  }
});

test("runDockerStreamed stringifies a non-Error spawn failure", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: () =>
      Promise.resolve({ success: true, code: 0, stdout: "24.0.0", stderr: "" }),
    spawnStreaming: () => Promise.reject("boom-string"),
  });
  try {
    const result = await runDockerStreamed(["ps"]);
    assertEquals(result.success, false);
    assertEquals(result.stderr.includes("boom-string"), true);
  } finally {
    restore();
  }
});

/** Docker binary stand-in for probe tests (never spawned — `runRaw` is stubbed). */
const FAKE_DOCKER_BIN = "/bin/true";
const SUDO_BIN = "/usr/bin/sudo";

function socketDenied(): DockerCliResult {
  return {
    success: false,
    code: 1,
    stdout: "",
    stderr:
      "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
  };
}

/**
 * `runRaw` stub where only `sudo -n -- docker` reaches the socket: direct and
 * `sudo -n -u <self> --` both come back permission-denied (root-only socket).
 */
function rootOnlySocketRunRaw(probes: string[][]) {
  return (command: string, args: string[]): Promise<DockerCliResult> => {
    if (command === "/usr/bin/id") {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "tp",
        stderr: "",
      });
    }
    probes.push([command, ...args]);
    if (command === SUDO_BIN && args[1] === "--") {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "24.0.0",
        stderr: "",
      });
    }
    return Promise.resolve(socketDenied());
  };
}

test("runDockerStreamed falls back to sudo -n -- docker on a root-only socket", async () => {
  const probes: string[][] = [];
  const spawned: string[][] = [];
  const restore = setDockerCliIoForTest({
    dockerBin: FAKE_DOCKER_BIN,
    runRaw: rootOnlySocketRunRaw(probes),
    spawnStreaming: (bin, args) => {
      spawned.push([bin, ...args]);
      return Promise.resolve(shellChild("printf 'downed\\n'"));
    },
  });
  try {
    const result = await runDockerStreamed(["compose", "down"]);
    assertEquals(result.success, true);
    assertEquals(result.stdout, "downed");
    // direct → sudo -n -u <self> → sudo -n --
    assertEquals(probes.length, 3);
    assertEquals(probes[0]?.[0], FAKE_DOCKER_BIN);
    assertEquals(probes[1]?.slice(0, 3), [SUDO_BIN, "-n", "-u"]);
    assertEquals(probes[2]?.slice(0, 3), [SUDO_BIN, "-n", "--"]);
    assertEquals(spawned, [[
      SUDO_BIN,
      "-n",
      "--",
      FAKE_DOCKER_BIN,
      "compose",
      "down",
    ]]);
  } finally {
    restore();
  }
});

test({
  name:
    "handleEnvironmentStop streams compose down through the root sudo fallback",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-root-sudo-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envrootsu";
    const deploymentDir = join(
      stateDir,
      "deployments",
      "proj-1",
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      "services:\n  web: {}\n",
    );

    const spawned: string[][] = [];
    const restore = setDockerCliIoForTest({
      dockerBin: FAKE_DOCKER_BIN,
      runRaw: rootOnlySocketRunRaw([]),
      spawnStreaming: (bin, args) => {
        spawned.push([bin, ...args]);
        return Promise.resolve(shellChild("printf 'Container web Removed\\n'"));
      },
    });
    try {
      // No `runDocker` dep: the handler's createStreamedRunner() resolves the
      // real invocation ladder, which must reach the root-only socket.
      const result = await handleEnvironmentStop(
        {
          environmentId,
          projectId: "proj-1",
          projectName: "tp-demo-envrootsu",
        },
        new Date().toISOString(),
      );
      assertEquals(result.summary.includes("Stopped"), true);
      const downCall = spawned.find((argv) => argv.includes("down"));
      assertEquals(downCall?.slice(0, 4), [
        SUDO_BIN,
        "-n",
        "--",
        FAKE_DOCKER_BIN,
      ]);
    } finally {
      restore();
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});
