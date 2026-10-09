import { assert, assertEquals } from "@std/assert";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  clearManagedDemotedMarker,
  isManagedMemberDemoted,
  maybeClearDemotedMarkerAfterApply,
  writeManagedDemotedMarker,
} from "./demoted-marker.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_MEMBER = "00000000-0000-4000-8000-0000000000b2";

test("write and clear a demoted marker", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID),
      false,
    );
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    const path = `${layout.stateDir}/managed/${MANAGED_ID}/demoted.json`;
    const text = await Deno.readTextFile(path);
    assertEquals(JSON.parse(text), {
      memberId: MEMBER_ID,
      demotedAt: "2026-10-08T12:00:00.000Z",
    });
    const stat = await Deno.stat(path);
    assertEquals(stat.mode && (stat.mode & 0o777), 0o600);
    assert(await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID));
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID, OTHER_MEMBER),
      false,
    );
    await clearManagedDemotedMarker(layout, MANAGED_ID);
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID),
      false,
    );
  });
});

test("an unreadable demoted marker fails closed", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${layout.stateDir}/managed/${MANAGED_ID}/demoted.json`,
      "{not json",
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID));
  });
});

test("a replica apply that is ready clears the marker; other outcomes keep it", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId: MANAGED_ID, memberRole: "primary" },
      "ready",
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID));
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId: MANAGED_ID, memberRole: "replica" },
      "needs_resync",
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID));
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId: MANAGED_ID, memberRole: "replica" },
      "ready",
    );
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID),
      false,
    );
  });
});
