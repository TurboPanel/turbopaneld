import { assert } from "@std/assert";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("production client does not import the checkout-sync unpack path", async () => {
  const client = await Deno.readTextFile(new URL("./client.ts", import.meta.url));
  assert(
    !client.includes("dev-sync-apply.ts"),
    "instance/client.ts must not import src/dev-sync-apply.ts",
  );
  assert(
    !client.includes("applyDevSyncTarball,"),
    "instance/client.ts must not statically import applyDevSyncTarball",
  );
});

test("production compile entry does not enable checkout-sync unpack", async () => {
  const entry = await Deno.readTextFile(
    new URL("../prod-main.ts", import.meta.url),
  );
  assert(!entry.includes("dev-sync-apply.ts"));
  assert(!entry.includes("enableCheckoutDevSync"));
  assert(entry.includes("daemon-run.ts"));
});

test("source main.ts enables checkout-sync unpack", async () => {
  const entry = await Deno.readTextFile(new URL("../../main.ts", import.meta.url));
  assert(entry.includes("applyDevSyncTarball"));
  assert(entry.includes("enableCheckoutDevSync"));
});
