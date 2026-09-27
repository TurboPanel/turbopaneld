import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  assertContainerStable,
  isCrashLooping,
  lastLogReason,
  parseContainerState,
} from "./container-stability.ts";

const test = Deno.test;
const instant = { sleep: () => Promise.resolve() };

function ok(stdout: string, stderr = ""): Promise<DockerCliResult> {
  return Promise.resolve({ success: true, stdout, stderr, code: 0 });
}

test("parseContainerState reads status, exit code and restart count", () => {
  assertEquals(parseContainerState('{"Status":"running","ExitCode":0} 0\n'), {
    status: "running",
    exitCode: 0,
    restartCount: 0,
  });
  assertEquals(parseContainerState('{"Status":"exited","ExitCode":2} 4'), {
    status: "exited",
    exitCode: 2,
    restartCount: 4,
  });
  assertEquals(parseContainerState(""), null);
  assertEquals(parseContainerState("not json 3"), null);
  assertEquals(parseContainerState('{"ExitCode":1} 1'), null);
});

test("isCrashLooping: restarting, or exited/dead with a non-zero code", () => {
  const s = (status: string, exitCode = 0) => ({
    status,
    exitCode,
    restartCount: 0,
  });
  assertEquals(isCrashLooping(s("restarting")), true);
  assertEquals(isCrashLooping(s("exited", 1)), true);
  assertEquals(isCrashLooping(s("dead", 137)), true);
  assertEquals(isCrashLooping(s("exited", 0)), false);
  assertEquals(isCrashLooping(s("running")), false);
  assertEquals(isCrashLooping(s("created")), false);
});

test("lastLogReason keeps the last non-empty line and caps its length", () => {
  assertEquals(lastLogReason("a\nb\n\n  \n"), "b");
  assertEquals(lastLogReason(""), "");
  assertEquals(lastLogReason("x".repeat(1000)).length, 400);
});

test("assertContainerStable passes when the container keeps running", async () => {
  const calls: string[][] = [];
  await assertContainerStable(
    (args) => {
      calls.push(args);
      return ok('{"Status":"running","ExitCode":0} 0');
    },
    "c1",
    "Test",
    { ...instant, attempts: 3 },
  );
  assertEquals(calls.filter((a) => a[0] === "inspect").length, 3);
  assertEquals(calls.some((a) => a[0] === "logs"), false);
});

test("assertContainerStable stays quiet when the state cannot be read", async () => {
  await assertContainerStable(
    () =>
      Promise.resolve({
        success: false,
        stdout: "",
        stderr: "no engine",
        code: 1,
      }),
    "c1",
    "Test",
    instant,
  );
  await assertContainerStable(() => ok(""), "c1", "Test", instant);
});

test("assertContainerStable reports a container that crashes after a clean first check", async () => {
  let n = 0;
  await assertRejects(
    () =>
      assertContainerStable(
        (args) => {
          if (args[0] === "logs") return ok("booting\nfatal: bad config\n");
          n += 1;
          return ok(
            n === 1
              ? '{"Status":"running","ExitCode":0} 0'
              : '{"Status":"exited","ExitCode":3} 1',
          );
        },
        "c1",
        "Test",
        { ...instant, attempts: 3 },
      ),
    Error,
    "Test container c1 is crash-looping (exited, exit 3, 1 restarts): fatal: bad config",
  );
});

test("assertContainerStable omits the reason when the logs are empty", async () => {
  await assertRejects(
    () =>
      assertContainerStable(
        (args) => (args[0] === "logs"
          ? ok("")
          : ok('{"Status":"restarting","ExitCode":1} 2')),
        "c1",
        "Test",
        instant,
      ),
    Error,
    "(restarting, exit 1, 2 restarts)",
  );
});
