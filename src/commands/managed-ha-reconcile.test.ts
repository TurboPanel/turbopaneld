/**
 * `managed.ha.reconcile` handler — Orchestrator stack coverage.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_HA_COMPONENT,
} from "../deploy/system-component.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfigDir,
  orchestratorConfPath,
  orchestratorHostPrepMarkerPath,
  orchestratorRaftCnfPath,
} from "../managed/engine-paths.ts";
import {
  mysqlOrchestratorClientCnf,
  orchestratorApiPlainEnvelope,
  orchestratorApiPlaintext,
  orchestratorApiUsername,
  orchestratorRaftPlainEnvelope,
  orchestratorRaftPlaintext,
  replicationPlainEnvelope,
  replicationPlaintext,
  topologyPlainEnvelope,
  topologyPlaintext,
  topologyUsername,
} from "../testing/managed-topology-fixtures.ts";
import {
  type TempLayoutFixture,
  withTempLayout,
} from "../testing/temp-layout.ts";
import type { ManagedHaReconcilePayload } from "../contracts/commands-contracts.ts";
import { handleManagedHaReconcile } from "./managed-ha-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const STALE_MANAGED_ID = "00000000-0000-4000-8000-000000000002";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";

function applyLayoutEnv(fixture: TempLayoutFixture): void {
  Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
  Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
}

function clearLayoutEnv(): void {
  Deno.env.delete("TURBOPANEL_STATE_DIR");
  Deno.env.delete("TURBOPANEL_CONFIG_DIR");
}

function baseIdentity() {
  return {
    serviceId: SERVICE_ID,
    composeServiceName: ORCHESTRATOR_COMPOSE_SERVICE_NAME,
    containerName: `${SERVICE_ID}-ha`,
  };
}

function presentPayload(
  overrides: Partial<ManagedHaReconcilePayload> = {},
): ManagedHaReconcilePayload {
  return {
    serverId: SERVER_ID,
    managedNetwork: "00000000-0000-4000-8000-0000000000ee",
    desired: "present",
    raft: {
      nodeId: "00000000-0000-4000-8000-0000000000ab",
      advertiseAddress: "10.100.0.10",
      httpPort: 33001,
      raftPort: 33002,
      peers: [],
    },
    clusters: [{
      managedId: MANAGED_ID,
      clusterAlias: MANAGED_ID,
      engine: "mysql",
      members: [{
        memberId: MEMBER_ID,
        role: "primary",
        replicaClass: null,
        host: "db-1",
        port: 3306,
        promotionRule: "prefer",
      }],
      replicationUsername: "tp_repl",
      replicationPasswordEnvelope: replicationPlainEnvelope(),
    }],
    topologyUser: {
      username: topologyUsername(),
      password: topologyPlainEnvelope(),
    },
    orchestratorApiUser: {
      username: orchestratorApiUsername(),
      password: orchestratorApiPlainEnvelope(),
    },
    orchestratorRaftToken: orchestratorRaftPlainEnvelope(),
    identity: baseIdentity(),
    ...overrides,
  };
}

function teardownPayload(): ManagedHaReconcilePayload {
  return {
    serverId: SERVER_ID,
    managedNetwork: "00000000-0000-4000-8000-0000000000ee",
    desired: "absent",
    raft: null,
    clusters: [],
    identity: baseIdentity(),
  };
}

async function seedOrchestratorHostPrep(
  layout: ReturnType<typeof resolveLayout>,
): Promise<void> {
  await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
  await Deno.writeTextFile(orchestratorHostPrepMarkerPath(layout), "");
}

/** Legacy on-disk API creds for tests that exercise topology/replication decrypt only. */
async function seedLegacyOrchestratorApiCnf(
  layout: ReturnType<typeof resolveLayout>,
): Promise<void> {
  await seedOrchestratorHostPrep(layout);
  await Deno.writeTextFile(
    orchestratorApiCnfPath(layout),
    mysqlOrchestratorClientCnf("orch-admin", "orch-admin-plain"),
  );
  await Deno.writeTextFile(
    orchestratorRaftCnfPath(layout),
    mysqlOrchestratorClientCnf("raft", "raft-auth-plain"),
  );
}

