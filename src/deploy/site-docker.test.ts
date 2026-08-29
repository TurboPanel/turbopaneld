import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSiteEndpointMap,
  buildSiteReachabilityFragment,
  resolveDockerHostGatewayAddress,
  SITE_ENDPOINTS_ENV,
  siteEnvKeyForService,
} from "./site-docker.ts";
import { apacheSiteConfig, nginxSiteConfig } from "./site.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("siteEnvKeyForService sanitizes compose service names", () => {
  assertEquals(
    siteEnvKeyForService("my-app"),
    "TURBOPANEL_SITE_MY_APP_URL",
  );
  assertEquals(
    siteEnvKeyForService("9frontend"),
    "TURBOPANEL_SITE__9FRONTEND_URL",
  );
});

test("buildSiteReachabilityFragment is empty without sites or services", () => {
  assertEquals(
    buildSiteReachabilityFragment(
      [],
      { serviceNames: ["api"], services: { api: { image: "node:22" } } },
    ),
    {},
  );
  assertEquals(
    buildSiteReachabilityFragment(
      [{ composeServiceName: "static", listenPort: 18080 }],
      { serviceNames: [], services: {} },
    ),
    {},
  );
});

test({
  name:
    "resolveDockerHostGatewayAddress prefers a valid TURBOPANEL_DOCKER_HOST_GATEWAY",
  permissions: { env: true, run: ["ip"] },
  fn: async () => {
    const previous = Deno.env.get("TURBOPANEL_DOCKER_HOST_GATEWAY");
    const previousLd = Deno.env.get("LD_LIBRARY_PATH");
    try {
      // CI setup-python exports this; scoped --allow-run=ip must still spawn.
      Deno.env.set("LD_LIBRARY_PATH", "/usr/lib");
      Deno.env.set("TURBOPANEL_DOCKER_HOST_GATEWAY", "203.0.113.50");
      assertEquals(await resolveDockerHostGatewayAddress(), "203.0.113.50");

      Deno.env.set("TURBOPANEL_DOCKER_HOST_GATEWAY", "not-an-ip");
      const fallback = await resolveDockerHostGatewayAddress();
      // Invalid override falls through to ip/docker0 or the Docker default.
      assertEquals(typeof fallback, "string");
      assertEquals(fallback.includes("."), true);
    } finally {
      if (previous === undefined) {
        Deno.env.delete("TURBOPANEL_DOCKER_HOST_GATEWAY");
      } else {
        Deno.env.set("TURBOPANEL_DOCKER_HOST_GATEWAY", previous);
      }
      if (previousLd === undefined) {
        Deno.env.delete("LD_LIBRARY_PATH");
      } else {
        Deno.env.set("LD_LIBRARY_PATH", previousLd);
      }
    }
  },
});

test("buildSiteReachabilityFragment adds extra_hosts and env URLs", () => {
  const fragment = buildSiteReachabilityFragment(
    [{ composeServiceName: "static", listenPort: 18080 }],
    {
      serviceNames: ["api"],
      services: { api: { image: "node:22" } },
    },
  );
  const service = fragment.services?.api as {
    extra_hosts: string[];
    environment: Record<string, string>;
  };
  assertEquals(service.extra_hosts, ["host.docker.internal:host-gateway"]);
  assertStringIncludes(
    service.environment[SITE_ENDPOINTS_ENV] ?? "",
    "18080",
  );
  assertEquals(
    service.environment[siteEnvKeyForService("static")],
    "http://host.docker.internal:18080",
  );
});

test("buildSiteEndpointMap keys by compose service name", () => {
  assertEquals(
    buildSiteEndpointMap([
      { composeServiceName: "a", listenPort: 18080 },
      { composeServiceName: "b", listenPort: 18081 },
    ]),
    {
      a: "http://host.docker.internal:18080",
      b: "http://host.docker.internal:18081",
    },
  );
});

test("nginxSiteConfig adds docker bridge listen when bind address provided", () => {
  const conf = nginxSiteConfig(
    {
      composeServiceName: "site",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
    },
    "/var/lib/turbopanel/sites/env/site/public",
    "172.17.0.1",
  );
  assertStringIncludes(conf, "listen 172.17.0.1:18080;");
});

test("apacheSiteConfig adds docker VirtualHost address when bind provided", () => {
  const conf = apacheSiteConfig(
    {
      composeServiceName: "site",
      engine: "apache",
      root: "public",
      listenPort: 18081,
    },
    "/var/lib/turbopanel/sites/env/site/public",
    { dockerBindAddress: "172.17.0.1" },
  );
  assertStringIncludes(conf, "Listen 172.17.0.1:18081");
  assertStringIncludes(conf, "<VirtualHost 127.0.0.1:18081 172.17.0.1:18081>");
});
