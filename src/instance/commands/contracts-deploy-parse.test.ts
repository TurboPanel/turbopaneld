import { assertEquals, assertThrows } from "@std/assert";
import {
  parseEnvironmentDeployPayload,
  parseEnvironmentLifecyclePayload,
  parseEnvironmentStopPayload,
  parseFabricReconcilePayload,
  parseFabricReconcileResult,
  parseHostnamePayload,
  parseNtpSetPayload,
  parsePrincipalsReconcilePayload,
  parseSystemReconcilePayload,
  parseTimezoneSetPayload,
} from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const WG_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TP_ENVELOPE = "tpdaemon.v1.sealed.payload";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000099";
const SERVICE_UUID = "00000000-0000-4000-8000-0000000000aa";
const SERVER_UUID = "11111111-2222-3333-4444-555555555555";
const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEmvBcjT+NvO6sokGNoJ0zA3dr0nhIQhhZ3wP220uFZ";

const DEPLOY_BASE = {
  environmentId: "env-1",
  projectId: "proj-1",
  organizationId: "org-1",
  projectName: "demo",
  composeFiles: [{
    filename: "compose.yaml",
    role: "runtime" as const,
    content: "services:\n  web:\n    image: nginx\n",
  }],
  hostings: [] as unknown[],
};

const SOURCE_ENTRY = {
  sourceId: "00000000-0000-4000-8000-000000000001",
  composeServiceName: "web",
  provider: "github",
  cloneUrl: "https://gitlab.test/acme/app.git",
  ref: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  releaseId: "rel-1",
  credential: TP_ENVELOPE,
  credentialKind: "token",
  build: { kind: "native" },
};

const SITE_PRINCIPAL = {
  principalId: PRINCIPAL_ID,
  username: "site_user",
  uid: 10001,
  gid: 10001,
};

function rejectDeploy(patch: Record<string, unknown>, message: string): void {
  assertThrows(
    () => parseEnvironmentDeployPayload({ ...DEPLOY_BASE, ...patch }),
    TypeError,
    message,
  );
}

function hosting(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    hostingId: "h1",
    serviceId: "s1",
    composeServiceName: "web",
    hostnames: ["app.example.test"],
    ...overrides,
  };
}

test("parseEnvironmentDeployPayload rejects non-object and missing hostings", () => {
  assertThrows(
    () => parseEnvironmentDeployPayload(null),
    TypeError,
    "Invalid environment deploy payload",
  );
  rejectDeploy({ hostings: "none" }, "hostings must be an array");
  rejectDeploy(
    { environmentId: "" },
    "environmentId must be a non-empty string",
  );
});

test("parseEnvironmentDeployPayload rejects hosting field parse errors", () => {
  rejectDeploy({ hostings: [null] }, "Invalid environment deploy hosting");
  rejectDeploy(
    { hostings: [hosting({ hostnames: "app.example.test" })] },
    "hostings[].hostnames must contain valid hostnames",
  );
  rejectDeploy(
    { hostings: [hosting({ targetPort: 70000 })] },
    "hostings[].targetPort must be a valid port",
  );
  rejectDeploy(
    { hostings: [hosting({ bindAddress: "" })] },
    "hostings[].bindAddress must be a non-empty IP address",
  );
  rejectDeploy(
    { hostings: [hosting({ bindAddress: "not-an-ip" })] },
    "hostings[].bindAddress must be a valid IP address",
  );
  rejectDeploy(
    { hostings: [hosting({ protocol: "sctp" })] },
    "hostings[].protocol must be http, tcp, or udp",
  );
  rejectDeploy(
    {
      hostings: [hosting({
        protocol: "tcp",
        ports: [{ published: 80, target: 0 }],
      })],
    },
    "hostings[].ports entries must have valid published/target ports",
  );
});

