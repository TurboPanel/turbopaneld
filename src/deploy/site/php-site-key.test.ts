import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import { withTempLayout } from "../../testing/index.ts";
import {
  cachedPhpSiteKeySecret,
  loadPhpSiteKeySecret,
  phpSiteKey,
  phpSiteKeySecretPath,
} from "./php-site-key.ts";

const test = Deno.test.bind(Deno);

const SECRET_A = new Uint8Array(32).fill(1);
const SECRET_B = new Uint8Array(32).fill(2);

test("the key is 64 hex, stable for one secret and id, and different for another", async () => {
  const key = await phpSiteKey(SECRET_A, "shop-0123456789ab-fcgi8.4");
  assertMatch(key, /^[0-9a-f]{64}$/);
  assertEquals(await phpSiteKey(SECRET_A, "shop-0123456789ab-fcgi8.4"), key);
  assertNotEquals(await phpSiteKey(SECRET_A, "shop-0123456789ab-fpm8.4"), key);
  assertNotEquals(await phpSiteKey(SECRET_B, "shop-0123456789ab-fcgi8.4"), key);
});

test("the loader creates a 0600 secret, reuses it, and refuses a malformed file", async () => {
  await withTempLayout(async ({ dirs }) => {
    const layout = { daemonStateDir: dirs.stateDir };
    const path = phpSiteKeySecretPath(layout);
    const first = await loadPhpSiteKeySecret(layout);
    assertEquals(first.length, 32);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(await loadPhpSiteKeySecret(layout), first);
    assertEquals(await cachedPhpSiteKeySecret(layout), first);

    await Deno.writeTextFile(path, "not hex\n");
    await assertRejects(
      () => loadPhpSiteKeySecret(layout),
      Error,
      "64 hex characters",
    );
    // A refused file is left alone, never replaced.
    assertEquals(await Deno.readTextFile(path), "not hex\n");
    assertEquals(
      (await Array.fromAsync(
        Deno.readDir(join(layout.daemonStateDir, "sites")),
      ))
        .map((entry) => entry.name),
      ["php-site-key"],
    );
  });
});
