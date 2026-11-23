import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  servicesWithChangedFiles,
  snapshotGeneratedFiles,
} from "./generated-files-changed.ts";
import { secretHostPath } from "./secret-runtime.ts";

const test = Deno.test.bind(Deno);

const payload = {
  projectId: "p1",
  environmentId: "e1",
  secretPlan: ["a", "b"].map((name) => ({
    key: name,
    composeServiceName: name,
    source: name,
    target: name,
    relativePath: `${name}.secret`,
    forBuild: false,
    forRuntime: true,
  })),
  configFiles: [],
};

async function write(runDir: string, name: string, text: string) {
  const path = secretHostPath({ runDir }, "p1", "e1", `${name}.secret`);
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

test("only the service whose secret content changed is reported", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const layout = { runDir };
    await write(runDir, "a", "one");
    await write(runDir, "b", "two");
    const before = await snapshotGeneratedFiles(layout, payload);
    await write(runDir, "b", "rotated");
    const changed = await servicesWithChangedFiles(before, layout, payload);
    assertEquals([...changed], ["b"]);
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});

test("a file that did not exist before counts as changed", async () => {
  const runDir = await Deno.makeTempDir();
  try {
    const layout = { runDir };
    const before = await snapshotGeneratedFiles(layout, payload);
    await write(runDir, "a", "one");
    await write(runDir, "b", "two");
    const changed = await servicesWithChangedFiles(before, layout, payload);
    assertEquals([...changed].sort(), ["a", "b"]);
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
});