test("parseEnvironmentDeployPayload rejects tls/variable/secret/envFile shapes", () => {
  rejectDeploy(
    { tlsMaterial: [null] },
    "Invalid environment deploy tlsMaterial entry",
  );
  rejectDeploy(
    { variableMaterial: ["API_KEY"] },
    "Invalid environment deploy variableMaterial entry",
  );
  rejectDeploy(
    { secretPlan: ["db_pass"] },
    "Invalid environment deploy secretPlan entry",
  );
  rejectDeploy(
    {
      secretPlan: [{
        key: "DB_PASS",
        composeServiceName: "web",
        source: "DB_PASS",
        target: "DB_PASS",
        relativePath: "dir/db_pass",
      }],
    },
    "Invalid environment deploy secretPlan relativePath",
  );
  rejectDeploy({ envFile: 12 }, "envFile must be a string");
});

test("parseEnvironmentDeployPayload rejects storageMaterial and serviceHooks", () => {
  rejectDeploy(
    { storageMaterial: [null] },
    "Invalid environment deploy storageMaterial entry",
  );
  rejectDeploy(
    {
      storageMaterial: [{
        storageId: "st-1",
        locationId: "loc-1",
        kind: "blob",
        name: "uploads",
        provider: "s3",
        serverId: "srv-1",
        mounts: [],
      }],
    },
    "Invalid environment deploy storageMaterial entry",
  );
  rejectDeploy(
    {
      storageMaterial: [{
        storageId: "st-1",
        locationId: "loc-1",
        kind: "volume",
        name: "uploads",
        provider: "docker",
        serverId: "srv-1",
        volumeName: "../escape",
        mounts: [],
      }],
    },
    "Invalid environment deploy storageMaterial volumeName",
  );
  rejectDeploy(
    {
      storageMaterial: [{
        storageId: "st-1",
        locationId: "loc-1",
        kind: "directory",
        name: "uploads",
        provider: "path",
        serverId: "srv-1",
        sourcePath: "/var/lib/turbopanel/uploads",
        mounts: [null],
      }],
    },
    "Invalid environment deploy storageMaterial mount",
  );
  rejectDeploy(
    { serviceHooks: ["web"] },
    "Invalid environment deploy serviceHooks entry",
  );
});

test("parseEnvironmentDeployPayload round-trips docker volume storage", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    storageMaterial: [{
      storageId: "st-1",
      locationId: "loc-1",
      kind: "volume",
      name: "uploads",
      provider: "docker",
      serverId: "srv-1",
      volumeName: "tp_uploads",
      managed: false,
      externalName: "ext_uploads",
      mounts: [{ destinationPath: "/data" }],
    }],
  });
  assertEquals(payload.storageMaterial?.[0]?.volumeName, "tp_uploads");
  assertEquals(payload.storageMaterial?.[0]?.managed, false);
});

