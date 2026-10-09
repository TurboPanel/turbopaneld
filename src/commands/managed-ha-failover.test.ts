import { assertEquals, assertRejects } from "@std/assert";
import type {
  ManagedPromotePayload,
  ManagedPromoteResult,
} from "../contracts/commands-contracts.ts";
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

test("managed.ha.failover recover promote fallback forwards switchover GTID fields", async () => {
  const promoteCalls: ManagedPromotePayload[] = [];
  await handleManagedHaFailover(
    {
      ...RECOVER_PAYLOAD,
      engine: "mariadb",
      requiredExecutedGtidSet: "0-1-9",
      gtidWaitTimeoutSeconds: 99,
    },
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(false),
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(promoteCalls.length, 1);
  assertEquals(promoteCalls[0]?.requiredExecutedGtidSet, "0-1-9");
  assertEquals(promoteCalls[0]?.gtidWaitTimeoutSeconds, 99);
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

test("managed.ha.failover drain uses the local ProxySQL helper when drain is omitted", async () => {
  const result = await handleManagedHaFailover(
    {
      ...RECOVER_PAYLOAD,
      phase: "drain",
    },
    "2026-08-19T12:00:00.000Z",
  );
  assertEquals(result.phase, "drain");
  assertEquals(result.summary.includes("drained writer"), true);
});

test("managed.ha.failover recover probes host prep when haPresent is omitted", async () => {
  const promoteCalls: unknown[] = [];
  const result = await handleManagedHaFailover(
    {
      managedId: RECOVER_PAYLOAD.managedId,
      sourceMemberId: RECOVER_PAYLOAD.sourceMemberId,
      targetMemberId: RECOVER_PAYLOAD.targetMemberId,
      phase: "recover",
      sourceHost: "203.0.113.10",
    },
    "2026-08-19T12:00:00.000Z",
    {
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(promoteCalls.length, 1);
  assertEquals(result.summary.includes("without Orchestrator"), true);
});

test("managed.ha.failover drain skips drain helper when source endpoint is absent", async () => {
  let drainCalled = false;
  const result = await handleManagedHaFailover(
    {
      managedId: RECOVER_PAYLOAD.managedId,
      sourceMemberId: RECOVER_PAYLOAD.sourceMemberId,
      targetMemberId: RECOVER_PAYLOAD.targetMemberId,
      phase: "drain",
    },
    "2026-08-19T12:00:00.000Z",
    {
      drain: () => {
        drainCalled = true;
        return Promise.resolve();
      },
    },
  );
  assertEquals(drainCalled, false);
  assertEquals(result.phase, "drain");
});

test("managed.ha.failover recover stringifies non-Error recover failures", async () => {
  const promoteCalls: unknown[] = [];
  const result = await handleManagedHaFailover(
    RECOVER_PAYLOAD,
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(true),
      recover: () => Promise.reject("orchestrator string failure"),
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(promoteCalls.length, 1);
  assertEquals(result.summary.includes("Orchestrator recover failure"), true);
});

test("managed.ha.failover repoint follows the new primary on a remaining replica", async () => {
  const followCalls: unknown[] = [];
  const result = await handleManagedHaFailover(
    {
      ...RECOVER_PAYLOAD,
      phase: "repoint",
    },
    "2026-08-19T12:00:00.000Z",
    {
      follow: (spec) => {
        followCalls.push(spec);
        return Promise.resolve();
      },
      promote: promoteStub([]),
    },
  );
  assertEquals(followCalls, [
    {
      managedId: RECOVER_PAYLOAD.managedId,
      engine: "postgres",
      primary: { host: "203.0.113.11", port: 5432 },
    },
  ]);
  assertEquals(result.phase, "repoint");
  assertEquals(result.summary.includes("repointed replica"), true);
});

test("managed.ha.failover repoint passes targetHostaddr through to follow", async () => {
  const followCalls: unknown[] = [];
  await handleManagedHaFailover(
    {
      ...RECOVER_PAYLOAD,
      phase: "repoint",
      targetHostaddr: "10.100.0.4",
    },
    "2026-08-19T12:00:00.000Z",
    {
      follow: (spec) => {
        followCalls.push(spec);
        return Promise.resolve();
      },
    },
  );
  assertEquals(followCalls, [
    {
      managedId: RECOVER_PAYLOAD.managedId,
      engine: "postgres",
      primary: {
        host: "203.0.113.11",
        port: 5432,
        hostaddr: "10.100.0.4",
      },
    },
  ]);
});

test("managed.ha.failover repoint requires the new primary endpoint", async () => {
  await assertRejects(
    () =>
      handleManagedHaFailover(
        {
          managedId: RECOVER_PAYLOAD.managedId,
          sourceMemberId: RECOVER_PAYLOAD.sourceMemberId,
          targetMemberId: RECOVER_PAYLOAD.targetMemberId,
          phase: "repoint",
        },
        "2026-08-19T12:00:00.000Z",
        {
          follow: () => Promise.reject(new Error("should not run")),
        },
      ),
    Error,
    "targetHost and targetPort",
  );
});

test("managed.ha.failover repoint works for mysql engines", async () => {
  const followCalls: unknown[] = [];
  const result = await handleManagedHaFailover(
    {
      ...RECOVER_PAYLOAD,
      engine: "mysql",
      phase: "repoint",
      targetPort: 3306,
    },
    "2026-08-19T12:00:00.000Z",
    {
      follow: (spec) => {
        followCalls.push(spec);
        return Promise.resolve();
      },
    },
  );
  assertEquals(followCalls, [
    {
      managedId: RECOVER_PAYLOAD.managedId,
      engine: "mysql",
      primary: { host: "203.0.113.11", port: 3306 },
    },
  ]);
  assertEquals(result.phase, "repoint");
});

test("managed.ha.failover repoint ensureSlots does not require a follow endpoint", async () => {
  const slotCalls: unknown[] = [];
  let followCalled = false;
  const result = await handleManagedHaFailover(
    {
      managedId: RECOVER_PAYLOAD.managedId,
      sourceMemberId: RECOVER_PAYLOAD.sourceMemberId,
      targetMemberId: RECOVER_PAYLOAD.targetMemberId,
      engine: "postgres",
      phase: "repoint",
      ensureSlots: ["tp_member_2", "tp_member_3"],
    },
    "2026-08-19T12:00:00.000Z",
    {
      ensurePrimarySlots: (spec) => {
        slotCalls.push(spec);
        return Promise.resolve();
      },
      follow: () => {
        followCalled = true;
        return Promise.resolve();
      },
    },
  );
  assertEquals(followCalled, false);
  assertEquals(slotCalls, [
    {
      managedId: RECOVER_PAYLOAD.managedId,
      engine: "postgres",
      slots: ["tp_member_2", "tp_member_3"],
    },
  ]);
  assertEquals(result.phase, "repoint");
  assertEquals(result.summary.includes("slots ensured"), true);
});

test("managed.ha.failover recover does not repoint the promoted member", async () => {
  let followCalled = false;
  await handleManagedHaFailover(
    RECOVER_PAYLOAD,
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(true),
      recover: () => Promise.resolve(),
      follow: () => {
        followCalled = true;
        return Promise.resolve();
      },
    },
  );
  assertEquals(followCalled, false);
});

test("managed.ha.failover recover stringifies non-JSON-serializable failures", async () => {
  const promoteCalls: unknown[] = [];
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const result = await handleManagedHaFailover(
    RECOVER_PAYLOAD,
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(true),
      recover: () => Promise.reject(circular),
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(promoteCalls.length, 1);
  assertEquals(result.phase, "recover");
});
