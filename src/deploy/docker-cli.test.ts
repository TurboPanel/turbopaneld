import { assertEquals } from "@std/assert";
import {
  type DockerCliResult,
  dockerConfigDir,
  dockerEngineProbe,
  dockerEngineReachable,
  resetDockerInvocation,
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

test("runDocker retries via sudo -n root when self-refresh still cannot open the socket", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          fail(
            "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
          ),
        );
      }
      if (command === "/usr/bin/sudo" && args[0] === "-n" && args[1] === "-u") {
        return Promise.resolve(
          fail(
            "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
          ),
        );
      }
      if (command === "/usr/bin/sudo" && args[0] === "-n" && args[1] === "--") {
        return Promise.resolve(ok("27.1.0"));
      }
      return Promise.resolve(fail(`unexpected ${command}`));
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    const result = await runDocker(["compose", "up", "-d"]);
    assertEquals(result.success, true);
    assertEquals(result.stdout, "27.1.0");
    assertEquals(calls[2]?.command, "/usr/bin/sudo");
    assertEquals(calls[2]?.args.slice(0, 3), ["-n", "--", "/usr/bin/docker"]);
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("runDocker retries sudo when socket permission is on stdout", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout:
            "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
          stderr: "",
        });
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
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("runDocker falls back to sudo stderr when the original socket error is empty", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout:
            "permission denied while trying to connect to the Docker daemon socket",
          stderr: "",
        });
      }
      return Promise.resolve(fail("sudo: a password is required", 1));
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    const result = await runDocker(["info"]);
    assertEquals(result.success, false);
    assertEquals(result.stderr, "sudo: a password is required");
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

const DENIED_RUN =
  'spawn failed: Requires run access to "/usr/bin/sudo", run again with the --allow-run flag';
const SOCKET_DENIED =
  "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock";

test("runDocker reports the real socket error when this process may not run sudo", async () => {
  const calls: string[] = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      calls.push(command);
      return Promise.resolve(
        command === "/usr/bin/docker" ? fail(SOCKET_DENIED) : fail(DENIED_RUN),
      );
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    const result = await runDocker(["info"]);
    assertEquals(result.success, false);
    assertEquals(result.stderr, SOCKET_DENIED);
    assertEquals(calls, [
      "/usr/bin/docker",
      "/usr/bin/sudo",
      "/usr/bin/sudo",
    ]);
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("resolveDockerInvocation keeps the direct docker call when this process may not run sudo", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: (command) =>
      Promise.resolve(
        command === "/usr/bin/docker" ? fail(SOCKET_DENIED) : fail(DENIED_RUN),
      ),
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    assertEquals(await resolveDockerInvocation(), {
      bin: "/usr/bin/docker",
      prefixArgs: [],
    });
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("resolveDockerInvocation does not cache a probe made before Docker was installed", async () => {
  // Phase 0: no docker binary. Phase 1: installed, but this process still has
  // no docker group, so only `sudo -u <self>` reaches the socket.
  let installed = false;
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          installed
            ? fail(SOCKET_DENIED)
            : fail("spawn failed: No such file or directory (os error 2)", 127),
        );
      }
      return Promise.resolve(ok("24.0.0"));
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    assertEquals(await resolveDockerInvocation(), {
      bin: "/usr/bin/docker",
      prefixArgs: [],
    });
    installed = true;
    const after = await resolveDockerInvocation();
    assertEquals(after.bin, "/usr/bin/sudo");
    assertEquals(after.prefixArgs.slice(0, 4), ["-n", "-u", "tp", "--"]);
    installed = false;
    // The settled answer is now cached for the life of the process.
    assertEquals(await resolveDockerInvocation(), after);
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("resetDockerInvocation drops a settled invocation so the next call probes again", async () => {
  let permissionDenied = false;
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        return Promise.resolve(permissionDenied ? fail(SOCKET_DENIED) : ok());
      }
      return Promise.resolve(ok());
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    assertEquals((await resolveDockerInvocation()).prefixArgs, []);
    permissionDenied = true;
    assertEquals((await resolveDockerInvocation()).prefixArgs, []);
    resetDockerInvocation();
    assertEquals((await resolveDockerInvocation()).bin, "/usr/bin/sudo");
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("spawnDockerStreaming reaches the socket through sudo after Docker is installed mid-process", async () => {
  let installed = false;
  const spawned: Array<{ bin: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          installed
            ? fail(SOCKET_DENIED)
            : fail("spawn failed: not found", 127),
        );
      }
      return Promise.resolve(ok("24.0.0"));
    },
    spawnStreaming: (bin, args) => {
      spawned.push({ bin, args: [...args] });
      return Promise.resolve(
        new Deno.Command("true").spawn(),
      );
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    await (await spawnDockerStreaming(["compose", "version"])).status;
    installed = true;
    await (await spawnDockerStreaming(["compose", "up"])).status;
    assertEquals(spawned[0]?.bin, "/usr/bin/docker");
    assertEquals(spawned[1]?.bin, "/usr/bin/sudo");
    assertEquals(spawned[1]?.args.slice(0, 4), ["-n", "-u", "tp", "--"]);
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("runDocker returns the sudo-run command's real failure instead of the socket error", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === "/usr/bin/docker") {
        return Promise.resolve(
          fail(
            "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
          ),
        );
      }
      // sudo -u self reaches the socket; the command itself fails on its merits.
      return Promise.resolve(
        fail("pg_basebackup: error: connection to server failed", 1),
      );
    },
  });
  const previousUser = Deno.env.get("USER");
  Deno.env.set("USER", "tp");
  try {
    const result = await runDocker(["run", "--rm", "img", "pg_basebackup"]);
    assertEquals(result.success, false);
    assertEquals(
      result.stderr,
      "pg_basebackup: error: connection to server failed",
    );
    // The failing command must not be re-run a third time as root.
    assertEquals(calls.filter((c) => c.command === "/usr/bin/sudo").length, 1);
  } finally {
    if (previousUser === undefined) Deno.env.delete("USER");
    else Deno.env.set("USER", previousUser);
    restore();
  }
});

