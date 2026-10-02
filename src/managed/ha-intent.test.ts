import { assert, assertEquals } from "@std/assert";
import {
  COMMAND_TYPES,
  type CommandDispatchMessage,
} from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  isManagedIntentActive,
  MANAGED_COMMAND_INTENT_EXEMPT,
  MANAGED_COMMAND_INTENT_KINDS,
  MANAGED_INTENT_GRACE_MS,
  MANAGED_INTENT_TTL_MS,
  managedCommandIntent,
  readManagedIntent,
  recordManagedIntent,
  resetManagedIntentsForTests,
} from "./ha-intent.ts";
import { setManagedCommandHooksLayoutForTests } from "./ha-command-hooks.ts";
import { readManagedHaMember } from "./ha-member.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";

test("every managed.* command type is classified for intent exactly once", () => {
  const managedTypes = COMMAND_TYPES.filter((type) =>
    type.startsWith("managed.")
  );
  assert(managedTypes.length > 0);
  for (const type of managedTypes) {
    const marks = type in MANAGED_COMMAND_INTENT_KINDS;
    const exempt = type in MANAGED_COMMAND_INTENT_EXEMPT;
    assert(
      marks !== exempt,
      `${type}: add it to MANAGED_COMMAND_INTENT_KINDS (it can stop/restart/` +
        `recreate an engine container) or MANAGED_COMMAND_INTENT_EXEMPT ` +
        `(with the reason it never does) — never both, never neither`,
    );
  }
  const known = new Set<string>(COMMAND_TYPES);
  for (
    const type of [
      ...Object.keys(MANAGED_COMMAND_INTENT_KINDS),
      ...Object.keys(MANAGED_COMMAND_INTENT_EXEMPT),
    ]
  ) {
    assert(known.has(type), `${type} is not a command type`);
  }
});

test("the router records the intent before dispatch and refreshes it after", async () => {
  const source = await Deno.readTextFile(
    new URL("../commands/command-router.ts", import.meta.url),
  );
  const begin = source.indexOf("await beginManagedCommandIntent(");
  const dispatch = source.indexOf("switch (message.commandType)");
  const end = source.indexOf("await endManagedCommandIntent(");
  assert(begin > 0 && dispatch > 0 && end > 0);
  assert(begin < dispatch, "intent must be recorded before any handler runs");
  assert(
    source.lastIndexOf("finally", end) > dispatch,
    "intent refresh belongs in the finally",
  );
});

test("managedCommandIntent maps lifecycle actions and skips exempt/invalid", () => {
  assertEquals(
    managedCommandIntent("managed.lifecycle", {
      managedId: MANAGED_ID,
      action: "stop",
    }),
    { managedId: MANAGED_ID, kind: "stop" },
  );
  assertEquals(
    managedCommandIntent("managed.apply", { managedId: MANAGED_ID })?.kind,
    "apply",
  );
  assertEquals(
    managedCommandIntent("managed.backup", { managedId: MANAGED_ID }),
    null,
  );
  assertEquals(
    managedCommandIntent("managed.apply", { managedId: "../etc" }),
    null,
  );
  assertEquals(managedCommandIntent("environment.deploy", {}), null);
});

test("a stop is held; transient markers expire after TTL plus grace", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    const t0 = 1_000_000;
    const stop = await recordManagedIntent(
      dirs.stateDir,
      MANAGED_ID,
      "stop",
      t0,
    );
    assertEquals(stop.untilMs, null);
    assert(isManagedIntentActive(stop, t0 + 365 * 86_400_000));

    const restart = await recordManagedIntent(
      dirs.stateDir,
      MANAGED_ID,
      "restart",
      t0 + 1,
    );
    const expiry = t0 + 1 + MANAGED_INTENT_TTL_MS;
    assert(isManagedIntentActive(restart, expiry));
    assert(
      isManagedIntentActive(restart, expiry + MANAGED_INTENT_GRACE_MS - 1),
    );
    assert(!isManagedIntentActive(restart, expiry + MANAGED_INTENT_GRACE_MS));
    assert(!isManagedIntentActive(null, t0));
  });
});

test("markers survive a daemon restart through the disk copy", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    await recordManagedIntent(dirs.stateDir, MANAGED_ID, "stop", 5);
    resetManagedIntentsForTests();
    const read = await readManagedIntent(dirs.stateDir, MANAGED_ID);
    assertEquals(read?.kind, "stop");
    assertEquals(read?.untilMs, null);
  });
});

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly sentFrames: string[] = [];
  readyState = MockWebSocket.OPEN;
  send(data: string): void {
    this.sentFrames.push(data);
  }
}

const APPLY_PAYLOAD = {
  managedId: MANAGED_ID,
  environmentId: "00000000-0000-4000-8000-000000000002",
  engine: "postgres",
  projectName: "tp-managed-pg",
  containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
  managedNetwork: "00000000-0000-4000-8000-0000000000ee",
  image: "docker.io/library/postgres:18-alpine",
  containerPort: 5432,
  composeYaml: "services:\n  postgres:\n    image: postgres:18-alpine\n",
  configFiles: [],
  volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
  exposure: { enabled: false, protocol: "tcp" },
  credentials: [{
    principalId: "00000000-0000-4000-8000-000000000003",
    username: "postgres",
    role: "root",
    databases: ["postgres"],
    password: "tpdaemon.v1.server.key.payload",
  }],
  memberId: MEMBER_ID,
  memberRole: "primary",
  memberOrdinal: 1,
  readEligible: false,
  peers: [{
    memberId: "00000000-0000-4000-8000-0000000000a2",
    role: "replica",
    readEligible: false,
    address: "10.0.0.2",
    transport: "datacenter",
    port: 45001,
  }],
};

