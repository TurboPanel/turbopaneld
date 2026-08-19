import { assertEquals, assertThrows } from "@std/assert";
import {
  COMMAND_TYPES,
  type CommandAckMessage,
  type CommandDispatchMessage,
  type CommandOutcomeMessage,
  parseEnvironmentDeployPayload,
  parseEnvironmentLifecyclePayload,
  parseEnvironmentStopPayload,
  parseFabricReconcilePayload,
  parseFabricReconcileResult,
  parseManagedApplyPayload,
  parseManagedApplyResult,
  parseManagedBackupPayload,
  parseManagedBackupResult,
  parseManagedDestroyPayload,
  parseManagedDestroyResult,
  parseManagedHaFailoverPayload,
  parseManagedHaFailoverResult,
  parseManagedHaReconcilePayload,
  parseManagedHaReconcileResult,
  parseManagedIngressReconcilePayload,
  parseManagedLifecyclePayload,
  parseManagedLifecycleResult,
  parseManagedPromotePayload,
  parseManagedPromoteResult,
  parseManagedRestorePayload,
  parseManagedRestoreResult,
  parseSystemReconcilePayload,
} from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Byte-identical order with instance `src/lib/commands/types.ts` COMMAND_TYPES. */
const INSTANCE_COMMAND_TYPES = [
  "daemon.ping",
  "server.hostname.set",
  "server.ntp.set",
  "server.reboot",
  "server.timezone.set",
  "server.fabric.reconcile",
  "environment.deploy",
  "environment.lifecycle",
  "environment.stop",
  "managed.apply",
  "managed.lifecycle",
  "managed.destroy",
  "managed.backup",
  "managed.restore",
  "managed.promote",
  "managed.ingress.reconcile",
  "managed.ha.reconcile",
  "managed.ha.failover",
  "system.reconcile",
] as const;

test("COMMAND_TYPES matches instance canonical order", () => {
  assertEquals([...COMMAND_TYPES], [...INSTANCE_COMMAND_TYPES]);
});

test("environment.deploy hosting fixture round-trips bindAddress", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  web:\n    image: nginx\n",
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
        bindAddress: "203.0.113.10",
      },
    ],
  });
  assertEquals(payload.hostings[0]?.bindAddress, "203.0.113.10");
});

test("environment.deploy composeFiles round-trips and preserves order", () => {
  const composeFiles = [
    {
      filename: "docker-compose.yml",
      role: "project" as const,
      content: "services:\n  web:\n    image: nginx\n",
    },
    {
      filename: "docker-compose.prod.yml",
      role: "environment" as const,
      source: "inline" as const,
      content: "services:\n  web:\n    restart: always\n",
    },
    {
      filename: "docker-compose.turbopanel.yml",
      role: "platform" as const,
      content: "services:\n  web:\n    container_name: abc\n",
    },
  ];
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [],
    composeFiles,
  });
  assertEquals(payload.composeFiles, composeFiles);
  assertEquals(
    payload.composeFiles?.map((f) => f.filename),
    [
      "docker-compose.yml",
      "docker-compose.prod.yml",
      "docker-compose.turbopanel.yml",
    ],
  );
});

test("environment.deploy rejects invalid composeFiles", () => {
  const base = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [] as unknown[],
  };
  assertThrows(
    () => parseEnvironmentDeployPayload({ ...base, composeFiles: [] }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          { filename: "../evil.yml", role: "project", content: "x" },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          { filename: "nested/file.yml", role: "project", content: "x" },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          { filename: "compose.txt", role: "project", content: "x" },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          { filename: "docker-compose.yml", role: "project", content: "a" },
          {
            filename: "docker-compose.yml",
            role: "environment",
            content: "b",
          },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          { filename: "docker-compose.yml", role: "unknown", content: "a" },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          {
            filename: "docker-compose.yml",
            role: "project",
            source: "git",
            content: "a",
          },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          { filename: "docker-compose.yml", role: "project", content: "" },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          {
            filename: "docker-compose.turbopanel.yml",
            role: "platform",
            content: "p",
          },
          { filename: "docker-compose.yml", role: "project", content: "a" },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          { filename: "docker-compose.yml", role: "project", content: "a" },
          {
            filename: "docker-compose.platform.yml",
            role: "platform",
            content: "p1",
          },
          {
            filename: "docker-compose.turbopanel.yml",
            role: "platform",
            content: "p2",
          },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
});

test("environment.deploy omits composeFiles when absent (legacy)", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [],
  });
  assertEquals(payload.composeFiles, undefined);
});

test("environment.deploy composeFiles accepts repository source with a valid path", () => {
  const base = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [] as unknown[],
  };
  const payload = parseEnvironmentDeployPayload({
    ...base,
    composeFiles: [
      {
        filename: "docker-compose.yml",
        role: "project",
        source: "repository",
        path: "deploy/docker-compose.yml",
        content: "services:\n  web:\n    image: nginx\n",
      },
    ],
  });
  assertEquals(payload.composeFiles?.[0]?.source, "repository");
  assertEquals(payload.composeFiles?.[0]?.path, "deploy/docker-compose.yml");
});

test("environment.deploy composeFiles rejects a path with traversal or a leading slash", () => {
  const base = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [] as unknown[],
  };
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          {
            filename: "docker-compose.yml",
            role: "project",
            source: "repository",
            path: "../evil/docker-compose.yml",
            content: "a",
          },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          {
            filename: "docker-compose.yml",
            role: "project",
            source: "repository",
            path: "/etc/docker-compose.yml",
            content: "a",
          },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...base,
        composeFiles: [
          {
            filename: "docker-compose.yml",
            role: "project",
            source: "repository",
            path: "",
            content: "a",
          },
        ],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
});

test("EnvironmentDeployComposeFile shape stays structurally identical to the instance canonical type (including path)", () => {
  const composeFiles = [
    {
      filename: "docker-compose.yml",
      role: "project" as const,
      source: "repository" as const,
      path: "deploy/docker-compose.yml",
      content: "services:\n  web:\n    image: nginx\n",
    },
  ];
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [],
    composeFiles,
  });
  assertEquals(payload.composeFiles, composeFiles);
});

test("environment.deploy hosting fixture round-trips tcp protocol and ports", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  db:\n    image: postgres\n",
    hostings: [
      {
        hostingId: "h2",
        serviceId: "s2",
        composeServiceName: "db",
        hostnames: [],
        protocol: "tcp",
        ports: [{ published: 5432, target: 5432 }],
        bindAddress: "203.0.113.10",
      },
    ],
  });
  assertEquals(payload.hostings[0]?.protocol, "tcp");
  assertEquals(payload.hostings[0]?.ports, [{ published: 5432, target: 5432 }]);
});

test("environment.deploy storageMaterial accepts volume without mounts", () => {
  const volumeId = "01936b3e-8c7a-7b2d-a1f0-123456789abc";
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  web:\n    image: nginx\n",
    hostings: [],
    storageMaterial: [
      {
        storageId: volumeId,
        locationId: "loc-1",
        kind: "volume",
        name: "data",
        provider: "docker",
        serverId: "srv-1",
        volumeName: volumeId,
        mounts: [],
      },
    ],
  });
  assertEquals(payload.storageMaterial?.[0]?.volumeName, volumeId);
  assertEquals(payload.storageMaterial?.[0]?.mounts, []);
});

