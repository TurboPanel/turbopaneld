import { assertEquals } from "@std/assert";
import type {
  ManagedPromotePayload,
  ManagedPromoteResult,
} from "./contracts.ts";
import { handleManagedHaFailover } from "./managed-ha-failover.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const RECOVER_PAYLOAD = {
  managedId: "00000000-0000-4000-8000-000000000001",
  sourceMemberId: "00000000-0000-4000-8000-000000000002",
  targetMemberId: "00000000-0000-4000-8000-000000000003",
  engine: "postgres",
  phase: "recover",
  sourceHost: "203.0.113.10",
  sourcePort: 5432,
  targetHost: "203.0.113.11",
  targetPort: 5432,
} as const;

function promoteStub(calls: unknown[]) {
  return (
    raw: ManagedPromotePayload,
    _received: string,
  ): Promise<ManagedPromoteResult> => {
    calls.push(raw);
    return Promise.resolve({
      status: "ready",
      role: "primary",
      promotedMemberId: RECOVER_PAYLOAD.targetMemberId,
      demoted: true,
      summary: "standby promoted to primary",
    });
  };
}

test("managed.ha.failover recover falls back to promote when Orchestrator throws", async () => {
  const promoteCalls: unknown[] = [];
  let recoverCalled = false;
  const result = await handleManagedHaFailover(
    RECOVER_PAYLOAD,
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(true),
      recover: () => {
        recoverCalled = true;
        return Promise.reject(new Error("orchestrator recover failed"));
      },
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(recoverCalled, true);
  assertEquals(promoteCalls.length, 1);
  assertEquals(result.phase, "recover");
  assertEquals(
    result.summary.includes("Orchestrator recover failure"),
    true,
  );
});

test("managed.ha.failover recover does not promote when Orchestrator succeeds", async () => {
  const promoteCalls: unknown[] = [];
  const result = await handleManagedHaFailover(
    RECOVER_PAYLOAD,
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(true),
      recover: () => Promise.resolve(),
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(promoteCalls.length, 0);
  assertEquals(result.summary.includes("designated replica"), true);
});

test("managed.ha.failover recover falls back to promote when the HA stack is absent", async () => {
  const promoteCalls: unknown[] = [];
  let recoverCalled = false;
  const result = await handleManagedHaFailover(
    RECOVER_PAYLOAD,
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(false),
      recover: () => {
        recoverCalled = true;
        return Promise.resolve();
      },
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(recoverCalled, false);
  assertEquals(promoteCalls.length, 1);
  assertEquals(result.summary.includes("without Orchestrator"), true);
});

test("managed.ha.failover drain invokes drain helper for source endpoint", async () => {
  const drainCalls: Array<{ host: string; port: number }> = [];
  const result = await handleManagedHaFailover(
    {
      ...RECOVER_PAYLOAD,
      phase: "drain",
    },
    "2026-08-19T12:00:00.000Z",
    {
      drain: (hostname, port) => {
        drainCalls.push({ host: hostname, port });
        return Promise.resolve();
      },
    },
  );
  assertEquals(drainCalls, [{ host: "203.0.113.10", port: 5432 }]);
  assertEquals(result.phase, "drain");
  assertEquals(result.summary.includes("drained writer"), true);
});

test("managed.ha.failover recover falls back when endpoints are incomplete", async () => {
  const promoteCalls: unknown[] = [];
  const result = await handleManagedHaFailover(
    {
      managedId: RECOVER_PAYLOAD.managedId,
      sourceMemberId: RECOVER_PAYLOAD.sourceMemberId,
      targetMemberId: RECOVER_PAYLOAD.targetMemberId,
      phase: "recover",
      sourceHost: "203.0.113.10",
      sourcePort: 5432,
    },
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(true),
      recover: () => Promise.reject(new Error("should not run")),
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(promoteCalls.length, 1);
  assertEquals(result.summary.includes("without Orchestrator"), true);
});
