import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildTraditionalWebEndpointMap,
  buildTraditionalWebReachabilityFragment,
  resolveDockerHostGatewayAddress,
  TRADITIONAL_WEB_ENDPOINTS_ENV,
  traditionalWebEnvKeyForService,
} from "./traditional-web-docker.ts";
import { apacheSiteConfig, nginxSiteConfig } from "./traditional-web.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("traditionalWebEnvKeyForService sanitizes compose service names", () => {
  assertEquals(
    traditionalWebEnvKeyForService("my-app"),
    "TURBOPANEL_TRADITIONAL_WEB_MY_APP_URL",
  );
  assertEquals(
    traditionalWebEnvKeyForService("9frontend"),
    "TURBOPANEL_TRADITIONAL_WEB__9FRONTEND_URL",
  );
});

test("buildTraditionalWebReachabilityFragment is empty without sites or services", () => {
  assertEquals(
    buildTraditionalWebReachabilityFragment(
      [],
      { serviceNames: ["api"], services: { api: { image: "node:22" } } },
    ),
    {},
  );
  assertEquals(
    buildTraditionalWebReachabilityFragment(
      [{ composeServiceName: "static", listenPort: 18080 }],
      { serviceNames: [], services: {} },
    ),
    {},
  );
});

test({
  name: "resolveDockerHostGatewayAddress prefers a valid TURBOPANEL_DOCKER_HOST_GATEWAY",
  permissions: { env: true, run: ["ip"] },
  fn: async () => {
    const previous = Deno.env.get("TURBOPANEL_DOCKER_HOST_GATEWAY");
    try {
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
    }
  },
});

test("buildTraditionalWebReachabilityFragment adds extra_hosts and env URLs", () => {
  const fragment = buildTraditionalWebReachabilityFragment(
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
    service.environment[TRADITIONAL_WEB_ENDPOINTS_ENV] ?? "",
    "18080",
  );
  assertEquals(
    service.environment[traditionalWebEnvKeyForService("static")],
    "http://host.docker.internal:18080",
  );
});

test("buildTraditionalWebEndpointMap keys by compose service name", () => {
  assertEquals(
    buildTraditionalWebEndpointMap([
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