test("environment.deploy storageMaterial rejects invalid volumeName", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "demo",
        composeYaml: "services: {}\n",
        hostings: [],
        storageMaterial: [
          {
            storageId: "st1",
            locationId: "loc1",
            kind: "volume",
            name: "data",
            provider: "docker",
            serverId: "srv-1",
            volumeName: "-bad",
            mounts: [],
          },
        ],
      }),
    TypeError,
    "volumeName",
  );
});

test("environment.deploy traditionalWebSites fixture round-trips", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "site",
        hostnames: ["site.example.com"],
      },
    ],
    traditionalWebSites: [
      {
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        principal: {
          principalId: "00000000-0000-4000-8000-000000000099",
          username: "site_user",
        },
      },
    ],
  });
  assertEquals(payload.traditionalWebSites?.[0]?.engine, "nginx");
  assertEquals(payload.traditionalWebSites?.[0]?.listenPort, 18080);
  assertEquals(
    payload.traditionalWebSites?.[0]?.principal?.username,
    "site_user",
  );
});

test("environment.deploy principalMaterial round-trips without uid/gid", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [],
    principalMaterial: [
      {
        principalId: "00000000-0000-4000-8000-000000000099",
        username: "app_user",
        home: "/srv/users/app_user",
        shell: "/usr/sbin/nologin",
      },
    ],
  });
  assertEquals(
    payload.principalMaterial?.[0]?.home,
    "/srv/users/app_user",
  );
  assertEquals(payload.principalMaterial?.[0]?.shell, "/usr/sbin/nologin");
  assertEquals(payload.principalMaterial?.[0]?.uid, undefined);
  assertEquals(payload.principalMaterial?.[0]?.gid, undefined);
});

test("environment.deploy principalMaterial round-trips with uid/gid", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [],
    principalMaterial: [
      {
        principalId: "00000000-0000-4000-8000-000000000099",
        username: "app_user",
        uid: 10001,
        gid: 10001,
        home: "/srv/users/app_user",
        shell: "/usr/sbin/nologin",
      },
    ],
  });
  assertEquals(payload.principalMaterial?.[0]?.uid, 10001);
  assertEquals(payload.principalMaterial?.[0]?.gid, 10001);
  assertEquals(
    payload.principalMaterial?.[0]?.home,
    "/srv/users/app_user",
  );
});

test("environment.deploy principalMaterial rejects negative uid", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "demo",
        composeYaml: "services: {}\n",
        hostings: [],
        principalMaterial: [
          {
            principalId: "00000000-0000-4000-8000-000000000099",
            username: "app_user",
            uid: -1,
            home: "/srv/users/app_user",
          },
        ],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial entry",
  );
});

test("environment.deploy principalMaterial rejects non-integer uid", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "demo",
        composeYaml: "services: {}\n",
        hostings: [],
        principalMaterial: [
          {
            principalId: "00000000-0000-4000-8000-000000000099",
            username: "app_user",
            uid: 1.5,
            home: "/srv/users/app_user",
          },
        ],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial entry",
  );
});

test("environment.deploy round-trips fabricNetworks and rejects invalid entries", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  web:\n    image: nginx\n",
    hostings: [],
    fabricNetworks: [
      {
        name: "tpn_net1",
        subnet: "203.0.113.0/24",
        mtu: 1420,
        gateway: "203.0.113.1",
      },
    ],
  });
  assertEquals(payload.fabricNetworks, [
    {
      name: "tpn_net1",
      subnet: "203.0.113.0/24",
      mtu: 1420,
      gateway: "203.0.113.1",
    },
  ]);
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "demo",
        composeYaml: "services:\n  web:\n    image: nginx\n",
        hostings: [],
        fabricNetworks: [{ name: "-bad", subnet: "203.0.113.0/24" }],
      }),
    TypeError,
    "Invalid fabricNetworks name",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "demo",
        composeYaml: "services:\n  web:\n    image: nginx\n",
        hostings: [],
        fabricNetworks: [{ name: "tpn_net1", subnet: "not-a-cidr" }],
      }),
    TypeError,
    "Invalid fabricNetworks subnet",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "demo",
        composeYaml: "services:\n  web:\n    image: nginx\n",
        hostings: [],
        fabricNetworks: [{
          name: "tpn_net1",
          subnet: "203.0.113.0/24",
          mtu: 1279,
        }],
      }),
    TypeError,
    "Invalid fabricNetworks mtu",
  );
});

test("environment.deploy round-trips dockerExternalNetworks and serviceHooks", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  web:\n    image: nginx\n",
    hostings: [],
    dockerExternalNetworks: ["org-net-a"],
    serviceHooks: [
      {
        composeServiceName: "web",
        preDeployCommand: "echo pre",
        postDeployCommand: "echo post",
        buildDisableCache: true,
      },
    ],
  });
  assertEquals(payload.dockerExternalNetworks, ["org-net-a"]);
  assertEquals(payload.serviceHooks?.[0]?.composeServiceName, "web");
  assertEquals(payload.serviceHooks?.[0]?.preDeployCommand, "echo pre");
  assertEquals(payload.serviceHooks?.[0]?.postDeployCommand, "echo post");
  assertEquals(payload.serviceHooks?.[0]?.buildDisableCache, true);
});

test("environment.deploy round-trips managedNetworkServices and rejects hostile entries", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  app:\n    image: nginx\n",
    hostings: [],
    managedNetworkServices: ["app", "app"],
  });
  // Deduped and sorted, mirroring the instance parser.
  assertEquals(payload.managedNetworkServices, ["app"]);
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "demo",
        composeYaml: "services:\n  app:\n    image: nginx\n",
        hostings: [],
        managedNetworkServices: ["bad;name"],
      }),
    TypeError,
    "Invalid managedNetworkServices entry",
  );
});

test("environment.deploy round-trips noCache", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  web:\n    image: nginx\n",
    hostings: [],
    noCache: true,
  });
  assertEquals(payload.noCache, true);
});

test("environment.deploy rejects non-boolean noCache", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "demo",
        composeYaml: "services:\n  web:\n    image: nginx\n",
        hostings: [],
        noCache: "yes",
      }),
    TypeError,
    "noCache must be a boolean",
  );
});

test("environment.deploy round-trips envFile and secretPlan", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  web:\n    image: nginx\n",
    hostings: [],
    envFile: "web__PORT=3000\n",
    secretPlan: [{
      key: "TOKEN",
      composeServiceName: "web",
      source: "web_token",
      target: "TOKEN",
      relativePath: "web--TOKEN",
      forBuild: false,
      forRuntime: true,
    }],
  });
  assertEquals(payload.envFile, "web__PORT=3000\n");
  assertEquals(payload.secretPlan?.[0]?.source, "web_token");
});

test("environment.stop payload parser round-trips", () => {
  assertEquals(
    parseEnvironmentStopPayload({
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
    },
  );
  assertEquals(
    parseEnvironmentStopPayload({
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      fabricNetworks: ["tpn_net1"],
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      fabricNetworks: ["tpn_net1"],
    },
  );
  assertThrows(
    () => parseEnvironmentStopPayload(null),
    TypeError,
    "Invalid environment stop payload",
  );
  assertThrows(
    () => parseEnvironmentStopPayload({ environmentId: "env-1" }),
    TypeError,
    "projectId must be a non-empty string",
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        fabricNetworks: ["bridge_net1"],
      }),
    TypeError,
    "Invalid environment.stop fabricNetworks name",
  );
});

test("environment.lifecycle payload parser round-trips", () => {
  assertEquals(
    parseEnvironmentLifecyclePayload({
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      action: "restart",
    }),
    {
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      action: "restart",
    },
  );
  assertThrows(
    () =>
      parseEnvironmentLifecyclePayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        action: "down",
      }),
    TypeError,
    "Invalid environment lifecycle payload",
  );
});