test("parseEnvironmentDeployPayload rejects principalMaterial field errors", () => {
  rejectDeploy(
    { principalMaterial: [null] },
    "Invalid environment deploy principalMaterial entry",
  );
  rejectDeploy(
    {
      principalMaterial: [{
        principalId: PRINCIPAL_ID,
        username: "Bad User",
      }],
    },
    "Invalid environment deploy principalMaterial entry",
  );
  rejectDeploy(
    {
      principalMaterial: [{
        principalId: PRINCIPAL_ID,
        username: "deploy_user",
        uid: -1,
      }],
    },
    "Invalid environment deploy principalMaterial entry",
  );
  rejectDeploy(
    {
      principalMaterial: [{
        principalId: PRINCIPAL_ID,
        username: "deploy_user",
        home: "relative/home",
      }],
    },
    "Invalid environment deploy principalMaterial home",
  );
  rejectDeploy(
    {
      principalMaterial: [{
        principalId: PRINCIPAL_ID,
        username: "deploy_user",
        shell: "/bin/zsh",
      }],
    },
    "Invalid environment deploy principalMaterial shell",
  );
  rejectDeploy(
    {
      principalMaterial: [{
        principalId: PRINCIPAL_ID,
        username: "deploy_user",
        runtimes: "php",
      }],
    },
    "Invalid environment deploy principalMaterial runtimes",
  );
  rejectDeploy(
    {
      principalMaterial: [{
        principalId: PRINCIPAL_ID,
        username: "deploy_user",
        runtimes: [{ runtime: "php", series: "latest" }],
      }],
    },
    "Invalid environment deploy principalMaterial runtimes entry",
  );
  rejectDeploy(
    {
      principalMaterial: [{
        principalId: PRINCIPAL_ID,
        username: "deploy_user",
        accessGroups: ["TPNODEAPP"],
      }],
    },
    "Invalid environment deploy principalMaterial accessGroups",
  );
  rejectDeploy(
    {
      principalMaterial: [{
        principalId: PRINCIPAL_ID,
        username: "deploy_user",
        sshKeys: [`${SSH_KEY} comment`],
      }],
    },
    "Invalid environment deploy principalMaterial sshKeys",
  );
  // Anything but a sha512-crypt hash is refused — a plaintext, a colon, or a
  // newline here would otherwise land in `/etc/shadow` via `chpasswd -e`.
  for (
    const passwordHash of [
      "hunter2",
      `$1$old$${"a".repeat(22)}`,
      `$6$saltstring$${"a".repeat(85)}`,
      `$6$saltstring$${"a".repeat(86)}:x`,
      `$6$saltstring$${"a".repeat(86)}\n`,
    ]
  ) {
    rejectDeploy(
      {
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          passwordHash,
        }],
      },
      "Invalid environment deploy principalMaterial passwordHash",
    );
  }
});

test("parsePrincipalsReconcilePayload rejects malformed principal grants", () => {
  assertThrows(
    () =>
      parsePrincipalsReconcilePayload({
        principals: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          home: "/srv/users/deploy_user",
          shell: "/usr/sbin/nologin",
          runtimes: [{ series: "8.4" }],
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial runtimes entry",
  );
});

test("parsePrincipalsReconcilePayload round-trips a password hash", () => {
  const passwordHash = `$6$rounds=100000$saltstring$${"a".repeat(86)}`;
  const payload = parsePrincipalsReconcilePayload({
    principals: [{
      principalId: PRINCIPAL_ID,
      username: "deploy_user",
      passwordHash,
    }],
  });
  assertEquals(payload.principals[0].passwordHash, passwordHash);
});

test("parseEnvironmentDeployPayload rejects sites engine cron and sourceKind", () => {
  rejectDeploy({ sites: [null] }, "Invalid sites entry");
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "litespeed",
        root: "public",
        listenPort: 18080,
      }],
    },
    "Invalid sites entry",
  );
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 80,
      }],
    },
    "Invalid sites entry",
  );
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "caddy",
        root: "public",
        listenPort: 18080,
        sourceKind: "git",
      }],
    },
    "Invalid sites sourceKind",
  );
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        principal: SITE_PRINCIPAL,
        cron: "hourly",
      }],
    },
    "Invalid sites.site cron",
  );
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        principal: SITE_PRINCIPAL,
        cron: [{
          name: "Nightly",
          schedule: "*-*-* 02:00:00",
          command: ["/usr/bin/php", "artisan"],
        }],
      }],
    },
    "Invalid sites.site cron entry",
  );
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        principal: SITE_PRINCIPAL,
        cron: [
          {
            name: "nightly",
            schedule: "*-*-* 02:00:00",
            command: ["/usr/bin/true"],
          },
          {
            name: "nightly",
            schedule: "*-*-* 03:00:00",
            command: ["/usr/bin/true"],
          },
        ],
      }],
    },
    "Duplicate sites.site cron job: nightly",
  );
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        principal: "root",
      }],
    },
    "Invalid sites.principal entry",
  );
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        principal: { principalId: PRINCIPAL_ID, username: "Bad User" },
      }],
    },
    "Invalid sites.principal entry",
  );
  rejectDeploy(
    {
      sites: [{
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        principal: { ...SITE_PRINCIPAL, uid: -1 },
      }],
    },
    "Invalid sites.principal entry",
  );
});

