import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
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
    const fakeRunDocker = async (
      args: string[],
    ): Promise<DockerCliResult> => {
      calls.push([...args]);
      if (args.includes("ps")) {
        return {
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
        };
      }
      return { success: true, stdout: "", stderr: "", code: 0 };
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