test("system.reconcile payload parser round-trips and rejects invalid shapes", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assertEquals(
    parseSystemReconcilePayload({
      environmentId: "11111111-2222-3333-4444-555555555555",
      action: "restart",
      components: [
        {
          component: "hosting-ingress",
          serviceId,
          composeServiceName: "traefik",
          containerName: `${serviceId}-in`,
          role: "ingress",
          desired: "present",
        },
      ],
    }),
    {
      environmentId: "11111111-2222-3333-4444-555555555555",
      action: "restart",
      components: [
        {
          component: "hosting-ingress",
          serviceId,
          composeServiceName: "traefik",
          containerName: `${serviceId}-in`,
          role: "ingress",
          desired: "present",
        },
      ],
    },
  );
  assertEquals(
    parseSystemReconcilePayload({
      environmentId: "11111111-2222-3333-4444-555555555555",
      action: "stop",
      components: [
        {
          component: "hosting-ingress",
          serviceId,
          composeServiceName: "traefik",
          containerName: `${serviceId}-in`,
          role: "ingress",
          desired: "absent",
        },
      ],
    }).action,
    "stop",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId: "11111111-2222-3333-4444-555555555555",
        components: [
          {
            component: "not-allowlisted",
            serviceId,
            composeServiceName: "traefik",
            containerName: `${serviceId}-in`,
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId: "11111111-2222-3333-4444-555555555555",
        components: [
          {
            component: "hosting-ingress",
            serviceId,
            composeServiceName: "traefik",
            containerName: "wrong-name",
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
});

test("system.reconcile payload parser accepts database/queue/analytics with system role and bare serviceId containerName", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  for (const component of ["database", "queue", "analytics"] as const) {
    assertEquals(
      parseSystemReconcilePayload({
        environmentId: "11111111-2222-3333-4444-555555555555",
        components: [
          {
            component,
            serviceId,
            composeServiceName: component,
            containerName: serviceId,
            role: "turbopanel",
            desired: "present",
          },
        ],
      }).components[0],
      {
        component,
        serviceId,
        composeServiceName: component,
        containerName: serviceId,
        role: "turbopanel",
        desired: "present",
      },
    );
  }
});

test("system.reconcile payload parser accepts managed-ingress with system role and <serviceId>-sql containerName", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assertEquals(
    parseSystemReconcilePayload({
      environmentId: "11111111-2222-3333-4444-555555555555",
      components: [
        {
          component: "managed-ingress",
          serviceId,
          composeServiceName: "proxysql",
          containerName: `${serviceId}-sql`,
          role: "turbopanel",
          desired: "present",
        },
      ],
    }).components[0],
    {
      component: "managed-ingress",
      serviceId,
      composeServiceName: "proxysql",
      containerName: `${serviceId}-sql`,
      role: "turbopanel",
      desired: "present",
    },
  );
});

test("system.reconcile payload parser rejects role/containerName mismatches across the system/ingress split", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  // hosting-ingress must be role: "ingress" — declaring "service" is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId: "11111111-2222-3333-4444-555555555555",
        components: [
          {
            component: "hosting-ingress",
            serviceId,
            composeServiceName: "traefik",
            containerName: `${serviceId}-in`,
            role: "service",
            desired: "present",
          },
        ],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  // database must be role: "turbopanel" — declaring "ingress" is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId: "11111111-2222-3333-4444-555555555555",
        components: [
          {
            component: "database",
            serviceId,
            composeServiceName: "database",
            containerName: `${serviceId}-in`,
            role: "ingress",
            desired: "present",
          },
        ],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  // database with role: "turbopanel" but an ingress-shaped containerName is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId: "11111111-2222-3333-4444-555555555555",
        components: [
          {
            component: "database",
            serviceId,
            composeServiceName: "database",
            containerName: `${serviceId}-in`,
            role: "turbopanel",
            desired: "present",
          },
        ],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  // managed-ingress requires `<serviceId>-sql` — bare serviceId is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId: "11111111-2222-3333-4444-555555555555",
        components: [
          {
            component: "managed-ingress",
            serviceId,
            composeServiceName: "proxysql",
            containerName: serviceId,
            role: "turbopanel",
            desired: "present",
          },
        ],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  // managed-ingress with Traefik `-in` containerName is rejected.
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId: "11111111-2222-3333-4444-555555555555",
        components: [
          {
            component: "managed-ingress",
            serviceId,
            composeServiceName: "proxysql",
            containerName: `${serviceId}-in`,
            role: "turbopanel",
            desired: "present",
          },
        ],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
});

test("command wire message types carry required shape fields", () => {
  const dispatch: CommandDispatchMessage = {
    type: "command-dispatch",
    id: "corr-1",
    commandId: "cmd-1",
    commandType: "daemon.ping",
    payload: {},
    at: "2020-01-01T00:00:00.000Z",
  };
  assertEquals(dispatch.type, "command-dispatch");
  assertEquals(dispatch.commandType, "daemon.ping");

  const ack: CommandAckMessage = {
    type: "command-ack",
    id: "corr-1",
    at: "2020-01-01T00:00:01.000Z",
    daemonReceivedAt: "2020-01-01T00:00:01.000Z",
  };
  assertEquals(ack.type, "command-ack");
  assertEquals(ack.id, dispatch.id);

  const outcome: CommandOutcomeMessage = {
    type: "command-outcome",
    id: "corr-1",
    ok: true,
    result: { pong: true },
    at: "2020-01-01T00:00:02.000Z",
    daemonReceivedAt: ack.daemonReceivedAt,
    daemonRespondedAt: "2020-01-01T00:00:02.000Z",
  };
  assertEquals(outcome.type, "command-outcome");
  assertEquals(outcome.ok, true);
});

test("server.fabric.reconcile fixture round-trips", () => {
  const payload = parseFabricReconcilePayload({
    enabled: true,
    fabricId: "550e8400-e29b-41d4-a716-446655440000",
    address: "10.250.0.11/32",
    prefix: "10.192.0.0/16",
    mtu: 1420,
    peers: [
      {
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        allowedIPs: ["10.250.0.12/32", "10.193.0.0/16"],
        endpoint: "203.0.113.1:51820",
        keepalive: 25,
        presharedKeyEnvelope: "tpdaemon.v1.server.key.payload",
        pathKind: "gateway",
        viaServerId: "550e8400-e29b-41d4-a716-446655440001",
      },
    ],
    networks: [
      {
        name: "tpn_550e8400-e29b-41d4-a716-446655440000",
        subnet: "10.192.11.0/24",
        mtu: 1420,
        gateway: "10.192.11.1",
      },
    ],
    gateway: true,
  });
  assertEquals(payload.enabled, true);
  if (!payload.enabled) {
    throw new TypeError("expected enabled fabric payload");
  }
  assertEquals(payload.address, "10.250.0.11/32");
  assertEquals(payload.mtu, 1420);
  assertEquals(payload.peers[0]?.keepalive, 25);
  assertEquals(
    payload.peers[0]?.presharedKeyEnvelope,
    "tpdaemon.v1.server.key.payload",
  );
  assertEquals(payload.peers[0]?.pathKind, "gateway");
  assertEquals(
    payload.peers[0]?.viaServerId,
    "550e8400-e29b-41d4-a716-446655440001",
  );
  assertEquals(payload.gateway, true);
  assertEquals(payload.networks?.[0]?.gateway, "10.192.11.1");
  const result = parseFabricReconcileResult({
    summary: "TurboFabric reconciled",
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    peers: [
      {
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        lastHandshakeAt: "2020-01-01T00:00:00.000Z",
        transferRx: 1,
        transferTx: 2,
        endpoint: "203.0.113.50:48172",
        health: "healthy",
      },
    ],
  });
  assertEquals(result.peers?.[0]?.transferTx, 2);
});

test("server.fabric.reconcile disable result is summary-only", () => {
  const result = parseFabricReconcileResult({
    summary: "TurboFabric torn down",
  });
  assertEquals(result, { summary: "TurboFabric torn down" });
  assertEquals("publicKey" in result, false);
  assertEquals(result.skipped, undefined);
});

const VALID_MANAGED_APPLY = {
  managedId: "00000000-0000-4000-8000-000000000001",
  environmentId: "00000000-0000-4000-8000-000000000002",
  engine: "postgres",
  projectName: "tp-managed-pg",
  containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
  image: "docker.io/library/postgres:18-alpine",
  containerPort: 5432,
  composeYaml: "services:\n  postgres:\n    image: postgres:18-alpine\n",
  configFiles: [
    {
      path: "postgresql.conf",
      contents: "listen_addresses = '*'\n",
      mode: "0640",
    },
    {
      path: "pg_hba.conf",
      contents:
        "# TurboPanel managed PostgreSQL — platform pg_hba\nlocal all all peer\n",
      mode: "0640",
    },
  ],
  volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
  exposure: { enabled: false, protocol: "tcp" },
  credentials: [
    {
      principalId: "00000000-0000-4000-8000-000000000003",
      username: "postgres",
      role: "root",
      databases: ["postgres"],
      password: "tpdaemon.v1.server.key.payload",
    },
  ],
  memberId: "00000000-0000-4000-8000-0000000000a1",
  memberRole: "primary",
  memberOrdinal: 1,
  readEligible: false,
  peers: [],
} as const;

test("managed.apply fixture round-trips", () => {
  const payload = parseManagedApplyPayload(VALID_MANAGED_APPLY);
  assertEquals(payload.engine, "postgres");
  assertEquals(payload.projectName, "tp-managed-pg");
  assertEquals(
    payload.containerName,
    "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
  );
  assertEquals(payload.credentials[0]?.username, "postgres");
});

test("managed.apply enforces the engine image allowlist", () => {
  // Mirrors the instance release catalog
  // (`src/lib/managed/releases.ts`, surfaced through
  // `src/lib/managed/settings.ts`) so a forged/replayed command payload cannot
  // smuggle an unsupported or EOL image past this last daemon-side check
  // before Docker runs it.
  assertEquals(
    parseManagedApplyPayload(VALID_MANAGED_APPLY).image,
    "docker.io/library/postgres:18-alpine",
  );
  // Every catalog series is accepted, not just the default.
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      image: "docker.io/library/postgres:15-alpine",
    }).image,
    "docker.io/library/postgres:15-alpine",
  );
  // Below the catalog floor (PostgreSQL 15) stays rejected.
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        image: "docker.io/library/postgres:14-alpine",
      }),
    TypeError,
    "Invalid managed.apply payload",
  );
  // Cross-engine image swap must also be rejected even though it is on the
  // MySQL allowlist — the payload's `engine` is postgres.
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        image: "docker.io/library/mysql:9.7",
      }),
    TypeError,
    "Invalid managed.apply payload",
  );
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      engine: "mysql",
      image: "docker.io/library/mysql:9.7",
      credentials: [{
        ...VALID_MANAGED_APPLY.credentials[0],
        username: "root",
      }],
    }).image,
    "docker.io/library/mysql:9.7",
  );
  // MySQL 8.0 went EOL in April 2026 and is absent from the catalog.
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        engine: "mysql",
        image: "docker.io/library/mysql:8.0",
        credentials: [{
          ...VALID_MANAGED_APPLY.credentials[0],
          username: "root",
        }],
      }),
    TypeError,
    "Invalid managed.apply payload",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        engine: "mariadb",
        image: "docker.io/library/mariadb:11",
        credentials: [{
          ...VALID_MANAGED_APPLY.credentials[0],
          username: "root",
        }],
      }),
    TypeError,
    "Invalid managed.apply payload",
  );
});

