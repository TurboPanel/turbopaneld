import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  COMPOSE_MANIFEST_FILENAME,
  DAEMON_COMPOSE_FILENAME,
  LEGACY_COMPOSE_FILENAME,
} from "../../deploy/compose-files.ts";
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
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    const composePath = join(deploymentDir, "docker-compose.yml");
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
    "handleEnvironmentLifecycle replays manifest multi-file chain for start|stop|restart and ps",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-manifest-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envlife02";
    const projectName = "tp-demo-envlife2";
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    const projectPath = join(deploymentDir, "docker-compose.project.yml");
    const envPath = join(deploymentDir, "docker-compose.env.yml");
    const daemonPath = join(deploymentDir, DAEMON_COMPOSE_FILENAME);
    await Deno.writeTextFile(projectPath, "services:\n  web: {}\n");
    await Deno.writeTextFile(envPath, "services:\n  web: {}\n");
    await Deno.writeTextFile(daemonPath, "services:\n  web: {}\n");
    await Deno.writeTextFile(
      join(deploymentDir, COMPOSE_MANIFEST_FILENAME),
      JSON.stringify({
        version: 1,
        files: [
          "docker-compose.project.yml",
          "docker-compose.env.yml",
          DAEMON_COMPOSE_FILENAME,
        ],
      }),
    );

    const expected = [projectPath, envPath, daemonPath];
    const calls: string[][] = [];
    const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
      calls.push([...args]);
      return Promise.resolve({
        success: true,
        stdout: args.includes("ps") ? "[]" : "",
        stderr: "",
        code: 0,
      });
    };

    try {
      for (const action of ["start", "stop", "restart"] as const) {
        calls.length = 0;
        await handleEnvironmentLifecycle(
          {
            environmentId,
            projectId: "proj-1",
            projectName,
            action,
          },
          new Date().toISOString(),
          { runDocker: fakeRunDocker },
        );
        const actionCall = calls.find((argv) => argv.includes(action));
        assertEquals(actionCall !== undefined, true);
        assertEquals(pathsInOrder(actionCall!, expected), true);
        const psCall = calls.find((argv) => argv.includes("ps"));
        assertEquals(psCall !== undefined, true);
        assertEquals(pathsInOrder(psCall!, expected), true);
        assertEquals(psCall!.includes("-a"), true);
      }
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
    "handleEnvironmentLifecycle legacy fallback uses only docker-compose.yml",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-legacy-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    const environmentId = "envlife03";
    const projectName = "tp-demo-envlife3";
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    const legacy = join(deploymentDir, LEGACY_COMPOSE_FILENAME);
    await Deno.writeTextFile(legacy, "services: {}\n");

    const calls: string[][] = [];
    try {
      await handleEnvironmentLifecycle(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
          action: "restart",
        },
        new Date().toISOString(),
        {
          runDocker: (args) => {
            calls.push([...args]);
            return Promise.resolve({
              success: true,
              stdout: args.includes("ps") ? "[]" : "",
              stderr: "",
              code: 0,
            });
          },
        },
      );
      const actionCall = calls.find((argv) => argv.includes("restart"));
      assertEquals(pathsInOrder(actionCall!, [legacy]), true);
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
    "handleEnvironmentLifecycle refuses corrupt or incomplete manifest even when docker-compose.yml exists (no partial chain)",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-corrupt-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    const environmentId = "envlife04";
    const projectName = "tp-demo-envlife4";
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, LEGACY_COMPOSE_FILENAME),
      "services:\n  web: {}\n",
    );

    const calls: string[][] = [];
    const runDocker = (args: string[]): Promise<DockerCliResult> => {
      calls.push([...args]);
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };
    const payload = {
      environmentId,
      projectId: "proj-1",
      projectName,
      action: "restart" as const,
    };

    try {
      await Deno.writeTextFile(
        join(deploymentDir, COMPOSE_MANIFEST_FILENAME),
        "{not-json",
      );
      await assertRejects(
        () =>
          handleEnvironmentLifecycle(
            payload,
            new Date().toISOString(),
            { runDocker },
          ),
        Error,
        "compose-files.json",
      );

      await Deno.writeTextFile(
        join(deploymentDir, COMPOSE_MANIFEST_FILENAME),
        JSON.stringify({
          version: 1,
          files: ["docker-compose.project.yml", "docker-compose.env.yml"],
        }),
      );
      await assertRejects(
        () =>
          handleEnvironmentLifecycle(
            payload,
            new Date().toISOString(),
            { runDocker },
          ),
        Error,
        "missing layer file",
      );
      assertEquals(calls.length, 0);
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

function pathsInOrder(argv: string[], paths: string[]): boolean {
  let index = 0;
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "-f" && argv[i + 1] === paths[index]) {
      index += 1;
      if (index === paths.length) return true;
    }
  }
  return false;
}
