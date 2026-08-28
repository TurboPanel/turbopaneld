import { assertEquals, assertThrows } from "@std/assert";
import {
  isValidIpv6Literal,
  parseEnvironmentDeployPayload,
  parseManagedApplyPayload,
  parseManagedApplyResult,
  parseManagedBackupResult,
  parseManagedDestroyResult,
  parseManagedLifecycleResult,
  parseManagedPromoteResult,
  parseManagedReplicationHealth,
  parseManagedRestoreResult,
} from "./contracts.ts";

/**
 * Shared hosting-ingress Docker network — the `hosting-ingress` system
 * component's allocated `serviceId`, required on the wire whenever a deploy
 * carries hostings. A bare UUID, not a readable literal.
 */
const HOSTING_INGRESS_NETWORK = "00000000-0000-4000-8000-0000000000bb";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TP_ENVELOPE = "tpdaemon.v1.sealed.payload";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";

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

const VALID_MANAGED_APPLY = {
  managedId: "00000000-0000-4000-8000-000000000001",
  environmentId: "00000000-0000-4000-8000-000000000002",
  engine: "postgres",
  projectName: "tp-managed-pg",
  containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
  managedNetwork: "00000000-0000-4000-8000-0000000000ee",
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
  memberId: MEMBER_ID,
  memberRole: "primary",
  memberOrdinal: 1,
  readEligible: false,
  peers: [],
};

function hosting(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    hostingId: "h1",
    serviceId: "s1",
    composeServiceName: "web",
    hostnames: ["app.example.test"],
    ...overrides,
  };
}

function rejectDockerOptions(dockerOptions: unknown): void {
  assertThrows(
    () => parseManagedApplyPayload({ ...VALID_MANAGED_APPLY, dockerOptions }),
    TypeError,
    "Invalid managed.apply dockerOptions",
  );
}

function deployContainer(
  index: number,
  role: "service" | "ingress" | "turbopanel" = "service",
): Record<string, unknown> {
  return {
    composeServiceName: "pg",
    containerId: `cid-${index}`,
    containerName: `pg-${index}`,
    status: "running",
    role,
  };
}

test("empty hosting proxy and php objects are omitted rather than stored", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    hostings: [hosting({
      proxy: {},
      web: { php: {}, env: {} },
    })],
    hostingIngressNetwork: HOSTING_INGRESS_NETWORK,
    sites: [{
      composeServiceName: "site",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
      php: {},
      webEnv: {},
    }],
  });
  assertEquals(payload.hostings[0]?.proxy, undefined);
  assertEquals(payload.hostings[0]?.web, undefined);
  assertEquals(payload.sites?.[0]?.php, undefined);
  assertEquals(payload.sites?.[0]?.webEnv, undefined);
});

test("isValidIpv6Literal parseSide inner null rejects bad hextets and misplaced IPv4", () => {
  assertEquals(isValidIpv6Literal("2001:db8::gggg"), false);
  assertEquals(isValidIpv6Literal("203.0.113.1:abcd:ef01"), false);
});

test("hosting web and site omit php when it is not a record", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    hostings: [hosting({
      web: { env: { KEEP: "yes" }, php: "not-an-object" },
    })],
    hostingIngressNetwork: HOSTING_INGRESS_NETWORK,
    sites: [{
      composeServiceName: "site",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
      php: 42,
    }],
  });
  assertEquals(payload.hostings[0]?.web, { env: { KEEP: "yes" } });
  assertEquals(payload.sites?.[0]?.php, undefined);
});

test("hosting proxy and php drop non-boolean / non-string entries and keep valid ones", () => {
  const payload = parseEnvironmentDeployPayload({
    ...DEPLOY_BASE,
    hostings: [
      hosting({
        proxy: { forceHttps: 1, gzip: "yes", brotli: null, stripPrefix: 12 },
        web: {
          env: { KEEP: "yes", DROP: 1 },
          php: {
            version: 8,
            settings: { memory_limit: "128M", workers: 4 },
            pool: {},
            extensions: [1, "curl", null, "mbstring"],
          },
        },
      }),
      hosting({
        hostingId: "h2",
        proxy: "not-an-object",
        web: "not-an-object",
      }),
    ],
    hostingIngressNetwork: HOSTING_INGRESS_NETWORK,
  });
  assertEquals(payload.hostings[0]?.proxy, undefined);
  assertEquals(payload.hostings[0]?.web, {
    env: { KEEP: "yes" },
    php: {
      settings: { memory_limit: "128M" },
      extensions: ["curl", "mbstring"],
    },
  });
  assertEquals(payload.hostings[1]?.proxy, undefined);
  assertEquals(payload.hostings[1]?.web, undefined);
});

