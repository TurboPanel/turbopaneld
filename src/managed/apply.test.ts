/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { resolveManagedApplyHost } from "./apply.ts";

const test = Deno.test.bind(Deno);

test("resolveManagedApplyHost reports 0.0.0.0 when exposed without bindAddress", () => {
  assertEquals(
    resolveManagedApplyHost({
      enabled: true,
      protocol: "tcp",
      publishedPort: 15432,
    }),
    "0.0.0.0",
  );
});

test("resolveManagedApplyHost uses bindAddress when exposed with one", () => {
  assertEquals(
    resolveManagedApplyHost({
      enabled: true,
      protocol: "tcp",
      publishedPort: 15432,
      bindAddress: "203.0.113.10",
    }),
    "203.0.113.10",
  );
});

test("resolveManagedApplyHost reports loopback when exposure is disabled", () => {
  assertEquals(
    resolveManagedApplyHost({ enabled: false, protocol: "tcp" }),
    "127.0.0.1",
  );
});
