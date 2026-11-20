import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { writeComposeCheckoutMarker } from "./compose-checkout-marker.ts";
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

test("a deployment with a checkout runs compose from the repository", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-compose-cwd-" });
  const seen: Array<{ cwd?: string; args: string[] }> = [];
  const restore = setDockerCliIoForTest({
    runRaw: (_command, args, options) => {
      seen.push({ cwd: options?.cwd, args });
      return Promise.resolve(ok());
    },
  });
  try {
    await writeComposeCheckoutMarker(dir, {
      version: 1,
      cloneUrl: "https://git.example.net/acme/stack.git",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      composePath: "deploy/compose.yaml",
    });
    await Deno.writeTextFile(join(dir, ".env"), "A=1\n");
    const chain = [join(dir, "compose.yaml")];
    await runDocker([...composeFileArgs("demo", chain), "build"]);
    // The staged copy of the same deployment gets the same project directory.
    await runDocker([
      ...composeFileArgs("demo", [join(dir, ".staging", "compose.yaml")]),
      "config",
    ]);
    // A caller that names its own project directory keeps it.
    await runDocker([
      "compose",
      "--project-directory",
      "/own",
      "-f",
      chain[0],
      "config",
    ]);
  } finally {
    restore();
    await Deno.remove(dir, { recursive: true });
  }
  const projectDir = join(
    dir,
    "repo",
    "0123456789abcdef0123456789abcdef01234567",
    "deploy",
  );
  assertEquals(
    seen[0].cwd,
    join(dir, "repo", "0123456789abcdef0123456789abcdef01234567"),
  );
  assertEquals(seen[0].args.slice(0, 6), [
    "compose",
    "--project-directory",
    projectDir,
    "--env-file",
    join(dir, ".env"),
    "-p",
  ]);
  assertEquals(seen[1].args.slice(1, 3), ["--project-directory", projectDir]);
  assertEquals(seen[2].args.slice(1, 3), ["--project-directory", "/own"]);
  assertEquals(
    seen[2].args.filter((a) => a === "--project-directory").length,
    1,
  );
});
