import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  RUNTIME_COMPOSE_FILENAME,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "../../deploy/compose-files.ts";
import { serviceIngressDir } from "../../deploy/ingress.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { handleEnvironmentLifecycle } from "./lifecycle-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type EnvSnapshot = {
  TURBOPANEL_STATE_DIR?: string;
  TURBOPANEL_CONFIG_DIR?: string;
  TURBOPANEL_RUN_DIR?: string;
};

function snapshotEnv(): EnvSnapshot {
  return {
    TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
    TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    TURBOPANEL_RUN_DIR: Deno.env.get("TURBOPANEL_RUN_DIR"),
  };
}

function restoreEnv(previous: EnvSnapshot): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function okDocker(args: string[]): Promise<DockerCliResult> {
  return Promise.resolve({
    success: true,
    stdout: args.includes("ps") ? "[]" : "",
    stderr: "",
    code: 0,
  });
}

test({
  name: "handleEnvironmentLifecycle rejects unsafe projectId characters",
  permissions: { env: true, read: true },
  fn: async () => {
    await assertRejects(
      () =>
        handleEnvironmentLifecycle(
          {
            environmentId: "envlife09",
            projectId: "../escape",
            projectName: "tp-demo-envlife9",
            action: "stop",
          },
          new Date().toISOString(),
        ),
      Error,
      "projectId contains unsupported characters",
    );
  },
});

test({
  name:
    "handleEnvironmentLifecycle omits containers when compose ps throws",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-life-ps-throw-" });
    const previous = snapshotEnv();
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envlife10";
    const projectName = "tp-demo-envlif10";
    const deploymentDir = join(stateDir, "deployments", "proj-1", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      "services: {}\n",
      { mode: 0o640 },
    );

    try {
      const result = await handleEnvironmentLifecycle(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
          action: "stop",
        },
        new Date().toISOString(),
        {
          runDocker: (args) => {
            if (args.includes("ps")) {
              return Promise.reject(new Error("ps exploded"));
            }
            return okDocker(args);
          },
        },
      );
      assertEquals(result.containers, undefined);
      assertEquals(result.projectName, projectName);
    } finally {
      restoreEnv(previous);
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentLifecycle uses a fallback message when compose stderr is empty",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-life-empty-err-" });
    const previous = snapshotEnv();
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envlife11";
    const projectName = "tp-demo-envlif11";
    const deploymentDir = join(stateDir, "deployments", "proj-1", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      "services: {}\n",
      { mode: 0o640 },
    );

    try {
      await assertRejects(
        () =>
          handleEnvironmentLifecycle(
            {
              environmentId,
              projectId: "proj-1",
              projectName,
              action: "restart",
            },
            new Date().toISOString(),
            {
              runDocker: () =>
                Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "",
                  code: 1,
                }),
            },
          ),
        Error,
        "compose restart failed",
      );
    } finally {
      restoreEnv(previous);
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentLifecycle start rehydrates planned secrets then continues",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-life-rehydrate-" });
    const previous = snapshotEnv();
    const stateDir = join(root, "state");
    const runDir = join(root, "run");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    Deno.env.set("TURBOPANEL_RUN_DIR", runDir);

    const environmentId = "envlife12";
    const projectId = "proj-1";
    const projectName = "tp-demo-envlif12";
    const deploymentDir = join(
      stateDir,
      "deployments",
      projectId,
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true });
    await writeComposeFileSecure(
      join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      "services:\n  web:\n    image: nginx\n",
    );
    await writeDeploymentManifest(deploymentDir, {
      version: 2,
      projectId,
      environmentId,
      serverId: "srv-1",
      generation: 3,
      projectName,
      composeSha256: "c".repeat(64),
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

    const rehydrateCalls: Array<{
      projectId: string;
      environmentId: string;
      generation?: number;
    }> = [];

    try {
      const result = await handleEnvironmentLifecycle(
        {
          environmentId,
          projectId,
          projectName,
          action: "start",
        },
        new Date().toISOString(),
        {
          runDocker: okDocker,
          decryptSecrets: (ciphertexts) =>
            Promise.resolve(ciphertexts.map(() => "rehydrated-token")),
          rehydrateDeploymentSecrets: (deployments) => {
            rehydrateCalls.push(...deployments);
            return Promise.resolve([{
              projectId,
              environmentId,
              generation: 3,
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
            }]);
          },
        },
      );
      assertEquals(result.projectName, projectName);
      assertEquals(rehydrateCalls, [{
        projectId,
        environmentId,
        generation: 3,
      }]);
    } finally {
      restoreEnv(previous);
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentLifecycle skips ingress compose that is missing or not a file",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-life-ing-skip-" });
    const previous = snapshotEnv();
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);

    const environmentId = "envlife13";
    const projectName = "tp-demo-envlif13";
    const missingServiceId = "00000000-0000-4000-8000-0000000000aa";
    const dirServiceId = "00000000-0000-4000-8000-0000000000bb";
    const deploymentDir = join(stateDir, "deployments", "proj-1", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      "services: {}\n",
      { mode: 0o640 },
    );

    const layout = resolveLayout(
      {
        TURBOPANEL_STATE_DIR: stateDir,
        TURBOPANEL_CONFIG_DIR: configDir,
      },
      { skipDiscovery: true, forceMode: "production" },
    );
    await Deno.mkdir(join(stateDir, "ingress", "by-environment"), {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      join(stateDir, "ingress", "by-environment", `${environmentId}.json`),
      JSON.stringify([missingServiceId, dirServiceId]),
      { mode: 0o640 },
    );
    await Deno.mkdir(
      join(serviceIngressDir(layout, dirServiceId), "docker-compose.yml"),
      { recursive: true },
    );

    const ingressProjects: string[] = [];
    try {
      const result = await handleEnvironmentLifecycle(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
          action: "stop",
        },
        new Date().toISOString(),
        {
          runDocker: (args) => {
            const projectIdx = args.indexOf("-p");
            if (projectIdx >= 0 && args[projectIdx + 1]?.startsWith(
              "turbopanel-ingress-",
            )) {
              ingressProjects.push(args[projectIdx + 1]!);
            }
            return okDocker(args);
          },
        },
      );
      assertEquals(result.projectName, projectName);
      assertEquals(ingressProjects, []);
    } finally {
      restoreEnv(previous);
      await Deno.remove(root, { recursive: true });
    }
  },
});
