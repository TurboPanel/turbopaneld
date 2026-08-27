import { assertEquals, assertThrows } from "@std/assert";
import {
  getManagedReservedEnvKeys,
  parseEnvironmentDeployPayload,
  parseEnvironmentLifecyclePayload,
  parseEnvironmentStopPayload,
  parseFabricReconcilePayload,
  parseFabricReconcileResult,
  parseManagedApplyPayload,
  parseManagedIngressReconcileResult,
  parsePrincipalsReconcilePayload,
  parseTlsTrustReconcilePayload,
  parseTlsTrustReconcileResult,
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
      contents: "local all all peer\n",
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
      password: TP_ENVELOPE,
    },
  ],
  memberId: "00000000-0000-4000-8000-0000000000a1",
  memberRole: "primary",
  memberOrdinal: 1,
  readEligible: false,
  peers: [],
};

test("parseEnvironmentDeployPayload round-trips hosting proxy and web.php options", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    hostings: [{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: ["app.example.test"],
      pathPrefix: "/api",
      targetPort: 8080,
      tlsId: null,
      bindAddress: "203.0.113.10",
      proxy: {
        forceHttps: true,
        gzip: true,
        brotli: false,
        stripPrefix: "/old",
      },
      web: {
        env: { APP_ENV: "production" },
        php: {
          version: "8.4",
          settings: { memory_limit: "256M" },
          pool: { pm: "dynamic" },
          extensions: ["curl", "mbstring"],
        },
      },
    }],
  });
  const hosting = payload.hostings[0];
  assertEquals(hosting?.pathPrefix, "/api");
  assertEquals(hosting?.targetPort, 8080);
  assertEquals(hosting?.tlsId, null);
  assertEquals(hosting?.proxy?.forceHttps, true);
  assertEquals(hosting?.proxy?.stripPrefix, "/old");
  assertEquals(hosting?.web?.php?.extensions, ["curl", "mbstring"]);
});

test("parseEnvironmentDeployPayload round-trips udp protocol and rejects empty ports", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    hostings: [{
      hostingId: "h-udp",
      serviceId: "s-udp",
      composeServiceName: "game",
      hostnames: [],
      protocol: "udp",
      ports: [{ published: 27015, target: 27015 }],
      bindAddress: "203.0.113.20",
    }],
  });
  assertEquals(payload.hostings[0]?.protocol, "udp");
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        hostings: [{
          hostingId: "h-bad",
          serviceId: "s-bad",
          composeServiceName: "game",
          hostnames: [],
          protocol: "tcp",
          ports: [],
        }],
      }),
    TypeError,
    "hostings[].ports must be a non-empty array when present",
  );
});

test("parseEnvironmentDeployPayload rejects invalid hosting hostnames and pathPrefix", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        hostings: [{
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: ["not_a_hostname"],
        }],
      }),
    TypeError,
    "hostings[].hostnames must contain valid hostnames",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        hostings: [{
          hostingId: "h1",
          serviceId: "s1",
          composeServiceName: "web",
          hostnames: ["app.example.test"],
          pathPrefix: "no-leading-slash",
        }],
      }),
    TypeError,
    "hostings[].pathPrefix must start with /",
  );
});

test("parseEnvironmentDeployPayload round-trips managed-directory site with cron", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    sites: [{
      composeServiceName: "site",
      engine: "openlitespeed",
      root: "public",
      listenPort: 18080,
      sourceKind: "managed-directory",
      webEnv: { DOCUMENT_ROOT: "public" },
      principal: {
        principalId: PRINCIPAL_ID,
        username: "site_user",
        uid: 10001,
        gid: 10001,
      },
      cron: [{
        name: "nightly",
        schedule: "*-*-* 02:00:00",
        command: ["/usr/bin/php", "/srv/app/artisan", "schedule:run"],
      }],
    }],
  });
  const site = payload.sites?.[0];
  assertEquals(site?.sourceKind, "managed-directory");
  assertEquals(site?.cron?.[0]?.name, "nightly");
  assertEquals(site?.principal?.username, "site_user");
});

