import { assertEquals, assertThrows } from "@std/assert";
import {
  parseManagedApplyPayload,
  parseManagedBackupPayload,
  parseManagedBackupResult,
  parseManagedDestroyPayload,
  parseManagedHaFailoverPayload,
  parseManagedHaFailoverResult,
  parseManagedHaReconcilePayload,
  parseManagedHaReconcileResult,
  parseManagedIngressReconcilePayload,
  parseManagedLifecyclePayload,
  parseManagedPromotePayload,
  parseManagedPromoteResult,
  parseManagedRestorePayload,
  parseManagedRestoreResult,
} from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TP_ENVELOPE = "tpdaemon.v1.sealed.payload";
const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const ENV_ID = "00000000-0000-4000-8000-000000000002";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";
const REPLICA_ID = "00000000-0000-4000-8000-0000000000a2";
const SERVER_ID = "00000000-0000-4000-8000-0000000000ab";
const SERVICE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const VALID_MANAGED_APPLY = {
  managedId: MANAGED_ID,
  environmentId: ENV_ID,
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
  memberId: MEMBER_ID,
  memberRole: "primary",
  memberOrdinal: 1,
  readEligible: false,
  peers: [],
};

const VALID_INGRESS = {
  serverId: SERVER_ID,
  bindAddresses: ["203.0.113.10"],
  clusters: [
    {
      managedId: MANAGED_ID,
      engine: "postgres",
      protocolPort: 5432,
      writerHostgroup: 0,
      readerHostgroup: 1,
      backends: [
        {
          memberId: MEMBER_ID,
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
          password: TP_ENVELOPE,
          defaultDatabase: "app",
        },
      ],
    },
  ],
};

const HA_IDENTITY = {
  serviceId: SERVICE_ID,
  composeServiceName: "orchestrator",
  containerName: `${SERVICE_ID}-ha`,
};

function rejectApply(patch: Record<string, unknown>, message: string): void {
  assertThrows(
    () => parseManagedApplyPayload({ ...VALID_MANAGED_APPLY, ...patch }),
    TypeError,
    message,
  );
}

test("parseManagedApplyPayload rejects configFiles volumes credentials and resources", () => {
  assertThrows(
    () => parseManagedApplyPayload(null),
    TypeError,
    "Invalid managed.apply payload",
  );
  rejectApply(
    { configFiles: "postgresql.conf" },
    "Invalid managed.apply configFiles",
  );
  rejectApply(
    {
      configFiles: Array.from(
        { length: 33 },
        () => VALID_MANAGED_APPLY.configFiles[0],
      ),
    },
    "Invalid managed.apply configFiles: too many entries",
  );
  rejectApply({ volumes: "pgdata" }, "Invalid managed.apply volumes");
  rejectApply(
    {
      volumes: Array.from({ length: 17 }, () => VALID_MANAGED_APPLY.volumes[0]),
    },
    "Invalid managed.apply volumes: too many entries",
  );
  rejectApply(
    { volumes: [{ name: "pgdata;rm", target: "/var/lib/postgresql" }] },
    "Invalid managed.apply volumes entry",
  );
  rejectApply(
    { volumes: [{ name: "pgdata", target: "relative" }] },
    "Invalid managed.apply volumes entry",
  );
  rejectApply({ resources: "lots" }, "Invalid managed.apply resources");
  rejectApply(
    { resources: { cpus: -1 } },
    "Invalid managed.apply resources.cpus",
  );
  rejectApply(
    { resources: { memoryBytes: 0 } },
    "Invalid managed.apply resources.memoryBytes",
  );
  rejectApply(
    { resources: { memoryReservationBytes: 1.5 } },
    "Invalid managed.apply resources.memoryReservationBytes",
  );
  rejectApply({ credentials: [] }, "Invalid managed.apply credentials");
  rejectApply(
    {
      credentials: Array.from(
        { length: 33 },
        () => VALID_MANAGED_APPLY.credentials[0],
      ),
    },
    "Invalid managed.apply credentials: too many entries",
  );
  rejectApply(
    { credentials: [null] },
    "Invalid managed.apply credentials entry",
  );
  rejectApply(
    {
      credentials: [{
        ...VALID_MANAGED_APPLY.credentials[0],
        role: "admin",
      }],
    },
    "Invalid managed.apply credentials entry",
  );
  rejectApply(
    {
      credentials: [{
        ...VALID_MANAGED_APPLY.credentials[0],
        databases: "postgres",
      }],
    },
    "Invalid managed.apply credentials.databases",
  );
  rejectApply(
    {
      credentials: [{
        ...VALID_MANAGED_APPLY.credentials[0],
        databases: ["bad;db"],
      }],
    },
    "Invalid managed.apply credentials.databases",
  );
});

