import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  COMPOSE_MANIFEST_FILENAME,
  COMPOSE_STAGE_DIRNAME,
  DAEMON_COMPOSE_FILENAME,
  LEGACY_COMPOSE_FILENAME,
  resolveDeployedComposePaths,
  writeComposeFileManifest,
  writeComposeFileSecure,
} from "../../deploy/compose-files.ts";
import { handleEnvironmentLifecycle } from "./lifecycle-environment.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";
import {
  containerHostingsNeedSharedHttpIngress,
  handleEnvironmentDeploy,
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
    "handleEnvironmentDeploy multi-file chain writes layers, manifesto, daemon layer, and ordered -f argv",
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
    const projectName = "tp-demo-envdeploy";
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    // Stale layer from a prior deploy should be pruned after successful publish.
    await Deno.writeTextFile(
      join(deploymentDir, "docker-compose.old.yml"),
      "services: {}\n",
      { mode: 0o640 },
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
              filename: "docker-compose.env.yml",
              role: "environment",
              source: "inline",
              content: "services:\n  web:\n    environment:\n      E: '1'\n",
            },
          ],
          hostings: [],
          // Non-empty daemon fragment so the generated layer is last in the chain.
          managedNetworkServices: ["web"],
          noCache: true,
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      const projectLayer = join(deploymentDir, "docker-compose.project.yml");
      const envLayer = join(deploymentDir, "docker-compose.env.yml");
      const daemonLayer = join(deploymentDir, DAEMON_COMPOSE_FILENAME);
      const projectStat = await Deno.stat(projectLayer);
      assertEquals(projectStat.mode! & 0o777, 0o640);
      const daemonStat = await Deno.stat(daemonLayer);
      assertEquals(daemonStat.mode! & 0o777, 0o640);
      await assertRejects(
        () => Deno.stat(join(deploymentDir, "docker-compose.old.yml")),
        Deno.errors.NotFound,
      );
      // Staging directory must not linger after a successful deploy.
      await assertRejects(
        () => Deno.stat(join(deploymentDir, COMPOSE_STAGE_DIRNAME)),
        Deno.errors.NotFound,
      );

      const manifest = JSON.parse(
        await Deno.readTextFile(join(deploymentDir, COMPOSE_MANIFEST_FILENAME)),
      ) as { version: number; files: string[] };
      assertEquals(manifest.version, 1);
      assertEquals(manifest.files, [
        "docker-compose.project.yml",
        "docker-compose.env.yml",
        DAEMON_COMPOSE_FILENAME,
      ]);

      const fullChain = [projectLayer, envLayer, daemonLayer];
      // Pre-publish resolve/validate use the staged chain.
      const configJsonCall = calls.find((argv) =>
        argv.includes("config") && argv.includes("--format")
      );
      assertEquals(configJsonCall !== undefined, true);
      const stagedUserPaths = argvStagePaths(configJsonCall!);
      assertEquals(stagedUserPaths.length, 2);
      assertEquals(
        stagedUserPaths[0]!.endsWith("/docker-compose.project.yml"),
        true,
      );
      assertEquals(
        stagedUserPaths[1]!.endsWith("/docker-compose.env.yml"),
        true,
      );

      const configQCall = calls.find((argv) =>
        argv.includes("config") && argv.includes("-q")
      );
      assertEquals(configQCall !== undefined, true);
      const stagedFull = argvStagePaths(configQCall!);
      assertEquals(stagedFull.length, 3);
      assertEquals(
        stagedFull[2]!.endsWith(`/${DAEMON_COMPOSE_FILENAME}`),
        true,
      );

      const buildCall = calls.find((argv) =>
        argv.includes("build") && argv.includes("--no-cache") &&
        argv.includes("--pull")
      );
      assertEquals(buildCall !== undefined, true);
      // Post-publish build/up/ps use the live deployment paths.
      assertEquals(argvHasOrderedPaths(buildCall!, fullChain), true);

      const upCall = calls.find((argv) =>
        argv.includes("up") && argv.includes("--remove-orphans")
      );
      assertEquals(upCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(upCall!, fullChain), true);

      const psCall = calls.find((argv) => argv.includes("ps"));
      assertEquals(psCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(psCall!, fullChain), true);

      // network inspect for managed ingress must go through the fake seam.
      const networkInspect = calls.find((argv) =>
        argv[0] === "network" && argv[1] === "inspect"
      );
      assertEquals(networkInspect !== undefined, true);

      // Second deploy renames layers — prior env overlay must be pruned.
      calls.length = 0;
      await handleEnvironmentDeploy(
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
              filename: "docker-compose.staging.yml",
              role: "environment",
              source: "inline",
              content: "services:\n  web:\n    environment:\n      E: '2'\n",
            },
          ],
          hostings: [],
          managedNetworkServices: ["web"],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );
      await assertRejects(
        () => Deno.stat(envLayer),
        Deno.errors.NotFound,
      );
      await Deno.stat(join(deploymentDir, "docker-compose.staging.yml"));
      const secondManifest = JSON.parse(
        await Deno.readTextFile(join(deploymentDir, COMPOSE_MANIFEST_FILENAME)),
      ) as { files: string[] };
      assertEquals(secondManifest.files, [
        "docker-compose.project.yml",
        "docker-compose.staging.yml",
        DAEMON_COMPOSE_FILENAME,
      ]);
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
    "handleEnvironmentDeploy legacy composeYaml produces one-element user chain on disk",
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
    const projectName = "tp-demo-envlegacy";
    const deploymentDir = join(root, "state", "deployments", environmentId);

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
          projectId: "proj-1",
          organizationId: "org-1",
          projectName,
          composeYaml: "services:\n  web:\n    image: nginx:alpine\n",
          hostings: [],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      const legacyPath = join(deploymentDir, LEGACY_COMPOSE_FILENAME);
      await Deno.stat(legacyPath);
      const manifest = JSON.parse(
        await Deno.readTextFile(join(deploymentDir, COMPOSE_MANIFEST_FILENAME)),
      ) as { files: string[] };
      assertEquals(manifest.files, [LEGACY_COMPOSE_FILENAME]);

      const buildCall = calls.find((argv) =>
        argv.includes("build") && argv.includes("--no-cache")
      );
      assertEquals(buildCall, undefined);

      const upCall = calls.find((argv) => argv.includes("up"));
      assertEquals(upCall !== undefined, true);
      assertEquals(argvHasOrderedPaths(upCall!, [legacyPath]), true);
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
    "handleEnvironmentDeploy accepts composeFiles overlay with !reset / !override tags",
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
    const projectName = "tp-demo-envtags";
    const deploymentDir = join(stateDir, "deployments", environmentId);

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

    const envOverlay = `services:
  web:
    environment: !reset null
    ports: !override
      - "9000:80"
`;

    try {
      const result = await handleEnvironmentDeploy(
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
              content:
                "services:\n  web:\n    image: nginx:alpine\n    environment:\n      FOO: '1'\n    ports:\n      - '80:80'\n",
            },
            {
              filename: "docker-compose.env.yml",
              role: "environment",
              source: "inline",
              content: envOverlay,
            },
          ],
          hostings: [],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      // Local preflight must detect container services despite Compose tags.
      assertEquals(result.summary.includes(environmentId), true);
      await Deno.stat(join(deploymentDir, "docker-compose.project.yml"));
      await Deno.stat(join(deploymentDir, "docker-compose.env.yml"));
      const envOnDisk = await Deno.readTextFile(
        join(deploymentDir, "docker-compose.env.yml"),
      );
      assertEquals(envOnDisk.includes("!reset"), true);
      assertEquals(envOnDisk.includes("!override"), true);

      const configCall = calls.find((argv) =>
        argv.includes("config") && argv.includes("--format")
      );
      assertEquals(configCall !== undefined, true);
      // Must have taken the container path (config against staged multi-file chain).
      assertEquals(argvStagePaths(configCall!).length >= 2, true);
      const upCall = calls.find((argv) => argv.includes("up"));
      assertEquals(upCall !== undefined, true);
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
