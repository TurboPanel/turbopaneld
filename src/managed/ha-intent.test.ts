import { assert, assertEquals } from "@std/assert";
import {
  COMMAND_TYPES,
  type CommandDispatchMessage,
} from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  beginManagedIntent,
  clearManagedIntent,
  endManagedIntent,
  HOST_WIDE_INTENT_ID,
  isIntentLookupActive,
  isManagedIntentActive,
  isOverdueRunningIntent,
  isRunningIntent,
  lookupManagedIntent,
  MANAGED_COMMAND_INTENT_EXEMPT,
  MANAGED_COMMAND_INTENT_KINDS,
  MANAGED_INTENT_GRACE_MS,
  MANAGED_INTENT_MAX_RUNNING_MS,
  MANAGED_INTENT_TTL_MS,
  managedCommandIntent,
  managedIntentPath,
  readManagedIntent,
  recordManagedIntent,
  resetManagedIntentsForTests,
} from "./ha-intent.ts";
import {
  noteManagedDestroySucceeded,
  setManagedCommandHooksLayoutForTests,
} from "./ha-command-hooks.ts";
import {
  haMemberRecordFromApply,
  managedHaMemberPath,
  markManagedHaMemberPromoted,
  readManagedHaMember,
  saveManagedHaMember,
} from "./ha-member.ts";

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
  const end = source.indexOf(
    "await endManagedCommandIntent(managedIntent, commandSucceeded,",
  );
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
  // Commands that may stop any engine container record a host-wide marker.
  assertEquals(
    managedCommandIntent("storage.restore", { copyId: "c" }),
    { managedId: HOST_WIDE_INTENT_ID, kind: "restore" },
  );
  assertEquals(
    managedCommandIntent("server.reboot", {})?.managedId,
    HOST_WIDE_INTENT_ID,
  );
});

test("a held marker never expires; transient markers expire after TTL plus grace", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    const t0 = 1_000_000;
    const held = await recordManagedIntent(dirs.stateDir, MANAGED_ID, "stop", {
      mode: "held",
      nowMs: t0,
    });
    assertEquals(held.untilMs, null);
    assert(isManagedIntentActive(held, t0 + 365 * 86_400_000));

    const restart = await recordManagedIntent(
      dirs.stateDir,
      MANAGED_ID,
      "restart",
      { nowMs: t0 + 1 },
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
    await recordManagedIntent(dirs.stateDir, MANAGED_ID, "stop", {
      mode: "held",
    });
    resetManagedIntentsForTests();
    const read = await readManagedIntent(dirs.stateDir, MANAGED_ID);
    assertEquals(read?.kind, "stop");
    assertEquals(read?.untilMs, null);
  });
});

test("a torn/unparseable marker file reads as unreadable and suppresses", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    await Deno.mkdir(`${dirs.stateDir}/managed-intent`, { recursive: true });
    await Deno.writeTextFile(
      managedIntentPath(dirs.stateDir, MANAGED_ID),
      '{"managedId":"',
    );
    const lookup = await lookupManagedIntent(dirs.stateDir, MANAGED_ID);
    assertEquals(lookup.status, "unreadable");
    assert(isIntentLookupActive(lookup, Date.now()));
    assertEquals(
      (await lookupManagedIntent(dirs.stateDir, "absent-cluster")).status,
      "none",
    );
  });
});

test("marker race: a command finishing late never overwrites a newer marker", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    const restart = await beginManagedIntent(
      dirs.stateDir,
      MANAGED_ID,
      "restart",
    );
    const apply = await beginManagedIntent(dirs.stateDir, MANAGED_ID, "apply");
    // The older restart finishes after the apply began: apply's marker stays.
    await endManagedIntent(dirs.stateDir, restart, true);
    const current = await readManagedIntent(dirs.stateDir, MANAGED_ID);
    assertEquals(current?.id, apply.ownId);
    assertEquals(current?.kind, "apply");
  });
});

test("a stop is held only after it succeeded; a failed stop stays transient", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    const failed = await beginManagedIntent(dirs.stateDir, MANAGED_ID, "stop");
    const running = await readManagedIntent(dirs.stateDir, MANAGED_ID);
    assertEquals(running?.untilMs, null);
    assert(running?.maxUntilMs !== null, "running, not held");
    await endManagedIntent(dirs.stateDir, failed, false);
    assert(
      (await readManagedIntent(dirs.stateDir, MANAGED_ID))?.untilMs !== null,
    );

    const ok = await beginManagedIntent(dirs.stateDir, MANAGED_ID, "stop");
    await endManagedIntent(dirs.stateDir, ok, true);
    assertEquals(
      (await readManagedIntent(dirs.stateDir, MANAGED_ID))?.untilMs,
      null,
    );
  });
});

