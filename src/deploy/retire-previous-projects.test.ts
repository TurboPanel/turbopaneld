import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  RUNTIME_COMPOSE_FILENAME,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "./compose-files.ts";
import type { DockerCliResult } from "./docker-cli.ts";
import {
  readPreviousProjects,
  retirePreviousProjects,
} from "./retire-previous-projects.ts";

const test = Deno.test.bind(Deno);

const ok: DockerCliResult = { success: true, code: 0, stdout: "", stderr: "" };
const previous = { names: ["proj-1"], composePaths: ["/d/compose.yaml"] };

function recorder(result: DockerCliResult = ok) {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      return Promise.resolve(result);
    },
  };
}

test("retirePreviousProjects takes down an earlier-named project, keeps volumes", async () => {
  const r = recorder();
  const retired = await retirePreviousProjects(previous, "env-1", r.run);
  assertEquals(retired, ["proj-1"]);
  assertEquals(r.calls, [[
    "compose",
    "-p",
    "proj-1",
    "-f",
    "/d/compose.yaml",
    "down",
    "--remove-orphans",
  ]]);
});

test("retirePreviousProjects leaves the current project alone by default", async () => {
  const r = recorder();
  assertEquals(await retirePreviousProjects(previous, "proj-1", r.run), []);
  assertEquals(r.calls.length, 0);
});

test("retirePreviousProjects includeCurrent clears the current project (zero services)", async () => {
  const r = recorder();
  const retired = await retirePreviousProjects(previous, "proj-1", r.run, {
    includeCurrent: true,
  });
  assertEquals(retired, ["proj-1"]);
});

test("retirePreviousProjects does nothing without a previous deployment", async () => {
  const r = recorder();
  assertEquals(await retirePreviousProjects(null, "env-1", r.run), []);
  assertEquals(r.calls.length, 0);
});

test("retirePreviousProjects surfaces a failed down", async () => {
  const r = recorder({ success: false, code: 1, stdout: "", stderr: "boom\n" });
  await assertRejects(
    () => retirePreviousProjects(previous, "env-1", r.run),
    Error,
    "proj-1",
  );
});

test("readPreviousProjects reads the live manifest and compose chain", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readPreviousProjects(dir), null);
    await writeComposeFileSecure(
      join(dir, RUNTIME_COMPOSE_FILENAME),
      "services: {}\n",
    );
    await writeDeploymentManifest(dir, {
      version: 2,
      projectId: "p",
      environmentId: "e",
      serverId: "s",
      generation: 1,
      projectName: "p",
      composeSha256: "a".repeat(64),
      services: { web: { replicas: 1 } },
    });
    const prev = await readPreviousProjects(dir);
    assertEquals(prev?.names, ["p"]);
    assertEquals(prev?.composePaths, [join(dir, RUNTIME_COMPOSE_FILENAME)]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