test("parseEnvironmentDeployPayload rejects cron and managed-directory without principal", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        sites: [{
          composeServiceName: "site",
          engine: "nginx",
          root: "public",
          listenPort: 18080,
          cron: [{
            name: "job",
            schedule: "hourly",
            command: ["/bin/true"],
          }],
        }],
      }),
    TypeError,
    "scheduled jobs require a principal to run as",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        sites: [{
          composeServiceName: "site",
          engine: "caddy",
          root: "public",
          listenPort: 18080,
          sourceKind: "managed-directory",
        }],
      }),
    TypeError,
    "managed-directory site requires a principal",
  );
});

test("parseEnvironmentDeployPayload round-trips release sourceKind site", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    sites: [{
      composeServiceName: "static",
      engine: "caddy",
      root: "dist",
      listenPort: 18443,
      sourceKind: "release",
    }],
  });
  assertEquals(payload.sites?.[0]?.sourceKind, "release");
});

test("parseEnvironmentDeployPayload round-trips railpack sourceMaterial options", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    sourceMaterial: [{
      ...SOURCE_ENTRY,
      provider: "git",
      cloneUrl: "git@gitlab.test:acme/app.git",
      credentialKind: "ssh_key",
      rollbackToReleaseId: "prev-rel",
      subdirectory: "apps/web",
      commitMessage: "Deploy build",
      commitAuthor: "ci@203.0.113.1",
      build: {
        kind: "railpack",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        startCommand: "node server.js",
        outputDirectory: "dist",
        env: { NODE_ENV: "production" },
      },
    }],
  });
  const source = payload.sourceMaterial?.[0];
  assertEquals(source?.credentialKind, "ssh_key");
  assertEquals(source?.rollbackToReleaseId, "prev-rel");
  assertEquals(source?.build.kind, "railpack");
  assertEquals(source?.subdirectory, "apps/web");
});

test("parseEnvironmentDeployPayload rejects credential-bearing cloneUrl", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        sourceMaterial: [{
          ...SOURCE_ENTRY,
          cloneUrl: "https://oauth2:secret@gitlab.test/acme/app.git",
        }],
      }),
    TypeError,
    "Invalid sourceMaterial cloneUrl",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        sourceMaterial: [{
          ...SOURCE_ENTRY,
          ref: "../escape",
        }],
      }),
    TypeError,
    "Invalid sourceMaterial ref/commitSha",
  );
});

test("parseEnvironmentDeployPayload round-trips nativeAppServices optional limits", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    nativeAppServices: [{
      composeServiceName: "api",
      serviceId: "svc-native-1",
      listenPort: 13000,
      framework: "next",
      nodeVersion: "22.11",
      resources: { cpus: 2, memoryBytes: 512_000_000 },
      accountLimits: { cpus: 1, memoryBytes: 256_000_000, tasksMax: 4 },
    }],
  });
  const app = payload.nativeAppServices?.[0];
  assertEquals(app?.framework, "next");
  assertEquals(app?.nodeVersion, "22.11");
  assertEquals(app?.resources?.cpus, 2);
  assertEquals(app?.accountLimits?.tasksMax, 4);
});

test("parseEnvironmentDeployPayload rejects invalid nativeAppServices fields", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        nativeAppServices: [{
          composeServiceName: "api",
          serviceId: "svc-native-1",
          listenPort: 13000,
          framework: "deno",
        }],
      }),
    TypeError,
    "Invalid nativeAppServices entry",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        nativeAppServices: [{
          composeServiceName: "api",
          serviceId: "svc-native-1",
          listenPort: 13000,
          framework: "node",
          nodeVersion: "latest",
        }],
      }),
    TypeError,
    "Invalid nativeAppServices nodeVersion",
  );
});

