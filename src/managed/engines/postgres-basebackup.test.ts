/**
 * Pure basebackup connection-string helpers.
 */

import { assertEquals } from "@std/assert";
import { buildBasebackupConnectionString } from "./postgres.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("buildBasebackupConnectionString prefers host SAN and optional hostaddr for dial", () => {
  const remote = buildBasebackupConnectionString(
    {
      host: "managed-00000000-0000-4000-8000-000000000001",
      hostaddr: "203.0.113.10",
      port: 15432,
    },
    "tp_repl",
  );
  assertEquals(
    remote.includes("host=managed-00000000-0000-4000-8000-000000000001"),
    true,
  );
  assertEquals(remote.includes("hostaddr=203.0.113.10"), true);
  assertEquals(remote.includes("port=15432"), true);
  assertEquals(remote.includes("sslmode=verify-full"), true);
  assertEquals(
    remote.includes("sslrootcert=/etc/postgresql/tls/ca.crt"),
    true,
  );
  // Must not dial only by hostaddr (would fail cert SAN for verify-full).
  assertEquals(remote.startsWith("host=managed-"), true);
});

test("buildBasebackupConnectionString omits hostaddr for co-resident container peers", () => {
  const local = buildBasebackupConnectionString(
    {
      host: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
      port: 5432,
    },
    "tp_repl",
  );
  assertEquals(local.includes("hostaddr="), false);
  assertEquals(
    local.includes("host=01936b3e-aaaa-bbbb-cccc-123456789abc-1"),
    true,
  );
});
