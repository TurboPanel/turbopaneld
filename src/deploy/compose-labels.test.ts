import { assertEquals, assertThrows } from "@std/assert";
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
  organizationId: "org_123",
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
    labels["traefik.http.routers.hosting_123.entrypoints"],
    "web,websecure",
  );
  assertEquals(
    labels["traefik.http.routers.hosting_123.rule"],
    "(Host(`app.example.test`) || Host(`www.example.test`)) && PathPrefix(`/api`)",
  );
  assertEquals(
    labels["traefik.http.services.hosting_123.loadbalancer.server.port"],
    "3000",
  );
  assertEquals(labels["com.turbopanel.project"], "project_123");
  assertEquals(labels["com.turbopanel.raw-port"], undefined);
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

test("injectHostingLabels rejects nested object label values", () => {
  assertThrows(
    () =>
      injectHostingLabels({
        ...payload,
        composeYaml: `services:
  app:
    image: nginx:alpine
    labels:
      nested: { oops: true }
`,
      }),
    TypeError,
    "Compose label values must be strings or scalars",
  );
});

test("injectHostingLabels stringifies scalar label values", () => {
  const result = injectHostingLabels({
    ...payload,
    composeYaml: `services:
  app:
    image: nginx:alpine
    labels:
      numeric: 42
      flag: true
`,
  });
  const compose = parse(result.composeYaml) as {
    services: { app: { labels: Record<string, string> } };
  };
  assertEquals(compose.services.app.labels.numeric, "42");
  assertEquals(compose.services.app.labels.flag, "true");
});

const tcpUdpPayload: EnvironmentDeployPayload = {
  environmentId: "env_123",
  projectId: "project_123",
  organizationId: "org_123",
  projectName: "web_app",
  composeYaml: `services:
  db:
    image: postgres:16
`,
  hostings: [{
    hostingId: "hosting_db",
    serviceId: "service_db",
    composeServiceName: "db",
    hostnames: [],
    protocol: "tcp",
    ports: [{ published: 5432, target: 5432 }],
    bindAddress: "203.0.113.10",
  }],
};

test("injectHostingLabels configures a tcp router+service per published port, no hostname rule", () => {
  const result = injectHostingLabels(tcpUdpPayload);
  const compose = parse(result.composeYaml) as {
    services: { db: { labels: Record<string, string>; networks: string[] } };
  };
  const labels = compose.services.db.labels;

  assertEquals(result.services, ["db"]);
  assertEquals(labels["traefik.enable"], "true");
  assertEquals(
    labels["traefik.tcp.routers.hosting_db-5432.entrypoints"],
    "tcp5432",
  );
  assertEquals(
    labels["traefik.tcp.routers.hosting_db-5432.rule"],
    "HostSNI(`*`)",
  );
  assertEquals(
    labels["traefik.tcp.services.hosting_db-5432.loadbalancer.server.port"],
    "5432",
  );
  assertEquals(labels["traefik.http.routers.hosting_db-5432.rule"], undefined);
  assertEquals(labels["com.turbopanel.raw-port"], "true");
  assertEquals(compose.services.db.networks, ["turbopanel-ingress"]);
});

test("injectHostingLabels configures a udp router+service with no rule label", () => {
  const result = injectHostingLabels({
    ...tcpUdpPayload,
    hostings: [{
      ...tcpUdpPayload.hostings[0],
      protocol: "udp",
      ports: [{ published: 5300, target: 53 }],
    }],
  });
  const compose = parse(result.composeYaml) as {
    services: { db: { labels: Record<string, string> } };
  };
  const labels = compose.services.db.labels;
  assertEquals(
    labels["traefik.udp.routers.hosting_db-5300.entrypoints"],
    "udp5300",
  );
  assertEquals(
    labels["traefik.udp.services.hosting_db-5300.loadbalancer.server.port"],
    "53",
  );
  assertEquals(labels["traefik.udp.routers.hosting_db-5300.rule"], undefined);
});

test("injectHostingLabels rejects a tcp/udp hosting with empty ports", () => {
  assertThrows(
    () =>
      injectHostingLabels({
        ...tcpUdpPayload,
        hostings: [{ ...tcpUdpPayload.hostings[0], ports: undefined }],
      }),
    Error,
    "ports must not be empty",
  );
});

test("injectHostingLabels stamps raw-port on tcp/udp and pins HTTP entrypoints on mixed services", () => {
  const result = injectHostingLabels({
    environmentId: "env_123",
    projectId: "project_123",
    organizationId: "org_123",
    projectName: "web_app",
    composeYaml: `services:
  app:
    image: nginx:alpine
`,
    hostings: [
      {
        hostingId: "hosting_http",
        serviceId: "service_mixed",
        composeServiceName: "app",
        hostnames: ["app.example.test"],
        targetPort: 8080,
      },
      {
        hostingId: "hosting_tcp",
        serviceId: "service_mixed",
        composeServiceName: "app",
        hostnames: [],
        protocol: "tcp",
        ports: [{ published: 5432, target: 5432 }],
      },
    ],
  });
  const compose = parse(result.composeYaml) as {
    services: { app: { labels: Record<string, string> } };
  };
  const labels = compose.services.app.labels;

  // Per-service Traefik selects only raw-port containers.
  assertEquals(labels["com.turbopanel.raw-port"], "true");
  assertEquals(labels["com.turbopanel.service"], "service_mixed");

  // HTTP stays on shared loopback Traefik entrypoints.
  assertEquals(
    labels["traefik.http.routers.hosting_http.entrypoints"],
    "web,websecure",
  );
  assertEquals(
    labels["traefik.http.routers.hosting_http.rule"],
    "Host(`app.example.test`)",
  );

  // TCP routers keep their dedicated entrypoints (not web/websecure).
  assertEquals(
    labels["traefik.tcp.routers.hosting_tcp-5432.entrypoints"],
    "tcp5432",
  );
  assertEquals(
    labels["traefik.http.routers.hosting_tcp-5432.entrypoints"],
    undefined,
  );
});

test("injectHostingLabels does not stamp raw-port on HTTP-only services", () => {
  const result = injectHostingLabels(payload);
  const compose = parse(result.composeYaml) as {
    services: { app: { labels: Record<string, string> } };
  };
  assertEquals(
    compose.services.app.labels["com.turbopanel.raw-port"],
    undefined,
  );
  assertEquals(
    compose.services.app.labels["traefik.http.routers.hosting_123.entrypoints"],
    "web,websecure",
  );
});
