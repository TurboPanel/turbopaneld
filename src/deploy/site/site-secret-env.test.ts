import { assertEquals, assertRejects } from "@std/assert";
import type { EnvironmentDeploySite } from "../../contracts/commands-contracts.ts";
import { resolveSiteSecretEnv } from "./site-secret-env.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const site = (
  patch: Partial<EnvironmentDeploySite>,
): EnvironmentDeploySite => ({
  composeServiceName: "app",
  engine: "nginx",
  root: "public",
  listenPort: 18080,
  ...patch,
});

/** `tpdaemon.<plaintext>` stands in for an envelope; `null` for a failure. */
function fakeDecrypt(calls: string[][] = []) {
  return (envelopes: string[]): Promise<(string | null)[]> => {
    calls.push([...envelopes]);
    return Promise.resolve(
      envelopes.map((e) => e.startsWith("tpdaemon.") ? e.slice(9) : null),
    );
  };
}

test("resolveSiteSecretEnv folds decrypted secrets into webEnv and drops the sealed map", async () => {
  const [out] = await resolveSiteSecretEnv(
    [site({
      webEnv: { APP_ENV: "production" },
      webSecretEnv: { VAR_A: "tpdaemon.alpha", VAR_B: "tpdaemon.beta" },
    })],
    fakeDecrypt(),
  );
  assertEquals(out?.webEnv, {
    APP_ENV: "production",
    VAR_A: "alpha",
    VAR_B: "beta",
  });
  assertEquals("webSecretEnv" in (out as object), false);
});

test("resolveSiteSecretEnv decrypts in name order and one site at a time", async () => {
  const calls: string[][] = [];
  await resolveSiteSecretEnv(
    [
      site({ webSecretEnv: { B: "tpdaemon.b", A: "tpdaemon.a" } }),
      site({
        composeServiceName: "other",
        webSecretEnv: { C: "tpdaemon.c" },
      }),
    ],
    fakeDecrypt(calls),
  );
  assertEquals(calls, [["tpdaemon.a", "tpdaemon.b"], ["tpdaemon.c"]]);
});

test("resolveSiteSecretEnv keeps one site's secrets out of every other site", async () => {
  const [a, b] = await resolveSiteSecretEnv(
    [
      site({ webSecretEnv: { VAR_C: "tpdaemon.for-a" } }),
      site({ composeServiceName: "b", webEnv: { PLAIN: "1" } }),
    ],
    fakeDecrypt(),
  );
  assertEquals(a?.webEnv, { VAR_C: "for-a" });
  assertEquals(b?.webEnv, { PLAIN: "1" });
});

test("resolveSiteSecretEnv returns a site with no secrets untouched and needs no decrypt for it", async () => {
  const plain = site({ webEnv: { APP_ENV: "production" } });
  const [out] = await resolveSiteSecretEnv([plain], undefined);
  assertEquals(out, plain);
});

test("resolveSiteSecretEnv fails when secrets arrive and decrypt is unavailable", async () => {
  await assertRejects(
    () =>
      resolveSiteSecretEnv(
        [site({ webSecretEnv: { A: "tpdaemon.a" } })],
        undefined,
      ),
    Error,
    "decrypt is unavailable",
  );
});

test("resolveSiteSecretEnv names the variable, never the value, when decrypt fails", async () => {
  const err = await assertRejects(
    () =>
      resolveSiteSecretEnv(
        [site({ webSecretEnv: { VAR_A: "garbage" } })],
        fakeDecrypt(),
      ),
    Error,
    "VAR_A",
  );
  assertEquals(err.message.includes("garbage"), false);
});

test("resolveSiteSecretEnv skips a secret that is empty after trimming", async () => {
  const [out] = await resolveSiteSecretEnv(
    [site({
      webSecretEnv: { EMPTY: "tpdaemon.  ", KEEP: "tpdaemon. v " },
    })],
    fakeDecrypt(),
  );
  assertEquals(out?.webEnv, { KEEP: "v" });
});

test("resolveSiteSecretEnv decrypts more than one batch of secrets", async () => {
  const names = Array.from(
    { length: 130 },
    (_, i) => `K${String(i).padStart(3, "0")}`,
  );
  const calls: string[][] = [];
  const [out] = await resolveSiteSecretEnv(
    [site({
      webSecretEnv: Object.fromEntries(
        names.map((n) => [n, `tpdaemon.v-${n}`]),
      ),
    })],
    fakeDecrypt(calls),
  );
  assertEquals(calls.map((c) => c.length), [100, 30]);
  assertEquals(Object.keys(out?.webEnv ?? {}).length, 130);
  assertEquals(out?.webEnv?.K129, "v-K129");
});

test("resolveSiteSecretEnv drops the PHP ini override names, plain and sealed, in any case", async () => {
  const calls: string[][] = [];
  const out = await resolveSiteSecretEnv(
    [site({
      webEnv: { PHP_VALUE: "memory_limit=-1", Php_Admin_Value: "x", KEEP: "1" },
      webSecretEnv: {
        PHP_ADMIN_VALUE: "tpdaemon.open_basedir=",
        php_value: "tpdaemon.y",
        SECRET: "tpdaemon.s",
      },
    })],
    fakeDecrypt(calls),
  );
  assertEquals(out[0]?.webEnv, { KEEP: "1", SECRET: "s" });
  // A reserved sealed value is never sent to be decrypted.
  assertEquals(calls, [["tpdaemon.s"]]);
});

test("resolveSiteSecretEnv leaves no empty maps behind when only reserved names were set", async () => {
  const [out] = await resolveSiteSecretEnv(
    [site({
      webEnv: { PHP_VALUE: "a" },
      webSecretEnv: { PHP_ADMIN_VALUE: "tpdaemon.b" },
    })],
    undefined,
  );
  assertEquals("webEnv" in (out as object), false);
  assertEquals("webSecretEnv" in (out as object), false);
});

test("resolveSiteSecretEnv returns a site without reserved names as the same object", async () => {
  const plain = site({ webEnv: { APP_ENV: "production" } });
  const [out] = await resolveSiteSecretEnv([plain], undefined);
  assertEquals(out, plain);
});