test("parseEnvironmentDeployPayload round-trips variableMaterial flags and ingressServices", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    variableMaterial: [{
      key: "API_KEY",
      composeServiceName: null,
      forBuild: true,
      forRuntime: false,
      isLiteral: true,
      valueEnvelope: TP_ENVELOPE,
    }],
    ingressServices: [{
      serviceId: SERVICE_UUID,
      composeServiceName: "traefik",
      containerName: `${SERVICE_UUID}-in`,
    }],
    tlsMaterial: [{
      tlsId: "tls-1",
      certificatePem:
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      privateKeyEnvelope: TP_ENVELOPE,
    }],
  });
  const variable = payload.variableMaterial?.[0];
  assertEquals(variable?.forBuild, true);
  assertEquals(variable?.forRuntime, false);
  assertEquals(variable?.isLiteral, true);
  assertEquals(payload.ingressServices?.[0]?.composeServiceName, "traefik");
  assertEquals(payload.tlsMaterial?.[0]?.tlsId, "tls-1");
});

test("parseEnvironmentDeployPayload rejects invalid secretPlan and oversized envFile", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        secretPlan: [{
          key: "DB_PASS",
          composeServiceName: "web",
          source: "../escape",
          target: "DB_PASS",
          relativePath: "db_pass",
        }],
      }),
    TypeError,
    "Invalid environment deploy secretPlan source/target",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        envFile: "x".repeat(1_048_577),
      }),
    TypeError,
    "envFile exceeds maximum length",
  );
});

test("parseEnvironmentDeployPayload round-trips generation desiredHash replicaCounts serverId", () => {
  const hash = "a".repeat(64);
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    generation: 7,
    desiredHash: hash,
    replicaCounts: { web: 3, api: 2 },
    serverId: SERVER_UUID,
  });
  assertEquals(payload.generation, 7);
  assertEquals(payload.desiredHash, hash);
  assertEquals(payload.replicaCounts, { web: 3, api: 2 });
  assertEquals(payload.serverId, SERVER_UUID);
});

test("parseEnvironmentDeployPayload rejects invalid generation replicaCounts and desiredHash", () => {
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        generation: -1,
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        desiredHash: "not-a-sha256",
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        replicaCounts: { web: 0 },
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
});

test("parseEnvironmentDeployPayload round-trips principalMaterial runtimes and sshKeys", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    principalMaterial: [{
      principalId: PRINCIPAL_ID,
      username: "deploy_user",
      home: "/srv/users/deploy_user",
      shell: "/bin/bash",
      runtimes: [{ runtime: "php", series: "8.4" }],
      accessGroups: ["tpnodeapp"],
      sshKeys: [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEmvBcjT+NvO6sokGNoJ0zA3dr0nhIQhhZ3wP220uFZ",
      ],
    }],
  });
  const principal = payload.principalMaterial?.[0];
  assertEquals(principal?.runtimes?.[0]?.series, "8.4");
  assertEquals(principal?.accessGroups, ["tpnodeapp"]);
  assertEquals(principal?.sshKeys?.length, 1);
});

test("parseEnvironmentDeployPayload round-trips serviceHooks and path storage mount", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    serviceHooks: [{
      composeServiceName: "web",
      preDeployCommand: "echo pre",
      postDeployCommand: "echo post",
      buildDisableCache: true,
    }],
    storageMaterial: [{
      storageId: "st-1",
      locationId: "loc-1",
      kind: "directory",
      name: "uploads",
      provider: "path",
      serverId: "srv-1",
      sourcePath: "/var/lib/turbopanel/uploads",
      managed: true,
      mounts: [{
        destinationPath: "/data",
        composeServiceName: "web",
        subpath: "files",
        readOnly: true,
      }],
    }],
  });
  assertEquals(payload.serviceHooks?.[0]?.buildDisableCache, true);
  assertEquals(payload.storageMaterial?.[0]?.provider, "path");
  assertEquals(payload.storageMaterial?.[0]?.mounts[0]?.readOnly, true);
});

test("parseEnvironmentStopPayload round-trips ingressServices and rejects bad serviceId", () => {
  assertEquals(
    parseEnvironmentStopPayload({
      environmentId: "env-1",
      projectId: "proj-1",
      projectName: "tp-demo",
      ingressServices: [{ serviceId: SERVICE_UUID }],
    }).ingressServices,
    [{ serviceId: SERVICE_UUID }],
  );
  assertThrows(
    () =>
      parseEnvironmentStopPayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "tp-demo",
        ingressServices: [{ serviceId: "not-a-uuid" }],
      }),
    TypeError,
    "Invalid environment.stop ingressServices entry",
  );
});

