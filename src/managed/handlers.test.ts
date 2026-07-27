/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { join } from "@std/path";
import { handleManagedDestroy } from "./destroy.ts";
import { handleManagedLifecycle } from "./lifecycle.ts";

const test = Deno.test.bind(Deno);

test("handleManagedLifecycle is idempotent when state dir is missing", async () => {
  const managedId = `noop-life-${crypto.randomUUID()}`;
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-life-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    const result = await handleManagedLifecycle(
      { managedId, action: "stop" },
      new Date().toISOString(),
    );
    assertEquals(result.status, "stopped");
    assertEquals(result.summary?.includes("idempotent"), true);
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    await Deno.remove(tmp, { recursive: true });
  }
});

test("handleManagedDestroy is idempotent when state dir is missing", async () => {
  const managedId = `noop-destroy-${crypto.randomUUID()}`;
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-destroy-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    const result = await handleManagedDestroy(
      { managedId, removeVolumes: false },
      new Date().toISOString(),
    );
    assertEquals(result.status, "stopped");
    assertEquals(result.containers, []);
    assertEquals(result.summary?.includes("idempotent"), true);
    // Confirm nothing was created under managed/.
    try {
      await Deno.stat(join(tmp, "managed", managedId));
      throw new TypeError("managed dir should not exist");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    await Deno.remove(tmp, { recursive: true });
  }
});
