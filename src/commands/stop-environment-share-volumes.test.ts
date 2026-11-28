import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { handleEnvironmentStop } from "./stop-environment.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";

const test = Deno.test.bind(Deno);

const PROJECT = "tp-demo-shares";
const SHARE_VOLUME = `${PROJECT}_media_abcdef012345`;

async function stopWith(
  removeDeploymentDir: boolean,
): Promise<string[][]> {
  const root = await Deno.makeTempDir({ prefix: "tp-stop-shares-" });
  const previous = {
    TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
    TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  };
  Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  const calls: string[][] = [];
  try {
    await handleEnvironmentStop(
      {
        environmentId: "envshare1",
        projectId: "proj-1",
        projectName: PROJECT,
        ...(removeDeploymentDir ? { removeDeploymentDir: true as const } : {}),
      },
      new Date().toISOString(),
      {
        runDocker: (args): Promise<DockerCliResult> => {
          calls.push([...args]);
          const stdout = args[0] === "volume" && args[1] === "ls"
            ? `${SHARE_VOLUME}\tmedia\n`
            : args[0] === "volume" && args[1] === "inspect"
            ? "cifs\n"
            : "";
          return Promise.resolve({
            success: true,
            stdout,
            stderr: "",
            code: 0,
          });
        },
      },
    );
    return calls;
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

const removals = (calls: string[][]) =>
  calls.filter((c) => c[0] === "volume" && c[1] === "rm");

test("a delete removes the project's share volume", async () => {
  assertEquals(removals(await stopWith(true)), [[
    "volume",
    "rm",
    SHARE_VOLUME,
  ]]);
});

test("a plain stop keeps the share volumes", async () => {
  const calls = await stopWith(false);
  assertEquals(removals(calls), []);
  assertEquals(calls.some((c) => c[0] === "volume" && c[1] === "ls"), false);
});
