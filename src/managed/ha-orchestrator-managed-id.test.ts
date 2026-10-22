import { assertEquals } from "@std/assert";
import { engineInspectPortsJson } from "../testing/managed-topology-fixtures.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  orchestratorClusterAliasManagedId,
  orchestratorKeysMatch,
  resolveManagedIdForOrchestratorInstance,
  resolveOrchestratorDeadPrimaryEmit,
} from "./ha-orchestrator-managed-id.ts";
import { saveManagedHaMember } from "./ha-member.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-0000000000aa";

const LOCAL_DIAL = { hostname: "172.20.4.10", port: 45001 };

test("orchestratorKeysMatch compares each provided field to the local dial", () => {
  assertEquals(orchestratorKeysMatch({}, LOCAL_DIAL), true);
  assertEquals(
    orchestratorKeysMatch({ hostname: LOCAL_DIAL.hostname }, LOCAL_DIAL),
    true,
  );
  assertEquals(
    orchestratorKeysMatch({ port: LOCAL_DIAL.port }, LOCAL_DIAL),
    true,
  );
  assertEquals(orchestratorKeysMatch(LOCAL_DIAL, LOCAL_DIAL), true);
  assertEquals(
    orchestratorKeysMatch({ hostname: "10.0.0.9" }, LOCAL_DIAL),
    false,
  );
  assertEquals(
    orchestratorKeysMatch({ port: 9999 }, LOCAL_DIAL),
    false,
  );
  assertEquals(
    orchestratorKeysMatch(
      { hostname: LOCAL_DIAL.hostname, port: 9999 },
      LOCAL_DIAL,
    ),
    false,
  );
});

test("orchestratorClusterAliasManagedId accepts a managed UUID only", () => {
  assertEquals(orchestratorClusterAliasManagedId(MANAGED_ID), MANAGED_ID);
  assertEquals(orchestratorClusterAliasManagedId("172.20.4.10:45001"), null);
  assertEquals(orchestratorClusterAliasManagedId(undefined), null);
});

test("resolveManagedIdForOrchestratorInstance maps a local primary dial", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const now = new Date().toISOString();
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: "00000000-0000-4000-8000-000000000001",
      engine: "mysql",
      role: "primary",
      containerName: "mysql-primary-1",
      replicaPeerCount: 1,
      peerCount: 1,
      updatedAt: now,
    });
    const managedId = await resolveManagedIdForOrchestratorInstance(
      layout,
      { hostname: "172.20.4.10", port: 45001 },
      "172.20.4.10:45001",
      (args) => {
        if (args[0] === "inspect") {
          return Promise.resolve({
            success: true,
            stdout: engineInspectPortsJson({
              "3306/tcp": [{ HostIp: "172.20.4.10", HostPort: "45001" }],
            }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "unexpected",
          code: 1,
        });
      },
    );
    assertEquals(managedId, MANAGED_ID);
  });
});

test("resolveOrchestratorDeadPrimaryEmit refuses UUID alias when the key is not the local primary dial", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const now = new Date().toISOString();
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: "00000000-0000-4000-8000-000000000001",
      engine: "mysql",
      role: "primary",
      containerName: "mysql-primary-1",
      replicaPeerCount: 1,
      peerCount: 1,
      updatedAt: now,
    });
    const { resolveOrchestratorDeadPrimaryEmit } = await import(
      "./ha-orchestrator-managed-id.ts"
    );
    const ctx = await resolveOrchestratorDeadPrimaryEmit(
      layout,
      { hostname: "10.0.0.9", port: 9999 },
      MANAGED_ID,
      (args) => {
        if (args[0] === "inspect") {
          return Promise.resolve({
            success: true,
            stdout: engineInspectPortsJson({
              "3306/tcp": [{ HostIp: "172.20.4.10", HostPort: "45001" }],
            }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "",
          code: 1,
        });
      },
      Date.now(),
    );
    assertEquals(ctx, null);
  });
});

test("resolveOrchestratorDeadPrimaryEmit includes dial coordinates for an empty instance key", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const now = new Date().toISOString();
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: "00000000-0000-4000-8000-000000000001",
      engine: "mysql",
      role: "primary",
      containerName: "mysql-primary-1",
      replicaPeerCount: 1,
      peerCount: 1,
      updatedAt: now,
    });
    const { resolveOrchestratorDeadPrimaryEmit } = await import(
      "./ha-orchestrator-managed-id.ts"
    );
    const ctx = await resolveOrchestratorDeadPrimaryEmit(
      layout,
      {},
      MANAGED_ID,
      (args) => {
        if (args[0] === "inspect") {
          return Promise.resolve({
            success: true,
            stdout: engineInspectPortsJson({
              "3306/tcp": [{ HostIp: "172.20.4.10", HostPort: "45001" }],
            }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "",
          code: 1,
        });
      },
      Date.now(),
    );
    assertEquals(ctx?.emitKey, { hostname: "172.20.4.10", port: 45001 });
  });
});