test("parseEnvironmentDeployPayload rejects nativeAppServices resource limits", () => {
  rejectDeploy(
    { nativeAppServices: [null] },
    "Invalid nativeAppServices entry",
  );
  rejectDeploy(
    {
      nativeAppServices: [{
        composeServiceName: "api",
        serviceId: "svc/native",
        listenPort: 13000,
        framework: "node",
      }],
    },
    "Invalid nativeAppServices entry",
  );
  rejectDeploy(
    {
      nativeAppServices: [{
        composeServiceName: "api",
        serviceId: "svc-native-1",
        listenPort: 80,
        framework: "node",
      }],
    },
    "Invalid sites entry",
  );
  rejectDeploy(
    {
      nativeAppServices: [{
        composeServiceName: "api",
        serviceId: "svc-native-1",
        listenPort: 13000,
        framework: "node",
        resources: "lots",
      }],
    },
    "Invalid nativeAppServices resources",
  );
  rejectDeploy(
    {
      nativeAppServices: [{
        composeServiceName: "api",
        serviceId: "svc-native-1",
        listenPort: 13000,
        framework: "node",
        resources: { cpus: 0 },
      }],
    },
    "Invalid nativeAppServices resources.cpus",
  );
  rejectDeploy(
    {
      nativeAppServices: [{
        composeServiceName: "api",
        serviceId: "svc-native-1",
        listenPort: 13000,
        framework: "node",
        accountLimits: "none",
      }],
    },
    "Invalid nativeAppServices accountLimits",
  );
  rejectDeploy(
    {
      nativeAppServices: [{
        composeServiceName: "api",
        serviceId: "svc-native-1",
        listenPort: 13000,
        framework: "node",
        accountLimits: { tasksMax: -1 },
      }],
    },
    "Invalid nativeAppServices accountLimits.tasksMax",
  );
});

test("parseEnvironmentDeployPayload rejects unhonourable restart policies", () => {
  // Each of these becomes a systemd directive, so the payload is re-checked
  // here rather than trusted from the control plane. `maxAttempts: 0` is
  // refused for the reason the instance refuses it: `StartLimitBurst=0` means
  // *no* rate limit, the inverse of "do not retry".
  for (
    const [restartPolicy, message] of [
      ["always", "Invalid nativeAppServices restartPolicy"],
      [{ condition: "unless-stopped" }, "Invalid nativeAppServices restartPolicy.condition"],
      [{ delay: "soon" }, "Invalid nativeAppServices restartPolicy.delay"],
      [{ window: "5" }, "Invalid nativeAppServices restartPolicy.window"],
      [{ maxAttempts: 0 }, "Invalid nativeAppServices restartPolicy.maxAttempts"],
      [{ maxAttempts: 1.5 }, "Invalid nativeAppServices restartPolicy.maxAttempts"],
    ] as const
  ) {
    rejectDeploy(
      {
        nativeAppServices: [{
          composeServiceName: "api",
          serviceId: "svc-native-1",
          listenPort: 13000,
          framework: "node",
          restartPolicy,
        }],
      },
      message,
    );
  }
});

test("parseEnvironmentDeployPayload keeps restartPolicy and serviceLabels", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    nativeAppServices: [{
      composeServiceName: "api",
      serviceId: "svc-native-1",
      listenPort: 13000,
      framework: "node",
      restartPolicy: {
        condition: "any",
        delay: "5s",
        maxAttempts: 3,
        window: "1m30s",
      },
      serviceLabels: { "com.example.team": "platform", dropped: 7 },
    }],
  });
  assertEquals(payload.nativeAppServices?.[0]?.restartPolicy, {
    condition: "any",
    delay: "5s",
    maxAttempts: 3,
    window: "1m30s",
  });
  // Metadata, so a non-string value is dropped rather than failing the deploy.
  assertEquals(payload.nativeAppServices?.[0]?.serviceLabels, {
    "com.example.team": "platform",
  });
});

