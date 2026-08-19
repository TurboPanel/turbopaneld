import { assertEquals } from "@std/assert";
import {
  type DockerCliResult,
  dockerEngineReachable,
  resolveDockerInvocation,
  runDocker,
  setDockerCliIoForTest,
  spawnDockerStreaming,
} from "./docker-cli.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function ok(stdout = ""): DockerCliResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fail(stderr: string, code = 1): DockerCliResult {
  return { success: false, code, stdout: "", stderr };
}

test("runDocker succeeds on direct /usr/bin/docker without sudo", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command, args) => {
      calls.push({ command, args: [...args] });
      return Promise.resolve(ok("24.0.0"));
    },
  });
  try {
    const result = await runDocker([
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    assertEquals(result.success, true);
    assertEquals(result.stdout, "24.0.0");
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.command, "/usr/bin/docker");
    assertEquals(calls[0]?.args[0], "version");
  } finally {
    restore();
  }
});

test("runDocker retries via sudo -n -u self on docker.sock permission denied", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          fail(
            "permission denied while trying to connect to the Docker daemon socket",
          ),
        );
      }
      if (command === "/usr/bin/sudo") {
        return Promise.resolve(ok("24.0.0"));
      }
      return Promise.resolve(fail(`unexpected ${command}`));
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    const result = await runDocker(["ps"]);
    assertEquals(result.success, true);
    assertEquals(result.stdout, "24.0.0");
    assertEquals(calls[0]?.command, "/usr/bin/docker");
    assertEquals(calls[1]?.command, "/usr/bin/sudo");
    assertEquals(calls[1]?.args.slice(0, 5), [
      "-n",
      "-u",
      "tp",
      "--",
      "/usr/bin/docker",
    ]);
    assertEquals(calls[1]?.args.at(-1), "ps");
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("runDocker prefers original stderr when sudo refresh also fails", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          fail(
            "permission denied while trying to connect to the Docker daemon socket",
            1,
          ),
        );
      }
      return Promise.resolve(fail("sudo: a password is required", 1));
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    const result = await runDocker(["info"]);
    assertEquals(result.success, false);
    assertEquals(
      result.stderr.includes("permission denied"),
      true,
    );
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("runDocker does not sudo-retry for non-permission failures", async () => {
  const calls: string[] = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      calls.push(command);
      return Promise.resolve(fail("Cannot connect to the Docker daemon"));
    },
  });
  try {
    const result = await runDocker(["ps"]);
    assertEquals(result.success, false);
    assertEquals(calls, ["/usr/bin/docker"]);
  } finally {
    restore();
  }
});

test("dockerEngineReachable mirrors runDocker success", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: () => Promise.resolve(ok("27.1.0")),
  });
  try {
    assertEquals(await dockerEngineReachable(), true);
  } finally {
    restore();
  }

  const restoreFail = setDockerCliIoForTest({
    runRaw: () => Promise.resolve(fail("daemon offline")),
  });
  try {
    assertEquals(await dockerEngineReachable(), false);
  } finally {
    restoreFail();
  }
});

test("resolveDockerInvocation caches direct bin then sudo prefix after permission denied", async () => {
  let versionCalls = 0;
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        versionCalls += 1;
        return Promise.resolve(ok("24.0.0"));
      }
      return Promise.resolve(fail(`unexpected ${command}`));
    },
  });
  try {
    const first = await resolveDockerInvocation();
    const second = await resolveDockerInvocation();
    assertEquals(first, { bin: "/usr/bin/docker", prefixArgs: [] });
    assertEquals(second, first);
    assertEquals(versionCalls, 1);
  } finally {
    restore();
  }

  const restoreSudo = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          fail(
            "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
          ),
        );
      }
      return Promise.resolve(fail(`unexpected ${command}`));
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "daemon");
  try {
    const invocation = await resolveDockerInvocation();
    assertEquals(invocation.bin, "/usr/bin/sudo");
    assertEquals(invocation.prefixArgs, [
      "-n",
      "-u",
      "daemon",
      "--",
      "/usr/bin/docker",
    ]);
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restoreSudo();
  }
});

test("runDocker pipes options.input through runRaw", async () => {
  let seenInput: string | undefined;
  const restore = setDockerCliIoForTest({
    runRaw: (_command, _args, options) => {
      seenInput = options?.input;
      return Promise.resolve(ok());
    },
  });
  try {
    await runDocker(["exec", "-i", "db", "psql"], { input: "SELECT 1;\n" });
    assertEquals(seenInput, "SELECT 1;\n");
  } finally {
    restore();
  }
});

