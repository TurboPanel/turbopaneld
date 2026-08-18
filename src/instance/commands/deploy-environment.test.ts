import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  COMPOSE_ENV_FILENAME,
  COMPOSE_MANIFEST_FILENAME,
  COMPOSE_STAGE_DIRNAME,
  DAEMON_COMPOSE_FILENAME,
  DEPLOYMENT_MANIFEST_FILENAME,
  resolveDeployedComposePaths,
  RUNTIME_COMPOSE_FILENAME,
  writeComposeFileManifest,
  writeComposeFileSecure,
} from "../../deploy/compose-files.ts";
import { handleEnvironmentLifecycle } from "./lifecycle-environment.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";
import {
  buildDeployServiceNames,
  buildDeploySummary,
  containerHostingsNeedSharedHttpIngress,
  handleEnvironmentDeploy,
  resolveDeployComposeFiles,
  shapeEnvironmentDeployResult,
} from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// Identifier validation runs before any Docker/ingress I/O — keep these two
// checks; broader validation lives in deploy-validation.test.ts.
// Success-path dispatch/result shape is covered via shapeEnvironmentDeployResult
// (same helper handleEnvironmentDeploy returns) for a container-free deploy.

const hermeticDeployDeps = {
  ensureDocker: () => Promise.resolve(),
  ensureExternalDockerNetworks: () => Promise.resolve(),
  ensureFabricDockerNetworks: () => Promise.resolve(),
};

test("containerHostingsNeedSharedHttpIngress requires HTTP hostnames", () => {
  assertEquals(containerHostingsNeedSharedHttpIngress([]), false);
  assertEquals(
    containerHostingsNeedSharedHttpIngress([{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: [],
      protocol: "tcp",
      ports: [{ published: 5432, target: 5432 }],
    }]),
    false,
  );
  assertEquals(
    containerHostingsNeedSharedHttpIngress([{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: [],
    }]),
    false,
  );
  assertEquals(
    containerHostingsNeedSharedHttpIngress([{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: ["app.example.test"],
    }]),
    true,
  );
});

test("handleEnvironmentDeploy rejects unsupported environmentId characters", async () => {
  await assertRejects(
    () =>
      handleEnvironmentDeploy(
        {
          environmentId: "bad/id",
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "demo",
          composeYaml: "services: {}\n",
          hostings: [],
        },
        new Date().toISOString(),
      ),
    Error,
    "environmentId contains unsupported characters",
  );
});

test("handleEnvironmentDeploy rejects unsupported projectId characters", async () => {
  await assertRejects(
    () =>
      handleEnvironmentDeploy(
        {
          environmentId: "env-1",
          projectId: "bad/id",
          organizationId: "org-1",
          projectName: "demo",
          composeYaml: "services: {}\n",
          hostings: [],
        },
        new Date().toISOString(),
      ),
    Error,
    "projectId contains unsupported characters",
  );
});

test("handleEnvironmentDeploy rejects invalid Docker Compose projectName", async () => {
  await assertRejects(
    () =>
      handleEnvironmentDeploy(
        {
          environmentId: "env-1",
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "BadName",
          composeYaml: "services: {}\n",
          hostings: [],
        },
        new Date().toISOString(),
      ),
    Error,
    "projectName must be a valid Docker Compose project name",
  );
});

test("shapeEnvironmentDeployResult matches container-free success contract", () => {
  const result = shapeEnvironmentDeployResult({
    projectName: "demo",
    environmentId: "env-1",
    labeledServices: [],
    traditionalWebSites: [],
    containers: [],
  });

  assertEquals(result, {
    projectName: "demo",
    summary: "Deployed 0 container service(s) for environment env-1",
    containers: [],
  });
  assertEquals("services" in result, false);
});

test("resolveDeployComposeFiles prefers composeFiles over composeYaml fallback", () => {
  const files = [{
    filename: "compose.yaml",
    role: "runtime" as const,
    source: "inline" as const,
    content: "services:\n  web:\n    image: nginx\n",
  }];
  assertEquals(
    resolveDeployComposeFiles({
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "tp-demo",
      composeYaml: "services: {}\n",
      composeFiles: files,
      hostings: [],
    }),
    files,
  );
  const fallback = resolveDeployComposeFiles({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo",
    composeYaml: "services:\n  api:\n    image: alpine\n",
    hostings: [],
  });
  assertEquals(fallback.length, 1);
  assertEquals(fallback[0]?.role, "runtime");
  assertEquals(fallback[0]?.content.includes("api"), true);
});

