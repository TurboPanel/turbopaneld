/**
 * `managed.ha.reconcile` handler — Orchestrator stack coverage.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_HA_COMPONENT,
} from "../../deploy/system-component.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfigDir,
  orchestratorConfPath,
  orchestratorRaftCnfPath,
} from "../../managed/paths.ts";
import {
  type TempLayoutFixture,
  withTempLayout,
} from "../../testing/temp-layout.ts";
import type { ManagedHaReconcilePayload } from "./contracts.ts";
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
      advertiseAddress: "203.0.113.10",
      httpPort: 33001,
      raftPort: 33002,
      peers: [],
    },
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
      replicationPasswordEnvelope: "tpdaemon.v1.repl-pass",
    }],
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
  options: { raftToken?: boolean } = {},
): Promise<void> {
  await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
  await Deno.writeTextFile(
    orchestratorApiCnfPath(layout),
    "[client]\nuser=orch-admin\npassword=orch-secret\n",
  );
  if (options.raftToken) {
    await Deno.writeTextFile(
      orchestratorRaftCnfPath(layout),
      "[client]\nuser=raft\npassword=raft-token-value\n",
    );
  }
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
    ciphertexts.map((c) =>
      c === "tpdaemon.v1.repl-pass"
        ? "repl-plaintext"
        : c.replace(/^tpdaemon\./, "")
    ),
  );
}

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
    "handleManagedHaReconcile writes Recover:false config and registers clusters",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedOrchestratorHostPrep(layout, { raftToken: true });
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
        assertEquals(result.containers?.length, 1);
        assertEquals(
          apiCalls.some((url) => url.includes("/api/discover/db-1/5432")),
          true,
        );
        assertEquals(
          apiCalls.some((url) =>
            url.includes("/api/register-candidate/db-1/5432/prefer")
          ),
          true,
        );
        const conf = JSON.parse(
          await Deno.readTextFile(orchestratorConfPath(layout)),
        ) as Record<string, unknown>;
        assertEquals(conf.Recover, false);
        assertEquals(conf.RaftAuthToken, "raft-token-value");
        assertEquals(conf.MySQLTopologyUser, "tp_repl");
        assertEquals(conf.MySQLTopologyPassword, "repl-plaintext");
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
  name: "handleManagedHaReconcile runs host prep when api.cnf is missing",
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
      // Partially prepared host: compose exists but api.cnf does not, so the
      // old ordering would have started the stack on its way to stopping it.
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
  name: "handleManagedHaReconcile skips host prep when api.cnf exists",
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
