import { assertEquals } from "@std/assert";
import { resolveManagedApplyHost } from "./apply.ts";
import { PROXYSQL_PROJECT } from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveManagedApplyHost always reports loopback — external access is via ProxySQL", () => {
  assertEquals(
    resolveManagedApplyHost({
      enabled: true,
      protocol: "tcp",
    }),
    "127.0.0.1",
  );
  assertEquals(
    resolveManagedApplyHost({
      enabled: true,
      protocol: "tcp",
      bindAddress: "203.0.113.10",
    }),
    "127.0.0.1",
  );
  assertEquals(
    resolveManagedApplyHost({ enabled: false, protocol: "tcp" }),
    "127.0.0.1",
  );
});

test("PROXYSQL_PROJECT names the shared managed ingress compose project", () => {
  assertEquals(PROXYSQL_PROJECT, "turbopanel-proxysql");
});
