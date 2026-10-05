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

const ok = (stdout = ""): DockerCliResult => ({
  success: true,
  code: 0,
  stdout,
  stderr: "",
});
const previous = { names: ["proj-1"] };
const scope = { environmentId: "env-1", deploymentDir: "/d/proj-1/env-1" };

/** Two environments share project `proj-1` on the host. */
const rows = [
  "a1\tenv-1\t/d/proj-1/env-1",
  "a2\t\t/d/proj-1/env-1",
  "b1\tenv-2\t/d/proj-1/env-2",
  "b2\t\t/d/proj-1/env-2",
].join("\n");

function recorder(psResult: DockerCliResult = ok(rows), rmOk = true) {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      if (args[0] === "ps") return Promise.resolve(psResult);
      return Promise.resolve(
        rmOk ? ok() : { success: false, code: 1, stdout: "", stderr: "x" },
      );
    },
  };
}

test("retirePreviousProjects removes only this environment's containers; a sibling's survive", async () => {
  const r = recorder();
  const retired = await retirePreviousProjects(
    previous,
    "env-1",
    r.run,
    scope,
  );
  assertEquals(retired, ["proj-1"]);
  assertEquals(r.calls[1], ["rm", "-f", "a1", "a2"]);
  assertEquals(r.calls.flat().some((a) => a === "b1" || a === "b2"), false);
});

test("retirePreviousProjects leaves the current project alone by default", async () => {
  const r = recorder();
  assertEquals(
    await retirePreviousProjects(previous, "proj-1", r.run, scope),
    [],
  );
  assertEquals(r.calls.length, 0);
});

test("retirePreviousProjects includeCurrent clears the current project (zero services)", async () => {
  const r = recorder();
  const retired = await retirePreviousProjects(previous, "proj-1", r.run, {
    ...scope,
    includeCurrent: true,
  });
  assertEquals(retired, ["proj-1"]);
});

test("retirePreviousProjects does nothing without a previous deployment or without own containers", async () => {
  const r = recorder(ok("b1\tenv-2\t/d/proj-1/env-2"));
  assertEquals(await retirePreviousProjects(null, "env-1", r.run, scope), []);
  assertEquals(
    await retirePreviousProjects(previous, "env-1", r.run, scope),
    [],
  );
  assertEquals(r.calls.filter((c) => c[0] === "rm").length, 0);
});

test("retirePreviousProjects explains a failed listing or removal in plain words", async () => {
  const bad = recorder({ success: false, code: 1, stdout: "", stderr: "x" });
  await assertRejects(
    () => retirePreviousProjects(previous, "env-1", bad.run, scope),
    Error,
    "left running",
  );
  const noRm = recorder(ok(rows), false);
  await assertRejects(
    () => retirePreviousProjects(previous, "env-1", noRm.run, scope),
    Error,
    "stop them by hand",
  );
});

test("readPreviousProjects reads the recorded project names, with no compose file needed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readPreviousProjects(dir), null);
    await writeComposeFileSecure(
      join(dir, RUNTIME_COMPOSE_FILENAME),
      "services: {}\n",
    );
    await Deno.remove(join(dir, RUNTIME_COMPOSE_FILENAME));
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
    assertEquals((await readPreviousProjects(dir))?.names, ["p"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
