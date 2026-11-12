import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  isSecretsTrustSealed,
  markSecretsTrustSealed,
  TRUST_LEVEL_FILE,
} from "./trust-level-file.ts";

const test = Deno.test.bind(Deno);

test("the secrets trust mark starts unset, is written once and stays", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-trust-level-" });
  try {
    assertEquals(await isSecretsTrustSealed(dir), false);
    await markSecretsTrustSealed(dir);
    assertEquals(await isSecretsTrustSealed(dir), true);
    await markSecretsTrustSealed(dir);
    assertEquals(
      (await Deno.readTextFile(join(dir, TRUST_LEVEL_FILE))).trim(),
      "sealed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
