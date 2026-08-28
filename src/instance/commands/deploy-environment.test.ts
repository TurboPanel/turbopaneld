import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  COMPOSE_ENV_FILENAME,
  COMPOSE_STAGE_DIRNAME,
  DEPLOYMENT_MANIFEST_FILENAME,
  resolveDeployedComposePaths,
  RUNTIME_COMPOSE_FILENAME,
} from "../../deploy/compose-files.ts";
import { handleEnvironmentLifecycle } from "./lifecycle-environment.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { readSystemComponentDescriptor } from "../../deploy/system-component.ts";
import {
  buildDeployServiceNames,
  buildDeploySummary,
  containerHostingsNeedSharedHttpIngress,
  handleEnvironmentDeploy,
  hostNativeComposeServiceNames,
  persistHostingIngressIdentity,
  resolveDeployComposeFiles,
  resolveHostNativeLanes,
  shapeEnvironmentDeployResult,
} from "./deploy-environment.ts";
import { applyNativeAppServices } from "../../deploy/native/apply-native-apps.ts";
import { nativeAppUnitPath } from "../../deploy/native/unit.ts";
import type { AppliedRelease } from "../../deploy/release/apply-source-releases.ts";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeployPayload,
} from "./contracts.ts";

/**
 * Shared hosting-ingress Docker network — the `hosting-ingress` system
 * component's allocated `serviceId`, required on the wire whenever a deploy
 * carries hostings. A bare UUID, not a readable literal.
 */
const HOSTING_INGRESS_NETWORK = "00000000-0000-4000-8000-0000000000bb";

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

test("persistHostingIngressIdentity writes hosting-ingress.json", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    const serviceId = "00000000-0000-4000-8000-0000000000aa";
    await persistHostingIngressIdentity(layout, {
      serviceId,
      composeServiceName: "traefik",
      containerName: `${serviceId}-in`,
    });
    const loaded = await readSystemComponentDescriptor(
      layout,
      "hosting-ingress",
    );
    assertEquals(loaded?.serviceId, serviceId);
    assertEquals(loaded?.composeServiceName, "traefik");
    assertEquals(loaded?.containerName, `${serviceId}-in`);
    assertEquals(loaded?.role, "ingress");
  } finally {
    await fixture.cleanup();
  }
});

test("persistHostingIngressIdentity no-ops when identity is omitted", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    await persistHostingIngressIdentity(layout);
    const loaded = await readSystemComponentDescriptor(
      layout,
      "hosting-ingress",
    );
    assertEquals(loaded, null);
  } finally {
    await fixture.cleanup();
  }
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
          composeFiles: [{
            filename: "compose.yaml",
            role: "runtime",
            content: "services: {}\n",
          }],
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
          composeFiles: [{
            filename: "compose.yaml",
            role: "runtime",
            content: "services: {}\n",
          }],
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
          composeFiles: [{
            filename: "compose.yaml",
            role: "runtime",
            content: "services: {}\n",
          }],
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
    sites: [],
    containers: [],
  });

  assertEquals(result, {
    projectName: "demo",
    summary: "Deployed 0 container service(s) for environment env-1",
    containers: [],
  });
  assertEquals("services" in result, false);
});

test("resolveDeployComposeFiles returns payload composeFiles", () => {
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
      composeFiles: files,
      hostings: [],
    }),
    files,
  );
});

test("buildDeploySummary and buildDeployServiceNames include sites", () => {
  const sites = [{
    composeServiceName: "static",
    engine: "nginx" as const,
    root: "/var/www/html",
    listenPort: 8080,
  }];
  assertEquals(
    buildDeploySummary("env-2", ["web"], sites),
    "Deployed 1 container service(s) + 1 site(s) for environment env-2",
  );
  assertEquals(
    buildDeployServiceNames(["web"], sites),
    ["static", "web"],
  );
});

