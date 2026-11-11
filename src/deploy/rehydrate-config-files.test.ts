import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
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
import type { EnvironmentDeployConfigFile } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "./docker-cli.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno);

const perm = { read: true, write: true };

const SECRET_CONF: EnvironmentDeployConfigFile = {
  composeServiceName: "web",
  source: "web_pgpass",
  relativePath: "web--pgpass",
  parts: [{ text: "pw=" }, { secretKey: "PW" }],
};
const TEXT_CONF: EnvironmentDeployConfigFile = {
  composeServiceName: "web",
  source: "web_servers",
  relativePath: "web--servers",
  parts: [{ text: "{}" }],
};

const ok = (): Promise<DockerCliResult> =>
  Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });

const MATERIAL = {
  key: "PW",
  composeServiceName: "web",
  forBuild: false,
  forRuntime: false,
  isLiteral: false,
  valueEnvelope: "sealed",
};

async function withDeployment<T>(
  configFiles: EnvironmentDeployConfigFile[],
  fn: (ctx: {
    layout: Parameters<typeof rehydrateLocalDeployments>[0]["layout"];
    configs: string;
    stateDir: string;
  }) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-cfg-" });
  const stateDir = join(root, "state");
  const runDir = join(root, "run");
  const dir = join(stateDir, "deployments", "proj-1", "env-1");
  await Deno.mkdir(dir, { recursive: true });
  await writeComposeFileSecure(
    join(dir, RUNTIME_COMPOSE_FILENAME),
    "services:\n  web:\n    image: nginx\n",
  );
  await writeDeploymentManifest(dir, {
    version: 3,
    projectId: "proj-1",
    environmentId: "env-1",
    serverId: "srv-1",
    generation: 1,
    projectName: "demo",
    composeSha256: "a".repeat(64),
    services: { web: { replicas: 1 } },
    configFiles,
  });
  try {
    return await fn({
      layout: { stateDir, runDir } as Parameters<
        typeof rehydrateLocalDeployments
      >[0]["layout"],
      configs: join(runDir, "deployments", "proj-1", "env-1", "configs"),
      stateDir,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test({
  name:
    "the manifest round-trips configFiles and an older manifest without it parses",
  permissions: perm,
  fn: () =>
    withDeployment([SECRET_CONF, TEXT_CONF], async ({ stateDir }) => {
      const [listed] = await listLocalDeploymentManifests({ stateDir });
      assertEquals(listed?.manifest.configFiles, [SECRET_CONF, TEXT_CONF]);
    }).then(() =>
      withDeployment([], async ({ stateDir }) => {
        const [listed] = await listLocalDeploymentManifests({ stateDir });
        assertEquals(listed?.manifest.configFiles, undefined);
      })
    ),
});

test({
  name:
    "rehydrate rebuilds generated files from the manifest with returned material",
  permissions: perm,
  fn: () =>
    withDeployment([SECRET_CONF, TEXT_CONF], async ({ layout, configs }) => {
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve(["hunter2"]),
        rehydrate: () =>
          Promise.resolve([{
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            secretPlan: [],
            variableMaterial: [MATERIAL],
          }]),
        runDocker: ok,
        composeUp: "always",
      });
      assertEquals(
        await Deno.readTextFile(join(configs, "web--pgpass")),
        "pw=hunter2",
      );
      assertEquals(
        await Deno.readTextFile(join(configs, "web--servers")),
        "{}",
      );
    }),
});

test({
  name: "a file with no secret part is rebuilt with no control plane answer",
  permissions: perm,
  fn: () =>
    withDeployment([TEXT_CONF], async ({ layout, configs }) => {
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.reject(new Error("unused")),
        rehydrate: () => Promise.reject(new Error("offline")),
        runDocker: ok,
        composeUp: "always",
      });
      assertEquals(
        await Deno.readTextFile(join(configs, "web--servers")),
        "{}",
      );
    }),
});

test({
  name: "a generation mismatch writes no secret-bearing generated file",
  permissions: perm,
  fn: () =>
    withDeployment([SECRET_CONF], async ({ layout, configs }) => {
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve(["hunter2"]),
        rehydrate: () =>
          Promise.resolve([{
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 9,
            secretPlan: [],
            variableMaterial: [MATERIAL],
          }]),
        runDocker: ok,
        composeUp: "always",
      });
      await assertRejects(
        () => Deno.stat(join(configs, "web--pgpass")),
        Deno.errors.NotFound,
      );
    }),
});

test({
  name:
    "a generation mismatch or no answer still rebuilds text-only generated files",
  permissions: perm,
  fn: () =>
    withDeployment([SECRET_CONF, TEXT_CONF], async ({ layout, configs }) => {
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve(["hunter2"]),
        rehydrate: () => Promise.reject(new Error("offline")),
        runDocker: ok,
        composeUp: "always",
      });
      assertEquals(
        await Deno.readTextFile(join(configs, "web--servers")),
        "{}",
      );
      await assertRejects(
        () => Deno.stat(join(configs, "web--pgpass")),
        Deno.errors.NotFound,
      );
    }),
});

test({
  name:
    "start and restart rebuild a missing generated file, or refuse to start",
  permissions: perm,
  fn: () =>
    withDeployment([SECRET_CONF, TEXT_CONF], async ({ layout, configs }) => {
      const params = {
        layout,
        projectId: "proj-1",
        environmentId: "env-1",
        generation: 1,
        configFiles: [SECRET_CONF, TEXT_CONF],
      };
      await assertRejects(
        () => ensureDeploymentSecretFiles(params),
        Error,
        "cannot start until TurboPanel rehydrates secrets",
      );
      // The text-only file was rebuilt locally even though start was refused.
      assertEquals(
        await Deno.readTextFile(join(configs, "web--servers")),
        "{}",
      );
      await ensureDeploymentSecretFiles({
        ...params,
        decryptSecrets: () => Promise.resolve(["hunter2"]),
        rehydrate: () =>
          Promise.resolve([{
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            secretPlan: [],
            variableMaterial: [MATERIAL],
          }]),
      });
      assertEquals(
        await Deno.readTextFile(join(configs, "web--pgpass")),
        "pw=hunter2",
      );
    }),
});

test("parseRehydrateDeploymentResults accepts material with no matching plan entry", () => {
  const parsed = parseRehydrateDeploymentResults([{
    projectId: "proj-1",
    environmentId: "env-1",
    generation: 1,
    secretPlan: [],
    variableMaterial: [MATERIAL],
  }]);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0]?.secretPlan, []);
  assertEquals(parsed[0]?.variableMaterial.length, 1);
});
