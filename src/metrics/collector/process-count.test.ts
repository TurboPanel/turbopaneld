import { assertEquals } from "@std/assert";
import { countProcessesInProc } from "./process-count.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "countProcessesInProc counts only numeric directory entries",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "tp-proc-count-" });
    try {
      await Deno.mkdir(`${dir}/1`);
      await Deno.mkdir(`${dir}/42`);
      await Deno.mkdir(`${dir}/self`);
      await Deno.writeTextFile(`${dir}/cmdline`, "x");
      assertEquals(await countProcessesInProc(dir), 2);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "countProcessesInProc returns null when the directory cannot be read",
  permissions: { read: true },
  async fn() {
    assertEquals(
      await countProcessesInProc("/no/such/turbopanel-proc-dir"),
      null,
    );
  },
});