test("managed.apply omits empty dockerOptions and keeps empty nested maps", () => {
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      dockerOptions: {},
    }).dockerOptions,
    undefined,
  );
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      dockerOptions: { labels: {}, extraEnv: {}, ulimits: {} },
    }).dockerOptions,
    { labels: {}, extraEnv: {}, ulimits: {} },
  );
});

test("managed.apply round-trips allowlisted dockerOptions including nofile ulimits", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    dockerOptions: {
      restart: "unless-stopped",
      stopGracePeriodSeconds: 15,
      shmSizeBytes: 67_108_864,
      ulimits: { nofile: { soft: 1024, hard: 2048 } },
      labels: { "app.kubernetes.io/name": "postgres" },
      extraEnv: { LANG: "C" },
    },
  });
  assertEquals(payload.dockerOptions, {
    restart: "unless-stopped",
    stopGracePeriodSeconds: 15,
    shmSizeBytes: 67_108_864,
    ulimits: { nofile: { soft: 1024, hard: 2048 } },
    labels: { "app.kubernetes.io/name": "postgres" },
    extraEnv: { LANG: "C" },
  });
});

test("managed.apply dockerOptions inner parsers return null for hostile nested values", () => {
  rejectDockerOptions("always");
  rejectDockerOptions({ labels: { "": "v" } });
  rejectDockerOptions({ labels: "not-a-map" });
  rejectDockerOptions({
    labels: Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`label${index}`, "v"]),
    ),
  });
  rejectDockerOptions({ labels: { "bad key": "v" } });
  rejectDockerOptions({ labels: { "com.docker.compose.project": "x" } });
  rejectDockerOptions({ labels: { app: 12 } });
  rejectDockerOptions({ labels: { app: "x".repeat(257) } });

  rejectDockerOptions({ extraEnv: ["TZ=UTC"] });
  rejectDockerOptions({
    extraEnv: Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`K_${index}`, "v"]),
    ),
  });
  rejectDockerOptions({ extraEnv: { "1BAD": "v" } });
  rejectDockerOptions({ extraEnv: { TZ: 1 } });
  rejectDockerOptions({ extraEnv: { TZ: "x".repeat(4097) } });
  rejectDockerOptions({ extraEnv: { TZ: "UTC\u0001" } });

  rejectDockerOptions({ ulimits: "nofile" });
  rejectDockerOptions({ ulimits: { nproc: { soft: 1, hard: 2 } } });
  rejectDockerOptions({ ulimits: { nofile: "unlimited" } });
  rejectDockerOptions({ ulimits: { nofile: { soft: 1024 } } });
  rejectDockerOptions({ ulimits: { nofile: { soft: 0, hard: 1 } } });
  rejectDockerOptions({ ulimits: { nofile: null } });

  rejectDockerOptions({ stopGracePeriodSeconds: 0 });
  rejectDockerOptions({ shmSizeBytes: "64m" });
  rejectDockerOptions({ restart: 1 });
});

test("managed result parsers drop invalid container entries instead of throwing", () => {
  const result = parseManagedApplyResult({
    host: "203.0.113.10",
    port: 5432,
    engineVersion: "18.1",
    appliedUsers: ["postgres", 12],
    appliedDatabases: ["appdb"],
    containers: [
      null,
      { composeServiceName: "pg" },
      deployContainer(1, "turbopanel"),
      deployContainer(2, "service"),
    ],
    member: "not-a-record",
  });
  assertEquals(result.engineVersion, "18.1");
  assertEquals(result.appliedUsers, undefined);
  assertEquals(result.appliedDatabases, ["appdb"]);
  assertEquals(result.member, undefined);
  assertEquals(result.containers, [
    {
      composeServiceName: "pg",
      containerId: "cid-1",
      containerName: "pg-1",
      status: "running",
      role: "turbopanel",
    },
    {
      composeServiceName: "pg",
      containerId: "cid-2",
      containerName: "pg-2",
      status: "running",
      role: "service",
    },
  ]);

  assertEquals(
    parseManagedApplyResult({
      host: "203.0.113.10",
      port: 5432,
      containers: "not-an-array",
    }).containers,
    undefined,
  );
  const capped = parseManagedApplyResult({
    host: "203.0.113.10",
    port: 5432,
    containers: Array.from(
      { length: 101 },
      (_, index) => deployContainer(index),
    ),
  });
  assertEquals(capped.containers?.length, 100);

  assertEquals(
    parseManagedDestroyResult({
      status: "stopped",
      containers: [null, deployContainer(3), { role: "service" }],
    }).containers,
    [{
      composeServiceName: "pg",
      containerId: "cid-3",
      containerName: "pg-3",
      status: "running",
      role: "service",
    }],
  );
  assertEquals(
    parseManagedLifecycleResult({
      status: "ready",
      member: { memberId: "not-a-uuid", role: "primary", status: "ready" },
    }).member,
    undefined,
  );
});