test("buildDeploySummary and buildDeployServiceNames include traditional-web sites", () => {
  const traditionalWebSites = [{
    composeServiceName: "static",
    engine: "nginx" as const,
    root: "/var/www/html",
    listenPort: 8080,
  }];
  assertEquals(
    buildDeploySummary("env-2", ["web"], traditionalWebSites),
    "Deployed 1 container service(s) + 1 traditional-web site(s) for environment env-2",
  );
  assertEquals(
    buildDeployServiceNames(["web"], traditionalWebSites),
    ["static", "web"],
  );
});

test("shapeEnvironmentDeployResult omits containers when collection failed", () => {
  const result = shapeEnvironmentDeployResult({
    projectName: "demo",
    environmentId: "env-3",
    labeledServices: ["web"],
    traditionalWebSites: [],
    containers: null,
  });
  assertEquals(result.summary, "Deployed 1 container service(s) for environment env-3");
  assertEquals(result.services, ["web"]);
  assertEquals("containers" in result, false);
});

test("handleEnvironmentDeploy rejects secret plan when decrypt is unavailable", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-secret-" });
  const previous = {
    TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
    TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  };
  Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  try {
    await assertRejects(
      () =>
        handleEnvironmentDeploy(
          {
            environmentId: "env-1",
            projectId: "proj-1",
            organizationId: "org-1",
            projectName: "tp-demo-secret",
            composeYaml: "services:\n  web:\n    image: nginx\n",
            hostings: [],
            secretPlan: [{
              key: "TOKEN",
              composeServiceName: "web",
              source: "web_token",
              target: "TOKEN",
              relativePath: "web--TOKEN",
              forBuild: false,
              forRuntime: true,
            }],
          },
          new Date().toISOString(),
          hermeticDeployDeps,
        ),
      Error,
      "Secret plan present but secrets decrypt is unavailable",
    );
  } finally {
    if (previous.TURBOPANEL_STATE_DIR === undefined) {
      Deno.env.delete("TURBOPANEL_STATE_DIR");
    } else {
      Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
    }
    if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
      Deno.env.delete("TURBOPANEL_CONFIG_DIR");
    } else {
      Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
    }
    await Deno.remove(root, { recursive: true });
  }
});

test({
  name:
    "handleEnvironmentDeploy omits containers from result when compose ps fails",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-ps-fail-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envpsfail1";
    const projectId = "proj-1";
    const projectName = "tp-demo-psfail";
    const deploymentDir = join(
      stateDir,
      "deployments",
      projectId,
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

    const runtimeYaml = "services:\n  web:\n    image: nginx:alpine\n";
    const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
      if (args.includes("config") && args.includes("--format")) {
        return Promise.resolve({
          success: true,
          stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("config") && args.includes("-q")) {
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("ps")) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "compose ps unavailable",
          code: 1,
        });
      }
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };

    try {
      const result = await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeYaml: runtimeYaml,
          hostings: [],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );
      assertEquals(result.projectName, projectName);
      assertEquals("containers" in result, false);
      assertEquals(result.services?.includes("web"), true);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

function fakeConfigJson(services: Record<string, unknown>): string {
  return JSON.stringify({ services });
}

function argvHasOrderedPaths(argv: string[], paths: string[]): boolean {
  let pathIndex = 0;
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "-f" && argv[i + 1] === paths[pathIndex]) {
      pathIndex += 1;
      if (pathIndex === paths.length) return true;
    }
  }
  return false;
}

function argvStagePaths(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (
      argv[i] === "-f" && argv[i + 1]?.includes(`/${COMPOSE_STAGE_DIRNAME}/`)
    ) {
      out.push(argv[i + 1]!);
    }
  }
  return out;
}

