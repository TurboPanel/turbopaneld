import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DEPLOYMENT_MANIFEST_FILENAME,
  listLocalDeploymentManifests,
  RUNTIME_COMPOSE_FILENAME,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "./compose-files.ts";
import {
  ensureDeploymentSecretFiles,
  parseRehydrateDeploymentResults,
  rehydrateLocalDeployments,
} from "./rehydrate-deployments.ts";
import type { DockerCliResult } from "./docker-cli.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseRehydrateDeploymentResults keeps valid secret plans", () => {
  const parsed = parseRehydrateDeploymentResults([{
    projectId: "proj-1",
    environmentId: "env-1",
    generation: 2,
    secretPlan: [{
      key: "TOKEN",
      composeServiceName: "web",
      source: "web_token",
      target: "TOKEN",
      relativePath: "web--TOKEN",
      forBuild: false,
      forRuntime: true,
    }],
    variableMaterial: [{
      key: "TOKEN",
      composeServiceName: "web",
      forBuild: false,
      forRuntime: true,
      isLiteral: false,
      valueEnvelope: "tpdaemon.v1.abc",
    }],
  }]);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0]?.secretPlan[0]?.relativePath, "web--TOKEN");
  assertEquals(
    parsed[0]?.variableMaterial[0]?.valueEnvelope,
    "tpdaemon.v1.abc",
  );
});

test({
  name: "rehydrateLocalDeployments writes files then compose up on first boot",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-" });
    const stateDir = join(root, "state");
    const runDir = join(root, "run");
    const layout = {
      stateDir,
      runDir,
    } as Parameters<typeof rehydrateLocalDeployments>[0]["layout"];
    const dir = join(stateDir, "deployments", "proj-1", "env-1");
    await Deno.mkdir(dir, { recursive: true });
    await writeComposeFileSecure(
      join(dir, RUNTIME_COMPOSE_FILENAME),
      "services:\n  web:\n    image: nginx\n",
    );
    await writeDeploymentManifest(dir, {
      version: 2,
      projectId: "proj-1",
      environmentId: "env-1",
      serverId: "srv-1",
      generation: 1,
      projectName: "demo",
      composeSha256: "a".repeat(64),
      services: { web: { replicas: 1 } },
      secrets: [{
        source: "web_token",
        target: "TOKEN",
        relativePath: "web--TOKEN",
        composeServiceName: "web",
        forBuild: false,
        key: "TOKEN",
        forRuntime: true,
      }],
    });

    const ups: string[][] = [];
    const fakeRun = (args: string[]): Promise<DockerCliResult> => {
      ups.push([...args]);
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };

    try {
      const listed = await listLocalDeploymentManifests({ stateDir });
      assertEquals(listed.length, 1);
      assertEquals(
        listed[0]?.manifest.secrets?.[0]?.relativePath,
        "web--TOKEN",
      );

      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve(["plain-token"]),
        rehydrate: () =>
          Promise.resolve([{
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            secretPlan: [{
              key: "TOKEN",
              composeServiceName: "web",
              source: "web_token",
              target: "TOKEN",
              relativePath: "web--TOKEN",
              forBuild: false,
              forRuntime: true,
            }],
            variableMaterial: [{
              key: "TOKEN",
              composeServiceName: "web",
              forBuild: false,
              forRuntime: true,
              isLiteral: false,
              valueEnvelope: "tpdaemon.v1.x",
            }],
          }]),
        runDocker: fakeRun,
        composeUp: "always",
      });

      const secretPath = join(
        runDir,
        "deployments",
        "proj-1",
        "env-1",
        "secrets",
        "web--TOKEN",
      );
      assertEquals(await Deno.readTextFile(secretPath), "plain-token");
      assertEquals(ups.some((argv) => argv.includes("up")), true);
      assertEquals(
        await Deno.readTextFile(join(dir, DEPLOYMENT_MANIFEST_FILENAME)).then(
          (text) => text.includes("plain-token"),
        ),
        false,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

async function writeSecretDeployment(
  root: string,
  generation: number,
): Promise<{
  layout: Parameters<typeof rehydrateLocalDeployments>[0]["layout"];
  dir: string;
  secretPath: string;
}> {
  const stateDir = join(root, "state");
  const runDir = join(root, "run");
  const layout = { stateDir, runDir } as Parameters<
    typeof rehydrateLocalDeployments
  >[0]["layout"];
  const dir = join(stateDir, "deployments", "proj-1", "env-1");
  await Deno.mkdir(dir, { recursive: true });
  await writeComposeFileSecure(
    join(dir, RUNTIME_COMPOSE_FILENAME),
    "services:\n  web:\n    image: nginx\n",
  );
  await writeDeploymentManifest(dir, {
    version: 2,
    projectId: "proj-1",
    environmentId: "env-1",
    serverId: "srv-1",
    generation,
    projectName: "demo",
    composeSha256: "a".repeat(64),
    services: { web: { replicas: 1 } },
    secrets: [{
      source: "web_token",
      target: "TOKEN",
      relativePath: "web--TOKEN",
      composeServiceName: "web",
      forBuild: false,
      key: "TOKEN",
      forRuntime: true,
    }],
  });
  return {
    layout,
    dir,
    secretPath: join(
      runDir,
      "deployments",
      "proj-1",
      "env-1",
      "secrets",
      "web--TOKEN",
    ),
  };
}

function mismatchedRehydrateResult(generation: number) {
  return {
    projectId: "proj-1",
    environmentId: "env-1",
    generation,
    secretPlan: [{
      key: "TOKEN",
      composeServiceName: "web",
      source: "web_token",
      target: "TOKEN",
      relativePath: "web--TOKEN",
      forBuild: false,
      forRuntime: true,
    }],
    variableMaterial: [{
      key: "TOKEN",
      composeServiceName: "web",
      forBuild: false,
      forRuntime: true,
      isLiteral: false,
      valueEnvelope: "tpdaemon.v1.x",
    }],
  };
}

test({
  name:
    "rehydrateLocalDeployments refuses to materialize or compose up on generation mismatch",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-mismatch-" });
    try {
      const { layout, secretPath } = await writeSecretDeployment(root, 1);
      const ups: string[][] = [];
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => {
          throw new TypeError("decrypt must not run for mismatched generation");
        },
        rehydrate: () => Promise.resolve([mismatchedRehydrateResult(9)]),
        runDocker: (args) => {
          ups.push([...args]);
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
        composeUp: "always",
      });

      let secretExists = true;
      try {
        await Deno.stat(secretPath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) secretExists = false;
        else throw err;
      }
      assertEquals(secretExists, false);
      assertEquals(ups, []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "ensureDeploymentSecretFiles throws on generation mismatch",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-ensure-" });
    try {
      const { layout } = await writeSecretDeployment(root, 1);
      await assertRejects(
        () =>
          ensureDeploymentSecretFiles({
            layout,
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            decryptSecrets: () => {
              throw new TypeError(
                "decrypt must not run for mismatched generation",
              );
            },
            rehydrate: () => Promise.resolve([mismatchedRehydrateResult(9)]),
            plan: [{ relativePath: "web--TOKEN" }],
          }),
        Error,
        "secret rehydrate generation mismatch",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
