import { assertEquals } from "@std/assert";
import { reservedManagedIngressAddress } from "./ingress-cidr.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("reservedManagedIngressAddress returns the last usable host in TEST-NET /24", () => {
  assertEquals(
    reservedManagedIngressAddress("203.0.113.0/24"),
    "203.0.113.254",
  );
  assertEquals(
    reservedManagedIngressAddress("198.51.100.128/25"),
    "198.51.100.254",
  );
});

test("reservedManagedIngressAddress rejects /31 and invalid CIDR input", () => {
  assertEquals(reservedManagedIngressAddress("198.51.100.0/31"), null);
  assertEquals(reservedManagedIngressAddress("not-a-cidr"), null);
  assertEquals(reservedManagedIngressAddress("203.0.113.1"), null);
  assertEquals(reservedManagedIngressAddress("999.0.113.0/24"), null);
});

test("reservedManagedIngressAddress normalizes network base for non-aligned input", () => {
  assertEquals(
    reservedManagedIngressAddress("203.0.113.17/24"),
    "203.0.113.254",
  );
});