test("parseEnvironmentDeployPayload rejects sourceMaterial parse errors", () => {
  rejectDeploy({ sourceMaterial: [null] }, "Invalid sourceMaterial entry");
  rejectDeploy(
    { sourceMaterial: [{ ...SOURCE_ENTRY, provider: "bitbucket" }] },
    "Invalid sourceMaterial provider",
  );
  rejectDeploy(
    { sourceMaterial: [{ ...SOURCE_ENTRY, releaseId: "../escape" }] },
    "Invalid sourceMaterial releaseId",
  );
  rejectDeploy(
    { sourceMaterial: [{ ...SOURCE_ENTRY, build: "native" }] },
    "Invalid sourceMaterial build",
  );
  rejectDeploy(
    { sourceMaterial: [{ ...SOURCE_ENTRY, build: { kind: "docker" } }] },
    "Invalid sourceMaterial build kind",
  );
  rejectDeploy(
    {
      sourceMaterial: [{
        ...SOURCE_ENTRY,
        build: { kind: "railpack", installCommand: "x".repeat(1001) },
      }],
    },
    "Invalid sourceMaterial build installCommand",
  );
  rejectDeploy(
    {
      sourceMaterial: [{
        ...SOURCE_ENTRY,
        build: { kind: "static", outputDirectory: "/abs" },
      }],
    },
    "Invalid sourceMaterial build outputDirectory",
  );
  rejectDeploy(
    { sourceMaterial: [{ ...SOURCE_ENTRY, subdirectory: "../etc" }] },
    "Invalid sourceMaterial subdirectory",
  );
  rejectDeploy(
    { sourceMaterial: [{ ...SOURCE_ENTRY, credential: "" }] },
    "Invalid sourceMaterial credential",
  );
  rejectDeploy(
    { sourceMaterial: [{ ...SOURCE_ENTRY, credentialKind: "password" }] },
    "Invalid sourceMaterial credentialKind",
  );
  rejectDeploy(
    { sourceMaterial: [{ ...SOURCE_ENTRY, rollbackToReleaseId: "../prev" }] },
    "Invalid sourceMaterial rollbackToReleaseId",
  );
  rejectDeploy(
    {
      sourceMaterial: [{
        ...SOURCE_ENTRY,
        cloneUrl: `https://${"x".repeat(2100)}.test/acme/app.git`,
      }],
    },
    "Invalid sourceMaterial cloneUrl",
  );
});

test("parseEnvironmentDeployPayload rejects optional array/boolean/network fields", () => {
  rejectDeploy({ sites: "all" }, "sites must be an array");
  rejectDeploy({ noCache: "yes" }, "noCache must be a boolean");
  rejectDeploy(
    { dockerExternalNetworks: "org-net" },
    "dockerExternalNetworks must be an array",
  );
  rejectDeploy(
    { dockerExternalNetworks: ["-bad"] },
    "Invalid dockerExternalNetworks entry",
  );
  rejectDeploy(
    { fabricNetworks: "tpn_net1" },
    "fabricNetworks must be an array",
  );
  rejectDeploy(
    { fabricNetworks: ["tpn_net1"] },
    "fabricNetworks must be an array of objects",
  );
  rejectDeploy(
    {
      fabricNetworks: [{
        name: "tpn_net1",
        subnet: "10.192.11.0/24",
        gateway: "host",
      }],
    },
    "Invalid fabricNetworks gateway",
  );
  rejectDeploy(
    { managedNetworkServices: "web" },
    "managedNetworkServices must be an array",
  );
  rejectDeploy(
    { replicaCounts: ["web"] },
    "Invalid environment deploy payload",
  );
  rejectDeploy(
    { replicaCounts: { "": 1 } },
    "Invalid environment deploy payload",
  );
  rejectDeploy(
    { serverId: "not-a-uuid" },
    "Invalid environment deploy payload",
  );
});