test("resolveOrchestratorDeadPrimaryEmit refuses UUID alias when only hostname differs from dial", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const now = new Date().toISOString();
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: "00000000-0000-4000-8000-000000000001",
      engine: "mysql",
      role: "primary",
      containerName: "mysql-primary-1",
      replicaPeerCount: 1,
      peerCount: 1,
      updatedAt: now,
    });
    const { resolveOrchestratorDeadPrimaryEmit } = await import(
      "./ha-orchestrator-managed-id.ts"
    );
    const ctx = await resolveOrchestratorDeadPrimaryEmit(
      layout,
      { hostname: "10.0.0.9" },
      MANAGED_ID,
      (args) => {
        if (args[0] === "inspect") {
          return Promise.resolve({
            success: true,
            stdout: engineInspectPortsJson({
              "3306/tcp": [{ HostIp: LOCAL_DIAL.hostname, HostPort: "45001" }],
            }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "",
          code: 1,
        });
      },
      Date.now(),
    );
    assertEquals(ctx, null);
  });
});

test("resolveOrchestratorDeadPrimaryEmit proves dial for UUID alias with a partial matching hostname", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const now = new Date().toISOString();
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: "00000000-0000-4000-8000-000000000001",
      engine: "mysql",
      role: "primary",
      containerName: "mysql-primary-1",
      replicaPeerCount: 1,
      peerCount: 1,
      updatedAt: now,
    });
    const { resolveOrchestratorDeadPrimaryEmit } = await import(
      "./ha-orchestrator-managed-id.ts"
    );
    const ctx = await resolveOrchestratorDeadPrimaryEmit(
      layout,
      { hostname: LOCAL_DIAL.hostname },
      MANAGED_ID,
      (args) => {
        if (args[0] === "inspect") {
          return Promise.resolve({
            success: true,
            stdout: engineInspectPortsJson({
              "3306/tcp": [{ HostIp: LOCAL_DIAL.hostname, HostPort: "45001" }],
            }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "",
          code: 1,
        });
      },
      Date.now(),
    );
    assertEquals(ctx?.emitKey, LOCAL_DIAL);
  });
});

async function seedLocalPrimary(
  layout: ReturnType<typeof resolveLayout>,
): Promise<void> {
  await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
    recursive: true,
  });
  await saveManagedHaMember(layout, {
    managedId: MANAGED_ID,
    memberId: "00000000-0000-4000-8000-000000000001",
    engine: "mysql",
    role: "primary",
    containerName: "mysql-primary-1",
    replicaPeerCount: 1,
    peerCount: 1,
    updatedAt: new Date().toISOString(),
  });
}

function inspectAnswer(stdout: string | null) {
  return () =>
    Promise.resolve({
      success: stdout !== null,
      stdout: stdout ?? "",
      stderr: stdout === null ? "No such object" : "",
      code: stdout === null ? 1 : 0,
    });
}

const LOCAL_PORTS = {
  "3306/tcp": [{
    HostIp: LOCAL_DIAL.hostname,
    HostPort: String(LOCAL_DIAL.port),
  }],
};

test("resolveOrchestratorDeadPrimaryEmit proves a killed primary from its configured bindings", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedLocalPrimary(layout);
    const ctx = await resolveOrchestratorDeadPrimaryEmit(
      layout,
      LOCAL_DIAL,
      `${LOCAL_DIAL.hostname}:${LOCAL_DIAL.port}`,
      inspectAnswer(engineInspectPortsJson(LOCAL_PORTS, { stopped: true })),
      Date.now(),
    );
    assertEquals(ctx?.managedId, MANAGED_ID);
    assertEquals(ctx?.emitKey, LOCAL_DIAL);
  });
});

test("resolveOrchestratorDeadPrimaryEmit refuses a partial key without a UUID alias", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedLocalPrimary(layout);
    const run = inspectAnswer(engineInspectPortsJson(LOCAL_PORTS));
    const keys = [
      { hostname: LOCAL_DIAL.hostname },
      { port: LOCAL_DIAL.port },
      {},
    ];
    const results = await Promise.all(
      keys.map((key) =>
        resolveOrchestratorDeadPrimaryEmit(
          layout,
          key,
          `${LOCAL_DIAL.hostname}:${LOCAL_DIAL.port}`,
          run,
          Date.now(),
        )
      ),
    );
    assertEquals(results, [null, null, null]);
  });
});

test("resolveOrchestratorDeadPrimaryEmit refuses when the primary's listener cannot be read", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedLocalPrimary(layout);
    const answers = [null, '{"live":{},"configured":{}}'];
    const results = await Promise.all(
      answers.map((stdout) =>
        resolveOrchestratorDeadPrimaryEmit(
          layout,
          {},
          MANAGED_ID,
          inspectAnswer(stdout),
          Date.now(),
        )
      ),
    );
    assertEquals(results, [null, null]);
  });
});

test("resolveOrchestratorDeadPrimaryEmit refuses a UUID alias that names another cluster's dial", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedLocalPrimary(layout);
    const ctx = await resolveOrchestratorDeadPrimaryEmit(
      layout,
      LOCAL_DIAL,
      "00000000-0000-4000-8000-0000000000bb",
      inspectAnswer(engineInspectPortsJson(LOCAL_PORTS)),
      Date.now(),
    );
    assertEquals(ctx, null);
  });
});
