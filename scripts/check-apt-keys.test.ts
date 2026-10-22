import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkAptKeys } from "./check-apt-keys.ts";

const test = Deno.test.bind(Deno);
const KEYS = new URL("../orchestration/apt-keys", import.meta.url).pathname;

test("bundled keys match when the live key is identical", async () => {
  const bundled = await Deno.readFile(join(KEYS, "sury-php.gpg"));
  assertEquals(await checkAptKeys(KEYS, () => Promise.resolve(bundled)), []);
});

test("a changed live key and an unreachable vendor are reported", async () => {
  const changed = await checkAptKeys(
    KEYS,
    () => Promise.resolve(new Uint8Array([1, 2, 3])),
  );
  assertEquals(changed.length, 1);
  assertEquals(changed[0].includes("differs from the bundled copy"), true);
  const down = await checkAptKeys(
    KEYS,
    () => Promise.reject(new Error("down")),
  );
  assertEquals(down[0].includes("could not fetch"), true);
});

test("a key within 60 days of expiry is reported", async () => {
  const bundled = await Deno.readFile(join(KEYS, "sury-php.gpg"));
  const late = Date.parse("2028-01-20");
  const findings = await checkAptKeys(
    KEYS,
    () => Promise.resolve(bundled),
    late,
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0].includes("within 60 days"), true);
});