test("managed.apply admits every catalog series and variant", () => {
  // Pin the daemon allowlist to the instance release catalog so adding
  // PostgreSQL 19 later is a three-repo change, not a silent daemon skip.
  const catalog: ReadonlyArray<{
    engine: "postgres" | "mysql" | "mariadb";
    image: string;
    username: string;
  }> = [
    {
      engine: "postgres",
      image: "docker.io/library/postgres:18-alpine",
      username: "postgres",
    },
    {
      engine: "postgres",
      image: "docker.io/library/postgres:18",
      username: "postgres",
    },
    {
      engine: "postgres",
      image: "docker.io/library/postgres:17-alpine",
      username: "postgres",
    },
    {
      engine: "postgres",
      image: "docker.io/library/postgres:17",
      username: "postgres",
    },
    {
      engine: "postgres",
      image: "docker.io/library/postgres:16-alpine",
      username: "postgres",
    },
    {
      engine: "postgres",
      image: "docker.io/library/postgres:16",
      username: "postgres",
    },
    {
      engine: "postgres",
      image: "docker.io/library/postgres:15-alpine",
      username: "postgres",
    },
    {
      engine: "postgres",
      image: "docker.io/library/postgres:15",
      username: "postgres",
    },
    { engine: "mysql", image: "docker.io/library/mysql:9.7", username: "root" },
    {
      engine: "mysql",
      image: "docker.io/library/mysql:9.7-oraclelinux9",
      username: "root",
    },
    { engine: "mysql", image: "docker.io/library/mysql:8.4", username: "root" },
    {
      engine: "mysql",
      image: "docker.io/library/mysql:8.4-oraclelinux9",
      username: "root",
    },
    {
      engine: "mariadb",
      image: "docker.io/library/mariadb:12.3",
      username: "root",
    },
    {
      engine: "mariadb",
      image: "docker.io/library/mariadb:12.3-ubi",
      username: "root",
    },
    {
      engine: "mariadb",
      image: "docker.io/library/mariadb:11.8",
      username: "root",
    },
    {
      engine: "mariadb",
      image: "docker.io/library/mariadb:11.8-ubi",
      username: "root",
    },
    {
      engine: "mariadb",
      image: "docker.io/library/mariadb:11.4",
      username: "root",
    },
    {
      engine: "mariadb",
      image: "docker.io/library/mariadb:11.4-ubi",
      username: "root",
    },
    {
      engine: "mariadb",
      image: "docker.io/library/mariadb:10.11",
      username: "root",
    },
    {
      engine: "mariadb",
      image: "docker.io/library/mariadb:10.11-ubi",
      username: "root",
    },
  ];
  for (const row of catalog) {
    assertEquals(
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        engine: row.engine,
        image: row.image,
        credentials: [{
          ...VALID_MANAGED_APPLY.credentials[0],
          username: row.username,
        }],
      }).image,
      row.image,
    );
  }
});

test("managed.apply requires no Traefik ingress — ProxySQL is out of band", () => {
  // exposure enabled without ingress is valid (shared ProxySQL frontends).
  const enabled = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    exposure: { enabled: true, protocol: "tcp" },
  });
  assertEquals(enabled.exposure.enabled, true);
  // Ingress identity is not part of managed.apply (ProxySQL reconcile is separate).
  assertEquals(
    Object.prototype.hasOwnProperty.call(enabled, "ingress"),
    false,
  );
});

