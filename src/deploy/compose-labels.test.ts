import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parse } from "yaml";
import { injectHostingLabels } from "./compose-labels.ts";
import {
  type EnvironmentDeployPayload,
  parseEnvironmentDeployPayload,
} from "../instance/commands/contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const payload: EnvironmentDeployPayload = {
  environmentId: "env_123",
  projectId: "project_123",
  projectName: "web_app",
  composeYaml: `services:
  app:
    image: nginx:alpine
    labels:
      existing.label: preserved
`,
  hostings: [{
    hostingId: "hosting_123",
    serviceId: "service_123",
    composeServiceName: "app",
    hostnames: ["app.example.test", "www.example.test"],
    pathPrefix: "/api",
    targetPort: 3000,
  }],
};

test("injectHostingLabels configures Traefik and ingress network", () => {
  const result = injectHostingLabels(payload);
  const compose = parse(result.composeYaml) as {
    services: { app: { labels: Record<string, string>; networks: string[] } };
    networks: { "turbopanel-ingress": { external: boolean } };
  };
  const labels = compose.services.app.labels;

  assertEquals(result.services, ["app"]);
  assertEquals(labels["traefik.enable"], "true");
  assertEquals(labels["traefik.docker.network"], "turbopanel-ingress");
  assertEquals(
    labels["traefik.http.routers.hosting_123.rule"],
    "(Host(`app.example.test`) || Host(`www.example.test`)) && PathPrefix(`/api`)",
  );
  assertEquals(
    labels["traefik.http.services.hosting_123.loadbalancer.server.port"],
    "3000",
  );
  assertEquals(labels["com.turbopanel.project"], "project_123");
  assertEquals(compose.services.app.networks, ["turbopanel-ingress"]);
  assertEquals(compose.networks["turbopanel-ingress"].external, true);
});

test("parseEnvironmentDeployPayload rejects invalid hosting routes", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...payload,
        hostings: [{ ...payload.hostings[0], hostnames: ["unsafe host"] }],
      }),
    TypeError,
  );
});