test("managed promote backup and restore results omit invalid optional fields", () => {
  assertEquals(parseManagedPromoteResult(null), {
    status: "",
    role: "",
    promotedMemberId: "",
    demoted: false,
  });
  const promote = parseManagedPromoteResult({
    status: "ready",
    role: "primary",
    promotedMemberId: "not-a-uuid",
    demotedMemberId: "also-bad",
    demoted: "yes",
    summary: 12,
    replication: "not-health",
  });
  assertEquals(promote.promotedMemberId, "");
  assertEquals(promote.demotedMemberId, undefined);
  assertEquals(promote.demoted, false);
  assertEquals(promote.summary, undefined);
  assertEquals(promote.replication, undefined);

  assertEquals(parseManagedBackupResult({}).backupId, "");
  const backup = parseManagedBackupResult({
    backupId: "bk_1",
    checksum: "not-sha256",
    sizeBytes: -1,
    pruned: ["keep", 12],
    deleted: "yes",
  });
  assertEquals(backup.checksum, undefined);
  assertEquals(backup.sizeBytes, undefined);
  assertEquals(backup.pruned, undefined);
  assertEquals(backup.deleted, undefined);
  assertEquals(
    parseManagedBackupResult({
      backupId: "bk_1",
      pruned: Array.from({ length: 201 }, (_, index) => `old_${index}`),
    }).pruned?.length,
    200,
  );

  assertEquals(parseManagedRestoreResult({ backupId: "" }).backupId, "");
  const restore = parseManagedRestoreResult({
    backupId: "bk_1",
    status: 12,
    restoredAt: 12,
    database: 12,
    summary: 12,
  });
  assertEquals(restore.status, undefined);
  assertEquals(restore.restoredAt, undefined);
  assertEquals(restore.database, undefined);
  assertEquals(restore.summary, undefined);
});

test("parseManagedReplicationHealth drops invalid lag fields and incomplete records", () => {
  assertEquals(
    parseManagedReplicationHealth({
      state: "streaming",
      observedAt: "not-iso",
    }),
    undefined,
  );
  assertEquals(
    parseManagedReplicationHealth({
      state: "catchup",
      observedAt: "2026-08-09T12:00:00.000Z",
      lagBytes: -1,
      lagSeconds: Number.NaN,
    }),
    {
      state: "catchup",
      observedAt: "2026-08-09T12:00:00.000Z",
    },
  );
  assertEquals(
    parseManagedReplicationHealth({
      state: "streaming",
      observedAt: "",
    }),
    undefined,
  );
  assertEquals(
    parseManagedReplicationHealth({
      state: "streaming",
      observedAt: `2026-08-09T12:00:00.000Z${"x".repeat(50)}`,
    }),
    undefined,
  );
});

test("managed result parsers keep valid member and replication observations", () => {
  const member = parseManagedLifecycleResult({
    status: "ready",
    summary: "up",
    member: {
      memberId: MEMBER_ID,
      role: "primary",
      status: "ready",
      replication: {
        state: "streaming",
        observedAt: "2026-08-09T12:00:00.000Z",
      },
    },
  }).member;
  assertEquals(member?.memberId, MEMBER_ID);
  assertEquals(member?.replication?.state, "streaming");

  const promote = parseManagedPromoteResult({
    status: "ready",
    role: "primary",
    promotedMemberId: MEMBER_ID,
    demoted: true,
    demotedMemberId: "00000000-0000-4000-8000-0000000000a2",
    summary: "promoted",
    replication: {
      state: "streaming",
      observedAt: "2026-08-09T12:00:00.000Z",
    },
  });
  assertEquals(promote.demoted, true);
  assertEquals(promote.replication?.state, "streaming");
});