test("managed.apply rejects unsafe containerName", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        containerName: "-bad",
      }),
    TypeError,
    "Invalid managed.apply payload",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        containerName: "has/slash",
      }),
    TypeError,
    "Invalid managed.apply payload",
  );
});

test("managed.apply admits dropUsers and rejects unsafe names", () => {
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      dropUsers: ["app_user", "readonly_user"],
    }).dropUsers,
    ["app_user", "readonly_user"],
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dropUsers: ["bad;user"],
      }),
    TypeError,
    "Invalid managed.apply dropUsers entry",
  );
});

test("managed.apply rejects missing required fields", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        composeYaml: "",
      }),
    TypeError,
    "Invalid managed.apply payload",
  );
});

test("managed.apply rejects hostile dockerOptions and path traversal", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: { privileged: true },
      }),
    TypeError,
    "Invalid managed.apply dockerOptions",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: "../etc/passwd", contents: "x", mode: "0640" },
        ],
      }),
    TypeError,
    "Invalid managed.apply configFiles entry",
  );
});

test("managed.apply rejects nested dockerOptions; exposure ignores publishedPort", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: { restart: "invalid-policy" },
      }),
    TypeError,
    "Invalid managed.apply dockerOptions",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: {
          ulimits: { nofile: { soft: 2048, hard: 1024 } },
        },
      }),
    TypeError,
    "Invalid managed.apply dockerOptions",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        dockerOptions: {
          labels: { "traefik.enable": "true" },
        },
      }),
    TypeError,
    "Invalid managed.apply dockerOptions",
  );
  // publishedPort is no longer part of exposure — ignored when present.
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      exposure: { enabled: true, protocol: "tcp", publishedPort: 15432 },
    }).exposure,
    { enabled: true, protocol: "tcp" },
  );
});

test("managed.apply rejects dockerOptions.extraEnv overriding postgres-reserved env keys", () => {
  const reservedOverrides: Array<[string, string]> = [
    ["POSTGRES_PASSWORD", "hunter2"],
    ["POSTGRES_USER", "root"],
    ["POSTGRES_DB", "postgres"],
    ["POSTGRES_INITDB_ARGS", "--data-checksums"],
    ["POSTGRES_HOST_AUTH_METHOD", "trust"],
    ["PGDATA", "/var/lib/postgresql/evil"],
  ];
  for (const [key, value] of reservedOverrides) {
    assertThrows(
      () =>
        parseManagedApplyPayload({
          ...VALID_MANAGED_APPLY,
          dockerOptions: { extraEnv: { [key]: value } },
        }),
      TypeError,
      "Invalid managed.apply dockerOptions",
    );
  }
});

test("managed.apply admits dockerOptions.extraEnv with harmless keys", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    dockerOptions: { extraEnv: { TZ: "UTC" } },
  });
  assertEquals(payload.dockerOptions?.extraEnv, { TZ: "UTC" });
});

test("managed.apply admits allowlisted config paths and rejects unexpected relative names", () => {
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      configFiles: [
        { path: "postgresql.conf", contents: "x\n", mode: "0640" },
        { path: "pg_hba.conf", contents: "local all all peer\n", mode: "0640" },
        { path: "tls/server.crt", contents: "cert\n", mode: "0640" },
        { path: "tls/server.key", contents: "key\n", mode: "0600" },
      ],
    }).configFiles.map((file) => file.path),
    ["postgresql.conf", "pg_hba.conf", "tls/server.crt", "tls/server.key"],
  );
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      configFiles: [
        { path: "my.cnf", contents: "[mysqld]\n", mode: "0640" },
        {
          path: "initdb/00-turbopanel.sql",
          contents: "SELECT 1;\n",
          mode: "0640",
        },
      ],
    }).configFiles.map((file) => file.path),
    ["my.cnf", "initdb/00-turbopanel.sql"],
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: "unexpected.conf", contents: "x\n", mode: "0640" },
        ],
      }),
    TypeError,
    "Invalid managed.apply configFiles entry",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        configFiles: [
          { path: "nested/postgresql.conf", contents: "x\n", mode: "0640" },
        ],
      }),
    TypeError,
    "Invalid managed.apply configFiles entry",
  );
});

test("managed.apply admits tlsMaterial and rejects hostile cert paths", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    tlsMaterial: {
      selfSigned: true,
      commonName: "managed-postgres",
      certPath: "tls/server.crt",
      keyPath: "tls/server.key",
    },
  });
  assertEquals(payload.tlsMaterial?.commonName, "managed-postgres");
  assertEquals(payload.tlsMaterial?.certPath, "tls/server.crt");
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        tlsMaterial: {
          selfSigned: true,
          commonName: "managed-postgres",
          certPath: "../etc/passwd",
          keyPath: "tls/server.key",
        },
      }),
    TypeError,
    "Invalid managed.apply tlsMaterial",
  );
});

test("managed.apply admits orgTlsMaterial and rejects incomplete envelopes", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    orgTlsMaterial: {
      certificatePem:
        "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
      privateKeyEnvelope: "tpdaemon.v1.server.key.ciphertext",
      caCertPem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
    },
  });
  assertEquals(
    payload.orgTlsMaterial?.privateKeyEnvelope,
    "tpdaemon.v1.server.key.ciphertext",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        orgTlsMaterial: {
          certificatePem: "not-a-pem",
          privateKeyEnvelope: "tpdaemon.v1.x",
          caCertPem:
            "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
        },
      }),
    TypeError,
    "Invalid managed.apply orgTlsMaterial",
  );
});

test("managed.lifecycle fixture round-trips and rejects invalid action", () => {
  assertEquals(
    parseManagedLifecyclePayload({ managedId: "m1", action: "stop" }),
    { managedId: "m1", action: "stop" },
  );
  assertThrows(
    () => parseManagedLifecyclePayload({ managedId: "m1", action: "pause" }),
    TypeError,
    "Invalid managed.lifecycle payload",
  );
});

test("managed.destroy fixture round-trips and rejects missing removeVolumes", () => {
  assertEquals(
    parseManagedDestroyPayload({ managedId: "m1", removeVolumes: true }),
    { managedId: "m1", removeVolumes: true },
  );
  assertThrows(
    () => parseManagedDestroyPayload({ managedId: "m1" }),
    TypeError,
    "Invalid managed.destroy payload",
  );
});

test("managed.destroy admits the instance-only deleteAfterDestroy marker but never requires it", () => {
  assertEquals(
    parseManagedDestroyPayload({
      managedId: "m1",
      removeVolumes: true,
      deleteAfterDestroy: true,
    }),
    { managedId: "m1", removeVolumes: true, deleteAfterDestroy: true },
  );
  assertEquals(
    parseManagedDestroyPayload({ managedId: "m1", removeVolumes: true }),
    { managedId: "m1", removeVolumes: true },
  );
  assertThrows(
    () =>
      parseManagedDestroyPayload({
        managedId: "m1",
        removeVolumes: true,
        deleteAfterDestroy: "yes",
      }),
    TypeError,
    "Invalid managed.destroy payload",
  );
});

