import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "./docker-cli.ts";
import {
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

function ok(): DockerCliResult {
  return { success: true, stdout: "", stderr: "", code: 0 };
}

test({
  name: "runDeployServiceHooks runs no-cache build then preDeployCommand",
  permissions: { read: true, write: true, run: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-hooks-" });
    const marker = join(dir, "pre.txt");
    const builds: string[][] = [];
    try {
      await runDeployServiceHooks(
        [{
          composeServiceName: "web",
          buildDisableCache: true,
          preDeployCommand: `printf 'ok' > ${marker}`,
        }],
        {
          projectName: "demo",
          composePaths: [join(dir, "compose.yaml")],
          deploymentDir: dir,
          runDocker: (args) => {
            builds.push([...args]);
            return Promise.resolve(ok());
          },
        },
      );
      assertEquals(builds.length, 1);
      assertEquals(builds[0]?.includes("build"), true);
      assertEquals(builds[0]?.includes("--no-cache"), true);
      assertEquals(builds[0]?.at(-1), "web");
      assertEquals(await Deno.readTextFile(marker), "ok");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "runDeployServiceHooks surfaces docker compose build failures",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-hooks-fail-" });
    try {
      await assertRejects(
        () =>
          runDeployServiceHooks(
            [{ composeServiceName: "web", buildDisableCache: true }],
            {
              projectName: "demo",
              composePaths: [join(dir, "compose.yaml")],
              deploymentDir: dir,
              runDocker: () =>
                Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "build blew up",
                  code: 1,
                }),
            },
          ),
        Error,
        "build blew up",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "runPostDeployHooks runs postDeployCommand in the deployment dir",
  permissions: { read: true, write: true, run: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-post-hooks-" });
    const marker = join(dir, "post.txt");
    try {
      await runPostDeployHooks(
        [{
          composeServiceName: "web",
          postDeployCommand: `printf 'done' > ${marker}`,
        }],
        dir,
      );
      assertEquals(await Deno.readTextFile(marker), "done");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "runPostDeployHooks surfaces failing shell hooks",
  permissions: { read: true, write: true, run: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-post-hooks-fail-" });
    try {
      await assertRejects(
        () =>
          runPostDeployHooks(
            [{
              composeServiceName: "web",
              postDeployCommand: "echo boom >&2; exit 2",
            }],
            dir,
          ),
        Error,
        "boom",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