test("parseEnvironmentLifecyclePayload rejects unknown action", () => {
  assertThrows(
    () =>
      parseEnvironmentLifecyclePayload({
        environmentId: "env-1",
        projectId: "proj-1",
        projectName: "demo",
        action: "pause",
      }),
    TypeError,
    "Invalid environment lifecycle payload",
  );
});

test("parsePrincipalsReconcilePayload accepts empty list and rejects duplicate username", () => {
  assertEquals(parsePrincipalsReconcilePayload({ principals: [] }), {
    principals: [],
  });
  assertThrows(
    () => parsePrincipalsReconcilePayload(null),
    Error,
    "Invalid principals reconcile payload",
  );
  assertThrows(
    () => parsePrincipalsReconcilePayload({ principals: "all" }),
    TypeError,
    "principals must be an array",
  );
  assertThrows(
    () =>
      parsePrincipalsReconcilePayload({
        principals: [
          {
            principalId: PRINCIPAL_ID,
            username: "dup_user",
            home: "/srv/users/dup_user",
            shell: "/usr/sbin/nologin",
          },
          {
            principalId: "00000000-0000-4000-8000-000000000088",
            username: "dup_user",
            home: "/srv/users/dup_user2",
            shell: "/usr/sbin/nologin",
          },
        ],
      }),
    Error,
    "principals contains dup_user more than once",
  );
});

test("parseTlsTrustReconcilePayload round-trips allowRemoval and rejects bad PEM", () => {
  const bundlePem =
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  assertEquals(
    parseTlsTrustReconcilePayload({
      bundlePem,
      fingerprint: "sha256:abc",
      allowRemoval: true,
    }),
    { bundlePem, fingerprint: "sha256:abc", allowRemoval: true },
  );
  assertThrows(
    () => parseTlsTrustReconcilePayload(null),
    Error,
    "Invalid tls trust reconcile payload",
  );
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem: "   ",
        fingerprint: "sha256:abc",
      }),
    Error,
    "bundlePem must be a non-empty PEM string",
  );
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem,
        fingerprint: "   ",
      }),
    Error,
    "fingerprint must be a non-empty string",
  );
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem: "not-a-pem-bundle",
        fingerprint: "sha256:abc",
      }),
    Error,
    "bundlePem must contain at least one certificate",
  );
  assertThrows(
    () =>
      parseTlsTrustReconcilePayload({
        bundlePem,
        fingerprint: "sha256:abc",
        allowRemoval: "yes",
      }),
    TypeError,
    "allowRemoval must be a boolean",
  );
});

test("parseTlsTrustReconcileResult rejects missing applied boolean", () => {
  assertEquals(
    parseTlsTrustReconcileResult({ applied: false, fingerprint: "fp" }),
    { applied: false, fingerprint: "fp" },
  );
  assertThrows(
    () => parseTlsTrustReconcileResult(null),
    Error,
    "Invalid tls trust reconcile result",
  );
  assertThrows(
    () => parseTlsTrustReconcileResult({ fingerprint: "fp" }),
    TypeError,
    "applied must be a boolean",
  );
  assertThrows(
    () => parseTlsTrustReconcileResult({ applied: true, fingerprint: "   " }),
    Error,
    "fingerprint must be a non-empty string",
  );
});

test("getManagedReservedEnvKeys returns engine sets and empty for unknown", () => {
  const postgres = getManagedReservedEnvKeys("postgres");
  assertEquals(postgres.has("POSTGRES_PASSWORD"), true);
  const mysql = getManagedReservedEnvKeys("mysql");
  assertEquals(mysql.has("MYSQL_ROOT_PASSWORD"), true);
  const mariadb = getManagedReservedEnvKeys("mariadb");
  assertEquals(mariadb.has("MARIADB_ROOT_PASSWORD"), true);
  assertEquals(getManagedReservedEnvKeys("unknown-engine").size, 0);
});