test("parseManagedApplyPayload rejects exposure databases dropUsers and peers", () => {
  rejectApply(
    { exposure: { enabled: true } },
    "Invalid managed.apply exposure",
  );
  rejectApply(
    { exposure: { enabled: false, protocol: "quic" } },
    "Invalid managed.apply exposure.protocol",
  );
  rejectApply(
    { exposure: { enabled: true, protocol: "tcp", bindAddress: "not-an-ip" } },
    "Invalid managed.apply exposure.bindAddress",
  );
  rejectApply({ databases: "appdb" }, "Invalid managed.apply databases");
  rejectApply(
    {
      databases: Array.from(
        { length: 65 },
        (_, i) => ({ name: `db${i}`, action: "create" }),
      ),
    },
    "Invalid managed.apply databases: too many entries",
  );
  rejectApply({ dropUsers: "olduser" }, "Invalid managed.apply dropUsers");
  rejectApply(
    { dropUsers: Array.from({ length: 33 }, (_, i) => `user${i}`) },
    "Invalid managed.apply dropUsers: too many entries",
  );
  rejectApply({ peers: "none" }, "Invalid managed.apply peers");
  rejectApply(
    {
      peers: Array.from({ length: 5 }, (_, i) => ({
        memberId: `00000000-0000-4000-8000-0000000000b${i}`,
        role: "replica",
        readEligible: true,
        address: "203.0.113.51",
        port: 5432,
        transport: "datacenter",
      })),
    },
    "Invalid managed.apply peers: too many entries",
  );
  rejectApply({ peers: [null] }, "Invalid managed.apply peers entry");
  rejectApply(
    {
      peers: [{
        memberId: REPLICA_ID,
        role: "replica",
        readEligible: true,
        address: "203.0.113.51",
        port: 5432,
        transport: "datacenter",
        containerName: "../escape",
      }],
    },
    "Invalid managed.apply peers entry",
  );
});

test("parseManagedApplyPayload rejects privateListener and replication invariants", () => {
  rejectApply(
    { privateListener: "203.0.113.10:5432" },
    "Invalid managed.apply privateListener",
  );
  rejectApply(
    { privateListener: { address: "127.0.0.1", port: 5432 } },
    "Invalid managed.apply privateListener",
  );
  rejectApply(
    {
      privateListener: {
        address: "203.0.113.10",
        port: 5432,
        transport: "vpn",
      },
    },
    "Invalid managed.apply privateListener",
  );
  rejectApply(
    { replication: { role: "primary", username: "repl" } },
    "Invalid managed.apply replication: primary requires desiredSlots",
  );
  rejectApply(
    {
      replication: {
        role: "standby",
        username: "repl",
        slotName: "slot1",
      },
    },
    "Invalid managed.apply replication: standby requires slotName and primary",
  );
  rejectApply(
    {
      replication: {
        role: "primary",
        username: "repl",
        desiredSlots: "slot1",
      },
    },
    "Invalid managed.apply replication.desiredSlots",
  );
  rejectApply(
    {
      replication: {
        role: "primary",
        username: "repl",
        desiredSlots: ["bad;slot"],
      },
    },
    "Invalid managed.apply replication.desiredSlots",
  );
  rejectApply(
    {
      replication: {
        role: "primary",
        username: "repl",
        desiredSlots: ["slot1"],
        slotName: "bad slot",
      },
    },
    "Invalid managed.apply replication.slotName",
  );
  rejectApply(
    {
      replication: {
        role: "primary",
        username: "repl",
        desiredSlots: ["slot1"],
        peerAddresses: "",
      },
    },
    "Invalid managed.apply replication.peerAddresses",
  );
  rejectApply(
    {
      replication: {
        role: "standby",
        username: "repl",
        slotName: "slot1",
        primary: { host: "db-1", port: 5432, hostaddr: "not-an-ip" },
      },
    },
    "Invalid managed.apply replication.primary.hostaddr",
  );
  rejectApply(
    {
      replication: {
        role: "standby",
        username: "repl",
        slotName: "slot1",
        primary: { host: "db-1" },
      },
    },
    "Invalid managed.apply replication.primary",
  );
  rejectApply(
    { replication: { role: "witness", username: "repl" } },
    "Invalid managed.apply replication",
  );
});