test("a transient marker never replaces a held stop; only a successful start releases it", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    await recordManagedIntent(dirs.stateDir, MANAGED_ID, "stop", {
      mode: "held",
    });

    const failedStart = await beginManagedIntent(
      dirs.stateDir,
      MANAGED_ID,
      "start",
    );
    assertEquals(
      (await readManagedIntent(dirs.stateDir, MANAGED_ID))?.kind,
      "stop",
    );
    await endManagedIntent(dirs.stateDir, failedStart, false);
    assertEquals(
      (await readManagedIntent(dirs.stateDir, MANAGED_ID))?.untilMs,
      null,
      "a failed start keeps the cluster held",
    );

    const restore = await beginManagedIntent(
      dirs.stateDir,
      MANAGED_ID,
      "restore",
    );
    await endManagedIntent(dirs.stateDir, restore, true);
    assertEquals(
      (await readManagedIntent(dirs.stateDir, MANAGED_ID))?.untilMs,
      null,
      "restore does not release a held stop",
    );

    const start = await beginManagedIntent(dirs.stateDir, MANAGED_ID, "start");
    await endManagedIntent(dirs.stateDir, start, true);
    const after = await readManagedIntent(dirs.stateDir, MANAGED_ID);
    assertEquals(after?.kind, "start");
    assert(after?.untilMs !== null);
  });
});

test("destroy is held from the start, so a failed destroy never re-arms the probe", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    const destroy = await beginManagedIntent(
      dirs.stateDir,
      MANAGED_ID,
      "destroy",
    );
    await endManagedIntent(dirs.stateDir, destroy, false);
    const current = await readManagedIntent(dirs.stateDir, MANAGED_ID);
    assertEquals(current?.kind, "destroy");
    assertEquals(current?.untilMs, null);
  });
});

test("a destroy that succeeded leaves no marker behind", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    const destroy = await beginManagedIntent(
      dirs.stateDir,
      MANAGED_ID,
      "destroy",
    );
    assertEquals(
      (await lookupManagedIntent(dirs.stateDir, MANAGED_ID)).status,
      "found",
    );
    await endManagedIntent(dirs.stateDir, destroy, true);
    assertEquals(
      (await lookupManagedIntent(dirs.stateDir, MANAGED_ID)).status,
      "none",
    );
    resetManagedIntentsForTests();
    assertEquals(await readManagedIntent(dirs.stateDir, MANAGED_ID), null);
  });
});

test("a destroy that succeeded but could not remove the member record keeps the marker", async () => {
  await withTempLayout(async (fixture) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(fixture.env);
    setManagedCommandHooksLayoutForTests(layout);
    try {
      // A non-empty directory where the record file should be: the remove
      // fails with something other than NotFound.
      const recordPath = managedHaMemberPath(layout, MANAGED_ID);
      await Deno.mkdir(recordPath, { recursive: true });
      await Deno.writeTextFile(`${recordPath}/stuck`, "x");
      const destroy = await beginManagedIntent(
        fixture.dirs.stateDir,
        MANAGED_ID,
        "destroy",
      );
      const recordGone = await noteManagedDestroySucceeded(
        {
          managedId: MANAGED_ID,
        } as Parameters<typeof noteManagedDestroySucceeded>[0],
      );
      assertEquals(recordGone, false);
      await endManagedIntent(fixture.dirs.stateDir, destroy, true, {
        keepHeld: !recordGone,
      });
      resetManagedIntentsForTests();
      assertEquals(
        (await lookupManagedIntent(fixture.dirs.stateDir, MANAGED_ID)).status,
        "found",
      );
    } finally {
      setManagedCommandHooksLayoutForTests(null);
    }
  });
});

test("a destroy that succeeded with the member record gone clears the marker", async () => {
  await withTempLayout(async (fixture) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(fixture.env);
    setManagedCommandHooksLayoutForTests(layout);
    try {
      const destroy = await beginManagedIntent(
        fixture.dirs.stateDir,
        MANAGED_ID,
        "destroy",
      );
      const recordGone = await noteManagedDestroySucceeded(
        {
          managedId: MANAGED_ID,
        } as Parameters<typeof noteManagedDestroySucceeded>[0],
      );
      assertEquals(recordGone, true);
      await endManagedIntent(fixture.dirs.stateDir, destroy, true, {
        keepHeld: !recordGone,
      });
      resetManagedIntentsForTests();
      assertEquals(
        (await lookupManagedIntent(fixture.dirs.stateDir, MANAGED_ID)).status,
        "none",
      );
    } finally {
      setManagedCommandHooksLayoutForTests(null);
    }
  });
});

