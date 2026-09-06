import { assertEquals } from "@std/assert";
import { resolveBootGeneration } from "./boot-generation.ts";

const test = Deno.test.bind(Deno);

function fixtureText(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../collector/testdata/${name}`, import.meta.url),
  );
}

async function withTempStateDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("resolveBootGeneration: no prior state starts at generation 0 and persists it", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const generation = await resolveBootGeneration({
      readBootId: () => fixtureText("proc-boot-id.txt"),
      daemonStateDir,
    });
    assertEquals(generation, 0);
  });
});

test("resolveBootGeneration: same boot_id across restarts stays unchanged", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const first = await resolveBootGeneration({
      readBootId: () => fixtureText("proc-boot-id.txt"),
      daemonStateDir,
    });
    const second = await resolveBootGeneration({
      readBootId: () => fixtureText("proc-boot-id.txt"),
      daemonStateDir,
    });
    assertEquals(first, 0);
    assertEquals(second, 0);
  });
});

test("resolveBootGeneration: a changed boot_id increments and persists", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const first = await resolveBootGeneration({
      readBootId: () => fixtureText("proc-boot-id.txt"),
      daemonStateDir,
    });
    const second = await resolveBootGeneration({
      readBootId: () => fixtureText("proc-boot-id-2.txt"),
      daemonStateDir,
    });
    const third = await resolveBootGeneration({
      readBootId: () => fixtureText("proc-boot-id-2.txt"),
      daemonStateDir,
    });
    assertEquals(first, 0);
    assertEquals(second, 1);
    assertEquals(third, 1);
  });
});
