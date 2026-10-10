import { assertEquals } from "@std/assert";
import { withTempLayout } from "../testing/temp-layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  orchestratorClusterAliasManagedId,
  resolveManagedIdForOrchestratorInstance,
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
            stdout: JSON.stringify({
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
            stdout: JSON.stringify({
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
