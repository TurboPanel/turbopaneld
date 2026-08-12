import { assertEquals } from "@std/assert";
import { runtimeEnv } from "./exec.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("runtimeEnv disables OpenSSL ARM CPU probing for ansible cryptography", () => {
  const env = runtimeEnv();
  assertEquals(
    env.OPENSSL_armcap,
    "0",
    "OPENSSL_armcap must be 0 so cryptography wheels do not SIGILL on Apple Silicon VMs that advertise SVE2 without implementing it",
  );
});

test("runtimeEnv extra vars can override OPENSSL_armcap when needed", () => {
  const env = runtimeEnv({ OPENSSL_armcap: "1" });
  assertEquals(env.OPENSSL_armcap, "1");
});
