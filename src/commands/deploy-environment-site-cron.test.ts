import { assertEquals } from "@std/assert";
import type { EnvironmentDeploySite } from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { siteEnvFileId } from "../deploy/site/site-env-file.ts";
import { siteCronSpec } from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const layout = resolveLayout(
  {
    TURBOPANEL_CONFIG_DIR: "/etc/turbopanel",
    TURBOPANEL_PRINCIPAL_HOME_ROOT: "/srv/users",
  },
  { skipDiscovery: true, forceMode: "production" },
);

const FOLDER = { owner: "alice", scope: "production", slug: "web" };
const BINDING = {
  serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
  username: "alice",
  folder: FOLDER,
};
const SERVICE = "/srv/users/alice/production/services/web";

const site = (patch: Partial<EnvironmentDeploySite> = {}) =>
  ({
    composeServiceName: "web",
    engine: "apache",
    root: "public",
    listenPort: 18080,
    principal: { principalId: "p1", username: "alice" },
    php: { version: "8.3" },
    cron: [{
      name: "schedule",
      schedule: "*-*-* *:*:00",
      command: ["/usr/local/bin/php", "artisan", "schedule:run"],
    }],
    ...patch,
  }) as EnvironmentDeploySite;

const ENV_FILE = `/etc/turbopanel/site-env/alice/${
  siteEnvFileId("env1", "web")
}.env`;

test("a release-backed site's jobs run in the release root with its variables and PHP series", () => {
  const spec = siteCronSpec(layout, "env1", site(), BINDING, undefined);
  assertEquals(spec?.workingDirectory, `${SERVICE}/current`);
  assertEquals(spec?.environmentFile, ENV_FILE);
  assertEquals(spec?.phpSeries, "8.3");
  assertEquals(spec?.username, "alice");
});

test("a managed-directory site's jobs keep its document root, and still load the variables", () => {
  const spec = siteCronSpec(layout, "env1", site(), undefined, BINDING);
  assertEquals(spec?.workingDirectory, `${SERVICE}/public`);
  assertEquals(spec?.environmentFile, ENV_FILE);
});

test("a site with no PHP pins no series; one with no jobs or no principal has no spec", () => {
  assertEquals(
    siteCronSpec(layout, "env1", site({ php: undefined }), BINDING, undefined)
      ?.phpSeries,
    undefined,
  );
  assertEquals(
    siteCronSpec(layout, "env1", site({ cron: [] }), BINDING, undefined),
    undefined,
  );
  assertEquals(
    siteCronSpec(
      layout,
      "env1",
      site({ principal: undefined }),
      BINDING,
      undefined,
    ),
    undefined,
  );
});
