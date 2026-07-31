import { assertEquals, assertThrows } from "@std/assert";
import {
  COMMAND_TYPES,
  type CommandAckMessage,
  type CommandDispatchMessage,
  type CommandOutcomeMessage,
  parseEnvironmentDeployPayload,
  parseEnvironmentStopPayload,
  parseManagedApplyPayload,
  parseManagedApplyResult,
  parseManagedBackupPayload,
  parseManagedBackupResult,
  parseManagedDestroyPayload,
  parseManagedDestroyResult,
  parseManagedLifecyclePayload,
  parseManagedLifecycleResult,
  parseManagedRestorePayload,
  parseManagedRestoreResult,
  parseWireguardApplyPayload,
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
  "server.wireguard.apply",
  "environment.deploy",
  "environment.stop",
  "managed.apply",
  "managed.lifecycle",
  "managed.destroy",
  "managed.backup",
  "managed.restore",
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

test("environment.deploy storageMaterial accepts docker_volume without destinationPath", () => {
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
        kind: "docker_volume",
        name: "data",
        serverId: "srv-1",
        volumeName: volumeId,
      },
    ],
  });
  assertEquals(payload.storageMaterial?.[0]?.volumeName, volumeId);
  assertEquals(payload.storageMaterial?.[0]?.destinationPath, undefined);
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
            kind: "docker_volume",
            name: "data",
            serverId: "srv-1",
            volumeName: "-bad",
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
          uid: 10001,
          gid: 10001,
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

test("environment.deploy principalMaterial round-trips home and shell", () => {
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
        home: "/srv/users/00000000-0000-4000-8000-000000000099",
        shell: "/usr/sbin/nologin",
      },
    ],
  });
  assertEquals(
    payload.principalMaterial?.[0]?.home,
    "/srv/users/00000000-0000-4000-8000-000000000099",
  );
  assertEquals(payload.principalMaterial?.[0]?.shell, "/usr/sbin/nologin");
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

test("server.wireguard.apply fixture round-trips", () => {
  const payload = parseWireguardApplyPayload({
    vpnId: "550e8400-e29b-41d4-a716-446655440000",
    peerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    interfaceName: "tpwg550e8400",
    address: "203.0.113.10/32",
    listenPort: 51820,
    peers: [
      {
        peerId: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        allowedIps: ["203.0.113.11/32"],
        endpoint: "203.0.113.1:51820",
      },
    ],
  });
  assertEquals(payload.address, "203.0.113.10/32");
  assertEquals(payload.peers[0]?.endpoint, "203.0.113.1:51820");
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
  ],
  volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
  exposure: { enabled: false, protocol: "tcp" },
  credentials: [
    {
      principalId: "00000000-0000-4000-8000-000000000003",
      username: "postgres",
      role: "root",
      databases: ["postgres"],
      password: "denc.server.key.1.payload",
    },
  ],
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

test("managed.apply rejects nested dockerOptions and enabled exposure without port", () => {
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
  assertThrows(
    () =>
      parseManagedApplyPayload({
        ...VALID_MANAGED_APPLY,
        exposure: { enabled: true, protocol: "tcp" },
      }),
    TypeError,
    "Invalid managed.apply exposure",
  );
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      exposure: { enabled: true, protocol: "tcp", publishedPort: 15432 },
    }).exposure.publishedPort,
    15432,
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
        { path: "tls/server.crt", contents: "cert\n", mode: "0640" },
        { path: "tls/server.key", contents: "key\n", mode: "0600" },
      ],
    }).configFiles.map((file) => file.path),
    ["postgresql.conf", "tls/server.crt", "tls/server.key"],
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