test("parseManagedApplyPayload round-trips replication standby and privateListener", () => {
  const payload = parseManagedApplyPayload({
    ...VALID_MANAGED_APPLY,
    memberRole: "replica",
    exposure: { enabled: true, protocol: "tcp", bindAddress: "203.0.113.10" },
    privateListener: {
      address: "203.0.113.20",
      port: 5432,
      transport: "datacenter",
    },
    peers: [{
      memberId: REPLICA_ID,
      role: "replica",
      readEligible: true,
      address: "203.0.113.51",
      port: 5432,
      transport: "local",
      containerName: "replica-1",
    }],
    replication: {
      role: "standby",
      username: "repl",
      slotName: "slot1",
      peerAddresses: ["203.0.113.10"],
      primary: {
        host: "db-1",
        port: 5432,
        hostaddr: "203.0.113.10",
      },
    },
  });
  assertEquals(payload.privateListener?.transport, "datacenter");
  assertEquals(payload.replication?.role, "standby");
  assertEquals(payload.peers[0]?.containerName, "replica-1");
  assertEquals(payload.exposure.bindAddress, "203.0.113.10");
});

test("parseManagedLifecyclePayload and parseManagedDestroyPayload reject optional ids", () => {
  assertThrows(
    () => parseManagedLifecyclePayload(null),
    TypeError,
    "Invalid managed.lifecycle payload",
  );
  assertThrows(
    () =>
      parseManagedLifecyclePayload({
        managedId: "m1",
        action: "stop",
        memberId: "not-a-uuid",
      }),
    TypeError,
    "Invalid managed.lifecycle payload",
  );
  assertThrows(
    () =>
      parseManagedLifecyclePayload({
        managedId: "m1",
        action: "restart",
        engine: "sqlite",
      }),
    TypeError,
    "Invalid managed.lifecycle payload",
  );
  assertEquals(
    parseManagedLifecyclePayload({
      managedId: "m1",
      action: "start",
      memberId: MEMBER_ID,
      engine: "postgres",
    }).engine,
    "postgres",
  );
  assertThrows(
    () => parseManagedDestroyPayload(null),
    TypeError,
    "Invalid managed.destroy payload",
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
  assertThrows(
    () =>
      parseManagedDestroyPayload({
        managedId: "m1",
        removeVolumes: true,
        memberId: "not-a-uuid",
      }),
    TypeError,
    "Invalid managed.destroy payload",
  );
  assertEquals(
    parseManagedDestroyPayload({
      managedId: "m1",
      removeVolumes: false,
      deleteAfterDestroy: true,
      memberId: MEMBER_ID,
    }).deleteAfterDestroy,
    true,
  );
});

test("parseManagedPromotePayload rejects invalid ids and engines", () => {
  assertThrows(
    () => parseManagedPromotePayload(null),
    TypeError,
    "Invalid managed.promote payload",
  );
  assertThrows(
    () =>
      parseManagedPromotePayload({
        managedId: "not-a-uuid",
        memberId: MEMBER_ID,
      }),
    TypeError,
    "Invalid managed.promote payload",
  );
  assertThrows(
    () =>
      parseManagedPromotePayload({
        managedId: MANAGED_ID,
        memberId: MEMBER_ID,
        demoteMemberId: "not-a-uuid",
      }),
    TypeError,
    "Invalid managed.promote payload",
  );
  assertThrows(
    () =>
      parseManagedPromotePayload({
        managedId: MANAGED_ID,
        memberId: MEMBER_ID,
        engine: "sqlite",
      }),
    TypeError,
    "Invalid managed.promote payload",
  );
  assertEquals(
    parseManagedPromotePayload({
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      engine: "mariadb",
    }).engine,
    "mariadb",
  );
  assertEquals(
    parseManagedPromoteResult({
      status: "ready",
      role: "primary",
      promotedMemberId: MEMBER_ID,
      demotedMemberId: REPLICA_ID,
      demoted: true,
      summary: "promoted",
    }).demotedMemberId,
    REPLICA_ID,
  );
});

test("parseManagedBackupPayload rejects non-objects and result parsers stay lenient", () => {
  assertThrows(
    () => parseManagedBackupPayload(null),
    Error,
    "Invalid managed.backup payload",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        managedId: MANAGED_ID,
        engine: "postgres",
        action: "create",
        backupId: "bk_1",
        artifactExtension: "dump",
        scope: "database",
        database: "bad;db",
      }),
    Error,
    "Invalid managed.backup payload database",
  );
  assertThrows(
    () =>
      parseManagedBackupPayload({
        managedId: MANAGED_ID,
        engine: "postgres",
        action: "create",
        backupId: "bk_1",
        artifactExtension: "dump",
        scope: "database",
      }),
    Error,
    "Invalid managed.backup payload: scope database requires database",
  );
  assertEquals(
    parseManagedBackupResult({
      backupId: "bk_1",
      deleted: true,
      path: "/var/lib/turbopanel/backups/bk_1.dump",
      sizeBytes: 12,
      checksum: "a".repeat(64),
      completedAt: "2026-08-09T12:00:00.000Z",
      database: "appdb",
      pruned: ["old_1"],
      summary: "ok",
    }).pruned,
    ["old_1"],
  );
  assertEquals(parseManagedRestoreResult(null).backupId, "");
  assertEquals(
    parseManagedRestoreResult({
      backupId: "bk_1",
      status: "restored",
      restoredAt: "2026-08-09T12:00:00.000Z",
      database: "appdb",
      summary: "ok",
    }).status,
    "restored",
  );
});