test("parseEnvironmentDeployPayload rejects compose file path/source and ingress identity", () => {
  rejectDeploy(
    {
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        content: "services:\n  web:\n    image: nginx\n",
        source: "tarball",
      }],
    },
    "Invalid environment deploy payload",
  );
  rejectDeploy(
    {
      composeFiles: [{
        filename: "compose.yaml",
        role: "runtime",
        content: "services:\n  web:\n    image: nginx\n",
        path: "/etc/passwd",
      }],
    },
    "Invalid environment deploy payload",
  );
  rejectDeploy(
    { ingressServices: [null] },
    "Invalid environment.deploy ingressServices entry",
  );
  rejectDeploy(
    {
      ingressServices: [{
        serviceId: SERVICE_UUID,
        composeServiceName: "traefik",
        containerName: SERVICE_UUID,
      }],
    },
    "Invalid environment.deploy ingressServices entry",
  );
  rejectDeploy(
    {
      hostingIngress: {
        serviceId: SERVICE_UUID,
        composeServiceName: "caddy",
        containerName: `${SERVICE_UUID}-in`,
      },
    },
    "Invalid environment.deploy hostingIngress",
  );
  rejectDeploy(
    { hostingIngress: { serviceId: "not-a-uuid" } },
    "Invalid environment.deploy hostingIngress",
  );
});

test("parseEnvironmentDeployPayload guards the hosting-ingress network identity", () => {
  const withHosting = { hostings: [hosting({})] };
  const ingress = {
    serviceId: SERVICE_UUID,
    composeServiceName: "traefik",
    containerName: `${SERVICE_UUID}-in`,
  };
  // The shared hosting-ingress network is also the shared Traefik compose
  // project, so it must equal the `hostingIngress` serviceId.
  assertEquals(
    parseEnvironmentDeployPayload({
      ...DEPLOY_BASE,
      ...withHosting,
      hostingIngress: ingress,
      hostingIngressNetwork: SERVICE_UUID,
    }).hostingIngressNetwork,
    SERVICE_UUID,
  );
  rejectDeploy(
    {
      ...withHosting,
      hostingIngress: ingress,
      hostingIngressNetwork: "00000000-0000-4000-8000-0000000000bb",
    },
    "Invalid environment deploy payload",
  );
  // Compose `name:` is stricter than the Docker resource rule
  // (`assertSafeComposeProjectName` in `src/deploy/ingress.ts`) — reject at the
  // boundary rather than at render time.
  for (
    const network of [
      "Ingress-Net",
      "ingress.net",
      "-ingress",
      "",
      "a".repeat(65),
    ]
  ) {
    rejectDeploy(
      { ...withHosting, hostingIngressNetwork: network },
      "Invalid environment deploy payload",
    );
  }
});

test("parseEnvironmentDeployPayload round-trips optional flags and networks", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    noCache: true,
    dockerExternalNetworks: ["org_net_b", "org_net_a"],
    fabricNetworks: [{
      name: "tpn_mesh01",
      subnet: "10.192.11.0/24",
      mtu: 1420,
      gateway: "203.0.113.1",
    }],
    hostingIngress: {
      serviceId: SERVICE_UUID,
      composeServiceName: "traefik",
      containerName: `${SERVICE_UUID}-in`,
    },
    envFile: "NODE_ENV=production\n",
    listenerPorts: { postgres: 15432, mysqlFamily: 13306 },
  });
  assertEquals(payload.noCache, true);
  assertEquals(payload.dockerExternalNetworks, ["org_net_a", "org_net_b"]);
  assertEquals(payload.fabricNetworks?.[0]?.gateway, "203.0.113.1");
  assertEquals(payload.hostingIngress?.composeServiceName, "traefik");
  assertEquals(payload.listenerPorts?.postgres, 15432);
});

test("parseEnvironmentStopPayload rejects non-object and array-shaped fields", () => {
  assertThrows(
    () => parseEnvironmentStopPayload(null),
    TypeError,
    "Invalid environment stop payload",
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        fabricNetworks: "tpn_net1",
      }),
    TypeError,
    "fabricNetworks must be an array",
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        siteReleases: [null],
      }),
    TypeError,
    "Invalid environment.stop siteReleases entry",
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        ingressServices: [null],
      }),
    TypeError,
    "Invalid environment.stop ingressServices entry",
  );
});

