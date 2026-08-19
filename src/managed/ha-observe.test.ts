import { assertEquals } from "@std/assert";
import { ManagedHaObserver } from "../instance/ha-observe.ts";
import type { OrchestratorProblem } from "./orchestrator-api.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("ManagedHaObserver emits managed-ha-event once per DeadPrimary alias", async () => {
  const sent: Array<{ type: string; managedId: string }> = [];
  const problems: OrchestratorProblem[] = [{
    clusterAlias: "00000000-0000-4000-8000-000000000001",
    key: { hostname: "db-1", port: 5432 },
    problems: ["DeadPrimary"],
  }];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push({ type: message.type, managedId: message.managedId });
    },
    isHostPrepPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(problems), { status: 200 }),
        ),
    },
  });
  await observer.poll();
  await observer.poll();
  assertEquals(sent.length, 1);
  assertEquals(sent[0]?.type, "managed-ha-event");
  assertEquals(sent[0]?.managedId, "00000000-0000-4000-8000-000000000001");
});

test("ManagedHaObserver ignores read-replica aliases that are not UUIDs", async () => {
  const sent: Array<{ type: string; managedId: string }> = [];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push({ type: message.type, managedId: message.managedId });
    },
    isHostPrepPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify([{
              clusterAlias: "not-a-uuid",
              problems: ["DeadPrimary"],
            }]),
            { status: 200 },
          ),
        ),
    },
  });
  await observer.poll();
  assertEquals(sent.length, 0);
});
