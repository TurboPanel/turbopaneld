import { assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  classifyHostBoot,
  hostBootPath,
  markHostCleanShutdown,
  readHostBootRecord,
  recordHostBoot,
} from "./host-boot.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const BOOT_A = "11111111-1111-4111-8111-111111111111";
const BOOT_B = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-06T10:00:00.000Z";

test("classifyHostBoot tells a power cut from a planned reboot and a daemon restart", () => {
  const running = { bootId: BOOT_A, startedAt: NOW };
  const stopped = { ...running, cleanShutdownAt: NOW };
  assertEquals(classifyHostBoot(null, BOOT_A), "first");
  assertEquals(classifyHostBoot(running, BOOT_A), "same-boot");
  assertEquals(classifyHostBoot(stopped, BOOT_A), "same-boot");
  assertEquals(classifyHostBoot(running, BOOT_B), "unclean");
  assertEquals(classifyHostBoot(stopped, BOOT_B), "clean-reboot");
  // No boot id (no /proc): no information, never a hold.
  assertEquals(classifyHostBoot(running, undefined), "same-boot");
  assertEquals(classifyHostBoot(null, undefined), "same-boot");
});

test("a boot that follows a run with no clean shutdown reads as unclean", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const at = (bootId: string) => ({
      readBootId: () => Promise.resolve(bootId),
      nowIso: () => NOW,
    });
    assertEquals(await recordHostBoot(layout, at(BOOT_A)), "first");
    // The daemon restarted on the same boot: nothing to decide.
    assertEquals(await recordHostBoot(layout, at(BOOT_A)), "same-boot");
    // Power cut: no clean stamp was written before boot B.
    assertEquals(await recordHostBoot(layout, at(BOOT_B)), "unclean");
    assertEquals((await readHostBootRecord(layout))?.bootId, BOOT_B);
  });
});

test("a clean shutdown stamp makes the next boot a planned reboot", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const at = (bootId: string) => ({
      readBootId: () => Promise.resolve(bootId),
      nowIso: () => NOW,
    });
    await recordHostBoot(layout, at(BOOT_A));
    await markHostCleanShutdown(layout, at(BOOT_A));
    assertEquals(await recordHostBoot(layout, at(BOOT_B)), "clean-reboot");
    // The stamp is earned per run: B never shut down cleanly.
    assertEquals(await recordHostBoot(layout, at(BOOT_A)), "unclean");
  });
});

test("a stamp from another boot is ignored and an unreadable record is no information", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const at = (bootId: string) => ({
      readBootId: () => Promise.resolve(bootId),
      nowIso: () => NOW,
    });
    await recordHostBoot(layout, at(BOOT_A));
    await markHostCleanShutdown(layout, at(BOOT_B));
    assertEquals(
      (await readHostBootRecord(layout))?.cleanShutdownAt,
      undefined,
    );

    await Deno.mkdir(dirname(hostBootPath(layout)), { recursive: true });
    await Deno.writeTextFile(hostBootPath(layout), "{not json");
    assertEquals(await readHostBootRecord(layout), null);
    assertEquals(await recordHostBoot(layout, at(BOOT_B)), "first");
  });
});
