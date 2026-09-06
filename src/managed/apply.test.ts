import { assertEquals } from "@std/assert";
import { resolveClientSourceHosts, resolveManagedApplyHost } from "./apply.ts";
import { proxysqlProject } from "./paths.ts";
import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";

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

test("resolveClientSourceHosts keeps IPv4 and IPv6 literals and drops names", () => {
  const hosts = resolveClientSourceHosts({
    replication: {
      role: "primary",
      username: "tp_repl",
      peerAddresses: ["203.0.113.10", "primary.internal", "2001:db8::1"],
    },
    ingressSourceAddresses: ["198.51.100.20", "db-peer"],
  } as ManagedApplyPayload);
  assertEquals(hosts, ["198.51.100.20", "2001:db8::1", "203.0.113.10"]);
});

test("resolveClientSourceHosts is empty when no address lists are present", () => {
  assertEquals(
    resolveClientSourceHosts({} as ManagedApplyPayload),
    [],
  );
});

test("proxysqlProject names the shared managed ingress compose project", () => {
  // The shared ProxySQL project is the managed-ingress system component's
  // allocated serviceId, round-tripped verbatim — never a readable literal.
  const serviceId = "00000000-0000-4000-8000-0000000000cc";
  assertEquals(proxysqlProject(serviceId), serviceId);
});