test("runDocker does not sudo-retry daemon errors that merely mention permission denied", async () => {
  const calls: string[] = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command) => {
      calls.push(command);
      return Promise.resolve(
        fail(
          "docker: Error response from daemon: error while creating mount source path '/srv/tls': permission denied",
        ),
      );
    },
  });
  try {
    const result = await runDocker(["run", "--rm", "img", "true"]);
    assertEquals(result.success, false);
    assertEquals(calls, ["/usr/bin/docker"]);
    assertEquals(result.stderr.includes("mount source path"), true);
  } finally {
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

test("dockerEngineProbe returns the probe's stderr so the diagnosis can use it", async () => {
  const restore = setDockerCliIoForTest({
    runRaw: () =>
      Promise.resolve(
        fail(
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        ),
      ),
  });
  try {
    const probe = await dockerEngineProbe();
    assertEquals(probe.success, false);
    assertEquals(
      probe.stderr.startsWith("Cannot connect to the Docker daemon"),
      true,
    );
    assertEquals(await dockerEngineReachable(), false);
  } finally {
    restore();
  }
});

/** Run `fn` with a fresh temp folder, removed afterwards. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-docker-cfg-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

test("the default config folder is under the run dir, never the state root or home", () => {
  setDockerCliIoForTest()(); // drop any cached folder from an earlier test
  assertEquals(
    dockerConfigDir("/run/turbopanel"),
    "/run/turbopanel/docker-config",
  );
  const previous = Deno.env.get("TURBOPANEL_RUN_DIR");
  Deno.env.set("TURBOPANEL_RUN_DIR", "/run/custom");
  try {
    assertEquals(dockerConfigDir(), "/run/custom/docker-config");
  } finally {
    if (previous === undefined) Deno.env.delete("TURBOPANEL_RUN_DIR");
    else Deno.env.set("TURBOPANEL_RUN_DIR", previous);
  }
});

test("runDocker points the client config at its own 0700 folder", async () => {
  await withTempDir(async (dir) => {
    const config = `${dir}/docker-config`;
    const calls: string[][] = [];
    const restore = setDockerCliIoForTest({
      configDir: config,
      runRaw: (_command, args) => {
        calls.push([...args]);
        return Promise.resolve(ok("x"));
      },
    });
    try {
      await runDocker(["compose", "build"]);
      assertEquals(calls[0], ["--config", config, "compose", "build"]);
      const info = await Deno.stat(config);
      assertEquals(info.isDirectory, true);
      assertEquals((info.mode ?? 0) & 0o777, 0o700);
    } finally {
      restore();
    }
  });
});

test("the config folder survives the sudo rungs as an argument, not the environment", async () => {
  await withTempDir(async (dir) => {
    const config = `${dir}/docker-config`;
    const calls: Array<{ command: string; args: string[] }> = [];
    const restore = setDockerCliIoForTest({
      configDir: config,
      runRaw: (command, args) => {
        calls.push({ command, args: [...args] });
        return Promise.resolve(
          command === "/usr/bin/docker"
            ? fail(
              "permission denied while trying to connect to the Docker daemon socket",
            )
            : ok("ok"),
        );
      },
    });
    const previousUser = Deno.env.get("USER");
    Deno.env.set("USER", "tp");
    try {
      await runDocker(["ps"]);
      assertEquals(calls[1]?.command, "/usr/bin/sudo");
      assertEquals(calls[1]?.args.slice(-3), ["--config", config, "ps"]);
    } finally {
      if (previousUser === undefined) Deno.env.delete("USER");
      else Deno.env.set("USER", previousUser);
      restore();
    }
  });
});

test("the streaming spawn and the probe carry the config folder too", async () => {
  await withTempDir(async (dir) => {
    const config = `${dir}/docker-config`;
    const probes: string[][] = [];
    const spawned: string[][] = [];
    const restore = setDockerCliIoForTest({
      configDir: config,
      runRaw: (_command, args) => {
        probes.push([...args]);
        return Promise.resolve(ok("1"));
      },
      spawnStreaming: (_bin, args) => {
        spawned.push([...args]);
        return Promise.resolve(new Deno.Command("/bin/true").spawn());
      },
    });
    try {
      const child = await spawnDockerStreaming(["save", "img"]);
      await child.status;
      assertEquals(probes[0]?.slice(0, 3), ["--config", config, "version"]);
      assertEquals(spawned[0], ["--config", config, "save", "img"]);
    } finally {
      restore();
    }
  });
});

test("a config folder the daemon cannot create leaves docker its own default", async () => {
  await withTempDir(async (dir) => {
    const blocker = `${dir}/blocker`;
    await Deno.writeTextFile(blocker, "");
    const calls: string[][] = [];
    const restore = setDockerCliIoForTest({
      configDir: `${blocker}/docker-config`,
      runRaw: (_command, args) => {
        calls.push([...args]);
        return Promise.resolve(ok("x"));
      },
    });
    try {
      await runDocker(["ps"]);
      assertEquals(calls[0], ["ps"]);
    } finally {
      restore();
    }
  });
});

async function configDirCalls(
  dir: string,
  extra: Partial<Parameters<typeof setDockerCliIoForTest>[0] & object> = {},
): Promise<{ args: string[]; warnings: string[] }> {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  const restore = setDockerCliIoForTest({
    configDir: dir,
    runRaw: (_command, args) => {
      calls.push([...args]);
      return Promise.resolve(ok("x"));
    },
    ...extra,
  });
  try {
    await runDocker(["ps"]);
    await runDocker(["ps"]);
  } finally {
    console.warn = originalWarn;
    restore();
  }
  return { args: calls[0] ?? [], warnings };
}

test("a config folder that already exists is used when it is ours, and its mode is set to 0700", async () => {
  await withTempDir(async (dir) => {
    const config = `${dir}/docker-config`;
    await Deno.mkdir(config, { mode: 0o755 });
    await Deno.chmod(config, 0o755);
    const { args, warnings } = await configDirCalls(config);
    assertEquals(args, ["--config", config, "ps"]);
    assertEquals(((await Deno.stat(config)).mode ?? 0) & 0o7777, 0o700);
    assertEquals(warnings, []);
  });
});

test("a config folder owned by another account is never used, and a private one is made instead", async () => {
  await withTempDir(async (dir) => {
    const config = `${dir}/docker-config`;
    await Deno.mkdir(config, { mode: 0o700 });
    const real = Deno.lstatSync;
    const { args, warnings } = await configDirCalls(config, {
      // Our folder reads as foreign; the fresh one reads as ours.
      lstatSync: (p) => {
        const info = real(p);
        return {
          isDirectory: info.isDirectory,
          isSymlink: info.isSymlink,
          uid: p === config ? (info.uid ?? 0) + 1 : info.uid,
          mode: info.mode,
        };
      },
    });
    assertEquals(args[0], "--config");
    assertEquals(args[1] !== config, true);
    assertEquals(args[1]?.startsWith(`${dir}/docker-config-`), true);
    assertEquals(((await Deno.stat(args[1]!)).mode ?? 0) & 0o777, 0o700);
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0]?.includes("owned by another account"), true);
  });
});

test("a symlink at the config path is never followed or used", async () => {
  await withTempDir(async (dir) => {
    const planted = `${dir}/planted`;
    await Deno.mkdir(planted, { mode: 0o700 });
    const config = `${dir}/docker-config`;
    await Deno.symlink(planted, config);
    const { args, warnings } = await configDirCalls(config);
    assertEquals(args[0], "--config");
    assertEquals(args[1] !== config && args[1] !== planted, true);
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0]?.includes("not a plain directory"), true);
  });
});

test("when nothing can be trusted docker gets no flag and the reason is logged once", async () => {
  await withTempDir(async (dir) => {
    const blocker = `${dir}/blocker`;
    await Deno.writeTextFile(blocker, "");
    const { args, warnings } = await configDirCalls(`${blocker}/docker-config`);
    assertEquals(args, ["ps"]);
    assertEquals(warnings.length, 1);
  });
});