test({
  name:
    "handleEnvironmentDeploy publishes compose.yaml + deployment.json and merges overlay into that file",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-chain-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);

    const environmentId = "envdeploy1";
    const projectId = "proj-1";
    const projectName = "tp-demo-envdeploy";
    const deploymentDir = join(
      stateDir,
      "deployments",
      projectId,
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, "docker-compose.old.yml"),
      "services: {}\n",
      { mode: 0o640 },
    );
    const legacyDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(legacyDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(legacyDir, "docker-compose.yml"),
      "services: {}\n",
      { mode: 0o640 },
    );

    const runtimeYaml = "services:\n  web:\n    image: nginx:alpine\n";
    const calls: string[][] = [];
    const fakeRunDocker = (
      args: string[],
    ): Promise<DockerCliResult> => {
      calls.push([...args]);
      if (args.includes("config") && args.includes("--format")) {
        return Promise.resolve({
          success: true,
          stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("config") && args.includes("-q")) {
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("ps")) {
        return Promise.resolve({
          success: true,
          stdout: "[]",
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };

    try {
      await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeYaml: runtimeYaml,
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: runtimeYaml,
          }],
          generation: 3,
          desiredHash: "a".repeat(64),
          serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          replicaCounts: { web: 2 },
          hostings: [],
          managedNetworkServices: ["web"],
          noCache: true,
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      const runtimePath = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
      const runtimeStat = await Deno.stat(runtimePath);
      assertEquals(runtimeStat.mode! & 0o777, 0o640);
      const published = await Deno.readTextFile(runtimePath);
      assertEquals(published.includes("image: nginx:alpine"), true);
      assertEquals(published.includes("turbopanel-managed"), true);
      await assertRejects(
        () => Deno.stat(join(deploymentDir, DAEMON_COMPOSE_FILENAME)),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(deploymentDir, "docker-compose.old.yml")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(deploymentDir, COMPOSE_MANIFEST_FILENAME)),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(deploymentDir, COMPOSE_STAGE_DIRNAME)),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(legacyDir),
        Deno.errors.NotFound,
      );

      const manifest = JSON.parse(
        await Deno.readTextFile(
          join(deploymentDir, DEPLOYMENT_MANIFEST_FILENAME),
        ),
      ) as {
        version: number;
        projectId: string;
        environmentId: string;
        serverId: string;
        generation: number;
        projectName: string;
        composeSha256: string;
        services: Record<string, { replicas: number }>;
      };
      assertEquals(manifest.version, 2);
      assertEquals(manifest.projectId, projectId);
      assertEquals(manifest.environmentId, environmentId);
      assertEquals(manifest.serverId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      assertEquals(manifest.generation, 3);
      assertEquals(manifest.projectName, projectName);
      assertEquals(manifest.composeSha256.length, 64);
      assertEquals(manifest.services, { web: { replicas: 2 } });

      const liveChain = [runtimePath];
      const configJsonCall = calls.find((argv) =>
        argv.includes("config") && argv.includes("--format")
      );
      assertEquals(configJsonCall !== undefined, true);
      const stagedPaths = argvStagePaths(configJsonCall!);
      assertEquals(stagedPaths.length, 1);
      assertEquals(
        stagedPaths[0]!.endsWith(`/${RUNTIME_COMPOSE_FILENAME}`),
        true,
      );

      const configQCall = calls.find((argv) =>
        argv.includes("config") && argv.includes("-q")
      );
      assertEquals(configQCall !== undefined, true);
      assertEquals(argvStagePaths(configQCall!).length, 1);

      const buildCall = calls.find((argv) =>
        argv.includes("build") && argv.includes("--no-cache") &&
        argv.includes("--pull")
      );
      assertEquals(buildCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(buildCall!, liveChain), true);

      const upCall = calls.find((argv) =>
        argv.includes("up") && argv.includes("--remove-orphans")
      );
      assertEquals(upCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(upCall!, liveChain), true);

      const psCall = calls.find((argv) => argv.includes("ps"));
      assertEquals(psCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(psCall!, liveChain), true);

      const networkInspect = calls.find((argv) =>
        argv[0] === "network" && argv[1] === "inspect"
      );
      assertEquals(networkInspect !== undefined, true);

      calls.length = 0;
      await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeYaml: runtimeYaml,
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: runtimeYaml,
          }],
          hostings: [],
          managedNetworkServices: ["web"],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );
      await Deno.stat(runtimePath);
      const secondBuild = calls.find((argv) =>
        argv.includes("build") && argv.includes("--no-cache")
      );
      assertEquals(secondBuild, undefined);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentDeploy composeYaml-only payload writes compose.yaml + deployment.json",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-legacy-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    const environmentId = "envlegacy1";
    const projectId = "proj-1";
    const projectName = "tp-demo-envlegacy";
    const deploymentDir = join(
      root,
      "state",
      "deployments",
      projectId,
      environmentId,
    );

    const calls: string[][] = [];
    const fakeRunDocker = (
      args: string[],
    ): Promise<DockerCliResult> => {
      calls.push([...args]);
      if (args.includes("config") && args.includes("--format")) {
        return Promise.resolve({
          success: true,
          stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve({
        success: true,
        stdout: args.includes("ps") ? "[]" : "",
        stderr: "",
        code: 0,
      });
    };

    try {
      await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeYaml: "services:\n  web:\n    image: nginx:alpine\n",
          hostings: [],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      const runtimePath = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
      await Deno.stat(runtimePath);
      const manifest = JSON.parse(
        await Deno.readTextFile(
          join(deploymentDir, DEPLOYMENT_MANIFEST_FILENAME),
        ),
      ) as { version: number; services: Record<string, { replicas: number }> };
      assertEquals(manifest.version, 2);
      assertEquals(manifest.services, { web: { replicas: 1 } });

      const buildCall = calls.find((argv) =>
        argv.includes("build") && argv.includes("--no-cache")
      );
      assertEquals(buildCall, undefined);

      const upCall = calls.find((argv) => argv.includes("up"));
      assertEquals(upCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(upCall!, [runtimePath]), true);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "failed redeploy with renamed layers leaves prior manifest chain resolvable for lifecycle/stop",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-txn-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);

    const environmentId = "envtxfail1";
    const projectName = "tp-demo-envtxfail";
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

    const projectLayer = "docker-compose.project.yml";
    const envLayer = "docker-compose.env.yml";
    const priorFiles = [projectLayer, envLayer, DAEMON_COMPOSE_FILENAME];
    const priorContent =
      "services:\n  web:\n    image: nginx:alpine\n    environment:\n      E: prior\n";
    for (const name of priorFiles) {
      await writeComposeFileSecure(
        join(deploymentDir, name),
        name === DAEMON_COMPOSE_FILENAME
          ? "networks:\n  turbopanel-managed:\n    external: true\n"
          : priorContent,
      );
    }
    await writeComposeFileManifest(deploymentDir, priorFiles);
    const priorChain = priorFiles.map((name) => join(deploymentDir, name));

    const failingRunDocker = (
      _args: string[],
    ): Promise<DockerCliResult> => {
      // Fail resolveComposeModel (`docker compose config --format json`).
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "forced resolveComposeModel failure",
        code: 1,
      });
    };

    try {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            {
              environmentId,
              projectId: "proj-1",
              organizationId: "org-1",
              projectName,
              composeYaml: "services:\n  web:\n    image: nginx:alpine\n",
              composeFiles: [
                {
                  filename: "docker-compose.project.yml",
                  role: "project",
                  source: "inline",
                  content: "services:\n  web:\n    image: nginx:alpine\n",
                },
                {
                  // Renamed environment layer vs prior manifest.
                  filename: "docker-compose.staging.yml",
                  role: "environment",
                  source: "inline",
                  content:
                    "services:\n  web:\n    environment:\n      E: '2'\n",
                },
              ],
              hostings: [],
              managedNetworkServices: ["web"],
            },
            new Date().toISOString(),
            { runDocker: failingRunDocker, ...hermeticDeployDeps },
          ),
        Error,
        "forced resolveComposeModel failure",
      );

      // Prior live files must still exist (not pruned by the failed redeploy).
      for (const abs of priorChain) {
        await Deno.stat(abs);
      }
      // Renamed layer must not appear live until publish.
      await assertRejects(
        () => Deno.stat(join(deploymentDir, "docker-compose.staging.yml")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(deploymentDir, COMPOSE_STAGE_DIRNAME)),
        Deno.errors.NotFound,
      );

      const resolved = await resolveDeployedComposePaths(deploymentDir);
      assertEquals(resolved, priorChain);

      const lifeCalls: string[][] = [];
      const lifeRun = (args: string[]): Promise<DockerCliResult> => {
        lifeCalls.push([...args]);
        return Promise.resolve({
          success: true,
          stdout: args.includes("ps") ? "[]" : "",
          stderr: "",
          code: 0,
        });
      };
      await handleEnvironmentLifecycle(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
          action: "restart",
        },
        new Date().toISOString(),
        { runDocker: lifeRun },
      );
      const restartCall = lifeCalls.find((argv) => argv.includes("restart"));
      assertEquals(restartCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(restartCall!, priorChain), true);

      const stopCalls: string[][] = [];
      const stopRun = (args: string[]): Promise<DockerCliResult> => {
        stopCalls.push([...args]);
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      };
      await handleEnvironmentStop(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
        },
        new Date().toISOString(),
        { runDocker: stopRun },
      );
      const downCall = stopCalls.find((argv) => argv.includes("down"));
      assertEquals(downCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(downCall!, priorChain), true);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "queued multi-file composeFiles still publish a single compiled compose.yaml from composeYaml",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-tags-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);

    const environmentId = "envdeploytags";
    const projectId = "proj-1";
    const projectName = "tp-demo-envtags";
    const deploymentDir = join(
      stateDir,
      "deployments",
      projectId,
      environmentId,
    );
    const compiled =
      'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "9000:80"\n';

    const calls: string[][] = [];
    const fakeRunDocker = (
      args: string[],
    ): Promise<DockerCliResult> => {
      calls.push([...args]);
      if (args.includes("config") && args.includes("--format")) {
        return Promise.resolve({
          success: true,
          stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("config") && args.includes("-q")) {
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("ps")) {
        return Promise.resolve({
          success: true,
          stdout: "[]",
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };

    try {
      const result = await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeYaml: compiled,
          composeFiles: [
            {
              filename: "docker-compose.project.yml",
              role: "project",
              source: "inline",
              content:
                "services:\n  web:\n    image: nginx:alpine\n    environment:\n      FOO: '1'\n    ports:\n      - '80:80'\n",
            },
            {
              filename: "docker-compose.env.yml",
              role: "environment",
              source: "inline",
              content: 'services:\n  web:\n    ports:\n      - "9000:80"\n',
            },
          ],
          hostings: [],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      assertEquals(result.summary.includes(environmentId), true);
      const runtimePath = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
      const onDisk = await Deno.readTextFile(runtimePath);
      assertEquals(onDisk.includes("9000:80"), true);
      await assertRejects(
        () => Deno.stat(join(deploymentDir, "docker-compose.project.yml")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(deploymentDir, "docker-compose.env.yml")),
        Deno.errors.NotFound,
      );

      const configCall = calls.find((argv) =>
        argv.includes("config") && argv.includes("--format")
      );
      assertEquals(configCall !== undefined, true);
      assertEquals(argvStagePaths(configCall!).length, 1);
      const upCall = calls.find((argv) => argv.includes("up"));
      assertEquals(upCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(upCall!, [runtimePath]), true);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentDeploy writes .env and /run secret files without secret bytes in compose.yaml",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-secrets-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
      TURBOPANEL_RUN_DIR: Deno.env.get("TURBOPANEL_RUN_DIR"),
    };
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    const runDir = join(root, "run");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);
    Deno.env.set("TURBOPANEL_RUN_DIR", runDir);

    const environmentId = "envsecret1";
    const projectId = "proj-1";
    const projectName = "tp-demo-envsecret";
    const secretValue = "super-secret-value";
    const runtimeYaml = `secrets:
  web_token:
    file: /run/turbopanel/deployments/${projectId}/${environmentId}/secrets/web--TOKEN
services:
  web:
    image: nginx:alpine
    environment:
      PORT: \${web__PORT}
      TOKEN_FILE: /run/secrets/TOKEN
    secrets:
      - source: web_token
        target: TOKEN
`;

    const fakeRunDocker = (
      args: string[],
    ): Promise<DockerCliResult> => {
      if (args.includes("config") && args.includes("--format")) {
        return Promise.resolve({
          success: true,
          stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve({
        success: true,
        stdout: args.includes("ps") ? "[]" : "",
        stderr: "",
        code: 0,
      });
    };

    try {
      await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeYaml: runtimeYaml,
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: runtimeYaml,
          }],
          hostings: [],
          envFile: "web__PORT=3000\n",
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
        },
        new Date().toISOString(),
        {
          runDocker: fakeRunDocker,
          decryptSecrets: () => Promise.resolve([secretValue]),
          ...hermeticDeployDeps,
        },
      );

      const deploymentDir = join(
        stateDir,
        "deployments",
        projectId,
        environmentId,
      );
      const composeText = await Deno.readTextFile(
        join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      );
      const envText = await Deno.readTextFile(
        join(deploymentDir, COMPOSE_ENV_FILENAME),
      );
      const secretPath = join(
        runDir,
        "deployments",
        projectId,
        environmentId,
        "secrets",
        "web--TOKEN",
      );
      assertEquals(composeText.includes(secretValue), false);
      assertEquals(envText.includes(secretValue), false);
      assertEquals(envText.includes("web__PORT=3000"), true);
      assertEquals(composeText.includes(secretPath), true);
      assertEquals(await Deno.readTextFile(secretPath), secretValue);
      assertEquals((await Deno.stat(secretPath)).mode! & 0o777, 0o600);
      const manifest = JSON.parse(
        await Deno.readTextFile(
          join(deploymentDir, DEPLOYMENT_MANIFEST_FILENAME),
        ),
      ) as { secrets?: Array<{ relativePath: string }> };
      assertEquals(manifest.secrets?.[0]?.relativePath, "web--TOKEN");
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      if (previous.TURBOPANEL_RUN_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_RUN_DIR");
      } else {
        Deno.env.set("TURBOPANEL_RUN_DIR", previous.TURBOPANEL_RUN_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentDeploy ensures fabricNetworks before compose up and skips when empty",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-fabric-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);

    const environmentId = "envfabric1";
    const projectId = "proj-1";
    const projectName = "tp-demo-fabric";
    const deploymentDir = join(
      stateDir,
      "deployments",
      projectId,
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

    const runtimeYaml = "services:\n  web:\n    image: nginx:alpine\n";
    const fabricNetworks = [{
      name: "tpn_net1",
      subnet: "203.0.113.0/24",
      mtu: 1420,
      gateway: "203.0.113.1",
    }];
    const events: string[] = [];
    const ensureCalls: Array<{
      networks: Array<{
        name: string;
        subnet: string;
        mtu?: number;
        gateway?: string;
      }>;
      defaultMtu: number;
    }> = [];
    const fakeRunDocker = (
      args: string[],
    ): Promise<DockerCliResult> => {
      if (args.includes("up")) events.push("compose-up");
      if (args.includes("config") && args.includes("--format")) {
        return Promise.resolve({
          success: true,
          stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve({
        success: true,
        stdout: args.includes("ps") ? "[]" : "",
        stderr: "",
        code: 0,
      });
    };

    const basePayload = {
      environmentId,
      projectId,
      organizationId: "org-1",
      projectName,
      composeYaml: runtimeYaml,
      composeFiles: [{
        filename: RUNTIME_COMPOSE_FILENAME,
        role: "runtime" as const,
        source: "inline" as const,
        content: runtimeYaml,
      }],
      hostings: [] as [],
    };

    try {
      await handleEnvironmentDeploy(
        { ...basePayload, fabricNetworks },
        new Date().toISOString(),
        {
          runDocker: fakeRunDocker,
          ...hermeticDeployDeps,
          ensureFabricDockerNetworks: (networks, defaultMtu) => {
            events.push("ensure-fabric");
            ensureCalls.push({
              networks: [...networks],
              defaultMtu,
            });
            return Promise.resolve();
          },
        },
      );

      assertEquals(ensureCalls.length, 1);
      assertEquals(ensureCalls[0]?.networks, fabricNetworks);
      assertEquals(ensureCalls[0]?.defaultMtu, 1420);
      assertEquals(
        events.indexOf("ensure-fabric") < events.indexOf("compose-up"),
        true,
      );

      events.length = 0;
      ensureCalls.length = 0;
      await handleEnvironmentDeploy(
        basePayload,
        new Date().toISOString(),
        {
          runDocker: fakeRunDocker,
          ...hermeticDeployDeps,
          ensureFabricDockerNetworks: (networks, defaultMtu) => {
            events.push("ensure-fabric");
            ensureCalls.push({
              networks: [...networks],
              defaultMtu,
            });
            return Promise.resolve();
          },
        },
      );
      assertEquals(ensureCalls.length, 0);
      assertEquals(events.includes("ensure-fabric"), false);
      assertEquals(events.includes("compose-up"), true);

      events.length = 0;
      ensureCalls.length = 0;
      await handleEnvironmentDeploy(
        { ...basePayload, fabricNetworks: [] },
        new Date().toISOString(),
        {
          runDocker: fakeRunDocker,
          ...hermeticDeployDeps,
          ensureFabricDockerNetworks: (networks, defaultMtu) => {
            events.push("ensure-fabric");
            ensureCalls.push({
              networks: [...networks],
              defaultMtu,
            });
            return Promise.resolve();
          },
        },
      );
      assertEquals(ensureCalls.length, 0);
      assertEquals(events.includes("ensure-fabric"), false);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentDeploy returns collected containers when compose ps succeeds",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-ps-ok-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envpsok1";
    const projectId = "proj-1";
    const projectName = "tp-demo-psok";
    const deploymentDir = join(
      stateDir,
      "deployments",
      projectId,
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

    const runtimeYaml = "services:\n  web:\n    image: nginx:alpine\n";
    const psJson = JSON.stringify([
      { ID: "bad-row" },
      {
        ID: "abc123",
        Name: `${projectName}-web-1`,
        Service: "web",
        State: "running",
      },
    ]);
    const serviceId = "00000000-0000-4000-8000-0000000000ee";
    const ingressPsJson = JSON.stringify([{
      ID: "ingress123",
      Name: `${serviceId}-in`,
      Service: "traefik",
      State: "running",
    }]);
    const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
      if (args.includes("config") && args.includes("--format")) {
        return Promise.resolve({
          success: true,
          stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("config") && args.includes("-q")) {
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("ps")) {
        if (args.some((arg) => arg.startsWith("turbopanel-ingress-"))) {
          return Promise.resolve({
            success: true,
            stdout: ingressPsJson,
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: psJson,
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };

    try {
      const result = await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeYaml: runtimeYaml,
          hostings: [{
            hostingId: "h1",
            serviceId: "s1",
            composeServiceName: "web",
            hostnames: [],
            protocol: "tcp",
            ports: [{ published: 8080, target: 80 }],
          }],
          ingressServices: [{
            serviceId,
            composeServiceName: "web",
            containerName: `${serviceId}-in`,
          }],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );
      assertEquals(result.projectName, projectName);
      assertEquals(Array.isArray(result.containers), true);
      assertEquals(result.containers?.length, 2);
      assertEquals(result.containers?.[0]?.serviceId, "s1");
      assertEquals(result.containers?.[0]?.composeServiceName, "web");
      assertEquals(result.containers?.[0]?.containerId, "abc123");
      assertEquals(result.containers?.[1]?.role, "ingress");
      assertEquals(result.containers?.[1]?.serviceId, serviceId);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "handleEnvironmentDeploy omits containers when compose ps throws",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-deploy-ps-throw-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envpsthrow1";
    const projectId = "proj-1";
    const projectName = "tp-demo-psthrow";
    const deploymentDir = join(
      stateDir,
      "deployments",
      projectId,
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

    const runtimeYaml = "services:\n  web:\n    image: nginx:alpine\n";
    const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
      if (args.includes("config") && args.includes("--format")) {
        return Promise.resolve({
          success: true,
          stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("config") && args.includes("-q")) {
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      }
      if (args.includes("ps")) {
        throw new Error("compose ps exploded");
      }
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };

    try {
      const result = await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeYaml: runtimeYaml,
          hostings: [],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );
      assertEquals(result.projectName, projectName);
      assertEquals("containers" in result, false);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});
