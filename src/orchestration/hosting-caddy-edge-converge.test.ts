import { assertStringIncludes } from "@std/assert";
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

test("daemon-converge backfills the hosting Caddy edge when tpedge is absent", async () => {
  const converge = await Deno.readTextFile(
    join(ORCH, "playbooks/daemon-converge.yml"),
  );
  assertStringIncludes(converge, "role: hosting-caddy");
  assertStringIncludes(converge, "tasks_from: backfill-edge-account.yml");

  const backfill = await Deno.readTextFile(
    join(ORCH, "roles/hosting-caddy/tasks/backfill-edge-account.yml"),
  );
  assertStringIncludes(backfill, "getent passwd {{ hosting_caddy_user }}");
  assertStringIncludes(backfill, "name: caddy");
  assertStringIncludes(backfill, "name: hosting-caddy");
  assertStringIncludes(backfill, "_hosting_caddy_account.rc != 0");
});