test("parseManagedIngressReconcilePayload rejects cluster backend user and bindAddresses", () => {
  assertThrows(
    () => parseManagedIngressReconcilePayload(null),
    TypeError,
    "Invalid managed.ingress.reconcile payload",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        listenerPorts: { postgres: 15432, mysqlFamily: 15432 },
      }),
    TypeError,
    "Invalid managed.ingress.reconcile listenerPorts",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [null],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile cluster",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          autoReadSplit: "yes",
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile cluster autoReadSplit",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          requireTls: "yes",
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile cluster requireTls",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          family: "oracle",
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile cluster family",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          backends: [null],
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile backend",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          users: [null],
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile user",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          users: [{
            ...VALID_INGRESS.clusters[0].users[0],
            defaultDatabase: "bad;db",
          }],
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile user defaultDatabase",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          users: [{
            ...VALID_INGRESS.clusters[0].users[0],
            connectionRole: "admin",
          }],
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile user connectionRole",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        bindAddresses: "203.0.113.10",
      }),
    TypeError,
    "Invalid managed.ingress.reconcile bindAddresses",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        bindAddresses: ["not-an-ip"],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile bindAddresses",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        segments: "tpn_net1",
      }),
    TypeError,
    "Invalid managed.ingress.reconcile segments",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        segments: [{ name: "bridge_net1", subnet: "10.192.11.0/24" }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile segment name",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        orgTlsMaterial: { certificatePem: "not-a-pem" },
      }),
    TypeError,
    "Invalid managed.apply orgTlsMaterial",
  );
  const accepted = parseManagedIngressReconcilePayload({
    ...VALID_INGRESS,
    clusters: [{
      ...VALID_INGRESS.clusters[0],
      family: "pgsql",
      autoReadSplit: true,
      requireTls: true,
      users: [{
        ...VALID_INGRESS.clusters[0].users[0],
        connectionRole: "read-only",
      }],
    }],
    segments: [{ name: "tpn_net1", subnet: "10.192.11.0/24" }],
  });
  assertEquals(accepted.clusters[0]?.family, "pgsql");
  assertEquals(accepted.clusters[0]?.users[0]?.connectionRole, "read-only");
  assertEquals(accepted.segments?.[0]?.name, "tpn_net1");
});