test("managed apply result preserves container role and drops omitted or invalid roles", () => {
  assertEquals(
    parseManagedApplyResult({
      host: "203.0.113.10",
      port: 5432,
      containers: [
        {
          serviceId: "svc-1",
          composeServiceName: "postgres-ingress",
          containerId: "cid-ingress",
          containerName: "svc-1-in",
          status: "running",
          role: "ingress",
        },
        {
          composeServiceName: "postgres",
          containerId: "cid-app",
          containerName: "svc-1-1",
          status: "running",
          role: "not-a-role",
        },
        {
          composeServiceName: "postgres",
          containerId: "cid-omit",
          containerName: "svc-1-2",
          status: "running",
        },
        {
          composeServiceName: "postgres",
          containerId: "cid-service",
          containerName: "svc-1-3",
          status: "running",
          role: "service",
        },
      ],
    }).containers,
    [
      {
        serviceId: "svc-1",
        composeServiceName: "postgres-ingress",
        containerId: "cid-ingress",
        containerName: "svc-1-in",
        status: "running",
        role: "ingress",
      },
      {
        composeServiceName: "postgres",
        containerId: "cid-service",
        containerName: "svc-1-3",
        status: "running",
        role: "service",
      },
    ],
  );
});

test("managed result parsers round-trip and reject hostile shapes", () => {
  assertEquals(
    parseManagedApplyResult({
      host: "203.0.113.10",
      port: 5432,
      summary: "ready",
      appliedUsers: ["postgres"],
    }),
    {
      host: "203.0.113.10",
      port: 5432,
      summary: "ready",
      appliedUsers: ["postgres"],
    },
  );
  assertEquals(parseManagedApplyResult(null), { host: "", port: 0 });
  assertEquals(parseManagedApplyResult({ host: 12, port: "x" }), {
    host: "",
    port: 0,
  });

  assertEquals(parseManagedLifecycleResult({ status: "ready" }), {
    status: "ready",
  });
  assertEquals(
    parseManagedLifecycleResult({ status: "failed", summary: "compose down" }),
    { status: "failed", summary: "compose down" },
  );
  assertEquals(parseManagedLifecycleResult(null), { status: "" });
  assertEquals(parseManagedLifecycleResult({ status: 12 }), { status: "" });

  assertEquals(
    parseManagedDestroyResult({
      status: "stopped",
      containers: [],
      summary: "removed",
    }),
    { status: "stopped", containers: [], summary: "removed" },
  );
  assertEquals(parseManagedDestroyResult({ status: "failed" }), {
    status: "failed",
    containers: [],
  });
  assertEquals(parseManagedDestroyResult(null), {
    status: "",
    containers: [],
  });
  assertEquals(
    parseManagedDestroyResult({
      status: "stopped",
      containers: [
        {
          composeServiceName: "postgres",
          containerId: "abc",
          containerName: "pg-1",
          status: "exited",
          role: "service",
        },
        { composeServiceName: "bad" },
      ],
    }),
    {
      status: "stopped",
      containers: [
        {
          composeServiceName: "postgres",
          containerId: "abc",
          containerName: "pg-1",
          status: "exited",
          role: "service",
        },
      ],
    },
  );
});

const VALID_MANAGED_BACKUP_CREATE = {
  managedId: "00000000-0000-4000-8000-000000000001",
  engine: "postgres",
  action: "create",
  backupId: "bk_1700000000000",
  artifactExtension: "dump",
  scope: "database",
  database: "appdb",
} as const;

test("managed.backup fixture round-trips (create + delete) and rejects hostile input", () => {
  assertEquals(
    parseManagedBackupPayload(VALID_MANAGED_BACKUP_CREATE),
    VALID_MANAGED_BACKUP_CREATE,
  );
  assertEquals(
    parseManagedBackupPayload({
      ...VALID_MANAGED_BACKUP_CREATE,
      action: "delete",
      retentionKeep: 7,
    }),
    { ...VALID_MANAGED_BACKUP_CREATE, action: "delete", retentionKeep: 7 },
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        backupId: "../etc/passwd",
      }),
    Error,
    "Invalid managed.backup payload",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        backupId: "bk_1; rm -rf /",
      }),
    Error,
    "Invalid managed.backup payload",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        artifactExtension: "exe",
      }),
    Error,
    "Invalid managed.backup payload",
  );
  assertThrows(
    () => {
      const { database: _database, ...rest } = VALID_MANAGED_BACKUP_CREATE;
      return parseManagedBackupPayload(rest);
    },
    Error,
    "scope database requires database",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        ...VALID_MANAGED_BACKUP_CREATE,
        retentionKeep: 0,
      }),
    Error,
    "Invalid managed.backup payload retentionKeep",
  );
});

test("managed.backup result parser is lenient and drops malformed checksum", () => {
  assertEquals(parseManagedBackupResult(null), { backupId: "" });
  assertEquals(
    parseManagedBackupResult({
      backupId: "bk_1",
      path: "/var/lib/turbopanel/managed/m1/backups/bk_1.dump",
      sizeBytes: 1024,
      checksum: "a".repeat(64),
      completedAt: "2020-01-01T00:00:00.000Z",
      pruned: ["bk_0"],
    }),
    {
      backupId: "bk_1",
      path: "/var/lib/turbopanel/managed/m1/backups/bk_1.dump",
      sizeBytes: 1024,
      checksum: "a".repeat(64),
      completedAt: "2020-01-01T00:00:00.000Z",
      pruned: ["bk_0"],
    },
  );
  assertEquals(
    parseManagedBackupResult({ backupId: "bk_1", checksum: "not-hex" }),
    { backupId: "bk_1" },
  );
});

const VALID_MANAGED_RESTORE = {
  managedId: "00000000-0000-4000-8000-000000000001",
  engine: "postgres",
  backupId: "bk_1700000000000",
  artifactExtension: "dump",
  database: "appdb",
  checksum: "c".repeat(64),
} as const;

test("managed.restore fixture round-trips and rejects hostile input", () => {
  assertEquals(
    parseManagedRestorePayload(VALID_MANAGED_RESTORE),
    VALID_MANAGED_RESTORE,
  );
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        backupId: "../../etc",
      }),
    Error,
    "Invalid managed.restore payload",
  );
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        checksum: "not-hex",
      }),
    Error,
    "Invalid managed.restore payload",
  );
  assertThrows(
    () =>
      parseManagedRestorePayload({
        ...VALID_MANAGED_RESTORE,
        database: "bad; name",
      }),
    Error,
    "Invalid managed.restore payload database",
  );
  assertThrows(
    () =>
      parseManagedRestorePayload({ ...VALID_MANAGED_RESTORE, sizeBytes: -1 }),
    Error,
    "Invalid managed.restore payload sizeBytes",
  );
});

test("managed.restore result parser is lenient", () => {
  assertEquals(parseManagedRestoreResult(null), { backupId: "" });
  assertEquals(
    parseManagedRestoreResult({
      backupId: "bk_1",
      status: "ready",
      restoredAt: "2020-01-01T00:00:00.000Z",
      database: "appdb",
      summary: "restored",
    }),
    {
      backupId: "bk_1",
      status: "ready",
      restoredAt: "2020-01-01T00:00:00.000Z",
      database: "appdb",
      summary: "restored",
    },
  );
});

