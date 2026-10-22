import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { writeTextFileAtomic } from "./atomic-write.ts";

const test = Deno.test.bind(Deno);

test("writeTextFileAtomic: concurrent writers of one file all succeed and leave no temp files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "metrics", "topology-generation.json");
    await Promise.all(
      Array.from(
        { length: 16 },
        (_, i) => writeTextFileAtomic(path, JSON.stringify({ n: i })),
      ),
    );
    const parsed = JSON.parse(await Deno.readTextFile(path));
    assertEquals(typeof parsed.n, "number");
    const names: string[] = [];
    for await (const e of Deno.readDir(join(dir, "metrics"))) {
      names.push(e.name);
    }
    assertEquals(names, ["topology-generation.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