const INTENT_DISPATCHES: Array<{
  commandType: string;
  handlerKey: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}> = [
  {
    commandType: "managed.apply",
    handlerKey: "handleManagedApply",
    payload: APPLY_PAYLOAD,
    result: { host: "h", port: 5432 },
  },
  {
    commandType: "managed.lifecycle",
    handlerKey: "handleManagedLifecycle",
    payload: { managedId: MANAGED_ID, action: "restart" },
    result: { status: "ready" },
  },
  {
    commandType: "managed.destroy",
    handlerKey: "handleManagedDestroy",
    payload: { managedId: MANAGED_ID, removeVolumes: false },
    result: { status: "stopped", containers: [] },
  },
  {
    commandType: "managed.promote",
    handlerKey: "handleManagedPromote",
    payload: { managedId: MANAGED_ID, memberId: MEMBER_ID },
    result: { status: "ready", role: "primary" },
  },
  {
    commandType: "managed.restore",
    handlerKey: "handleManagedRestore",
    payload: {
      managedId: MANAGED_ID,
      engine: "postgres",
      backupId: "bk_1700000000000",
      artifactExtension: "dump",
      checksum: "c".repeat(64),
    },
    result: { backupId: "bk_1700000000000" },
  },
  {
    commandType: "managed.ha.failover",
    handlerKey: "handleManagedHaFailover",
    payload: {
      managedId: MANAGED_ID,
      sourceMemberId: "00000000-0000-4000-8000-000000000002",
      targetMemberId: "00000000-0000-4000-8000-000000000003",
      phase: "drain",
    },
    result: { summary: "drained", phase: "drain" },
  },
];

test("every intent verb's handler runs with the marker already active", async () => {
  const { handleCommandDispatch, setCommandRouterHandlersForTests } =
    await import("../commands/command-router.ts");
  const covered = new Set(INTENT_DISPATCHES.map((d) => d.commandType));
  for (const type of Object.keys(MANAGED_COMMAND_INTENT_KINDS)) {
    assert(covered.has(type), `${type} lacks a dispatch case in this test`);
  }
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    setManagedCommandHooksLayoutForTests(layout);
    try {
      await INTENT_DISPATCHES.reduce(async (previous, dispatch) => {
        await previous;
        resetManagedIntentsForTests();
        await Deno.remove(`${fixture.dirs.stateDir}/managed-intent`, {
          recursive: true,
        }).catch(() => undefined);
        let activeAtHandler = false;
        setCommandRouterHandlersForTests({
          [dispatch.handlerKey]: async () => {
            const intent = await readManagedIntent(layout.stateDir, MANAGED_ID);
            activeAtHandler = isManagedIntentActive(intent, Date.now());
            return dispatch.result;
          },
        });
        const message: CommandDispatchMessage = {
          type: "command-dispatch",
          id: `req-${dispatch.commandType}`,
          commandId: `cmd-${dispatch.commandType}`,
          commandType: dispatch.commandType as CommandDispatchMessage[
            "commandType"
          ],
          payload: dispatch.payload,
          at: new Date().toISOString(),
        };
        await handleCommandDispatch(
          message,
          new MockWebSocket() as unknown as WebSocket,
          { decryptSecrets: (c) => Promise.resolve(c) },
        );
        assert(
          activeAtHandler,
          `${dispatch.commandType} ran without an intent marker`,
        );
      }, Promise.resolve());
    } finally {
      setCommandRouterHandlersForTests(null);
      setManagedCommandHooksLayoutForTests(null);
    }
  });
});

test("apply records the member; promote flips it; destroy removes it", async () => {
  const { handleCommandDispatch, setCommandRouterHandlersForTests } =
    await import("../commands/command-router.ts");
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    setManagedCommandHooksLayoutForTests(layout);
    setCommandRouterHandlersForTests({
      handleManagedApply: () => Promise.resolve({ host: "h", port: 5432 }),
      handleManagedPromote: () =>
        Promise.resolve({
          status: "ready",
          role: "primary",
          promotedMemberId: MEMBER_ID,
          demoted: false,
        }),
      handleManagedDestroy: () =>
        Promise.resolve({ status: "stopped", containers: [] }),
    });
    const send = (commandType: string, payload: Record<string, unknown>) =>
      handleCommandDispatch(
        {
          type: "command-dispatch",
          id: `req-${commandType}`,
          commandId: `cmd-${commandType}`,
          commandType: commandType as CommandDispatchMessage["commandType"],
          payload,
          at: new Date().toISOString(),
        },
        new MockWebSocket() as unknown as WebSocket,
        { decryptSecrets: (c) => Promise.resolve(c) },
      );
    try {
      await send("managed.apply", { ...APPLY_PAYLOAD, memberRole: "replica" });
      const applied = await readManagedHaMember(layout, MANAGED_ID);
      assertEquals(applied?.role, "replica");
      assertEquals(applied?.replicaPeerCount, 1);
      assertEquals(applied?.memberId, MEMBER_ID);

      await send("managed.promote", {
        managedId: MANAGED_ID,
        memberId: MEMBER_ID,
      });
      assertEquals(
        (await readManagedHaMember(layout, MANAGED_ID))?.role,
        "primary",
      );

      await send("managed.destroy", {
        managedId: MANAGED_ID,
        removeVolumes: false,
      });
      assertEquals(await readManagedHaMember(layout, MANAGED_ID), null);
    } finally {
      setCommandRouterHandlersForTests(null);
      setManagedCommandHooksLayoutForTests(null);
    }
  });
});
