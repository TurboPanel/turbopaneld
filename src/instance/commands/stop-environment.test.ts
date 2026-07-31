import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { handleEnvironmentStop } from "./stop-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "handleEnvironmentStop is idempotent when compose file is missing",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-env-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    try {
      const result = await handleEnvironmentStop(
        {
          environmentId: "envtest01",
          projectId: "proj-1",
          projectName: "tp-demo-envtest0",
        },
        new Date().toISOString(),
      );
      assertEquals(result.projectName, "tp-demo-envtest0");
      assertEquals(result.containers, []);
      assertEquals(result.summary.includes("already stopped"), true);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});