test("parseManagedHaReconcilePayload rejects identity raft cluster and member shapes", () => {
  assertThrows(
    () => parseManagedHaReconcilePayload(null),
    TypeError,
    "Invalid managed.ha.reconcile payload",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "maybe",
        raft: null,
        clusters: [],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile payload",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "absent",
        raft: null,
        clusters: [],
        identity: { ...HA_IDENTITY, containerName: SERVICE_ID },
      }),
    TypeError,
    "Invalid managed.ha.reconcile identity",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: "local",
        clusters: [],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile raft",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: {
          nodeId: SERVER_ID,
          advertiseAddress: "203.0.113.10",
          httpPort: 33001,
          raftPort: 33002,
          peers: [null],
        },
        clusters: [],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile raft peer",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: null,
        clusters: [null],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile cluster",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: null,
        clusters: [{
          managedId: MANAGED_ID,
          clusterAlias: MANAGED_ID,
          engine: "postgres",
          members: [null],
          replicationUsername: "tp_repl",
          replicationPasswordEnvelope: TP_ENVELOPE,
        }],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile cluster member",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: null,
        clusters: [{
          managedId: MANAGED_ID,
          clusterAlias: MANAGED_ID,
          engine: "postgres",
          members: [{
            memberId: MEMBER_ID,
            role: "primary",
            replicaClass: null,
            host: "db-1",
            port: 5432,
            promotionRule: "prefer",
            containerName: "../escape",
          }],
          replicationUsername: "tp_repl",
          replicationPasswordEnvelope: TP_ENVELOPE,
        }],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile cluster member",
  );
  assertThrows(
    () =>
      parseManagedHaReconcileResult({
        summary: "ok",
        registeredClusters: [],
        restarted: false,
        containers: "none",
      }),
    TypeError,
    "Invalid managed.ha.reconcile result containers",
  );
});

test("parseManagedHaFailoverPayload rejects missing fields and optional host/port", () => {
  assertThrows(
    () => parseManagedHaFailoverPayload(null),
    TypeError,
    "Invalid managed.ha.failover payload",
  );
  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: MANAGED_ID,
        sourceMemberId: MEMBER_ID,
        targetMemberId: REPLICA_ID,
        phase: "fence",
      }),
    TypeError,
    "Invalid managed.ha.failover payload",
  );
  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: MANAGED_ID,
        sourceMemberId: MEMBER_ID,
        targetMemberId: REPLICA_ID,
        phase: "drain",
        engine: "sqlite",
      }),
    TypeError,
    "Invalid managed.ha.failover payload",
  );
  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: MANAGED_ID,
        sourceMemberId: MEMBER_ID,
        targetMemberId: REPLICA_ID,
        phase: "drain",
        sourceHost: "",
      }),
    TypeError,
    "Invalid managed.ha.failover payload",
  );
  assertThrows(
    () =>
      parseManagedHaFailoverPayload({
        managedId: MANAGED_ID,
        sourceMemberId: MEMBER_ID,
        targetMemberId: REPLICA_ID,
        phase: "recover",
        targetPort: 0,
      }),
    TypeError,
    "Invalid managed.ha.failover payload",
  );
});

const RESTORE_BASE = {
  managedId: MANAGED_ID,
  engine: "postgres",
  backupId: "bk_1",
  artifactExtension: "dump",
  checksum: "a".repeat(64),
};

const ORG_TLS = {
  certificatePem:
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  privateKeyEnvelope: TP_ENVELOPE,
  caCertPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
};

test("parseManagedRestorePayload rejects non-objects and accepts optional sizeBytes", () => {
  assertThrows(
    () => parseManagedRestorePayload(null),
    Error,
    "Invalid managed.restore payload",
  );
  assertThrows(
    () => parseManagedRestorePayload([]),
    Error,
    "Invalid managed.restore payload",
  );
  assertEquals(
    parseManagedRestorePayload({ ...RESTORE_BASE, sizeBytes: 4096 }).sizeBytes,
    4096,
  );
  assertThrows(
    () => parseManagedRestorePayload({ ...RESTORE_BASE, sizeBytes: -1 }),
    Error,
    "Invalid managed.restore payload sizeBytes",
  );
});

