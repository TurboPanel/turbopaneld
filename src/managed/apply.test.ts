import { assertEquals } from "@std/assert";
import { resolveManagedApplyHost } from "./apply.ts";
import { proxysqlProject } from "./paths.ts";

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

test("proxysqlProject names the shared managed ingress compose project", () => {
  // The shared ProxySQL project is the managed-ingress system component's
  // allocated serviceId, round-tripped verbatim — never a readable literal.
  const serviceId = "00000000-0000-4000-8000-0000000000cc";
  assertEquals(proxysqlProject(serviceId), serviceId);
});
