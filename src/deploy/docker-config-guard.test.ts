import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import {
  dockerConfigEnv,
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

const REPO = join(dirname(fromFileUrl(import.meta.url)), "..", "..");

/**
 * A call that hands the docker client to a spawner: the program name (a
 * literal, or a variable named for the docker binary) is the first argument.
 */
const DOCKER_SPAWN =
  /\b(?:Deno\.Command|spawnText|runRaw|run|runHost|runCommand|runDefault)\(\s*(?:"docker"|"\/usr\/bin\/docker"|DOCKER_BIN|dockerBin|resolvedDockerBin\(\))\s*,/;

/** What a spawn site must use so the client gets the private config folder. */
const CONFIG_USE = /\b(?:withDockerConfig|dockerConfigEnv|runDocker\w*)\b/;

/**
 * Sites that may spawn the client without it, and why. Keep this list short:
 * every entry is a place where a tenant build could still reach the state root.
 */
const EXEMPT: Record<string, string> = {
  "src/commands/fabric.ts":
    "runs through tp-host as root, whose home is not the state root",
  "src/dev-host/auto-migrate.ts":
    "development hosts only; the console runs as the developer",
  "src/testing/docker-run.ts":
    "test-only helper (never imported by production)",
};

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name !== "testing") productionSources(path, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(relative(REPO, path));
    }
  }
  return out;
}

/** Files that spawn the docker client and do not route it through the config helpers. */
export function unguardedDockerSpawners(
  files: Record<string, string>,
): string[] {
  return Object.entries(files)
    .filter(([file, text]) =>
      DOCKER_SPAWN.test(text) && !CONFIG_USE.test(text) && !(file in EXEMPT)
    )
    .map(([file]) => file)
    .sort();
}

test("every production file that spawns docker uses the private config folder", () => {
  const files: Record<string, string> = {};
  for (const file of productionSources(join(REPO, "src"))) {
    if (file === "src/deploy/docker-cli.ts") continue;
    files[file] = Deno.readTextFileSync(join(REPO, file));
  }
  assertEquals(unguardedDockerSpawners(files), []);
});

test("the scan flags a bare docker spawn and accepts the sanctioned runners", () => {
  assertEquals(
    unguardedDockerSpawners({
      "src/x/bare.ts": 'await new Deno.Command("docker", { args })',
      "src/x/bin.ts": "await runCommand(DOCKER_BIN, args)",
      "src/x/ok.ts": 'import { runDocker } from "d";\nrun("docker", a)',
      "src/commands/fabric.ts": 'runHost("docker", a)',
    }),
    ["src/x/bare.ts", "src/x/bin.ts"],
  );
});

test("no exemption is stale", () => {
  for (const file of Object.keys(EXEMPT)) {
    assert(
      Deno.statSync(join(REPO, file)).isFile,
      `${file} is exempt but missing`,
    );
  }
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "docker-config-guard-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A stand-in client that reports the config it was handed, like a plugin child would see it. */
async function fakeDocker(dir: string): Promise<string> {
  const bin = join(dir, "docker");
  await Deno.writeTextFile(
    bin,
    '#!/bin/sh\necho "args=$*"\necho "env=$DOCKER_CONFIG"\n',
    { mode: 0o700 },
  );
  return bin;
}

test("a real docker child gets the config folder as flag and as DOCKER_CONFIG", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "docker-config");
    const restore = setDockerCliIoForTest({
      configDir: config,
      dockerBin: await fakeDocker(dir),
    });
    try {
      assertEquals(dockerConfigEnv(), { DOCKER_CONFIG: config });
      const result = await runDocker(["compose", "build"]);
      assertEquals(result.success, true);
      assert(result.stdout.includes(`args=--config ${config} compose build`));
      assert(result.stdout.includes(`env=${config}`));
    } finally {
      restore();
    }
  });
});

test("the streaming spawn child gets DOCKER_CONFIG too", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "docker-config");
    const restore = setDockerCliIoForTest({
      configDir: config,
      dockerBin: await fakeDocker(dir),
    });
    try {
      const child = await spawnDockerStreaming(["compose", "up"]);
      const out = await child.output();
      const text = new TextDecoder().decode(out.stdout);
      assert(text.includes(`env=${config}`));
    } finally {
      restore();
    }
  });
});

test("the sudo rungs restore DOCKER_CONFIG through env, since sudo resets the environment", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "docker-config");
    const calls: Array<{ command: string; args: string[] }> = [];
    const restore = setDockerCliIoForTest({
      configDir: config,
      runRaw: (command, args) => {
        calls.push({ command, args: [...args] });
        return Promise.resolve(
          command === "/usr/bin/docker"
            ? {
              success: false,
              code: 1,
              stdout: "",
              stderr:
                "permission denied while trying to connect to the Docker daemon socket",
            }
            : { success: true, code: 0, stdout: "ok", stderr: "" },
        );
      },
    });
    const previousUser = Deno.env.get("USER");
    Deno.env.set("USER", "tp");
    try {
      await runDocker(["ps"]);
      assertEquals(calls[1]?.args.slice(3, 6), [
        "--",
        "/usr/bin/env",
        `DOCKER_CONFIG=${config}`,
      ]);
      const invocation = await resolveDockerInvocation();
      assert(invocation.prefixArgs.includes(`DOCKER_CONFIG=${config}`));
    } finally {
      if (previousUser === undefined) Deno.env.delete("USER");
      else Deno.env.set("USER", previousUser);
      restore();
    }
  });
});
