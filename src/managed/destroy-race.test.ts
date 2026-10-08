/**
 * A destroy cannot be undone by an apply that runs right after (or beside) it.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ManagedApplyPayload } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { handleManagedApply } from "./apply.ts";
import { handleManagedDestroy } from "./destroy.ts";
import {
  isManagedMemberDestroyed,
  ManagedDestroyedError,
  writeManagedDestroyedMarker,
} from "./destroyed-marker.ts";
import { managedDir } from "./engine-paths.ts";
import { listManagedHaMembers, saveManagedHaMember } from "./ha-member.ts";
import { withManagedLifecycleLock } from "./target-lock.ts";

const test = Deno.test.bind(Deno);

const MANAGED_ID = "01936b3e-aaaa-bbbb-cccc-123456789abc";
const MEMBER_A = "00000000-0000-4000-8000-0000000000a1";
const MEMBER_B = "00000000-0000-4000-8000-0000000000b2";

function ok(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function quietDocker(): Promise<DockerCliResult> {
  return Promise.resolve(ok());
}

function applyPayload(memberId: string): ManagedApplyPayload {
  return {
    managedId: MANAGED_ID,
    environmentId: "env_1",
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
    credentials: [],
    memberId,
    memberRole: "replica",
    memberOrdinal: 2,
    readEligible: false,
    peers: [],
  };
}

async function withEnv(
  fn: (stateDir: string) => Promise<void>,
): Promise<void> {
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
      await fn(fixture.dirs.stateDir);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
}

const applyDeps = {
  ensureDocker: () => Promise.resolve(),
  runHostPrep: () => Promise.resolve(),
  runDocker: quietDocker,
};

test("apply right after destroy is refused and rebuilds nothing", async () => {
  await withEnv(async (stateDir) => {
    const layout = resolveLayout(Deno.env.toObject());
    const root = managedDir(layout, MANAGED_ID);
    await Deno.mkdir(root, { recursive: true });
    await handleManagedDestroy(
      { managedId: MANAGED_ID, removeVolumes: true, memberId: MEMBER_A },
      new Date().toISOString(),
      { runDocker: quietDocker },
    );

    const calls: string[][] = [];
    await assertRejects(
      () =>
        handleManagedApply(applyPayload(MEMBER_A), new Date().toISOString(), {
          ...applyDeps,
          runDocker: (args) => {
            calls.push(args);
            return quietDocker();
          },
        }),
      ManagedDestroyedError,
      "was destroyed",
    );
    assertEquals(calls, []);
    assertEquals(
      await Deno.stat(root).then(() => true, () => false),
      false,
    );
    assertEquals(
      await isManagedMemberDestroyed(stateDir, MANAGED_ID, MEMBER_A),
      true,
    );
  });
});

test("a new member of the same id applies after another member was destroyed", async () => {
  await withEnv(async () => {
    await handleManagedDestroy(
      { managedId: MANAGED_ID, removeVolumes: true, memberId: MEMBER_A },
      new Date().toISOString(),
      { runDocker: quietDocker },
    );
    // No decryptSecrets: the apply gets past the destroyed check and stops
    // at the next requirement, which is all this test needs to see.
    const err = await handleManagedApply(
      applyPayload(MEMBER_B),
      new Date().toISOString(),
      applyDeps,
    ).then(() => null, (e: unknown) => e);
    assert(err instanceof Error);
    assert(!(err instanceof ManagedDestroyedError));
  });
});

test("an expired marker no longer refuses", async () => {
  await withEnv(async (stateDir) => {
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await writeManagedDestroyedMarker(stateDir, MANAGED_ID, MEMBER_A, old);
    assertEquals(
      await isManagedMemberDestroyed(stateDir, MANAGED_ID, MEMBER_A),
      false,
    );
  });
});

test("a destroy that cannot write its marker fails before removing anything", async () => {
  await withEnv(async (stateDir) => {
    const layout = resolveLayout(Deno.env.toObject());
    const root = managedDir(layout, MANAGED_ID);
    await Deno.mkdir(root, { recursive: true });
    // A file where the marker directory belongs.
    await Deno.writeTextFile(`${stateDir}/managed-destroyed`, "x");
    const calls: string[][] = [];
    await assertRejects(() =>
      handleManagedDestroy(
        { managedId: MANAGED_ID, removeVolumes: false },
        new Date().toISOString(),
        {
          runDocker: (args) => {
            calls.push(args);
            return quietDocker();
          },
        },
      )
    );
    assertEquals(calls, []);
    assertEquals((await Deno.stat(root)).isDirectory, true);
  });
});

test("destroy waits for a running apply, and a queued apply then refuses", async () => {
  await withEnv(async () => {
    const layout = resolveLayout(Deno.env.toObject());
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));

    // Stands in for an apply that is mid-way through its compose up.
    const running = withManagedLifecycleLock(layout, MANAGED_ID, async () => {
      held();
      await gate;
      order.push("apply-done");
    });
    await holding;

    const destroy = handleManagedDestroy(
      { managedId: MANAGED_ID, removeVolumes: false, memberId: MEMBER_A },
      new Date().toISOString(),
      {
        runDocker: (args) => {
          if (!order.includes("destroy-started")) order.push("destroy-started");
          void args;
          return quietDocker();
        },
      },
    ).then(() => order.push("destroy-done"));
    const queued = handleManagedApply(
      applyPayload(MEMBER_A),
      new Date().toISOString(),
      applyDeps,
    ).then(() => "applied", (e: unknown) => e);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(order, []);
    release();
    await running;
    await destroy;
    assertEquals(order.slice(0, 3), [
      "apply-done",
      "destroy-started",
      "destroy-done",
    ]);
    assert((await queued) instanceof ManagedDestroyedError);
  });
});

test("destroy fails when a container comes back during teardown", async () => {
  await withEnv(async () => {
    let listings = 0;
    await assertRejects(
      () =>
        handleManagedDestroy(
          { managedId: MANAGED_ID, removeVolumes: false },
          new Date().toISOString(),
          {
            runDocker: (args) => {
              if (args[0] === "ps") {
                listings++;
                // Clean for the teardown's own look, present afterwards.
                return Promise.resolve(
                  ok(listings <= 1 ? "" : "abcdef123456\n"),
                );
              }
              if (args[0] === "rm") {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "busy",
                  code: 1,
                });
              }
              return quietDocker();
            },
          },
        ),
      Error,
      "re-created",
    );
  });
});

test("a destroyed member is not listed as a member to watch", async () => {
  await withEnv(async (stateDir) => {
    const layout = resolveLayout(Deno.env.toObject());
    await Deno.mkdir(managedDir(layout, MANAGED_ID), { recursive: true });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: MEMBER_A,
      engine: "postgres",
      role: "primary",
      containerName: "c1",
      replicaPeerCount: 1,
      updatedAt: new Date().toISOString(),
    });
    assertEquals((await listManagedHaMembers(layout)).length, 1);
    await writeManagedDestroyedMarker(
      stateDir,
      MANAGED_ID,
      MEMBER_A,
      new Date().toISOString(),
    );
    assertEquals((await listManagedHaMembers(layout)).length, 0);
  });
});
