import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { sessionEndMarkerPath, sessionEndsFor } from "./session-end-marker.ts";

const test = Deno.test.bind(Deno);
const MANAGED_ID = "11111111-2222-4333-8444-555555555555";

test("a login is remembered until its sessions are ended", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const ends = sessionEndsFor(layout, MANAGED_ID);
    assertEquals(await ends.pending(), []);
    await ends.add("a_login");
    await ends.add("a_login");
    await ends.add("b_login");
    // A second reader (the next apply) sees the same file.
    assertEquals(await sessionEndsFor(layout, MANAGED_ID).pending(), [
      "a_login",
      "b_login",
    ]);
    await ends.done("a_login");
    assertEquals(await ends.pending(), ["b_login"]);
    await ends.done("b_login");
    await ends.done("b_login");
    assertEquals(await ends.pending(), []);
    assertEquals(
      await Deno.stat(sessionEndMarkerPath(layout, MANAGED_ID)).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

test("an unsafe managed id is refused", async () => {
  await withTempLayout(({ env }) => {
    assertThrows(
      () => sessionEndMarkerPath(resolveLayout(env), "../x"),
      Error,
      "unsupported",
    );
    return Promise.resolve();
  });
});

test("a marker file that does not parse owes nothing", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const path = sessionEndMarkerPath(layout, MANAGED_ID);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, "{not json");
    assertEquals(await sessionEndsFor(layout, MANAGED_ID).pending(), []);
  });
});