test("managed.apply admits privateListener, peers, and replication blocks", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    privateListener: { address: "203.0.113.50", port: 45001 },
    peers: [
      {
        memberId: "00000000-0000-4000-8000-0000000000a2",
        role: "replica",
        readEligible: true,
        address: "203.0.113.51",
        port: 45002,
        transport: "datacenter",
      },
    ],
    replication: {
      role: "primary",
      username: "tp_repl",
      desiredSlots: ["tp_member_2"],
      peerAddresses: ["203.0.113.51"],
    },
    credentials: [
      ...VALID_MANAGED_APPLY.credentials,
      {
        principalId: "00000000-0000-4000-8000-0000000000b1",
        username: "tp_repl",
        role: "replication",
        databases: [],
        password: "tpdaemon.v1.server.key.repl",
      },
    ],
  });
  assertEquals(payload.privateListener?.port, 45001);
  assertEquals(payload.replication?.role, "primary");
  assertEquals(payload.peers.length, 1);
  assertEquals(payload.credentials.some((c) => c.role === "replication"), true);
});

test("managed.apply privateListener transport is optional and transport-validated", () => {
  const untagged = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    privateListener: { address: "203.0.113.50", port: 45001 },
  });
  assertEquals(untagged.privateListener?.transport, undefined);

  const tagged = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    privateListener: {
      address: "203.0.113.50",
      port: 45001,
      transport: "public",
    },
  });
  assertEquals(tagged.privateListener?.transport, "public");

  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        privateListener: {
          address: "203.0.113.50",
          port: 45001,
          transport: "carrier-pigeon",
        },
      }),
    Error,
  );
});

test("managed.apply rejects loopback privateListener", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        privateListener: { address: "127.0.0.1", port: 45001 },
      }),
    Error,
  );
});

test("managed.apply result admits member replication health", () => {
  const result = parseManagedApplyResult({
    host: "203.0.113.10",
    port: 5432,
    member: {
      memberId: "00000000-0000-4000-8000-0000000000a1",
      role: "primary",
      status: "ready",
      replication: {
        state: "streaming",
        lagBytes: 0,
        observedAt: "2026-08-09T12:00:00.000Z",
      },
    },
  });
  assertEquals(result.member?.status, "ready");
  assertEquals(result.member?.replication?.state, "streaming");
});

test("managed.promote payload and result round-trip", () => {
  const payload = parseManagedPromotePayload({
    managedId: "00000000-0000-4000-8000-000000000001",
    memberId: "00000000-0000-4000-8000-0000000000a2",
    demoteMemberId: "00000000-0000-4000-8000-0000000000a1",
  });
  assertEquals(payload.memberId, "00000000-0000-4000-8000-0000000000a2");
  const result = parseManagedPromoteResult({
    status: "ready",
    role: "primary",
    promotedMemberId: "00000000-0000-4000-8000-0000000000a2",
    demotedMemberId: "00000000-0000-4000-8000-0000000000a1",
    demoted: true,
    replication: {
      state: "ready",
      observedAt: "2026-08-09T12:00:00.000Z",
    },
  });
  assertEquals(result.promotedMemberId, payload.memberId);
  assertEquals(result.demoted, true);
});

test("managed.apply round-trips a fabric peer and rejects vpn", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    peers: [
      {
        memberId: "00000000-0000-4000-8000-0000000000a2",
        role: "replica",
        readEligible: true,
        address: "203.0.113.51",
        port: 45002,
        transport: "fabric",
      },
    ],
  });
  assertEquals(payload.peers[0]?.transport, "fabric");
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      peers: [
        {
          memberId: "00000000-0000-4000-8000-0000000000a2",
          role: "replica",
          readEligible: true,
          address: "203.0.113.51",
          port: 45002,
          transport: "public",
        },
      ],
    }).peers[0]?.transport,
    "public",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        peers: [
          {
            memberId: "00000000-0000-4000-8000-0000000000a2",
            role: "replica",
            readEligible: true,
            address: "203.0.113.51",
            port: 45002,
            transport: "vpn",
          },
        ],
      }),
    TypeError,
  );
});

const VALID_MANAGED_INGRESS_RECONCILE = {
  serverId: "00000000-0000-4000-8000-0000000000ab",
  bindAddresses: ["203.0.113.10"],
  orgTlsMaterial: {
    certificatePem:
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    privateKeyEnvelope: "tpdaemon.v1.server.key.payload",
    caCertPem:
      "-----BEGIN CERTIFICATE-----\nMIICaaaa\n-----END CERTIFICATE-----\n",
  },
  clusters: [
    {
      managedId: "00000000-0000-4000-8000-000000000001",
      engine: "postgres",
      protocolPort: 5432,
      writerHostgroup: 0,
      readerHostgroup: 1,
      backends: [
        {
          memberId: "00000000-0000-4000-8000-0000000000aa",
          role: "primary",
          readEligible: true,
          address: "203.0.113.20",
          port: 5432,
          transport: "local",
        },
      ],
      users: [
        {
          username: "app",
          role: "user",
          password: "tpdaemon.v1.server.key.payload",
          defaultDatabase: "app",
        },
      ],
    },
  ],
} as const;

test("managed.ingress.reconcile round-trips fabric backends and segments", () => {
  const netId = "00000000-0000-4000-8000-0000000000cc";
  const payload = parseManagedIngressReconcilePayload({
    ...VALID_MANAGED_INGRESS_RECONCILE,
    clusters: [
      {
        ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
        backends: [
          {
            ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0].backends[0],
            transport: "fabric",
          },
        ],
      },
    ],
    segments: [{ name: `tpn_${netId}`, subnet: "203.0.113.0/24" }],
  });
  assertEquals(payload.clusters[0]?.backends[0]?.transport, "fabric");
  assertEquals(
    parseManagedIngressReconcilePayload({
      ...VALID_MANAGED_INGRESS_RECONCILE,
      clusters: [
        {
          ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
          backends: [
            {
              ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0].backends[0],
              transport: "public",
            },
          ],
        },
      ],
    }).clusters[0]?.backends[0]?.transport,
    "public",
  );
  assertEquals(payload.segments, [
    { name: `tpn_${netId}`, subnet: "203.0.113.0/24" },
  ]);
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        clusters: [
          {
            ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
            backends: [
              {
                ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0].backends[0],
                transport: "vpn",
              },
            ],
          },
        ],
      }),
    TypeError,
  );
  assertEquals(
    parseManagedIngressReconcilePayload({
      ...VALID_MANAGED_INGRESS_RECONCILE,
      clusters: [
        {
          ...VALID_MANAGED_INGRESS_RECONCILE.clusters[0],
          protocolPort: 15432,
        },
      ],
    }).clusters[0]?.protocolPort,
    15432,
  );
  const teardown = parseManagedIngressReconcilePayload({
    serverId: VALID_MANAGED_INGRESS_RECONCILE.serverId,
    clusters: [],
  });
  assertEquals(teardown.clusters, []);
  assertEquals(teardown.orgTlsMaterial, undefined);
});

test("managed.ingress.reconcile round-trips connectionRole and autoReadSplit", () => {
  const base = VALID_MANAGED_INGRESS_RECONCILE.clusters[0];
  const payload = parseManagedIngressReconcilePayload({
    ...VALID_MANAGED_INGRESS_RECONCILE,
    clusters: [
      {
        ...base,
        autoReadSplit: true,
        users: [
          { ...base.users[0], connectionRole: "read-only" },
          {
            username: "rw",
            role: "user",
            password: "tpdaemon.v1.server.key.payload",
            connectionRole: "read-write",
          },
        ],
      },
    ],
  });
  assertEquals(payload.clusters[0]?.autoReadSplit, true);
  assertEquals(payload.clusters[0]?.users[0]?.connectionRole, "read-only");
  assertEquals(payload.clusters[0]?.users[1]?.connectionRole, "read-write");

  const defaults = parseManagedIngressReconcilePayload(
    VALID_MANAGED_INGRESS_RECONCILE,
  );
  assertEquals(defaults.clusters[0]?.autoReadSplit, undefined);
  assertEquals(defaults.clusters[0]?.users[0]?.connectionRole, undefined);

  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        clusters: [{ ...base, autoReadSplit: "yes" }],
      }),
    TypeError,
    "cluster autoReadSplit",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        clusters: [
          {
            ...base,
            users: [{ ...base.users[0], connectionRole: "writer" }],
          },
        ],
      }),
    TypeError,
    "user connectionRole",
  );
});

