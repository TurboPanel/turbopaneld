import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  RUNTIME_COMPOSE_FILENAME,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "../../deploy/compose-files.ts";
import {
  cleanupStaleTcpUdpServiceIngress,
  serviceIngressDir,
  syncTcpUdpIngressEntries,
} from "../../deploy/ingress.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { handleEnvironmentLifecycle } from "./lifecycle-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "handleEnvironmentLifecycle rejects when compose file is missing",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-env-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    try {
      await assertRejects(
        () =>
          handleEnvironmentLifecycle(
            {
              environmentId: "envtest01",
              projectId: "proj-1",
              projectName: "tp-demo-envtest0",
              action: "stop",
            },
            new Date().toISOString(),
          ),
        Error,
        "is not deployed on this server yet — deploy it first",
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
  name:
    "handleEnvironmentLifecycle runs compose action without down/volumes and keeps deployment dir",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-run-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);

    const environmentId = "envlife01";
    const projectName = "tp-demo-envlife0";
    const deploymentDir = join(stateDir, "deployments", "proj-1", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    const composePath = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
    await Deno.writeTextFile(composePath, "services: {}\n", { mode: 0o640 });

    const calls: string[][] = [];
    const fakeRunDocker = (
      args: string[],
    ): Promise<DockerCliResult> => {
      calls.push([...args]);
      if (args.includes("ps")) {
        return Promise.resolve({
          success: true,
          stdout: JSON.stringify([
            {
              ID: "cid-1",
              Name: "proj-web-1",
              Service: "web",
              State: "exited",
            },
          ]),
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
      const result = await handleEnvironmentLifecycle(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
          action: "stop",
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker },
      );

      assertEquals(result.projectName, projectName);
      assertEquals(result.containers?.[0]?.status, "exited");

      const actionCall = calls.find((argv) => argv.includes("stop"));
      assertEquals(actionCall !== undefined, true);
      assertEquals(actionCall!.includes("-p"), true);
      assertEquals(actionCall!.includes(projectName), true);
      assertEquals(actionCall!.includes("-f"), true);
      assertEquals(actionCall!.includes(composePath), true);
      assertEquals(actionCall!.includes("down"), false);
      assertEquals(actionCall!.includes("--volumes"), false);

      const psCall = calls.find((argv) => argv.includes("ps"));
      assertEquals(psCall !== undefined, true);
      assertEquals(psCall!.includes("-a"), true);

      const stat = await Deno.stat(deploymentDir);
      assertEquals(stat.isDirectory, true);
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
    "handleEnvironmentLifecycle start fails when planned secret files are missing",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-life-secrets-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
      TURBOPANEL_RUN_DIR: Deno.env.get("TURBOPANEL_RUN_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    Deno.env.set("TURBOPANEL_RUN_DIR", join(root, "run"));

    const environmentId = "envlife02";
    const projectId = "proj-1";
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
      generation: 1,
      projectName: "tp-demo-envlife2",
      composeSha256: "b".repeat(64),
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

    try {
      await assertRejects(
        () =>
          handleEnvironmentLifecycle(
            {
              environmentId,
              projectId,
              projectName: "tp-demo-envlife2",
              action: "start",
            },
            new Date().toISOString(),
            {
              runDocker: () =>
                Promise.resolve({
                  success: true,
                  stdout: "[]",
                  stderr: "",
                  code: 0,
                }),
            },
          ),
        Error,
        "secret files missing",
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
  name: "handleEnvironmentLifecycle rejects unsafe identifiers",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await assertRejects(
      () =>
        handleEnvironmentLifecycle(
          {
            environmentId: "../escape",
            projectId: "proj-1",
            projectName: "tp-demo-envlife0",
            action: "stop",
          },
          new Date().toISOString(),
        ),
      Error,
      "environmentId contains unsupported characters",
    );
    await assertRejects(
      () =>
        handleEnvironmentLifecycle(
          {
            environmentId: "envlife05",
            projectId: "proj-1",
            projectName: "INVALID",
            action: "stop",
          },
          new Date().toISOString(),
        ),
      Error,
      "projectName must be a valid Docker Compose project name",
    );
  },
});

test({
  name: "handleEnvironmentLifecycle surfaces compose action failures",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-fail-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envlife06";
    const projectName = "tp-demo-envlife6";
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
              action: "start",
            },
            new Date().toISOString(),
            {
              runDocker: () =>
                Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "compose start failed",
                  code: 1,
                }),
            },
          ),
        Error,
        "compose start failed",
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
  name: "handleEnvironmentLifecycle omits containers when compose ps fails",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-ps-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envlife07";
    const projectName = "tp-demo-envlife7";
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
              return Promise.resolve({
                success: false,
                stdout: "",
                stderr: "ps failed",
                code: 1,
              });
            }
            return Promise.resolve({
              success: true,
              stdout: "",
              stderr: "",
              code: 0,
            });
          },
        },
      );
      assertEquals(result.containers, undefined);
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
    "handleEnvironmentLifecycle logs ingress compose failures without failing",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-ing-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);

    const environmentId = "envlife08";
    const projectName = "tp-demo-envlife8";
    const serviceId = "00000000-0000-4000-8000-0000000000ee";
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
    await syncTcpUdpIngressEntries(layout, serviceId, [
      { hostingId: "h-tcp", protocol: "tcp", publishedPort: 15433 },
    ]);
    const ingressDir = serviceIngressDir(layout, serviceId);
    await Deno.mkdir(ingressDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(ingressDir, "docker-compose.yml"),
      "services: {}\n",
      { mode: 0o640 },
    );
    await cleanupStaleTcpUdpServiceIngress(
      layout,
      environmentId,
      new Set([serviceId]),
      new Set([serviceId]),
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
            const ingressProject = `turbopanel-ingress-${serviceId}`;
            if (args.includes(ingressProject) && args.includes("stop")) {
              return Promise.resolve({
                success: false,
                stdout: "",
                stderr: "ingress stop failed",
                code: 1,
              });
            }
            return Promise.resolve({
              success: true,
              stdout: args.includes("ps") ? "[]" : "",
              stderr: "",
              code: 0,
            });
          },
        },
      );
      assertEquals(result.projectName, projectName);
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
