import { assertEquals } from "@std/assert";
import { withTempLayout } from "../testing/temp-layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import { saveManagedHaMember } from "./ha-member.ts";
import { ManagedHaObserver } from "../instance/ha-observe.ts";
import type { OrchestratorProblem } from "./orchestrator-api.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-000000000002";
const DIAL = { hostname: "172.20.4.10", port: 5432 };

async function seedPrimary(layout: ReturnType<typeof resolveLayout>) {
  await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
    recursive: true,
  });
  await saveManagedHaMember(layout, {
    managedId: MANAGED_ID,
    memberId: MEMBER_ID,
    engine: "mysql",
    role: "primary",
    containerName: "mysql-primary-1",
    replicaPeerCount: 1,
    peerCount: 1,
    updatedAt: new Date().toISOString(),
  });
}

function runDockerForDial() {
  return (args: string[]) => {
    if (args[0] === "inspect") {
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({
          "3306/tcp": [{
            HostIp: DIAL.hostname,
            HostPort: String(DIAL.port),
          }],
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
  };
}

test("ManagedHaObserver emits managed-ha-event once per DeadPrimary alias", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await seedPrimary(layout);
    const sent: Array<{ type: string; managedId: string }> = [];
    const problems: OrchestratorProblem[] = [{
      clusterAlias: MANAGED_ID,
      key: DIAL,
      problems: ["DeadPrimary"],
    }];
    const observer = new ManagedHaObserver({
      layout,
      runDocker: runDockerForDial(),
      send: (message) => {
        sent.push({ type: message.type, managedId: message.managedId });
      },
      isStackPresent: () => Promise.resolve(true),
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
    assertEquals(sent[0]?.managedId, MANAGED_ID);
  });
});

test("ManagedHaObserver ignores read-replica aliases that are not UUIDs", async () => {
  const sent: Array<{ type: string; managedId: string }> = [];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push({ type: message.type, managedId: message.managedId });
    },
    isStackPresent: () => Promise.resolve(true),
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

test("ManagedHaObserver skips poll when orchestrator stack is absent", async () => {
  let fetchCalled = false;
  const observer = new ManagedHaObserver({
    send: () => {},
    isStackPresent: () => Promise.resolve(false),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(new Response("[]", { status: 200 }));
      },
    },
  });
  await observer.poll();
  assertEquals(fetchCalled, false);
});
