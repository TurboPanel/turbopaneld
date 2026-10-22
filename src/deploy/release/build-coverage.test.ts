/**
 * Extra {@link runReleaseBuild} coverage that lives outside `build.test.ts`
 * (that file is owned by another session).
 */

import { assertEquals } from "@std/assert";
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
  name: "runReleaseBuild runs a native build as a plain sh -c",
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    await withWorkingDir(async (workingDir) => {
      await runReleaseBuild({
        build: { kind: "native", buildCommand: "touch built" },
        workingDir,
        nativeRuntime: {
          nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
          nodeEnv: "production",
        },
      });
      assertEquals((await Deno.stat(join(workingDir, "built"))).isFile, true);
    });
  },
});