test("clearManagedIntent removes memory and disk copies", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    await recordManagedIntent(dirs.stateDir, MANAGED_ID, "stop", {
      mode: "held",
    });
    await clearManagedIntent(dirs.stateDir, MANAGED_ID, "test");
    assertEquals(
      (await lookupManagedIntent(dirs.stateDir, MANAGED_ID)).status,
      "none",
    );
    resetManagedIntentsForTests();
    assertEquals(
      (await lookupManagedIntent(dirs.stateDir, MANAGED_ID)).status,
      "none",
    );
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
  markerId?: string;
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
    commandType: "storage.restore",
    handlerKey: "handleStorageRestore",
    payload: {
      copyId: "00000000-0000-4000-8000-0000000000c1",
      copyProvider: "docker",
      volumeName: "managed_data",
      storageId: "00000000-0000-4000-8000-0000000000b1",
      backupId: "bk_0123abcd",
      checksum: "a".repeat(64),
    },
    result: { backupId: "bk_0123abcd" },
    markerId: HOST_WIDE_INTENT_ID,
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
            const intent = await readManagedIntent(
              layout.stateDir,
              dispatch.markerId ?? MANAGED_ID,
            );
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

test("managed.ha.failover recover flips the local target member to primary", async () => {
  const { handleCommandDispatch, setCommandRouterHandlersForTests } =
    await import("../commands/command-router.ts");
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      engine: "postgres",
      role: "replica",
      containerName: "svc-2",
      replicaPeerCount: 1,
      updatedAt: new Date().toISOString(),
    });
    setManagedCommandHooksLayoutForTests(layout);
    setCommandRouterHandlersForTests({
      handleManagedHaFailover: () =>
        Promise.resolve({ summary: "recovered", phase: "recover" }),
    });
    try {
      await handleCommandDispatch(
        {
          type: "command-dispatch",
          id: "req-recover",
          commandId: "cmd-recover",
          commandType: "managed.ha.failover",
          payload: {
            managedId: MANAGED_ID,
            sourceMemberId: "00000000-0000-4000-8000-0000000000a9",
            targetMemberId: MEMBER_ID,
            phase: "recover",
          },
          at: new Date().toISOString(),
        },
        new MockWebSocket() as unknown as WebSocket,
        { decryptSecrets: (c) => Promise.resolve(c) },
      );
      assertEquals(
        (await readManagedHaMember(layout, MANAGED_ID))?.role,
        "primary",
      );
    } finally {
      setCommandRouterHandlersForTests(null);
      setManagedCommandHooksLayoutForTests(null);
    }
  });
});

test("a running command's marker suppresses for its whole duration (TTL starts at the end, 6 h ceiling)", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    const begun = Date.now();
    const token = await beginManagedIntent(dirs.stateDir, MANAGED_ID, "apply");
    const running = await readManagedIntent(dirs.stateDir, MANAGED_ID);
    // A major upgrade keeping the engine down 11 min is still suppressed.
    assert(isManagedIntentActive(running, begun + 11 * 60_000));
    assert(isManagedIntentActive(running, begun + 5 * 3_600_000));
    assert(
      !isManagedIntentActive(
        running,
        begun + MANAGED_INTENT_MAX_RUNNING_MS + 1_000,
      ),
    );
    const overdue = await lookupManagedIntent(dirs.stateDir, MANAGED_ID);
    assert(
      isOverdueRunningIntent(
        overdue,
        begun + MANAGED_INTENT_MAX_RUNNING_MS + 1_000,
      ),
    );
    await endManagedIntent(dirs.stateDir, token, true);
    const ended = await readManagedIntent(dirs.stateDir, MANAGED_ID);
    assert(ended?.untilMs !== null && ended?.untilMs !== undefined);
    assert(ended.untilMs >= begun + MANAGED_INTENT_TTL_MS);
    assertEquals(ended.maxUntilMs, null);
  });
});

test("a running marker left on disk by an earlier daemon run reads as fromDisk", async () => {
  await withTempLayout(async ({ dirs }) => {
    resetManagedIntentsForTests();
    await beginManagedIntent(dirs.stateDir, MANAGED_ID, "stop");
    const live = await lookupManagedIntent(dirs.stateDir, MANAGED_ID);
    assert(live.status === "found" && !live.fromDisk && isRunningIntent(live));
    resetManagedIntentsForTests(); // daemon restart
    const left = await lookupManagedIntent(dirs.stateDir, MANAGED_ID);
    assert(left.status === "found" && left.fromDisk && isRunningIntent(left));
    assertEquals(left.status === "found" ? left.intent.kind : null, "stop");
  });
});

test("1+1 cluster: the promoted replica is watched at once (old primary counted as a peer)", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    const record = haMemberRecordFromApply(
      {
        ...APPLY_PAYLOAD,
        memberRole: "replica",
        peers: [{ ...APPLY_PAYLOAD.peers[0], role: "primary" }],
      } as unknown as Parameters<typeof haMemberRecordFromApply>[0],
      new Date().toISOString(),
    );
    assertEquals([record.replicaPeerCount, record.peerCount], [0, 1]);
    await saveManagedHaMember(layout, record);
    await markManagedHaMemberPromoted(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      new Date().toISOString(),
    );
    const promoted = await readManagedHaMember(layout, MANAGED_ID);
    assertEquals(promoted?.role, "primary");
    assertEquals(promoted?.replicaPeerCount, 1);

    // A record written before peerCount existed still counts the old primary.
    await saveManagedHaMember(layout, {
      ...record,
      peerCount: undefined,
      role: "replica",
    });
    await markManagedHaMemberPromoted(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      new Date().toISOString(),
    );
    assertEquals(
      (await readManagedHaMember(layout, MANAGED_ID))?.replicaPeerCount,
      1,
    );
  });
});