test("managed.ingress.reconcile round-trips the requireTls frontend policy", () => {
  const base = VALID_MANAGED_INGRESS_RECONCILE.clusters[0];
  assertEquals(
    parseManagedIngressReconcilePayload({
      ...VALID_MANAGED_INGRESS_RECONCILE,
      clusters: [{ ...base, requireTls: true }],
    }).clusters[0]?.requireTls,
    true,
  );
  // Absent means "TLS available but optional" — never coerce it to a boolean.
  assertEquals(
    parseManagedIngressReconcilePayload(VALID_MANAGED_INGRESS_RECONCILE)
      .clusters[0]?.requireTls,
    undefined,
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        clusters: [{ ...base, requireTls: "require" }],
      }),
    TypeError,
    "cluster requireTls",
  );
});

test("managed.ingress.reconcile round-trips the explicit cluster family", () => {
  const base = VALID_MANAGED_INGRESS_RECONCILE.clusters[0];
  assertEquals(
    parseManagedIngressReconcilePayload({
      ...VALID_MANAGED_INGRESS_RECONCILE,
      clusters: [{ ...base, family: "pgsql" }],
    }).clusters[0]?.family,
    "pgsql",
  );
  assertEquals(
    parseManagedIngressReconcilePayload({
      ...VALID_MANAGED_INGRESS_RECONCILE,
      clusters: [{ ...base, engine: "mariadb", family: "mysql" }],
    }).clusters[0]?.family,
    "mysql",
  );
  // Absent on an older control plane: the daemon falls back to the engine.
  assertEquals(
    parseManagedIngressReconcilePayload(VALID_MANAGED_INGRESS_RECONCILE)
      .clusters[0]?.family,
    undefined,
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_MANAGED_INGRESS_RECONCILE,
        clusters: [{ ...base, family: "postgres" }],
      }),
    TypeError,
    "cluster family",
  );
});

test("managed.ingress.reconcile round-trips organization listener ports", () => {
  assertEquals(
    parseManagedIngressReconcilePayload({
      ...VALID_MANAGED_INGRESS_RECONCILE,
      listenerPorts: { postgres: 18432, mysqlFamily: 18306 },
    }).listenerPorts,
    { postgres: 18432, mysqlFamily: 18306 },
  );
  // Absent: the daemon uses the platform defaults.
  assertEquals(
    parseManagedIngressReconcilePayload(VALID_MANAGED_INGRESS_RECONCILE)
      .listenerPorts,
    undefined,
  );

  for (
    const bad of [
      { postgres: 18432 },
      { postgres: 18432, mysqlFamily: 80 },
      { postgres: 6032, mysqlFamily: 18306 },
      { postgres: 45_100, mysqlFamily: 18306 },
      // Both protocol modules on one port would leave ProxySQL half-bound.
      { postgres: 18432, mysqlFamily: 18432 },
      { postgres: "18432", mysqlFamily: 18306 },
      [],
      "18432",
    ]
  ) {
    assertThrows(
      () =>
        parseManagedIngressReconcilePayload({
          ...VALID_MANAGED_INGRESS_RECONCILE,
          listenerPorts: bad,
        }),
      TypeError,
      "listenerPorts",
    );
  }
});

test("managed.ha.reconcile round-trips identity and teardown", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const payload = parseManagedHaReconcilePayload({
    serverId: "00000000-0000-4000-8000-0000000000ab",
    desired: "absent",
    raft: null,
    clusters: [],
    identity: {
      serviceId,
      composeServiceName: "orchestrator",
      containerName: `${serviceId}-ha`,
    },
  });
  assertEquals(payload.desired, "absent");
  assertEquals(payload.raft, null);
  assertEquals(payload.identity.containerName, `${serviceId}-ha`);
});

test("managed.ha.reconcile round-trips raft peers and cluster members", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const managedId = "00000000-0000-4000-8000-000000000001";
  const payload = parseManagedHaReconcilePayload({
    serverId: "00000000-0000-4000-8000-0000000000ab",
    desired: "present",
    raft: {
      nodeId: "00000000-0000-4000-8000-0000000000ab",
      advertiseAddress: "203.0.113.10",
      httpPort: 33001,
      raftPort: 33002,
      peers: [{
        nodeId: "00000000-0000-4000-8000-0000000000cd",
        address: "203.0.113.11",
        raftPort: 33002,
        httpPort: 33001,
      }],
    },
    clusters: [{
      managedId,
      clusterAlias: managedId,
      engine: "postgres",
      members: [{
        memberId: "00000000-0000-4000-8000-0000000000a1",
        role: "primary",
        replicaClass: null,
        host: "db-1",
        port: 5432,
        promotionRule: "prefer",
      }],
      replicationUsername: "tp_repl",
      replicationPasswordEnvelope: "tpdaemon.v1.server.key.payload",
    }],
    identity: {
      serviceId,
      composeServiceName: "orchestrator",
      containerName: `${serviceId}-ha`,
    },
  });
  assertEquals(payload.raft?.advertiseAddress, "203.0.113.10");
  assertEquals(payload.clusters[0]?.members[0]?.promotionRule, "prefer");
});

test("managed.ha.failover round-trips drain and recover hosts", () => {
  const drain = parseManagedHaFailoverPayload({
    managedId: "00000000-0000-4000-8000-000000000001",
    sourceMemberId: "00000000-0000-4000-8000-000000000002",
    targetMemberId: "00000000-0000-4000-8000-000000000003",
    engine: "postgres",
    phase: "drain",
    sourceHost: "db-1",
    sourcePort: 5432,
  });
  assertEquals(drain.phase, "drain");
  assertEquals(drain.sourceHost, "db-1");
  const recover = parseManagedHaFailoverPayload({
    managedId: "00000000-0000-4000-8000-000000000001",
    sourceMemberId: "00000000-0000-4000-8000-000000000002",
    targetMemberId: "00000000-0000-4000-8000-000000000003",
    phase: "recover",
    sourceHost: "203.0.113.10",
    sourcePort: 5432,
    targetHost: "203.0.113.11",
    targetPort: 5432,
  });
  assertEquals(recover.phase, "recover");
  assertEquals(recover.targetHost, "203.0.113.11");
});

test("managed.ha.reconcile and failover result parsers reject invalid shapes", () => {
  assertEquals(
    parseManagedHaReconcileResult({
      summary: "ok",
      registeredClusters: [],
      restarted: false,
    }).restarted,
    false,
  );
  assertThrows(
    () =>
      parseManagedHaReconcileResult({
        summary: "ok",
        registeredClusters: [],
        restarted: "yes",
      }),
    TypeError,
    "Invalid managed.ha.reconcile result",
  );
  assertEquals(
    parseManagedHaFailoverResult({
      summary: "ok",
      phase: "drain",
    }).phase,
    "drain",
  );
  assertThrows(
    () =>
      parseManagedHaFailoverResult({
        summary: "ok",
        phase: "fence",
      }),
    TypeError,
    "Invalid managed.ha.failover result",
  );
});