test("parseFabricReconcilePayload round-trips direct_nat pathKind and network gateway", () => {
  const payload = parseFabricReconcilePayload({
    enabled: true,
    fabricId: SERVER_UUID,
    listenPort: 51820,
    mtu: 1420,
    address: "203.0.113.2/32",
    prefix: "10.192.0.0/16",
    gateway: true,
    peers: [{
      publicKey: WG_PUBKEY,
      allowedIPs: ["203.0.113.0/24"],
      endpoint: "203.0.113.10:51820",
      pathKind: "direct_nat",
      viaServerId: SERVER_UUID,
      presharedKeyEnvelope: TP_ENVELOPE,
    }],
    networks: [{
      name: "tpn_mesh01",
      subnet: "10.192.11.0/24",
      mtu: 1420,
      gateway: "203.0.113.1",
    }],
  });
  assertEquals(payload.enabled, true);
  if (payload.enabled) {
    assertEquals(payload.peers[0]?.pathKind, "direct_nat");
    assertEquals(payload.peers[0]?.viaServerId, SERVER_UUID);
    assertEquals(payload.networks?.[0]?.gateway, "203.0.113.1");
  }
});

test("parseFabricReconcileResult round-trips peer health and transfer counters", () => {
  const result = parseFabricReconcileResult({
    summary: "mesh converged",
    skipped: false,
    publicKey: WG_PUBKEY,
    peers: [{
      publicKey: WG_PUBKEY,
      lastHandshakeAt: "2026-08-09T12:00:00.000Z",
      transferRx: 100,
      transferTx: 200,
      endpoint: "203.0.113.10:51820",
      health: "healthy",
    }],
  });
  assertEquals(result.peers?.[0]?.health, "healthy");
  assertEquals(result.peers?.[0]?.transferRx, 100);
});

test("parseManagedApplyPayload round-trips databases credentials privileges and resources", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    databases: [
      { name: "appdb", action: "create" },
      { name: "legacy", action: "drop" },
    ],
    credentials: [{
      principalId: "00000000-0000-4000-8000-000000000003",
      username: "appuser",
      role: "user",
      databases: ["appdb"],
      password: TP_ENVELOPE,
      privileges: ["SELECT", "INSERT"],
    }],
    resources: {
      cpus: 2,
      memoryBytes: 1_073_741_824,
      memoryReservationBytes: 536_870_912,
    },
  });
  assertEquals(payload.databases?.[0]?.action, "create");
  assertEquals(payload.credentials[0]?.privileges, ["SELECT", "INSERT"]);
  assertEquals(payload.resources?.memoryReservationBytes, 536_870_912);
});

test("parseManagedApplyPayload rejects invalid databases and credential privileges", () => {
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        databases: [{ name: "appdb", action: "truncate" }],
      }),
    TypeError,
    "Invalid managed.apply databases entry",
  );
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        credentials: [{
          ...VALID_MANAGED_APPLY.credentials[0],
          privileges: [123],
        }],
      }),
    TypeError,
    "Invalid managed.apply credentials.privileges",
  );
});