test("parseEnvironmentLifecyclePayload rejects a non-object", () => {
  assertThrows(
    () => parseEnvironmentLifecyclePayload("restart"),
    TypeError,
    "Invalid environment lifecycle payload",
  );
});

test("parseHostnamePayload and parseTimezoneSetPayload reject non-objects", () => {
  assertThrows(
    () => parseHostnamePayload(null),
    Error,
    "Invalid hostname payload",
  );
  assertThrows(
    () => parseTimezoneSetPayload([]),
    Error,
    "Invalid timezone payload",
  );
});

test("parseNtpSetPayload rejects empty payloads and malformed server lists", () => {
  assertThrows(
    () => parseNtpSetPayload({}),
    Error,
    "ntp payload must include enabled, servers, and/or fallbackServers",
  );
  assertThrows(
    () => parseNtpSetPayload({ servers: "pool.ntp.org" }),
    TypeError,
    "servers must be an array of server hostnames or IPs",
  );
  assertThrows(
    () => parseNtpSetPayload({ fallbackServers: [] }),
    Error,
    "fallbackServers must not be empty when provided",
  );
  assertEquals(
    parseNtpSetPayload({
      enabled: false,
      servers: ["time.example.test"],
      fallbackServers: ["203.0.113.1"],
    }).servers,
    ["time.example.test"],
  );
});

test("parseFabricReconcilePayload rejects address prefix peers listenPort and networks", () => {
  const peers = [{
    publicKey: WG_PUBKEY,
    allowedIPs: ["203.0.113.0/24"],
  }];
  assertThrows(
    () => parseFabricReconcilePayload(null),
    TypeError,
    "Invalid fabric reconcile payload",
  );
  assertThrows(
    () => parseFabricReconcilePayload([]),
    TypeError,
    "Invalid fabric reconcile payload",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "not-a-cidr",
        prefix: "10.192.0.0/16",
        peers,
      }),
    TypeError,
    "Invalid fabric address",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0",
        peers,
      }),
    TypeError,
    "Invalid fabric prefix",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0/16",
        peers: "none",
      }),
    TypeError,
    "Invalid fabric peers",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0/16",
        peers,
        listenPort: 0,
      }),
    TypeError,
    "Invalid fabric listenPort",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0/16",
        peers,
        networks: "tpn_net1",
      }),
    TypeError,
    "Invalid fabric networks",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0/16",
        peers,
        networks: [null],
      }),
    TypeError,
    "Invalid fabric network entry",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0/16",
        peers,
        networks: [{ name: "tpn_net1", subnet: "10.192.11.0" }],
      }),
    TypeError,
    "Invalid fabric network subnet",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0/16",
        peers,
        networks: [{
          name: "tpn_net1",
          subnet: "10.192.11.0/24",
          gateway: "2001:db8::1",
        }],
      }),
    TypeError,
    "Invalid fabric network gateway",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0/16",
        peers: [{ publicKey: "short", allowedIPs: ["203.0.113.0/24"] }],
      }),
    TypeError,
    "Invalid fabric peer publicKey",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "203.0.113.2/32",
        prefix: "10.192.0.0/16",
        peers: [{ publicKey: WG_PUBKEY, allowedIPs: ["203.0.113.0"] }],
      }),
    TypeError,
    "Invalid fabric peer allowedIPs",
  );
});