test("parseManagedApplyPayload rejects leftover image config volume tls and replication shapes", () => {
  rejectApply({ image: "" }, "Invalid managed.apply payload");
  rejectApply({ image: "x".repeat(257) }, "Invalid managed.apply payload");
  rejectApply({ image: "postgres alpine" }, "Invalid managed.apply payload");
  rejectApply({ image: "postgres;rm" }, "Invalid managed.apply payload");
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      engine: "redis",
      image: "docker.io/library/redis:7",
      composeYaml: "services:\n  redis:\n    image: redis:7\n",
    }).engine,
    "redis",
  );
  rejectApply(
    { configFiles: [null] },
    "Invalid managed.apply configFiles entry",
  );
  rejectApply(
    {
      configFiles: [{
        path: "",
        contents: "listen_addresses = '*'\n",
        mode: "0640",
      }],
    },
    "Invalid managed.apply configFiles entry",
  );
  rejectApply(
    {
      configFiles: [{
        path: "/postgresql.conf",
        contents: "listen_addresses = '*'\n",
        mode: "0640",
      }],
    },
    "Invalid managed.apply configFiles entry",
  );
  rejectApply(
    {
      configFiles: [{
        path: "tls\\server.crt",
        contents: "cert",
        mode: "0640",
      }],
    },
    "Invalid managed.apply configFiles entry",
  );
  rejectApply(
    {
      configFiles: [{
        path: "../postgresql.conf",
        contents: "listen_addresses = '*'\n",
        mode: "0640",
      }],
    },
    "Invalid managed.apply configFiles entry",
  );
  rejectApply(
    {
      configFiles: [{
        path: "postgresql.conf;rm",
        contents: "listen_addresses = '*'\n",
        mode: "0640",
      }],
    },
    "Invalid managed.apply configFiles entry",
  );
  rejectApply({ volumes: [null] }, "Invalid managed.apply volumes entry");
  rejectApply(
    { tlsMaterial: "self-signed" },
    "Invalid managed.apply tlsMaterial",
  );
  rejectApply(
    { orgTlsMaterial: "pem" },
    "Invalid managed.apply orgTlsMaterial",
  );
  rejectApply({ replication: "primary" }, "Invalid managed.apply replication");
  rejectApply(
    {
      replication: {
        role: "primary",
        username: "repl",
        desiredSlots: ["slot1"],
        peerAddresses: [""],
      },
    },
    "Invalid managed.apply replication.peerAddresses",
  );
  rejectApply(
    { privateListener: { address: "::1", port: 5432 } },
    "Invalid managed.apply privateListener",
  );
  assertEquals(
    parseManagedApplyPayload({
      ...VALID_MANAGED_APPLY,
      tlsMaterial: {
        selfSigned: true,
        commonName: "db.example.test",
        certPath: "tls/server.crt",
        keyPath: "tls/server.key",
      },
      orgTlsMaterial: ORG_TLS,
    }).tlsMaterial?.commonName,
    "db.example.test",
  );
});

test("parseManagedIngressReconcilePayload rejects leftover identity cluster and result shapes", () => {
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        serverId: SERVER_ID,
        clusters: "none",
      }),
    TypeError,
    "Invalid managed.ingress.reconcile payload",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        identity: "proxysql",
      }),
    TypeError,
    "Invalid managed.ingress.reconcile identity",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          backends: "local",
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile cluster",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        clusters: [{
          ...VALID_INGRESS.clusters[0],
          users: [{
            username: "app",
            role: "user",
            password: "plaintext",
          }],
        }],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile user",
  );
  assertThrows(
    () =>
      parseManagedIngressReconcilePayload({
        ...VALID_INGRESS,
        bindAddresses: [12],
      }),
    TypeError,
    "Invalid managed.ingress.reconcile bindAddresses",
  );
  const accepted = parseManagedIngressReconcilePayload({
    serverId: SERVER_ID,
    clusters: VALID_INGRESS.clusters,
    identity: {
      serviceId: SERVICE_ID,
      composeServiceName: "proxysql",
      containerName: `${SERVICE_ID}-in`,
    },
  });
  assertEquals(accepted.identity?.composeServiceName, "proxysql");
  assertEquals(accepted.segments, undefined);
});

