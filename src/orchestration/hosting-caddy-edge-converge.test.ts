import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORCH = join(DAEMON_ROOT, "orchestration");

test("daemon-converge backfills incomplete hosting Caddy edge prep", async () => {
  const converge = await Deno.readTextFile(
    join(ORCH, "playbooks/daemon-converge.yml"),
  );
  assertStringIncludes(converge, "role: hosting-caddy");
  assertStringIncludes(converge, "tasks_from: backfill-edge-account.yml");

  const backfill = await Deno.readTextFile(
    join(ORCH, "roles/hosting-caddy/tasks/backfill-edge-account.yml"),
  );
  assertStringIncludes(backfill, "getent passwd {{ hosting_caddy_user }}");
  assertStringIncludes(backfill, "caddy/current/caddy");
  assertStringIncludes(backfill, "hosting_ingress_guard_rules");
  assertStringIncludes(backfill, "turbopanel-ingress-guard.service");
  assertStringIncludes(backfill, "name: caddy");
  assertStringIncludes(backfill, "name: hosting-caddy");
  assertStringIncludes(backfill, "_hosting_caddy_account.rc != 0");
  assertStringIncludes(
    backfill,
    "not (_hosting_caddy_binary.stat.exists | default(false))",
  );
  assertStringIncludes(
    backfill,
    "_hosting_ingress_guard_marker.rc | default(1) != 0",
  );
  assertStringIncludes(backfill, "_hosting_ingress_guard_unit.rc != 0");

  const whenMatch = backfill.match(
    /when:\s*>\s*\n((?:\s+.+\n)+)/,
  );
  assertEquals(whenMatch !== null, true);
  const whenClause = whenMatch![1]!;
  assertEquals(whenClause.includes("_hosting_caddy_account.rc != 0"), true);
  assertEquals(
    whenClause.includes("_hosting_caddy_binary.stat.exists"),
    true,
  );
});
