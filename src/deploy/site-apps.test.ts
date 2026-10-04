import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { EnvironmentDeploySite } from "../contracts/commands-contracts.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { AppProbe } from "./site/app-detect.ts";
import { detectSiteApps } from "./site-apps.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function site(composeServiceName: string): EnvironmentDeploySite {
  return {
    composeServiceName,
    engine: "nginx",
    root: "public",
    listenPort: 8080,
  };
}

const refuseRun = () => {
  throw new Error("no privileged call expected");
};

test({
  name: "detectSiteApps reports one row per site and a fact only for WordPress",
  async fn() {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      const probedRoots: string[] = [];
      const wordpress: AppProbe = {
        listDir: (rel) =>
          Promise.resolve(
            {
              "": ["wp-config.php", "wp-settings.php"],
              "wp-includes": ["version.php"],
              "wp-content": [],
            }[rel] ?? null,
          ),
        readText: () => Promise.resolve("$wp_version = '6.4.3';"),
      };
      const plain: AppProbe = {
        listDir: (rel) => Promise.resolve(rel === "" ? ["index.php"] : null),
        readText: () => Promise.resolve(null),
      };
      const rows = await detectSiteApps(
        layout,
        "env-1",
        [site("blog"), site("docs")],
        {
          releaseBindings: new Map(),
          managedDirectoryBindings: new Map([
            ["blog", { serviceId: "svc-blog", username: "alice" }],
          ]),
          run: refuseRun,
          probeFor: (documentRoot) => {
            probedRoots.push(documentRoot);
            return documentRoot.includes("svc-blog") ? wordpress : plain;
          },
        },
      );
      assertEquals(rows, [
        {
          composeServiceName: "blog",
          app: { kind: "wordpress", version: "6.4.3" },
        },
        { composeServiceName: "docs" },
      ]);
      // The managed-directory webroot and the daemon-owned tree are what get probed.
      assertEquals(
        probedRoots[0]?.endsWith(join("svc-blog", "webroot", "public")),
        true,
      );
      assertEquals(probedRoots[1]?.includes("env-1"), true);
    });
  },
});

test({
  name: "detectSiteApps never fails the deploy when a probe throws",
  async fn() {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      const rows = await detectSiteApps(layout, "env-1", [site("blog")], {
        releaseBindings: new Map(),
        managedDirectoryBindings: new Map(),
        run: refuseRun,
        probeFor: () => {
          throw new Error("boom");
        },
      });
      assertEquals(rows, [{ composeServiceName: "blog" }]);
    });
  },
});
