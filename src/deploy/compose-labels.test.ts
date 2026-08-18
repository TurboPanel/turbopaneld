import { assertEquals, assertThrows } from "@std/assert";
import { buildHostingLabelsFragment } from "./compose-labels.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";
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

function resolvedFromServices(
  services: Record<string, Record<string, unknown>>,
): ResolvedComposeModel {
  return {
    services,
    serviceNames: Object.keys(services).sort((a, b) => a.localeCompare(b)),
  };
}

const payload: EnvironmentDeployPayload = {
  environmentId: "env_123",
  projectId: "project_123",
  organizationId: "org_123",
  projectName: "web_app",
  composeYaml: `services:
  app:
    image: nginx:alpine
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

const appResolved = resolvedFromServices({
  app: { image: "nginx:alpine" },
});

test("buildHostingLabelsFragment configures Traefik and ingress network", () => {
  const fragment = buildHostingLabelsFragment({
    payload,
    hostings: payload.hostings,
    resolved: appResolved,
  });
  const labels = fragment.services?.app?.labels as Record<string, string>;

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
  assertEquals(fragment.services?.app?.networks, ["turbopanel-ingress"]);
  assertEquals(
    (fragment.networks as Record<string, { external: boolean }>)[
      "turbopanel-ingress"
    ].external,
    true,
  );
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

const dbResolved = resolvedFromServices({
  db: { image: "postgres:16" },
});

test("buildHostingLabelsFragment configures a tcp router+service per published port, no hostname rule", () => {
  const fragment = buildHostingLabelsFragment({
    payload: tcpUdpPayload,
    hostings: tcpUdpPayload.hostings,
    resolved: dbResolved,
  });
  const labels = fragment.services?.db?.labels as Record<string, string>;

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
  assertEquals(fragment.services?.db?.networks, ["turbopanel-ingress"]);
});

test("buildHostingLabelsFragment configures a udp router+service with no rule label", () => {
  const fragment = buildHostingLabelsFragment({
    payload: {
      ...tcpUdpPayload,
      hostings: [{
        ...tcpUdpPayload.hostings[0],
        protocol: "udp",
        ports: [{ published: 5300, target: 53 }],
      }],
    },
    hostings: [{
      ...tcpUdpPayload.hostings[0],
      protocol: "udp",
      ports: [{ published: 5300, target: 53 }],
    }],
    resolved: dbResolved,
  });
  const labels = fragment.services?.db?.labels as Record<string, string>;
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

test("buildHostingLabelsFragment rejects a tcp/udp hosting with empty ports", () => {
  assertThrows(
    () =>
      buildHostingLabelsFragment({
        payload: tcpUdpPayload,
        hostings: [{ ...tcpUdpPayload.hostings[0], ports: undefined }],
        resolved: dbResolved,
      }),
    Error,
    "ports must not be empty",
  );
});

test("buildHostingLabelsFragment stamps raw-port on tcp/udp and pins HTTP entrypoints on mixed services", () => {
  const fragment = buildHostingLabelsFragment({
    payload: {
      environmentId: "env_123",
      projectId: "project_123",
      organizationId: "org_123",
      projectName: "web_app",
      composeYaml: `services:\n  app:\n    image: nginx:alpine\n`,
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
    },
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
    resolved: appResolved,
  });
  const labels = fragment.services?.app?.labels as Record<string, string>;

  assertEquals(labels["com.turbopanel.raw-port"], "true");
  assertEquals(labels["com.turbopanel.service"], "service_mixed");
  assertEquals(
    labels["traefik.http.routers.hosting_http.entrypoints"],
    "web,websecure",
  );
  assertEquals(
    labels["traefik.http.routers.hosting_http.rule"],
    "Host(`app.example.test`)",
  );
  assertEquals(
    labels["traefik.tcp.routers.hosting_tcp-5432.entrypoints"],
    "tcp5432",
  );
  assertEquals(
    labels["traefik.http.routers.hosting_tcp-5432.entrypoints"],
    undefined,
  );
});

test("buildHostingLabelsFragment does not stamp raw-port on HTTP-only services", () => {
  const fragment = buildHostingLabelsFragment({
    payload,
    hostings: payload.hostings,
    resolved: appResolved,
  });
  const labels = fragment.services?.app?.labels as Record<string, string>;
  assertEquals(labels["com.turbopanel.raw-port"], undefined);
  assertEquals(
    labels["traefik.http.routers.hosting_123.entrypoints"],
    "web,websecure",
  );
});

test("buildHostingLabelsFragment without hostings leaves services free of ingress network", () => {
  const fragment = buildHostingLabelsFragment({
    payload,
    hostings: [],
    resolved: appResolved,
  });
  assertEquals(fragment.services, undefined);
  assertEquals(fragment.networks, undefined);
});

test("buildHostingLabelsFragment attaches turbopanel-managed to managedNetworkServices", () => {
  const fragment = buildHostingLabelsFragment({
    payload: {
      ...payload,
      hostings: [],
      managedNetworkServices: ["app"],
    },
    hostings: [],
    resolved: appResolved,
  });
  assertEquals(fragment.services?.app?.networks, ["turbopanel-managed"]);
  assertEquals(
    (fragment.networks as Record<string, { external: boolean }>)[
      "turbopanel-managed"
    ]?.external,
    true,
  );
});

test("buildHostingLabelsFragment merges ingress and managed networks on the same service", () => {
  const fragment = buildHostingLabelsFragment({
    payload: {
      ...payload,
      managedNetworkServices: ["app"],
    },
    hostings: payload.hostings,
    resolved: appResolved,
  });
  assertEquals(fragment.services?.app?.networks, [
    "turbopanel-ingress",
    "turbopanel-managed",
  ]);
  assertEquals(
    (fragment.networks as Record<string, { external: boolean }>)[
      "turbopanel-ingress"
    ]?.external,
    true,
  );
  assertEquals(
    (fragment.networks as Record<string, { external: boolean }>)[
      "turbopanel-managed"
    ]?.external,
    true,
  );
});

test("buildHostingLabelsFragment rejects an unknown managedNetworkServices entry", () => {
  assertThrows(
    () =>
      buildHostingLabelsFragment({
        payload: {
          ...payload,
          hostings: [],
          managedNetworkServices: ["does-not-exist"],
        },
        hostings: [],
        resolved: appResolved,
      }),
    Error,
    "Compose service not found: does-not-exist",
  );
});

test("buildHostingLabelsFragment leaves network free when managedNetworkServices is absent", () => {
  const fragment = buildHostingLabelsFragment({
    payload: { ...payload, hostings: [] },
    hostings: [],
    resolved: appResolved,
  });
  assertEquals(fragment.networks?.["turbopanel-managed"], undefined);
});

test("buildHostingLabelsFragment unions resolved service networks with platform network", () => {
  const fragment = buildHostingLabelsFragment({
    payload,
    hostings: payload.hostings,
    resolved: resolvedFromServices({
      app: {
        image: "nginx:alpine",
        networks: { frontend: {}, backend: {} },
      },
    }),
  });
  assertEquals(fragment.services?.app?.networks, [
    "frontend",
    "backend",
    "turbopanel-ingress",
  ]);
});

test("buildHostingLabelsFragment unions list-form networks and proxy middlewares", () => {
  const fragment = buildHostingLabelsFragment({
    payload: {
      ...payload,
      hostings: [{
        ...payload.hostings[0],
        pathPrefix: undefined,
        proxy: {
          stripPrefix: "/api",
          gzip: true,
          brotli: true,
        },
      }],
    },
    hostings: [{
      ...payload.hostings[0],
      pathPrefix: undefined,
      proxy: {
        stripPrefix: "/api",
        gzip: true,
        brotli: true,
      },
    }],
    resolved: resolvedFromServices({
      app: {
        image: "nginx:alpine",
        networks: ["frontend", "", 12],
      },
    }),
  });
  const labels = fragment.services?.app?.labels as Record<string, string>;
  assertEquals(fragment.services?.app?.networks, [
    "frontend",
    "turbopanel-ingress",
  ]);
  assertEquals(
    labels["traefik.http.routers.hosting_123.rule"],
    "Host(`app.example.test`) || Host(`www.example.test`)",
  );
  assertEquals(
    labels["traefik.http.middlewares.hosting_123-strip.stripprefix.prefixes"],
    "/api",
  );
  assertEquals(
    labels["traefik.http.middlewares.hosting_123-compress.compress"],
    "true",
  );
  assertEquals(
    labels[
      "traefik.http.middlewares.hosting_123-compress.compress.encodings"
    ],
    "gzip,br",
  );
});

test("buildHostingLabelsFragment rejects unsafe router ids and pathPrefix", () => {
  assertThrows(
    () =>
      buildHostingLabelsFragment({
        payload,
        hostings: [{
          ...payload.hostings[0],
          hostingId: "bad.id",
        }],
        resolved: appResolved,
      }),
    Error,
    "must contain only letters, digits, hyphens, and underscores",
  );
  assertThrows(
    () =>
      buildHostingLabelsFragment({
        payload,
        hostings: [{
          ...payload.hostings[0],
          pathPrefix: "/api`x",
        }],
        resolved: appResolved,
      }),
    Error,
    "unsupported character",
  );
});
