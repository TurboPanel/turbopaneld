import { assertEquals } from "@std/assert";
import { installOriginNeedsInsecureTls } from "./install-tls.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("installOriginNeedsInsecureTls trusts public HTTPS on 443", () => {
  assertEquals(installOriginNeedsInsecureTls("https://turbopanel.dev"), false);
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com"),
    false,
  );
});

test("installOriginNeedsInsecureTls flags platform-CA listeners", () => {
  assertEquals(
    installOriginNeedsInsecureTls("https://studio.lan:8443"),
    true,
  );
  assertEquals(installOriginNeedsInsecureTls("https://studio.lan"), true);
  assertEquals(installOriginNeedsInsecureTls("http://studio.lan:8880"), false);
});