test("parseManagedHaReconcilePayload rejects leftover identity raft cluster and result shapes", () => {
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: null,
        clusters: [],
        identity: null,
      }),
    TypeError,
    "Invalid managed.ha.reconcile identity",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: {
          nodeId: SERVER_ID,
          advertiseAddress: "not-an-ip",
          httpPort: 33001,
          raftPort: 33002,
          peers: [],
        },
        clusters: [],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile raft",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: {
          nodeId: SERVER_ID,
          advertiseAddress: "203.0.113.10",
          httpPort: 33001,
          raftPort: 33002,
          peers: [{
            nodeId: SERVER_ID,
            address: "203.0.113.11",
            raftPort: 0,
            httpPort: 33001,
          }],
        },
        clusters: [],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile raft peer",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: null,
        clusters: [{
          managedId: MANAGED_ID,
          clusterAlias: MANAGED_ID,
          engine: "postgres",
          members: [{
            memberId: MEMBER_ID,
            role: "primary",
            replicaClass: null,
            host: "",
            port: 5432,
            promotionRule: "prefer",
          }],
          replicationUsername: "tp_repl",
          replicationPasswordEnvelope: TP_ENVELOPE,
        }],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile cluster member",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: null,
        clusters: [{
          managedId: MANAGED_ID,
          clusterAlias: MANAGED_ID,
          engine: "postgres",
          members: [{
            memberId: MEMBER_ID,
            role: "primary",
            replicaClass: null,
            host: "db-1",
            port: 5432,
            promotionRule: "prefer",
          }],
          replicationUsername: "tp_repl",
          replicationPasswordEnvelope: "plaintext",
        }],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile cluster",
  );
  assertThrows(
    () =>
      parseManagedHaReconcilePayload({
        serverId: SERVER_ID,
        desired: "present",
        raft: {
          nodeId: SERVER_ID,
          advertiseAddress: "203.0.113.10",
          httpPort: 33001,
          raftPort: 33002,
          peers: Array.from({ length: 33 }, (_, index) => ({
            nodeId: `${SERVER_ID.slice(0, -2)}${
              String(index).padStart(2, "0")
            }`,
            address: "203.0.113.11",
            raftPort: 33002,
            httpPort: 33001,
          })),
        },
        clusters: [],
        identity: HA_IDENTITY,
      }),
    TypeError,
    "Invalid managed.ha.reconcile raft",
  );
  const withTls = parseManagedHaReconcilePayload({
    serverId: SERVER_ID,
    desired: "absent",
    raft: null,
    clusters: [],
    identity: HA_IDENTITY,
    orgTlsMaterial: ORG_TLS,
  });
  assertEquals(withTls.orgTlsMaterial?.caCertPem.includes("BEGIN"), true);
  assertThrows(
    () => parseManagedHaReconcileResult(null),
    TypeError,
    "Invalid managed.ha.reconcile result",
  );
  assertThrows(
    () =>
      parseManagedHaReconcileResult({
        summary: "ok",
        registeredClusters: [],
        restarted: false,
        containers: [{
          composeServiceName: "ha",
          containerId: "cid-1",
          containerName: "ha-1",
          status: "running",
        }],
      }),
    TypeError,
    "Invalid managed.ha.reconcile result containers",
  );
  assertEquals(
    parseManagedHaReconcileResult({
      summary: "ok",
      registeredClusters: [MANAGED_ID],
      restarted: false,
      containers: [{
        composeServiceName: "orchestrator",
        containerId: "cid-1",
        containerName: `${SERVICE_ID}-ha`,
        status: "running",
        role: "turbopanel",
      }],
    }).containers?.length,
    1,
  );
  assertThrows(
    () => parseManagedHaFailoverResult("ok"),
    TypeError,
    "Invalid managed.ha.failover result",
  );
});
