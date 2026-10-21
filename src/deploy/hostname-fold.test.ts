import { assertEquals } from "@std/assert";
import { foldHostname } from "./hostname-fold.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("a hostname is folded to lowercase and an international name to punycode", () => {
  assertEquals(foldHostname("Example.COM"), "example.com");
  assertEquals(foldHostname(" www.Example.com "), "www.example.com");
  assertEquals(foldHostname("Bücher.Example"), "xn--bcher-kva.example");
  assertEquals(foldHostname("*.Bücher.Example"), "*.xn--bcher-kva.example");
  assertEquals(foldHostname("xn--bcher-kva.example"), "xn--bcher-kva.example");
});
