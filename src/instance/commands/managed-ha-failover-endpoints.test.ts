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

const BASE = {
  managedId: "00000000-0000-4000-8000-000000000001",
  sourceMemberId: "00000000-0000-4000-8000-000000000002",
  targetMemberId: "00000000-0000-4000-8000-000000000003",
  phase: "recover",
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
      promotedMemberId: BASE.targetMemberId,
      demoted: true,
      summary: "standby promoted to primary",
    });
  };
}

test("managed.ha.failover recover promotes when only targetHost is missing", async () => {
  const promoteCalls: unknown[] = [];
  let recoverCalled = false;
  const result = await handleManagedHaFailover(
    {
      ...BASE,
      sourceHost: "203.0.113.10",
      sourcePort: 5432,
      targetPort: 5432,
    },
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(true),
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
  const payload = promoteCalls[0];
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("expected promote payload object");
  }
  assertEquals("engine" in payload, false);
});

test("managed.ha.failover recover promotes when only sourcePort is missing", async () => {
  const promoteCalls: unknown[] = [];
  const result = await handleManagedHaFailover(
    {
      ...BASE,
      sourceHost: "203.0.113.10",
      targetHost: "203.0.113.11",
      targetPort: 5432,
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

test("managed.ha.failover recover stringifies JSON-serializable non-Error failures", async () => {
  const promoteCalls: unknown[] = [];
  const result = await handleManagedHaFailover(
    {
      ...BASE,
      engine: "postgres",
      sourceHost: "203.0.113.10",
      sourcePort: 5432,
      targetHost: "203.0.113.11",
      targetPort: 5432,
    },
    "2026-08-19T12:00:00.000Z",
    {
      haPresent: () => Promise.resolve(true),
      recover: () => Promise.reject({ code: 7 }),
      promote: promoteStub(promoteCalls),
    },
  );
  assertEquals(promoteCalls.length, 1);
  assertEquals(result.summary.includes("Orchestrator recover failure"), true);
  const payload = promoteCalls[0] as { engine?: string };
  assertEquals(payload.engine, "postgres");
});

test("managed.ha.failover drain skips helper when sourcePort is omitted", async () => {
  let drainCalled = false;
  const result = await handleManagedHaFailover(
    {
      ...BASE,
      phase: "drain",
      sourceHost: "203.0.113.10",
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
