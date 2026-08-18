import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withTempLayout } from "./testing/temp-layout.ts";
import {
  COLOCATED_DEV_SYNC_REFUSED_REASON,
  MANAGED_DEV_SYNC_REFUSED_REASON,
  newDevSyncState,
  resolveDevSyncSourceRoot,
} from "./dev-sync-resolve.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("newDevSyncState preallocates empty chunk slots", () => {
  const state = newDevSyncState(3);
  assertEquals(state.totalChunks, 3);
  assertEquals(state.chunks, ["", "", ""]);
});

test("resolveDevSyncSourceRoot refuses co-located development daemons", () => {
  for (const flag of ["1", "true", "yes", "TRUE"]) {
    const previous = Deno.env.get("TURBOPANEL_DEV_INSTANCE");
    Deno.env.set("TURBOPANEL_DEV_INSTANCE", flag);
    try {
      const result = resolveDevSyncSourceRoot({});
      assertEquals(result.ok, false);
      if (result.ok) throw new TypeError("expected refusal");
      assertEquals(result.reason, COLOCATED_DEV_SYNC_REFUSED_REASON);
    } finally {
      if (previous === undefined) Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
      else Deno.env.set("TURBOPANEL_DEV_INSTANCE", previous);
    }
  }
});

test("resolveDevSyncSourceRoot accepts an editable checkout override", async () => {
  await withTempLayout(async (fixture) => {
    const checkout = join(fixture.dirs.stateDir, "turbopaneld");
    await Deno.mkdir(checkout);
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");

    const previous = Deno.env.get("TURBOPANEL_DEV_INSTANCE");
    Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
    try {
      const result = resolveDevSyncSourceRoot({
        TURBOPANEL_DAEMON_ROOT: checkout,
      });
      assertEquals(result, { ok: true, root: checkout });
    } finally {
      if (previous === undefined) Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
      else Deno.env.set("TURBOPANEL_DEV_INSTANCE", previous);
    }
  });
});

test("resolveDevSyncSourceRoot refuses managed installs without a checkout", async () => {
  await withTempLayout(async (fixture) => {
    const notCheckout = join(fixture.dirs.stateDir, "bin");
    await Deno.mkdir(notCheckout);

    const previous = Deno.env.get("TURBOPANEL_DEV_INSTANCE");
    Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
    try {
      const result = resolveDevSyncSourceRoot({
        TURBOPANEL_DAEMON_ROOT: notCheckout,
      });
      assertEquals(result.ok, false);
      if (result.ok) throw new TypeError("expected managed refusal");
      assertEquals(result.reason, MANAGED_DEV_SYNC_REFUSED_REASON);
    } finally {
      if (previous === undefined) Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
      else Deno.env.set("TURBOPANEL_DEV_INSTANCE", previous);
    }
  });
});