function presentPayloadWithoutOrgOrchestratorSecrets(
  overrides: Partial<ManagedHaReconcilePayload> = {},
): ManagedHaReconcilePayload {
  const payload = presentPayload(overrides);
  delete payload.orchestratorApiUser;
  delete payload.orchestratorRaftToken;
  return payload;
}

function fakeRunSuccess(): (args: string[]) => Promise<DockerCliResult> {
  return (_args) =>
    Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });
}

function runningOrchestratorPsStdout(): string {
  return JSON.stringify([{
    ID: "orch-cid",
    Name: `${SERVICE_ID}-ha`,
    Service: ORCHESTRATOR_COMPOSE_SERVICE_NAME,
    State: "running",
    Labels: {
      "turbopanel.role": "turbopanel",
      "com.turbopanel.system.component": "managed-ha",
    },
  }]);
}

function fakeRunWithRunningOrchestrator(): (
  args: string[],
) => Promise<DockerCliResult> {
  return (args) => {
    if (args.includes("ps")) {
      return Promise.resolve({
        success: true,
        stdout: runningOrchestratorPsStdout(),
        stderr: "",
        code: 0,
      });
    }
    return fakeRunSuccess()(args);
  };
}

function decryptSecretsEcho(
  ciphertexts: string[],
): Promise<(string | null)[]> {
  return Promise.resolve(
    ciphertexts.map((c) => {
      if (c === replicationPlainEnvelope()) return replicationPlaintext();
      const prefix = "tpdaemon.v1.";
      if (c.startsWith(prefix)) return c.slice(prefix.length);
      return c.replace(/^tpdaemon\./, "");
    }),
  );
}

function fakeRunWithInspect(
  inspect: (args: string[]) => DockerCliResult,
): (args: string[]) => Promise<DockerCliResult> {
  const base = fakeRunWithRunningOrchestrator();
  return (args) => {
    if (args[0] === "inspect") return Promise.resolve(inspect(args));
    return base(args);
  };
}

async function reconcileWithTwoMembers(
  inspect: (args: string[]) => DockerCliResult,
): Promise<{ apiCalls: string[]; compose: string; registered: string[] }> {
  let result:
    | { apiCalls: string[]; compose: string; registered: string[] }
    | undefined;
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedOrchestratorHostPrep(layout);
    applyLayoutEnv(fixture);
    const apiCalls: string[] = [];
    const [cluster] = presentPayload().clusters;
    try {
      const out = await handleManagedHaReconcile(
        presentPayload({
          clusters: [{
            ...cluster,
            members: [
              {
                ...cluster.members[0]!,
                host: "10.100.0.5",
                port: 45001,
                containerName: "db-up",
              },
              {
                ...cluster.members[0]!,
                memberId: "00000000-0000-4000-8000-0000000000a2",
                host: "db-down",
                port: 3306,
                containerName: "db-down",
              },
            ],
          }],
        }),
        new Date().toISOString(),
        {
          runDocker: fakeRunWithInspect(inspect),
          ensureDocker: () => Promise.resolve(),
          decryptSecrets: decryptSecretsEcho,
          orchestratorApi: {
            fetch: (url) => {
              apiCalls.push(url);
              return Promise.resolve(new Response("", { status: 200 }));
            },
          },
        },
      );
      result = {
        apiCalls,
        compose: await Deno.readTextFile(orchestratorComposePath(layout)),
        registered: out.registeredClusters,
      };
    } finally {
      clearLayoutEnv();
    }
  });
  return result!;
}

