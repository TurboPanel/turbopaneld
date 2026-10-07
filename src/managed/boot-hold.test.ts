import { assert, assertEquals } from "@std/assert";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  applyBootHold,
  bootHoldPath,
  ensureHoldStopped,
  isHoldablePrimary,
  listActiveBootHolds,
  releaseBootHoldLocally,
} from "./boot-hold.ts";
import {
  beginManagedIntent,
  endManagedIntent,
  lookupManagedIntent,
  resetManagedIntentsForTests,
} from "./ha-intent.ts";
import type { ManagedHaMemberRecord } from "./ha-member.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const PRIMARY_ID = "00000000-0000-4000-8000-000000000001";
const STANDALONE_ID = "00000000-0000-4000-8000-000000000002";
const REPLICA_ID = "00000000-0000-4000-8000-000000000003";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";

function record(
  overrides: Partial<ManagedHaMemberRecord> = {},
): ManagedHaMemberRecord {
  return {
    managedId: PRIMARY_ID,
    memberId: MEMBER_ID,
    engine: "postgres",
    role: "primary",
    containerName: "db-1",
    replicaPeerCount: 1,
    peerCount: 1,
    updatedAt: "2026-10-06T10:00:00.000Z",
    ...overrides,
  };
}

function docker(outcomes: boolean[] = []) {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    const success = outcomes.length > 0 ? outcomes.shift()! : true;
    return Promise.resolve({
      success,
      code: success ? 0 : 1,
      stdout: "",
      stderr: success ? "" : "daemon not ready",
    });
  };
  return { run, calls };
}

test("only a primary with a peer is holdable", () => {
  assert(isHoldablePrimary(record()));
  assert(
    isHoldablePrimary(record({ peerCount: undefined, replicaPeerCount: 2 })),
  );
  assert(!isHoldablePrimary(record({ peerCount: 0, replicaPeerCount: 0 })));
  assert(!isHoldablePrimary(record({ role: "replica" })));
});

test("an unclean boot stops every primary that has a peer and writes a held marker first", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const fake = docker();
    assertEquals(
      await applyBootHold("unclean", {
        layout,
        run: fake.run,
        listMembers: () =>
          Promise.resolve([
            record(),
            record({
              managedId: STANDALONE_ID,
              peerCount: 0,
              replicaPeerCount: 0,
            }),
            record({ managedId: REPLICA_ID, role: "replica" }),
          ]),
      }),
      true,
    );
    const held = await listActiveBootHolds(layout);
    assertEquals(held.map((row) => row.managedId), [PRIMARY_ID]);
    assertEquals(held[0]?.engineStopped, true);
    assertEquals(fake.calls, [["compose", "-p", PRIMARY_ID, "stop"]]);
    const marker = await lookupManagedIntent(layout.stateDir, PRIMARY_ID);
    assert(marker.status === "found" && marker.intent.kind === "stop");
    assertEquals(marker.intent.untilMs, null);
    assertEquals(marker.intent.maxUntilMs, null);
    assertEquals((await listActiveBootHolds(layout)).length, 1);
  });
});

test("a daemon restart and a first boot hold nothing", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const fake = docker();
    for (const kind of ["first", "same-boot"] as const) {
      assertEquals(
        await applyBootHold(kind, {
          layout,
          run: fake.run,
          listMembers: () => Promise.resolve([record()]),
        }),
        true,
      );
    }
    assertEquals(fake.calls, []);
    assertEquals(await listActiveBootHolds(layout), []);
  });
});

test("a failed stop keeps the hold and the marker, and the retry finishes it", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const fake = docker([false, true]);
    await applyBootHold("unclean", {
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([record()]),
    });
    assertEquals((await listActiveBootHolds(layout))[0]?.engineStopped, false);
    const [active] = await listActiveBootHolds(layout);
    assertEquals(active?.engineStopped, false);
    const retried = await ensureHoldStopped(active!, { layout, run: fake.run });
    assertEquals(retried.engineStopped, true);
    assertEquals((await listActiveBootHolds(layout))[0]?.engineStopped, true);
    // Nothing more to do once stopped.
    await ensureHoldStopped(retried, { layout, run: fake.run });
    assertEquals(fake.calls.length, 2);
  });
});

test("a hold is kept across a second unclean boot, not reset", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const fake = docker();
    const deps = {
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([record()]),
    };
    await applyBootHold("unclean", {
      ...deps,
      nowIso: () => "2026-10-06T10:00:00.000Z",
    });
    const first = await listActiveBootHolds(layout);
    await applyBootHold("unclean", {
      ...deps,
      nowIso: () => "2026-10-06T11:00:00.000Z",
    });
    const second = await listActiveBootHolds(layout);
    assertEquals(second[0]?.heldAt, first[0]?.heldAt);
  });
});

test("a successful start releases the hold; a failed start does not", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await applyBootHold("unclean", {
      layout,
      run: docker().run,
      listMembers: () => Promise.resolve([record()]),
    });

    const failed = await beginManagedIntent(
      layout.stateDir,
      PRIMARY_ID,
      "start",
    );
    await endManagedIntent(layout.stateDir, failed, false);
    assertEquals((await listActiveBootHolds(layout)).length, 1);

    const ok = await beginManagedIntent(layout.stateDir, PRIMARY_ID, "start");
    await endManagedIntent(layout.stateDir, ok, true);
    assertEquals(await listActiveBootHolds(layout), []);
    await assertRejectsMissing(bootHoldPath(layout, PRIMARY_ID));
  });
});

async function assertRejectsMissing(path: string): Promise<void> {
  let missing = false;
  try {
    await Deno.stat(path);
  } catch (err) {
    missing = err instanceof Deno.errors.NotFound;
  }
  assert(missing, `${path} should be gone`);
}

test("releasing locally clears the marker, removes the file and starts the engine", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const fake = docker();
    await applyBootHold("unclean", {
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([record()]),
    });
    const [hold] = await listActiveBootHolds(layout);
    await releaseBootHoldLocally(hold!, { layout, run: fake.run }, "test");
    assertEquals(fake.calls.at(-1), ["compose", "-p", PRIMARY_ID, "start"]);
    assertEquals(
      (await lookupManagedIntent(layout.stateDir, PRIMARY_ID)).status,
      "none",
    );
    assertEquals(await listActiveBootHolds(layout), []);
  });
});

test("a planned reboot (clean stamp) holds the primary until the control plane answers", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const fake = docker();
    assertEquals(
      await applyBootHold("clean-reboot", {
        layout,
        run: fake.run,
        listMembers: () => Promise.resolve([record()]),
      }),
      true,
    );
    assertEquals(fake.calls, [["compose", "-p", PRIMARY_ID, "stop"]]);
    assertEquals((await listActiveBootHolds(layout)).length, 1);
  });
});