test("parseFabricReconcileResult rejects summary publicKey peers and observations", () => {
  assertThrows(
    () => parseFabricReconcileResult("ok"),
    TypeError,
    "Invalid fabric reconcile result",
  );
  assertThrows(
    () => parseFabricReconcileResult({ summary: "" }),
    TypeError,
    "Invalid fabric reconcile result summary",
  );
  assertThrows(
    () => parseFabricReconcileResult({ summary: "ok", publicKey: "short" }),
    TypeError,
    "Invalid fabric reconcile result publicKey",
  );
  assertThrows(
    () => parseFabricReconcileResult({ summary: "ok", peers: "none" }),
    TypeError,
    "Invalid fabric reconcile result peers",
  );
  assertThrows(
    () => parseFabricReconcileResult({ summary: "ok", peers: [null] }),
    TypeError,
    "Invalid fabric reconcile result peer",
  );
  assertThrows(
    () =>
      parseFabricReconcileResult({
        summary: "ok",
        peers: [{ publicKey: WG_PUBKEY, lastHandshakeAt: "yesterday" }],
      }),
    TypeError,
    "Invalid fabric reconcile result peer lastHandshakeAt",
  );
  assertThrows(
    () =>
      parseFabricReconcileResult({
        summary: "ok",
        peers: [{ publicKey: WG_PUBKEY, transferRx: -1 }],
      }),
    TypeError,
    "Invalid fabric reconcile result peer transferRx",
  );
  assertThrows(
    () =>
      parseFabricReconcileResult({
        summary: "ok",
        peers: [{ publicKey: WG_PUBKEY, endpoint: "203.0.113.10" }],
      }),
    TypeError,
    "Invalid fabric reconcile result peer endpoint",
  );
  assertThrows(
    () =>
      parseFabricReconcileResult({
        summary: "ok",
        peers: [{ publicKey: WG_PUBKEY, health: "down" }],
      }),
    TypeError,
    "Invalid fabric reconcile result peer health",
  );
});

test("parseSystemReconcilePayload rejects remaining invalid shapes and accepts managed-ha", () => {
  const serviceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const environmentId = SERVER_UUID;
  assertThrows(
    () => parseSystemReconcilePayload(null),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId: "not-a-uuid",
        components: [{
          component: "database",
          serviceId,
          composeServiceName: "database",
          containerName: serviceId,
          role: "turbopanel",
          desired: "present",
        }],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        action: "reload",
        components: [{
          component: "database",
          serviceId,
          composeServiceName: "database",
          containerName: serviceId,
          role: "turbopanel",
          desired: "present",
        }],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () => parseSystemReconcilePayload({ environmentId, components: [] }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: Array.from({ length: 9 }, (_, index) => ({
          component: "database",
          serviceId: `${serviceId.slice(0, -1)}${index}`,
          composeServiceName: "database",
          containerName: `${serviceId.slice(0, -1)}${index}`,
          role: "turbopanel",
          desired: "present",
        })),
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [
          {
            component: "database",
            serviceId,
            composeServiceName: "database",
            containerName: serviceId,
            role: "turbopanel",
            desired: "present",
          },
          {
            component: "database",
            serviceId,
            composeServiceName: "database",
            containerName: serviceId,
            role: "turbopanel",
            desired: "absent",
          },
        ],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: ["database"],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertEquals(
    parseSystemReconcilePayload({
      environmentId,
      components: [{
        component: "managed-ha",
        serviceId,
        composeServiceName: "orchestrator",
        containerName: `${serviceId}-ha`,
        role: "turbopanel",
        desired: "present",
      }],
    }).components[0]?.containerName,
    `${serviceId}-ha`,
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [{
          component: "database",
          serviceId: "not-a-uuid",
          composeServiceName: "database",
          containerName: "not-a-uuid",
          role: "turbopanel",
          desired: "present",
        }],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [{
          component: "database",
          serviceId,
          composeServiceName: "database",
          containerName: serviceId,
          role: "service",
          desired: "present",
        }],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [{
          component: "database",
          serviceId,
          composeServiceName: "database",
          containerName: `${serviceId}-extra`,
          role: "turbopanel",
          desired: "present",
        }],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
  assertThrows(
    () =>
      parseSystemReconcilePayload({
        environmentId,
        components: [{
          component: "database",
          serviceId,
          composeServiceName: "database",
          containerName: serviceId,
          role: "turbopanel",
          desired: "maybe",
        }],
      }),
    TypeError,
    "Invalid system.reconcile payload",
  );
});
