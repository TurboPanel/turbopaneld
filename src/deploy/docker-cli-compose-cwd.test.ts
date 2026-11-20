import { assertEquals } from "@std/assert";
import {
  composeWorkingDirectory,
  type DockerCliResult,
  runDocker,
  runDockerStreamed,
  setDockerCliIoForTest,
} from "./docker-cli.ts";
import { composeFileArgs } from "./compose-files.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const DEPLOYMENT_DIR = "/srv/example/deployments/project-a/env-a";
const CHAIN = [
  `${DEPLOYMENT_DIR}/compose.yaml`,
  `${DEPLOYMENT_DIR}/docker-compose.turbopanel.daemon.yml`,
];

function ok(stdout = ""): DockerCliResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

test("composeWorkingDirectory is the folder of the first compose file", () => {
  for (const verb of [["up", "-d"], ["build"], ["build", "--no-cache"]]) {
    assertEquals(
      composeWorkingDirectory([...composeFileArgs("demo", CHAIN), ...verb]),
      DEPLOYMENT_DIR,
    );
  }
});

test("composeWorkingDirectory leaves other calls in the daemon's folder", () => {
  assertEquals(composeWorkingDirectory(["ps", "-a"]), undefined);
  assertEquals(composeWorkingDirectory(["compose", "ls"]), undefined);
  assertEquals(
    composeWorkingDirectory(["compose", "-f", "relative.yaml", "up"]),
    undefined,
  );
  assertEquals(composeWorkingDirectory(["compose", "-f"]), undefined);
});

test("runDocker starts a compose call in the deployment directory", async () => {
  const seen: Array<{ cwd?: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (_command, args, options) => {
      seen.push({ cwd: options?.cwd, args });
      return Promise.resolve(ok());
    },
  });
  try {
    await runDocker([...composeFileArgs("demo", CHAIN), "up", "-d"]);
    await runDocker(["ps", "-q"]);
  } finally {
    restore();
  }
  assertEquals(seen[0].cwd, DEPLOYMENT_DIR);
  assertEquals(seen[1].cwd, undefined);
});

test("runDocker keeps the folder when it retries through sudo", async () => {
  const seen: Array<{ command: string; cwd?: string }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (command, _args, options) => {
      seen.push({ command, cwd: options?.cwd });
      if (command === "/usr/bin/docker") {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr:
            "permission denied while trying to connect to the docker.sock",
        });
      }
      if (command === "/usr/bin/id") return Promise.resolve(ok("tp"));
      return Promise.resolve(ok());
    },
  });
  try {
    const result = await runDocker([
      ...composeFileArgs("demo", CHAIN),
      "build",
    ]);
    assertEquals(result.success, true);
  } finally {
    restore();
  }
  const sudo = seen.find((entry) => entry.command === "/usr/bin/sudo");
  assertEquals(sudo?.cwd, DEPLOYMENT_DIR);
});

test("runDocker keeps the folder on the root sudo retry", async () => {
  const seen: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const denied = {
    success: false,
    code: 1,
    stdout: "",
    stderr: "permission denied while trying to connect to the docker.sock",
  };
  const restore = setDockerCliIoForTest({
    runRaw: (command, args, options) => {
      seen.push({ command, args, cwd: options?.cwd });
      if (command === "/usr/bin/id") return Promise.resolve(ok("tp"));
      // Direct docker and the sudo-as-self rung are denied; root succeeds.
      if (command === "/usr/bin/docker") return Promise.resolve(denied);
      if (command === "/usr/bin/sudo" && args.includes("-u")) {
        return Promise.resolve(denied);
      }
      return Promise.resolve(ok());
    },
  });
  try {
    const result = await runDocker([
      ...composeFileArgs("demo", CHAIN),
      "build",
    ]);
    assertEquals(result.success, true);
  } finally {
    restore();
  }
  const asRoot = seen.filter((entry) =>
    entry.command === "/usr/bin/sudo" && !entry.args.includes("-u")
  );
  assertEquals(asRoot.length > 0, true);
  for (const entry of asRoot) assertEquals(entry.cwd, DEPLOYMENT_DIR);
});

test("runDockerStreamed starts a compose build in the deployment directory", async () => {
  const seen: Array<{ cwd?: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: () => Promise.resolve(ok("24.0.0")),
    spawnStreaming: (_bin, args, options) => {
      seen.push({ cwd: options?.cwd, args });
      return Promise.resolve(
        new Deno.Command("/bin/true", {
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn(),
      );
    },
  });
  try {
    for (
      const verb of [["up", "-d", "--remove-orphans"], ["build"], [
        "build",
        "--no-cache",
        "--pull",
      ]]
    ) {
      await runDockerStreamed([...composeFileArgs("demo", CHAIN), ...verb]);
    }
    await runDockerStreamed(["image", "ls"]);
  } finally {
    restore();
  }
  assertEquals(seen.length, 4);
  assertEquals(seen.slice(0, 3).map((entry) => entry.cwd), [
    DEPLOYMENT_DIR,
    DEPLOYMENT_DIR,
    DEPLOYMENT_DIR,
  ]);
  assertEquals(seen[3].cwd, undefined);
});
