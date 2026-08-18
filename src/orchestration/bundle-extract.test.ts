import { join } from "@std/path";
import { ensureOrchestrationTree } from "./bundle-extract.ts";
import { ORCHESTRATION_DIR } from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("ensureOrchestrationTree succeeds when ansible.cfg exists in checkout", async () => {
  const ansibleCfg = join(ORCHESTRATION_DIR, "ansible.cfg");
  await Deno.stat(ansibleCfg);
  await ensureOrchestrationTree();
});