test("shapeEnvironmentDeployResult omits containers when collection failed", () => {
  const result = shapeEnvironmentDeployResult({
    projectName: "demo",
    environmentId: "env-3",
    labeledServices: ["web"],
    sites: [],
    containers: null,
  });
  assertEquals(
    result.summary,
    "Deployed 1 container service(s) for environment env-3",
  );
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
            composeFiles: [{
              filename: "compose.yaml",
              role: "runtime",
              content: "services:\n  web:\n    image: nginx\n",
            }],
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
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: runtimeYaml,
          }],
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
          managedNetwork: "00000000-0000-4000-8000-0000000000ee",
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
      assertEquals(
        published.includes("00000000-0000-4000-8000-0000000000ee"),
        true,
      );
      await assertRejects(
        () => Deno.stat(join(deploymentDir, "docker-compose.old.yml")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(deploymentDir, COMPOSE_STAGE_DIRNAME)),
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
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: runtimeYaml,
          }],
          hostings: [],
          managedNetworkServices: ["web"],
          managedNetwork: "00000000-0000-4000-8000-0000000000ee",
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
    "handleEnvironmentDeploy composeFiles payload writes compose.yaml + deployment.json",
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
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: "services:\n  web:\n    image: nginx:alpine\n",
          }],
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
    "failed redeploy leaves prior compose.yaml resolvable for lifecycle/stop",
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
    const projectId = "proj-1";
    const projectName = "tp-demo-envtxfail";
    const deploymentDir = join(
      stateDir,
      "deployments",
      projectId,
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

    const priorContent =
      "services:\n  web:\n    image: nginx:alpine\n    environment:\n      E: prior\n";
    const priorPath = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
    await Deno.writeTextFile(priorPath, priorContent, { mode: 0o640 });

    const failingRunDocker = (
      _args: string[],
    ): Promise<DockerCliResult> => {
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
              projectId,
              organizationId: "org-1",
              projectName,
              composeFiles: [{
                filename: RUNTIME_COMPOSE_FILENAME,
                role: "runtime",
                source: "inline",
                content:
                  "services:\n  web:\n    image: nginx:alpine\n    environment:\n      E: '2'\n",
              }],
              hostings: [],
              managedNetworkServices: ["web"],
              managedNetwork: "00000000-0000-4000-8000-0000000000ee",
            },
            new Date().toISOString(),
            { runDocker: failingRunDocker, ...hermeticDeployDeps },
          ),
        Error,
        "forced resolveComposeModel failure",
      );

      assertEquals(await Deno.readTextFile(priorPath), priorContent);
      await assertRejects(
        () => Deno.stat(join(deploymentDir, COMPOSE_STAGE_DIRNAME)),
        Deno.errors.NotFound,
      );

      const resolved = await resolveDeployedComposePaths(deploymentDir);
      assertEquals(resolved, [priorPath]);

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
          projectId,
          projectName,
          action: "restart",
        },
        new Date().toISOString(),
        { runDocker: lifeRun },
      );
      const restartCall = lifeCalls.find((argv) => argv.includes("restart"));
      assertEquals(restartCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(restartCall!, [priorPath]), true);

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
          projectId,
          projectName,
        },
        new Date().toISOString(),
        { runDocker: stopRun },
      );
      const downCall = stopCalls.find((argv) => argv.includes("down"));
      assertEquals(downCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(downCall!, [priorPath]), true);
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
    "handleEnvironmentDeploy publishes runtime compose.yaml from composeFiles snapshot",
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
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: compiled,
          }],
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
    const dockerCalls: string[][] = [];
    const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
      dockerCalls.push([...args]);
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
        if (args.some((arg) => arg.includes("/ingress/services/"))) {
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
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: runtimeYaml,
          }],
          hostings: [{
            hostingId: "h1",
            serviceId: "s1",
            composeServiceName: "web",
            hostnames: [],
            protocol: "tcp",
            ports: [{ published: 8080, target: 80 }],
          }],
          hostingIngressNetwork: HOSTING_INGRESS_NETWORK,
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
      // Per-service Traefik must go through the injected seam — an unthreaded
      // `runDocker` here starts a real ingress container on the test host.
      assertEquals(
        dockerCalls.some((args) =>
          // The per-service Traefik project is the bare serviceId.
          args.includes("up") && args.includes(serviceId)
        ),
        true,
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
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: runtimeYaml,
          }],
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