test("runRawDefault pipes stdin via dockerBin=/bin/cat without runRaw mock", async () => {
  const restore = setDockerCliIoForTest({ dockerBin: "/bin/cat" });
  try {
    const result = await runDocker([], { input: "hello-stdin\n" });
    assertEquals(result.success, true);
    assertEquals(result.stdout, "hello-stdin");
  } finally {
    restore();
  }
});

test("runRawDefault returns spawn failed for missing dockerBin", async () => {
  const restore = setDockerCliIoForTest({
    dockerBin: "/tmp/tp-no-such-docker-bin-for-test",
  });
  try {
    const result = await runDocker(["version"]);
    assertEquals(result.success, false);
    assertEquals(result.code, 127);
    assertEquals(result.stderr.includes("spawn failed"), true);
  } finally {
    restore();
  }
});

test("runDocker resolves username via id when USER and LOGNAME are unset", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          fail(
            "permission denied while trying to connect to the Docker daemon socket",
          ),
        );
      }
      if (command === "/usr/bin/id") {
        return Promise.resolve(ok("tpdaemon"));
      }
      if (command === "/usr/bin/sudo") {
        return Promise.resolve(ok("ok"));
      }
      return Promise.resolve(fail(`unexpected ${command}`));
    },
  });
  const previousUser = Deno.env.get("USER");
  const previousLogname = Deno.env.get("LOGNAME");
  Deno.env.delete("USER");
  Deno.env.delete("LOGNAME");
  try {
    const result = await runDocker(["ps"]);
    assertEquals(result.success, true);
    assertEquals(calls.some((c) => c.command === "/usr/bin/id"), true);
    assertEquals(
      calls.find((c) => c.command === "/usr/bin/sudo")?.args.slice(0, 5),
      ["-n", "-u", "tpdaemon", "--", "/usr/bin/docker"],
    );
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    if (previousLogname === undefined) Deno.env.delete("LOGNAME");
    else Deno.env.set("LOGNAME", previousLogname);
    restore();
  }
});

test("runDocker throws when username cannot be resolved for sudo refresh", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          fail(
            "permission denied while trying to connect to the Docker daemon socket",
          ),
        );
      }
      if (command === "/usr/bin/id") {
        return Promise.resolve(fail("id failed", 1));
      }
      return Promise.resolve(fail(`unexpected ${command}`));
    },
  });
  const previousUser = Deno.env.get("USER");
  const previousLogname = Deno.env.get("LOGNAME");
  Deno.env.delete("USER");
  Deno.env.delete("LOGNAME");
  try {
    let threw = false;
    try {
      await runDocker(["ps"]);
    } catch (err) {
      threw = true;
      assertEquals(err instanceof Error, true);
      assertEquals(
        (err as Error).message.includes("cannot resolve daemon username"),
        true,
      );
    }
    assertEquals(threw, true);
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    if (previousLogname === undefined) Deno.env.delete("LOGNAME");
    else Deno.env.set("LOGNAME", previousLogname);
    restore();
  }
});

test("spawnDockerStreaming uses inject spawnStreaming after resolve", async () => {
  const seen: Array<{ bin: string; args: string[] }> = [];
  const child = new Deno.Command("/bin/true", {
    args: [],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const restore = setDockerCliIoForTest({
    runRaw: () => Promise.resolve(ok("24.0.0")),
    spawnStreaming: (bin, args) => {
      seen.push({ bin, args: [...args] });
      return Promise.resolve(child);
    },
  });
  try {
    const process = await spawnDockerStreaming(["exec", "-i", "db", "pg_dump"]);
    assertEquals(process, child);
    assertEquals(seen.length, 1);
    assertEquals(seen[0]?.bin, "/usr/bin/docker");
    assertEquals(seen[0]?.args, ["exec", "-i", "db", "pg_dump"]);
    await process.status;
  } finally {
    restore();
  }
});

test("spawnDockerStreaming spawns dockerBin=/bin/true without spawnStreaming mock", async () => {
  const restore = setDockerCliIoForTest({ dockerBin: "/bin/true" });
  try {
    const process = await spawnDockerStreaming(["ignored"]);
    const status = await process.status;
    assertEquals(status.success, true);
  } finally {
    restore();
  }
});