test({
  name:
    "handleManagedHaReconcile skips a member whose container has no published port and still registers the rest",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    const out = await reconcileWithTwoMembers(() => ({
      success: true,
      stdout: "{}",
      stderr: "",
      code: 0,
    }));
    assertEquals(
      out.apiCalls.some((url) =>
        url.includes("/api/discover/10.100.0.5/45001")
      ),
      true,
    );
    assertEquals(out.apiCalls.some((url) => url.includes("db-down")), false);
    assertEquals(out.compose.includes("db-up:10.100.0.5"), true);
    assertEquals(out.registered.length, 1);
  },
});

test({
  name:
    "handleManagedHaReconcile skips a member when docker inspect fails and keeps the stack",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    const out = await reconcileWithTwoMembers(() => ({
      success: false,
      stdout: "",
      stderr: "No such object: db-down",
      code: 1,
    }));
    assertEquals(
      out.apiCalls.some((url) =>
        url.includes("/api/discover/10.100.0.5/45001")
      ),
      true,
    );
    assertEquals(out.compose.includes("services:"), true);
    assertEquals(out.registered.length, 1);
  },
});

test({
  name: "handleManagedHaReconcile tears down when desired is absent",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      await Deno.writeTextFile(
        orchestratorComposePath(layout),
        "services: {}\n",
      );
      applyLayoutEnv(fixture);
      const dockerArgs: string[][] = [];
      try {
        const result = await handleManagedHaReconcile(
          teardownPayload(),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              return fakeRunSuccess()(args);
            },
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(result.registeredClusters, []);
        assertEquals(result.failedClusters, []);
        assertEquals(result.partial, false);
        assertEquals(result.restarted, false);
        assertEquals(result.containers, []);
        assertEquals(dockerArgs.some((args) => args.includes("down")), true);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile skips Postgres clusters Orchestrator cannot monitor",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      const apiCalls: string[] = [];
      const [mysql] = presentPayload().clusters;
      const postgres = {
        ...mysql,
        managedId: "00000000-0000-4000-8000-0000000000f1",
        clusterAlias: "00000000-0000-4000-8000-0000000000f1",
        engine: "postgres" as const,
        members: mysql.members.map((member) => ({
          ...member,
          host: "pg-1",
          port: 5432,
        })),
      };
      try {
        const result = await handleManagedHaReconcile(
          presentPayload({ clusters: [postgres, mysql] }),
          new Date().toISOString(),
          {
            runDocker: fakeRunWithRunningOrchestrator(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            orchestratorApi: {
              fetch: (url) => {
                apiCalls.push(url);
                // What Orchestrator answers for a Postgres member.
                const status = url.includes("pg-1") ? 500 : 200;
                return Promise.resolve(new Response("", { status }));
              },
            },
          },
        );
        assertEquals(result.registeredClusters, [MANAGED_ID]);
        assertEquals(result.failedClusters, []);
        assertEquals(result.partial, false);
        assertEquals(apiCalls.some((url) => url.includes("pg-1")), false);
        assertEquals(
          apiCalls.some((url) => url.includes("/api/discover/db-1/3306")),
          true,
        );
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile registers a later cluster when an earlier discover fails",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      const [healthy] = presentPayload().clusters;
      const stale = {
        ...healthy,
        managedId: STALE_MANAGED_ID,
        clusterAlias: STALE_MANAGED_ID,
        members: healthy.members.map((member) => ({
          ...member,
          host: "db-stale",
        })),
      };
      try {
        const registrationError = "x".repeat(1_000);
        const shortRegistrationError = `…${"x".repeat(299)}`;
        const result = await handleManagedHaReconcile(
          presentPayload({ clusters: [stale, healthy] }),
          new Date().toISOString(),
          {
            runDocker: fakeRunWithRunningOrchestrator(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            orchestratorApi: {
              fetch: (url) => {
                if (url.includes("db-stale")) {
                  return Promise.reject(new Error(registrationError));
                }
                return Promise.resolve(new Response("", { status: 200 }));
              },
            },
          },
        );
        assertEquals(result.registeredClusters, [MANAGED_ID]);
        assertEquals(result.partial, true);
        assertEquals(result.failedClusters, [{
          managedId: STALE_MANAGED_ID,
          error: shortRegistrationError,
        }]);
        assertEquals(
          result.summary,
          `managed HA partially reconciled for server ${SERVER_ID}; failed clusters: ${STALE_MANAGED_ID}: ${shortRegistrationError}`,
        );
        assertEquals(
          result.failedClusters?.[0]?.error.length,
          300,
        );
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile fails the command when every monitored cluster fails to register",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      const [first] = presentPayload().clusters;
      const second = {
        ...first,
        managedId: STALE_MANAGED_ID,
        clusterAlias: STALE_MANAGED_ID,
        members: first.members.map((member) => ({
          ...member,
          host: "db-stale",
        })),
      };
      try {
        const err = await assertRejects(
          () =>
            handleManagedHaReconcile(
              presentPayload({ clusters: [first, second] }),
              new Date().toISOString(),
              {
                runDocker: fakeRunWithRunningOrchestrator(),
                ensureDocker: () => Promise.resolve(),
                decryptSecrets: decryptSecretsEcho,
                orchestratorApi: {
                  fetch: () =>
                    Promise.resolve(new Response("", { status: 500 })),
                },
              },
            ),
          Error,
        );
        assertEquals(err.message.includes(MANAGED_ID), true);
        assertEquals(err.message.includes(STALE_MANAGED_ID), true);
        assertEquals(err.message.includes("HTTP 500"), true);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile writes Recover:false config and registers clusters",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      const apiCalls: string[] = [];
      try {
        const result = await handleManagedHaReconcile(
          presentPayload(),
          new Date().toISOString(),
          {
            runDocker: fakeRunWithRunningOrchestrator(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            orchestratorApi: {
              fetch: (url) => {
                apiCalls.push(url);
                return Promise.resolve(new Response("", { status: 200 }));
              },
            },
          },
        );
        assertEquals(result.restarted, true);
        assertEquals(result.registeredClusters, [MANAGED_ID]);
        assertEquals(result.failedClusters, []);
        assertEquals(result.partial, false);
        assertEquals(result.containers?.length, 1);
        assertEquals(
          apiCalls.some((url) => url.includes("/api/discover/db-1/3306")),
          true,
        );
        assertEquals(
          apiCalls.some((url) =>
            url.includes("/api/register-candidate/db-1/3306/prefer")
          ),
          true,
        );
        const conf = JSON.parse(
          await Deno.readTextFile(orchestratorConfPath(layout)),
        ) as Record<string, unknown>;
        assertEquals(conf.Recover, false);
        assertEquals(conf.RaftAuthToken, orchestratorRaftPlaintext());
        assertEquals(conf.HTTPAuthUser, orchestratorApiUsername());
        assertEquals(conf.HTTPAuthPassword, orchestratorApiPlaintext());
        assertEquals(conf.MySQLTopologyUser, "tp_topology_111111111111");
        assertEquals(conf.MySQLTopologyPassword, topologyPlaintext());
        assertEquals(conf.MySQLTopologyUseMutualTLS, true);
        assertEquals("MySQLTopologyUseSSL" in conf, false);
        const compose = await Deno.readTextFile(
          orchestratorComposePath(layout),
        );
        assertEquals(compose.includes("127.0.0.1:33001:33001"), true);
        assertEquals(compose.includes("10.100.0.10:33001:33001"), true);
        assertEquals(compose.includes("restart: always"), true);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile registers the listener address, not the container name",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      const apiCalls: string[] = [];
      const [cluster] = presentPayload().clusters;
      try {
        await handleManagedHaReconcile(
          presentPayload({
            clusters: [{
              ...cluster,
              members: [{
                ...cluster.members[0]!,
                host: "10.100.0.5",
                port: 45001,
                containerName: "db-1",
              }],
            }],
          }),
          new Date().toISOString(),
          {
            runDocker: fakeRunWithRunningOrchestrator(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            orchestratorApi: {
              fetch: (url) => {
                apiCalls.push(url);
                return Promise.resolve(new Response("", { status: 200 }));
              },
            },
          },
        );
        assertEquals(
          apiCalls.some((url) =>
            url.includes("/api/discover/10.100.0.5/45001")
          ),
          true,
        );
        assertEquals(
          apiCalls.some((url) =>
            url.includes("/api/register-candidate/10.100.0.5/45001/prefer")
          ),
          true,
        );
        assertEquals(
          apiCalls.some((url) => url.includes("/api/discover/db-1/")),
          false,
        );
        const compose = await Deno.readTextFile(
          orchestratorComposePath(layout),
        );
        assertEquals(compose.includes(`"db-1:10.100.0.5"`), true);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile rewrites a container-name host to the published listener",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      const apiCalls: string[] = [];
      const [cluster] = presentPayload().clusters;
      const ports = JSON.stringify({
        "3306/tcp": [{ HostIp: "10.100.0.5", HostPort: "45001" }],
      });
      try {
        await handleManagedHaReconcile(
          presentPayload({
            clusters: [{
              ...cluster,
              members: [{
                ...cluster.members[0]!,
                host: "db-1",
                port: 3306,
                containerName: "db-1",
              }],
            }],
          }),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              if (args[0] === "inspect") {
                return Promise.resolve({
                  success: true,
                  stdout: ports,
                  stderr: "",
                  code: 0,
                });
              }
              return fakeRunWithRunningOrchestrator()(args);
            },
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            orchestratorApi: {
              fetch: (url) => {
                apiCalls.push(url);
                return Promise.resolve(new Response("", { status: 200 }));
              },
            },
          },
        );
        assertEquals(
          apiCalls.some((url) =>
            url.includes("/api/discover/10.100.0.5/45001")
          ),
          true,
        );
        assertEquals(
          apiCalls.some((url) => url.includes("/api/discover/db-1/")),
          false,
        );
        const compose = await Deno.readTextFile(
          orchestratorComposePath(layout),
        );
        assertEquals(compose.includes(`"db-1:10.100.0.5"`), true);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile reports no restart when stack files are unchanged",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      const deps = {
        runDocker: fakeRunWithRunningOrchestrator(),
        ensureDocker: () => Promise.resolve(),
        decryptSecrets: decryptSecretsEcho,
        orchestratorApi: {
          fetch: () => Promise.resolve(new Response("", { status: 200 })),
        },
      };
      try {
        const first = await handleManagedHaReconcile(
          presentPayload({ clusters: [] }),
          new Date().toISOString(),
          deps,
        );
        assertEquals(first.restarted, true);
        const second = await handleManagedHaReconcile(
          presentPayload({ clusters: [] }),
          new Date().toISOString(),
          deps,
        );
        assertEquals(second.restarted, false);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile runs host prep when wait-ready script is missing",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      applyLayoutEnv(fixture);
      let hostPrepCalls = 0;
      try {
        await handleManagedHaReconcile(
          presentPayload({ clusters: [] }),
          new Date().toISOString(),
          {
            runDocker: fakeRunSuccess(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            runHostPrep: async () => {
              hostPrepCalls += 1;
              await seedOrchestratorHostPrep(layout);
            },
          },
        );
        assertEquals(hostPrepCalls, 1);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile ensures the managed network before lazy host prep",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      // A rerun on a host that already has a compose file but whose external
      // managed network was pruned: host prep ends by starting
      // `turbopanel-orchestrator-stack.service`, whose unit runs
      // `docker compose up -d` against that network.
      await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
      await Deno.writeTextFile(
        orchestratorComposePath(layout),
        "services: {}\n",
      );
      applyLayoutEnv(fixture);
      const events: string[] = [];
      try {
        await handleManagedHaReconcile(
          presentPayload({ clusters: [] }),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              if (args[0] === "network") events.push(`network:${args[1]}`);
              return fakeRunSuccess()(args);
            },
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            runHostPrep: async () => {
              events.push("host-prep");
              await seedOrchestratorHostPrep(layout);
            },
          },
        );
        assertEquals(events[0], "network:inspect");
        assertEquals(events.includes("host-prep"), true);
        assertEquals(events.indexOf("host-prep") > 0, true);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name: "handleManagedHaReconcile never runs host prep on teardown",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      // Partially prepared host: compose exists but host prep is incomplete, so
      // the old ordering would have started the stack on its way to stopping it.
      await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
      await Deno.writeTextFile(
        orchestratorComposePath(layout),
        "services: {}\n",
      );
      applyLayoutEnv(fixture);
      let hostPrepCalls = 0;
      const dockerArgs: string[][] = [];
      try {
        await handleManagedHaReconcile(
          teardownPayload(),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              return fakeRunSuccess()(args);
            },
            ensureDocker: () => Promise.resolve(),
            runHostPrep: () => {
              hostPrepCalls += 1;
              return Promise.resolve();
            },
          },
        );
        assertEquals(hostPrepCalls, 0);
        assertEquals(dockerArgs.some((args) => args.includes("down")), true);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile skips host prep when wait-ready script exists",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      let hostPrepCalls = 0;
      try {
        await handleManagedHaReconcile(
          presentPayload({ clusters: [] }),
          new Date().toISOString(),
          {
            runDocker: fakeRunSuccess(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            runHostPrep: () => {
              hostPrepCalls += 1;
              return Promise.resolve();
            },
          },
        );
        assertEquals(hostPrepCalls, 0);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name: "handleManagedHaReconcile persists payload identity",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      try {
        await handleManagedHaReconcile(
          presentPayload({ clusters: [] }),
          new Date().toISOString(),
          {
            runDocker: fakeRunSuccess(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
          },
        );
        const descriptor = await readSystemComponentDescriptor(
          layout,
          SYSTEM_MANAGED_HA_COMPONENT,
        );
        assertEquals(descriptor?.serviceId, SERVICE_ID);
        assertEquals(descriptor?.containerName, `${SERVICE_ID}-ha`);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name: "handleManagedHaReconcile omits containers when compose ps fails",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedOrchestratorHostPrep(resolveLayout(fixture.env));
      applyLayoutEnv(fixture);
      try {
        const result = await handleManagedHaReconcile(
          presentPayload({ clusters: [] }),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              if (args.includes("ps")) {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "denied",
                  code: 1,
                });
              }
              return fakeRunSuccess()(args);
            },
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
          },
        );
        assertEquals(result.containers, undefined);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile requires decryptSecrets when org TLS material is present",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedOrchestratorHostPrep(resolveLayout(fixture.env));
      applyLayoutEnv(fixture);
      try {
        await assertRejects(
          () =>
            handleManagedHaReconcile(
              presentPayload({
                orgTlsMaterial: {
                  certificatePem:
                    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
                  privateKeyEnvelope: "tpdaemon.v1.server.key.payload",
                  caCertPem:
                    "-----BEGIN CERTIFICATE-----\nMIICaaaa\n-----END CERTIFICATE-----\n",
                },
              }),
              new Date().toISOString(),
              {
                runDocker: fakeRunSuccess(),
                ensureDocker: () => Promise.resolve(),
              },
            ),
          Error,
          "managed.ha.reconcile requires decryptSecrets",
        );
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name: "handleManagedHaReconcile rejects an empty decrypted topology password",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedLegacyOrchestratorApiCnf(layout);
      applyLayoutEnv(fixture);
      try {
        await assertRejects(
          () =>
            handleManagedHaReconcile(
              presentPayloadWithoutOrgOrchestratorSecrets(),
              new Date().toISOString(),
              {
                runDocker: fakeRunWithRunningOrchestrator(),
                ensureDocker: () => Promise.resolve(),
                decryptSecrets: () => Promise.resolve([""]),
              },
            ),
          Error,
          "failed to decrypt managed HA topology password",
        );
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile rejects an empty decrypted replication password without topologyUser",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedLegacyOrchestratorApiCnf(layout);
      applyLayoutEnv(fixture);
      try {
        await assertRejects(
          () =>
            handleManagedHaReconcile(
              presentPayloadWithoutOrgOrchestratorSecrets({
                topologyUser: undefined,
              }),
              new Date().toISOString(),
              {
                runDocker: fakeRunWithRunningOrchestrator(),
                ensureDocker: () => Promise.resolve(),
                decryptSecrets: () => Promise.resolve([""]),
              },
            ),
          Error,
          "failed to decrypt managed HA replication password",
        );
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name: "handleManagedHaReconcile requires decryptSecrets for present desired",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedOrchestratorHostPrep(resolveLayout(fixture.env));
      applyLayoutEnv(fixture);
      try {
        await assertRejects(
          () =>
            handleManagedHaReconcile(
              presentPayload(),
              new Date().toISOString(),
              {
                runDocker: fakeRunSuccess(),
                ensureDocker: () => Promise.resolve(),
              },
            ),
          Error,
          "managed.ha.reconcile requires decryptSecrets",
        );
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name: "handleManagedHaReconcile surfaces orchestrator compose up failures",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedOrchestratorHostPrep(resolveLayout(fixture.env));
      applyLayoutEnv(fixture);
      try {
        await assertRejects(
          () =>
            handleManagedHaReconcile(
              presentPayload({ clusters: [] }),
              new Date().toISOString(),
              {
                runDocker: () =>
                  Promise.resolve({
                    success: false,
                    stdout: "",
                    stderr: "orchestrator compose up failed",
                    code: 1,
                  }),
                ensureDocker: () => Promise.resolve(),
                decryptSecrets: decryptSecretsEcho,
              },
            ),
          Error,
          "orchestrator compose up failed",
        );
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile swallows cluster-alias failures after register",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout);
      applyLayoutEnv(fixture);
      try {
        const result = await handleManagedHaReconcile(
          presentPayload(),
          new Date().toISOString(),
          {
            runDocker: fakeRunWithRunningOrchestrator(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
            orchestratorApi: {
              fetch: (url) => {
                if (url.includes("/api/set-cluster-alias/")) {
                  return Promise.reject(new Error("alias rejected"));
                }
                return Promise.resolve(new Response("", { status: 200 }));
              },
            },
          },
        );
        assertEquals(result.registeredClusters, [MANAGED_ID]);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});

test({
  name:
    "handleManagedHaReconcile materializes org TLS when decryptSecrets is set",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedOrchestratorHostPrep(resolveLayout(fixture.env));
      applyLayoutEnv(fixture);
      const privatePem =
        "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n";
      try {
        const result = await handleManagedHaReconcile(
          presentPayload({
            clusters: [],
            orgTlsMaterial: {
              certificatePem:
                "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
              privateKeyEnvelope: "tpdaemon.v1.server.KEYID.ciphertext",
              caCertPem:
                "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
            },
          }),
          new Date().toISOString(),
          {
            runDocker: fakeRunWithRunningOrchestrator(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: (ciphertexts) =>
              Promise.resolve(ciphertexts.map(() => privatePem)),
            orchestratorApi: {
              fetch: () => Promise.resolve(new Response("", { status: 200 })),
            },
          },
        );
        assertEquals(result.restarted, true);
      } finally {
        clearLayoutEnv();
      }
    });
  },
});
