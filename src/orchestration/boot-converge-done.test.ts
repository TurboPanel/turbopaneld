import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  BOOT_CONVERGE_DONE_FILE,
  recordBootConvergeDone,
} from "./boot-converge-done.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("the boot converge marker is written into the run folder, whole", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-converge-done-" });
  try {
    const at = new Date("2026-11-09T12:00:00Z");
    assertEquals(await recordBootConvergeDone(dir, at), true);
    assertEquals(
      await Deno.readTextFile(join(dir, BOOT_CONVERGE_DONE_FILE)),
      '{"finishedAt":"2026-11-09T12:00:00.000Z"}\n',
    );
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, [BOOT_CONVERGE_DONE_FILE]);
    // A later converge on the same boot replaces it.
    assertEquals(
      await recordBootConvergeDone(dir, new Date("2026-11-09T12:05:00Z")),
      true,
    );
    assertEquals(
      await Deno.readTextFile(join(dir, BOOT_CONVERGE_DONE_FILE)),
      '{"finishedAt":"2026-11-09T12:05:00.000Z"}\n',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a missing run folder is left alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-converge-done-" });
  try {
    const missing = join(dir, "run");
    assertEquals(await recordBootConvergeDone(missing), false);
    assertEquals(
      await Deno.stat(missing).then(() => true, () => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
