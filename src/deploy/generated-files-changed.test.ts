import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { generatedFileTimes } from "./generated-files-changed.ts";
import { configHostDirectory } from "./config-files.ts";
import { secretHostPath, writeFileAtomic } from "./secret-runtime.ts";

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
  configFiles: [{
    composeServiceName: "c",
    source: "cfg",
    relativePath: "c.conf",
    parts: [{ text: "x" }],
  }],
};

const OLD = new Date("2026-01-01T00:00:00Z");

async function withRunDir(fn: (runDir: string) => Promise<void>) {
  const runDir = await Deno.makeTempDir();
  try {
    await fn(runDir);
  } finally {
    await Deno.remove(runDir, { recursive: true });
  }
}

test("each service gets the latest time of its secret and config files", () =>
  withRunDir(async (runDir) => {
    const paths = {
      a: secretHostPath({ runDir }, "p1", "e1", "a.secret"),
      b: secretHostPath({ runDir }, "p1", "e1", "b.secret"),
      c: join(configHostDirectory({ runDir }, "p1", "e1"), "c.conf"),
    };
    for (const path of Object.values(paths)) {
      await writeFileAtomic(path, "v", 0o444);
      await Deno.utime(path, OLD, OLD);
    }
    const bump = new Date("2026-02-01T00:00:00Z");
    await Deno.utime(paths.b, bump, bump);
    const times = await generatedFileTimes({ runDir }, payload);
    assertEquals(times.get("a"), OLD.getTime());
    assertEquals(times.get("b"), bump.getTime());
    assertEquals(times.get("c"), OLD.getTime());
  }));

test("a missing file counts as newer than any container", () =>
  withRunDir(async (runDir) => {
    const times = await generatedFileTimes({ runDir }, payload);
    assertEquals(times.get("a"), Infinity);
    assertEquals(times.get("c"), Infinity);
  }));

test("rewriting the same content keeps the file's time; new content moves it", () =>
  withRunDir(async (runDir) => {
    const path = join(runDir, "f", "s");
    await writeFileAtomic(path, "one", 0o444);
    await Deno.utime(path, OLD, OLD);
    await writeFileAtomic(path, "one", 0o444);
    assertEquals((await Deno.stat(path)).mtime?.getTime(), OLD.getTime());
    await writeFileAtomic(path, "two", 0o444);
    assertEquals(await Deno.readTextFile(path), "two");
    assertEquals(
      (await Deno.stat(path)).mtime!.getTime() > OLD.getTime(),
      true,
    );
  }));