test("parseEnvironmentDeployPayload covers leftover hosting site native and source fields", () => {
  const hostingPayload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    hostings: [{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: ["app.example.test"],
      tlsId: "tls-cert-1",
    }],
    sites: [{
      composeServiceName: "site",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
      php: { version: "8.4", settings: { memory_limit: "128M" } },
    }],
    nativeAppServices: [{
      composeServiceName: "api",
      serviceId: "svc-native-1",
      listenPort: 13000,
      framework: "node",
      resources: {},
      accountLimits: {},
    }],
  });
  assertEquals(hostingPayload.hostings[0]?.tlsId, "tls-cert-1");
  assertEquals(hostingPayload.sites?.[0]?.php?.version, "8.4");
  assertEquals(hostingPayload.nativeAppServices?.[0]?.resources, undefined);
  assertEquals(hostingPayload.nativeAppServices?.[0]?.accountLimits, undefined);

  const partialLimits = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    nativeAppServices: [{
      composeServiceName: "api",
      serviceId: "svc-native-1",
      listenPort: 13000,
      framework: "node",
      resources: { memoryBytes: 512_000_000 },
      accountLimits: { cpus: 1 },
    }],
  });
  assertEquals(partialLimits.nativeAppServices?.[0]?.resources, {
    memoryBytes: 512_000_000,
  });
  assertEquals(partialLimits.nativeAppServices?.[0]?.accountLimits, {
    cpus: 1,
  });

  const storage = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    storageMaterial: [{
      storageId: "st-1",
      locationId: "loc-1",
      kind: "file",
      name: "secret",
      provider: "path",
      serverId: "srv-1",
      sourcePath: "/var/lib/turbopanel/secret",
      principalId: PRINCIPAL_ID,
      contentEnvelope: TP_ENVELOPE,
      mounts: [{
        destinationPath: "/run/secret",
        serviceId: SERVICE_UUID,
      }],
    }],
  });
  assertEquals(storage.storageMaterial?.[0]?.principalId, PRINCIPAL_ID);
  assertEquals(storage.storageMaterial?.[0]?.contentEnvelope, TP_ENVELOPE);
  assertEquals(
    storage.storageMaterial?.[0]?.mounts[0]?.serviceId,
    SERVICE_UUID,
  );

  const source = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    sourceMaterial: [{
      ...SOURCE_ENTRY,
      commitMessage: "   \n  ",
      commitAuthor: "x".repeat(400),
    }],
  });
  assertEquals(source.sourceMaterial?.[0]?.commitMessage, undefined);
  assertEquals(source.sourceMaterial?.[0]?.commitAuthor?.length, 300);

  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        sourceMaterial: [{ ...SOURCE_ENTRY, subdirectory: 12 }],
      }),
    TypeError,
    "Invalid sourceMaterial subdirectory",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        sourceMaterial: [{ ...SOURCE_ENTRY, subdirectory: "" }],
      }),
    TypeError,
    "Invalid sourceMaterial subdirectory",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        sourceMaterial: [{ ...SOURCE_ENTRY, subdirectory: "/abs" }],
      }),
    TypeError,
    "Invalid sourceMaterial subdirectory",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        composeFiles: [null],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        composeFiles: [{
          filename: "compose.yaml",
          role: "project",
          content: "services:\n  web:\n    image: nginx\n",
        }],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        composeFiles: [{
          filename: "docker-compose.yaml",
          role: "runtime",
          content: "services:\n  web:\n    image: nginx\n",
        }],
      }),
    TypeError,
    "Invalid environment deploy payload",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        dockerExternalNetworks: [12],
      }),
    TypeError,
    "Invalid dockerExternalNetworks entry",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          home: "",
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial home",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          home: `/${"a".repeat(255)}`,
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial home",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          home: "/tmp/my home",
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial home",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          home: "/tmp/home\0x",
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial home",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          home: "/tmp/home\n",
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial home",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          home: "/tmp/../etc",
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial home",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          shell: "nologin",
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial shell",
  );
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY_BASE,
        principalMaterial: [{
          principalId: PRINCIPAL_ID,
          username: "deploy_user",
          shell: "/bin/sh@bad",
        }],
      }),
    TypeError,
    "Invalid environment deploy principalMaterial shell",
  );
});

test("parseManagedIngressReconcileResult rejects a non-object result", () => {
  assertThrows(
    () => parseManagedIngressReconcileResult(null),
    TypeError,
    "Invalid managed.ingress.reconcile result",
  );
});

test("parseManagedIngressReconcileResult rejects non-array containers", () => {
  assertThrows(
    () =>
      parseManagedIngressReconcileResult({
        summary: "ok",
        appliedUsers: ["app"],
        appliedBackends: [SERVICE_UUID],
        restarted: false,
        containers: "none",
      }),
    TypeError,
    "Invalid managed.ingress.reconcile result containers",
  );
});

test("parseManagedIngressReconcileResult rejects malformed container role", () => {
  assertThrows(
    () =>
      parseManagedIngressReconcileResult({
        summary: "ok",
        appliedUsers: ["app"],
        appliedBackends: [SERVICE_UUID],
        restarted: false,
        containers: [{
          composeServiceName: "proxysql",
          containerId: "cid-1",
          containerName: "proxysql-1",
          status: "running",
          role: "bogus",
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile result containers",
  );
});