// ---------------------------------------------------------------------------
// Whole-tree reclaim: a service that had a release tree and then lost its
// source must not leave `<principalHome>/sites/<serviceId>` behind. Per-release
// retention only walks services the deploy is still publishing, so the previous
// `deployment.json` is the only record that still names the removed one.
// ---------------------------------------------------------------------------

/** Env keys the reclaim path reads, restored by {@link withReclaimEnv}. */
const RECLAIM_ENV_KEYS = [
  "TURBOPANEL_STATE_DIR",
  "TURBOPANEL_CONFIG_DIR",
  "TURBOPANEL_PRINCIPAL_HOME_ROOT",
] as const;

async function withReclaimEnv(
  fn: (dirs: { stateDir: string; principalHomeRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-reclaim-" });
  const previous = new Map(
    RECLAIM_ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  const stateDir = join(root, "state");
  const principalHomeRoot = join(root, "srv", "users");
  Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  Deno.env.set("TURBOPANEL_PRINCIPAL_HOME_ROOT", principalHomeRoot);
  try {
    await fn({ stateDir, principalHomeRoot });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
}

/** The `deployment.json` a previous release-backed deploy would have left. */
async function seedPreviousReleaseManifest(
  deploymentDir: string,
  releases: unknown[],
): Promise<void> {
  await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
  await Deno.writeTextFile(
    join(deploymentDir, DEPLOYMENT_MANIFEST_FILENAME),
    JSON.stringify({
      version: 2,
      projectId: "proj-1",
      environmentId: "envreclaim1",
      serverId: "srv-1",
      generation: 1,
      projectName: "tp-demo-reclaim",
      composeSha256: "a".repeat(64),
      services: {},
      releases,
    }),
    { mode: 0o640 },
  );
}

function captureSudo(): {
  runPrivileged: (
    command: string,
    args: string[],
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    runPrivileged: (command, args) => {
      calls.push({ command, args: [...args] });
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  };
}

/** Enough of the compose CLI for a one-service deploy that never starts it. */
const fakeReclaimRunDocker = (args: string[]): Promise<DockerCliResult> => {
  if (args.includes("config") && args.includes("--format")) {
    return Promise.resolve({
      success: true,
      stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
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
  return Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });
};

const RECLAIM_RELEASE_ROW = {
  composeServiceName: "web",
  serviceId: "svc-gone",
  releaseId: "rel-1",
  sourceId: "src-1",
  commitSha: "a".repeat(40),
  username: "appuser",
};

test({
  name:
    "handleEnvironmentDeploy reclaims the release tree of a service removed from the compose",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withReclaimEnv(async ({ stateDir, principalHomeRoot }) => {
      const environmentId = "envreclaim1";
      const deploymentDir = join(
        stateDir,
        "deployments",
        "proj-1",
        environmentId,
      );
      await seedPreviousReleaseManifest(deploymentDir, [RECLAIM_RELEASE_ROW]);
      const sudo = captureSudo();

      // The redeploy carries no `sourceMaterial[]` at all — the service is gone
      // from the compose, so nothing in the payload names its tree.
      await handleEnvironmentDeploy(
        {
          environmentId,
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "tp-demo-reclaim",
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            source: "inline",
            content: "services:\n  web:\n    image: nginx:alpine\n",
          }],
          hostings: [],
        },
        new Date().toISOString(),
        {
          ...hermeticDeployDeps,
          runDocker: fakeReclaimRunDocker,
          runPrivileged: sudo.runPrivileged,
        },
      );

      assertEquals(sudo.calls, [{
        command: "sudo",
        args: [
          "-n",
          "rm",
          "-rf",
          "--",
          join(principalHomeRoot, "appuser", "sites", "svc-gone"),
        ],
      }]);
    });
  },
});

// The "still sourced → tree kept" side is covered without a real clone in
// `src/deploy/release/retention-reclaim.test.ts` (`releaseTreesToReclaim`),
// which is the selection rule this handler delegates to.

// ---------------------------------------------------------------------------
// Mixed lanes: an environment can carry Docker services, sites,
// and native apps at once. Only the Docker ones may reach a container-only
// path — a hosting for a host-native service has no compose service to hang a
// Traefik label on, and passing it to the overlay builder used to abort the
// deploy before a single app started.
// ---------------------------------------------------------------------------

const MIXED_ENVIRONMENT_ID = "envmixed1";

/** Payload with one container service and one *hosted* native Node app. */
function mixedLanePayload(): EnvironmentDeployPayload {
  return {
    environmentId: MIXED_ENVIRONMENT_ID,
    projectId: "proj-mixed",
    organizationId: "org-1",
    projectName: "tp-demo-mixed",
    composeFiles: [{
      filename: RUNTIME_COMPOSE_FILENAME,
      role: "runtime",
      source: "inline",
      // `web` is a native app: the instance already stripped it from the
      // runtime compose, so only `api` is a compose service here.
      content: "services:\n  api:\n    image: nginx:alpine\n",
    }],
    hostings: [
      {
        hostingId: "11111111-1111-4111-8111-111111111111",
        serviceId: "22222222-2222-4222-8222-222222222222",
        composeServiceName: "api",
        // A raw-port hosting: per-service Traefik covers it, so the container
        // side alone never needs the shared HTTP proxy. The *only* thing that
        // could pull the shared proxy into this deploy is the native app's
        // hosting leaking into `containerHostings`.
        hostnames: [],
        protocol: "tcp",
        ports: [{ published: 15432, target: 5432 }],
      },
      {
        hostingId: "33333333-3333-4333-8333-333333333333",
        serviceId: "44444444-4444-4444-8444-444444444444",
        composeServiceName: "web",
        hostnames: ["web.example.test"],
      },
    ],
    hostingIngressNetwork: HOSTING_INGRESS_NETWORK,
    nativeAppServices: [{
      composeServiceName: "web",
      serviceId: "svcweb",
      listenPort: 18300,
      framework: "next",
    }],
  } as unknown as EnvironmentDeployPayload;
}

test("hostNativeComposeServiceNames covers both host-native lanes", () => {
  const names = hostNativeComposeServiceNames({
    ...mixedLanePayload(),
    sites: [{
      composeServiceName: "legacy",
      engine: "nginx",
      root: "public",
      listenPort: 18400,
    }],
  } as unknown as EnvironmentDeployPayload);
  assertEquals([...names].sort((a, b) => a.localeCompare(b)), [
    "legacy",
    "web",
  ]);
});

test({
  name:
    "handleEnvironmentDeploy deploys a container service alongside a hosted native app",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withReclaimEnv(async ({ stateDir }) => {
      const composeArgv: string[][] = [];
      const runDocker = (args: string[]): Promise<DockerCliResult> => {
        composeArgv.push([...args]);
        if (args.includes("config") && args.includes("--format")) {
          // Only `api` resolves — `web` is not a compose service at all, which
          // is exactly why it must never reach the label overlay.
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ api: { image: "nginx:alpine" } }),
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

      const result = await handleEnvironmentDeploy(
        mixedLanePayload(),
        new Date().toISOString(),
        {
          ...hermeticDeployDeps,
          runDocker,
          runPrivileged: captureSudo().runPrivileged,
          // Host-free native apply: no systemd, no ansible-playbook.
          nativeAppIo: {
            run: () =>
              Promise.resolve({ success: true, stdout: "", stderr: "" }),
            runPlaybook: () => Promise.resolve(),
            probe: () => Promise.resolve(true),
            sleep: () => Promise.resolve(),
            systemdUnitDir: join(stateDir, "systemd"),
          },
        },
      );

      // The deploy completed instead of aborting on "Compose service not found".
      assertEquals(result.projectName, "tp-demo-mixed");
      assertEquals(result.services, ["api"]);

      // The published overlay labels only the container service.
      const composePath = join(
        stateDir,
        "deployments",
        "proj-mixed",
        MIXED_ENVIRONMENT_ID,
        RUNTIME_COMPOSE_FILENAME,
      );
      const compose = await Deno.readTextFile(composePath);
      assertEquals(compose.includes("traefik.enable"), true);
      // No router was generated for the native app's hostname.
      assertEquals(compose.includes("web.example.test"), false);

      // Hosting Caddy is what actually routes the native app, and it was
      // rewritten with the app's loopback port rather than a Traefik upstream.
      const caddySite = await Deno.readTextFile(
        join(
          Deno.env.get("TURBOPANEL_CONFIG_DIR")!,
          "hosting",
          "sites",
          `${MIXED_ENVIRONMENT_ID}.caddy`,
        ),
      );
      assertEquals(caddySite.includes("127.0.0.1:18300"), true);
    });
  },
});

// ---------------------------------------------------------------------------
// A `next export` build has no server process, so it leaves the native lane
// entirely rather than being supervised by a unit that could never come up.
// ---------------------------------------------------------------------------

const EXPORTED_APP: EnvironmentDeployNativeAppService = {
  composeServiceName: "web",
  serviceId: "svcweb",
  listenPort: 18300,
  framework: "next",
};

function exportedPayload(): EnvironmentDeployPayload {
  return {
    ...mixedLanePayload(),
    sourceMaterial: [{
      sourceId: "src-1",
      composeServiceName: "web",
      provider: "github",
      cloneUrl: "https://example.test/repo.git",
      ref: "main",
      commitSha: "a".repeat(40),
      releaseId: "rel-1",
      principal: { principalId: "pr-1", username: "appuser" },
      build: { kind: "native" },
    }],
  } as unknown as EnvironmentDeployPayload;
}

function appliedRelease(overrides: Partial<AppliedRelease>): AppliedRelease {
  return {
    composeServiceName: "web",
    serviceId: "svcweb",
    releaseId: "rel-1",
    commitSha: "a".repeat(40),
    releaseDir: "/tmp/rel-1",
    previousReleaseId: null,
    standaloneOutput: false,
    staticExport: false,
    ...overrides,
  };
}

test("a statically exported build moves to the site static lane", () => {
  const lanes = resolveHostNativeLanes(exportedPayload(), [
    appliedRelease({ staticExport: true }),
  ]);

  // Nothing is left on the native lane, so no unit can be generated for it.
  assertEquals(lanes.nativeAppServices, []);
  assertEquals(lanes.sites, [{
    composeServiceName: "web",
    // Static files and no PHP: Caddy needs no FPM socket and no vhost tuning.
    engine: "caddy",
    // The export tree *is* the release root (`out/` was published as it).
    root: ".",
    listenPort: EXPORTED_APP.listenPort,
    principal: { principalId: "pr-1", username: "appuser" },
  }]);
});

test("a server build stays on the native lane", () => {
  const lanes = resolveHostNativeLanes(exportedPayload(), [
    appliedRelease({ standaloneOutput: true }),
  ]);
  assertEquals(lanes.nativeAppServices, [EXPORTED_APP]);
  assertEquals(lanes.sites, []);
});

test({
  name: "no systemd unit is generated for an exported Next.js app",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const fixture = await createTempLayout();
    const unitDir = await Deno.makeTempDir({ prefix: "tp-export-units-" });
    try {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const lanes = resolveHostNativeLanes(exportedPayload(), [
        appliedRelease({ staticExport: true }),
      ]);

      const result = await applyNativeAppServices(
        layout,
        MIXED_ENVIRONMENT_ID,
        lanes.nativeAppServices,
        {
          bindings: new Map([[
            "web",
            { username: "appuser", previousReleaseId: null },
          ]]),
          run: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
          runPlaybook: () => Promise.resolve(),
          probe: () => Promise.resolve(true),
          sleep: () => Promise.resolve(),
          systemdUnitDir: unitDir,
        },
      );

      assertEquals(result.applied, []);
      await assertRejects(
        () => Deno.stat(nativeAppUnitPath(EXPORTED_APP.serviceId, unitDir)),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(unitDir, { recursive: true });
      await fixture.cleanup();
    }
  },
});
