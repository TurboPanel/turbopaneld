import { assertEquals } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  ENGINE_EXIT_GUARD_MAX_ATTEMPTS,
  ENGINE_EXIT_GUARD_MAX_START_GAP_MS,
  ManagedEngineExitGuard,
} from "./engine-exit-guard.ts";
import {
  applyBootHold,
  listActiveBootHolds,
  resetUnsettledBootHoldsForTests,
} from "./boot-hold.ts";
import { writeManagedDemotedMarker } from "./demoted-marker.ts";
import { writeManagedDestroyedMarker } from "./destroyed-marker.ts";
import {
  beginManagedIntent,
  clearManagedIntent,
  endManagedIntent,
  HOST_WIDE_INTENT_ID,
  isHeldIntent,
  lookupManagedIntent,
  managedIntentPath,
  recordManagedIntent,
  resetManagedIntentsForTests,
} from "./ha-intent.ts";
import { saveManagedHaMember } from "./ha-member.ts";
import { dirname } from "@std/path";
import { forEachSequential } from "../util/sequential.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";

const EXITED_PS = JSON.stringify([
  {
    ID: "abc123",
    Name: "db-1",
    Service: "db",
    State: "exited",
  },
]);

/**
 * A member record. The default is a standalone primary (no peers), which the
 * guard starts on sight; pass `peers` for a cluster member.
 */
function memberRecord(peers = 0) {
  return {
    managedId: MANAGED_ID,
    memberId: MEMBER_ID,
    engine: "postgres" as const,
    role: "primary" as const,
    containerName: "db-1",
    replicaPeerCount: peers,
    peerCount: peers,
    updatedAt: "2026-10-08T12:00:00.000Z",
  };
}

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123",
    Name: "db-1",
    Service: "db",
    State: "running",
  },
]);

function docker(psStdout = EXITED_PS) {
  const calls: string[][] = [];
  const stdout = psStdout;
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    if (args[0] === "compose" && args.includes("ps")) {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout,
        stderr: "",
      });
    }
    // Leave ps as exited so rate limiting can be exercised across ticks.
    return Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });
  };
  return { run, calls };
}

async function seedMember(
  layout: ReturnType<typeof resolveLayout>,
): Promise<void> {
  const root = `${layout.stateDir}/managed/${MANAGED_ID}`;
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docker-compose.yml`,
    [
      "services:",
      "  db:",
      "    image: postgres:18-alpine",
      "    volumes:",
      "      - pgdata:/var/lib/postgresql",
      "volumes:",
      "  pgdata:",
      "    name: pgdata",
    ].join("\n"),
  );
  await saveManagedHaMember(layout, memberRecord());
}

test("a stopped primary is started at most once per minute", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    let now = 1_000_000;
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
      intervalMs: 60_000,
      minStartGapMs: 60_000,
      nowMs: () => now,
    });
    await guard.tick();
    const startCalls = fake.calls.filter((args) =>
      args[0] === "compose" && args.at(-1) === "start"
    );
    assertEquals(startCalls.length, 1);

    await guard.tick();
    assertEquals(
      fake.calls.filter((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ).length,
      1,
    );

    now += 60_001;
    await guard.tick();
    assertEquals(
      fake.calls.filter((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ).length,
      2,
    );
  });
});

test("a running engine is not started", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const running = JSON.stringify([
      {
        ID: "abc123",
        Name: "db-1",
        Service: "db",
        State: "running",
      },
    ]);
    const fake = docker(running);
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

test("a demoted member is not started", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

test("a replica whose data is not a standby is not started", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const root = `${layout.stateDir}/managed/${MANAGED_ID}`;
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docker-compose.yml`,
      [
        "services:",
        "  db:",
        "    image: postgres:18-alpine",
        "    volumes:",
        "      - pgdata:/var/lib/postgresql",
        "volumes:",
        "  pgdata:",
        "    name: pgdata",
      ].join("\n"),
    );
    await saveManagedHaMember(layout, {
      ...memberRecord(),
      role: "replica",
    });
    const pgData = "/var/lib/postgresql/data/PG_VERSION";
    const calls: string[][] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      if (args[0] === "run") {
        const script = args.at(-1) ?? "";
        const path = script.split(" ")[2] ?? "";
        const stdout = path === pgData ? "present\n" : "absent\n";
        return Promise.resolve({
          success: true,
          code: 0,
          stdout,
          stderr: "",
        });
      }
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: EXITED_PS,
          stderr: "",
        });
      }
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    };
    const guard = new ManagedEngineExitGuard({
      layout,
      run,
      listMembers: () =>
        Promise.resolve([{ ...memberRecord(), role: "replica" }]),
    });
    await guard.tick();
    assertEquals(
      calls.some((args) => args[0] === "compose" && args.at(-1) === "start"),
      false,
    );
    assertEquals(calls.some((args) => args[0] === "run"), true);
  });
});

test("compose start failure is logged without throwing", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    let startAttempted = false;
    const failingRun = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "compose" && args.at(-1) === "start") {
        startAttempted = true;
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "start refused",
        });
      }
      return fake.run(args);
    };
    const guard = new ManagedEngineExitGuard({
      layout,
      run: failingRun,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(startAttempted, true);
  });
});

test("an empty compose ps list is treated as stopped", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker("[]");
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      true,
    );
  });
});

test("a running managed command blocks compose start", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    await beginManagedIntent(layout.stateDir, MANAGED_ID, "apply");
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

test("a held destroy intent blocks compose start", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    await recordManagedIntent(layout.stateDir, MANAGED_ID, "destroy", {
      mode: "held",
    });
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

test("a standby replica with valid data may be started", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const root = `${layout.stateDir}/managed/${MANAGED_ID}`;
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docker-compose.yml`,
      [
        "services:",
        "  db:",
        "    image: postgres:18-alpine",
        "    volumes:",
        "      - pgdata:/var/lib/postgresql",
        "volumes:",
        "  pgdata:",
        "    name: pgdata",
      ].join("\n"),
    );
    await saveManagedHaMember(layout, {
      ...memberRecord(),
      role: "replica",
    });
    const pgData = "/var/lib/postgresql/data/PG_VERSION";
    const pgSignal = "/var/lib/postgresql/data/standby.signal";
    const present = new Set([pgData, pgSignal]);
    const calls: string[][] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      if (args[0] === "run") {
        const script = args.at(-1) ?? "";
        const path = script.split(" ")[2] ?? "";
        const stdout = present.has(path) ? "present\n" : "absent\n";
        return Promise.resolve({
          success: true,
          code: 0,
          stdout,
          stderr: "",
        });
      }
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: EXITED_PS,
          stderr: "",
        });
      }
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    };
    const guard = new ManagedEngineExitGuard({
      layout,
      run,
      listMembers: () =>
        Promise.resolve([{ ...memberRecord(), role: "replica" }]),
    });
    await guard.tick();
    assertEquals(
      calls.some((args) => args[0] === "compose" && args.at(-1) === "start"),
      true,
    );
  });
});

test("a held operator stop is not started", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    await recordManagedIntent(layout.stateDir, MANAGED_ID, "stop", {
      mode: "held",
    });
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

test("a destroyed member is not started", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    await writeManagedDestroyedMarker(
      layout.stateDir,
      MANAGED_ID,
      MEMBER_ID,
      new Date().toISOString(),
    );
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

test("a transient lifecycle stop blocks compose start", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const token = await beginManagedIntent(layout.stateDir, MANAGED_ID, "stop");
    await endManagedIntent(layout.stateDir, token, false);
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

test("host-wide storage.restore blocks compose start", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    await beginManagedIntent(layout.stateDir, HOST_WIDE_INTENT_ID, "restore");
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

test("host-wide server.reboot blocks compose start", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    await beginManagedIntent(layout.stateDir, HOST_WIDE_INTENT_ID, "restart");
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "start"
      ),
      false,
    );
  });
});

function startCount(calls: string[][]): number {
  return calls.filter((args) =>
    args[0] === "compose" && args.at(-1) === "start"
  )
    .length;
}

test("a boot hold that could not be finished keeps the engine stopped", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    resetUnsettledBootHoldsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const failingStop = (args: string[]): Promise<DockerCliResult> =>
      Promise.resolve({
        success: !args.includes("stop"),
        code: args.includes("stop") ? 1 : 0,
        stdout: "",
        stderr: "",
      });
    try {
      await applyBootHold("unclean", {
        layout,
        run: failingStop,
        listMembers: () => Promise.resolve([memberRecord(1)]),
      });
      // The held marker could not be written: only the in-process note is left.
      await clearManagedIntent(layout.stateDir, MANAGED_ID, "test");
      const fake = docker();
      const guard = new ManagedEngineExitGuard({
        layout,
        run: fake.run,
        listMembers: () => Promise.resolve([memberRecord(1)]),
      });
      await guard.tick();
      assertEquals(startCount(fake.calls), 0);
    } finally {
      resetUnsettledBootHoldsForTests();
    }
  });
});

test("nothing is started while the boot hold is still pending", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    let pending = true;
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
      startPaused: () => pending,
    });
    await guard.tick();
    assertEquals(fake.calls.length, 0);
    pending = false;
    await guard.tick();
    assertEquals(startCount(fake.calls), 1);
  });
});

test("the wait between starts doubles and the guard gives up", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    const gap = 60_000;
    let now = 1_000_000;
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
      minStartGapMs: gap,
      nowMs: () => now,
    });
    await guard.tick();
    assertEquals(startCount(fake.calls), 1);
    now += gap + 1;
    await guard.tick();
    assertEquals(startCount(fake.calls), 2);
    // The wait before the third try is two gaps, not one.
    now += gap + 1;
    await guard.tick();
    assertEquals(startCount(fake.calls), 2);
    now += gap;
    await guard.tick();
    assertEquals(startCount(fake.calls), 3);
    await forEachSequential(Array.from({ length: 20 }), async () => {
      now += ENGINE_EXIT_GUARD_MAX_START_GAP_MS + 1;
      await guard.tick();
    });
    assertEquals(startCount(fake.calls), ENGINE_EXIT_GUARD_MAX_ATTEMPTS);
  });
});

test("seeing the engine run again resets the wait and the give-up count", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const calls: string[][] = [];
    let ps = EXITED_PS;
    const run = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      const stdout = args[0] === "compose" && args.includes("ps") ? ps : "";
      return Promise.resolve({ success: true, code: 0, stdout, stderr: "" });
    };
    let now = 1_000_000;
    const guard = new ManagedEngineExitGuard({
      layout,
      run,
      listMembers: () => Promise.resolve([memberRecord()]),
      nowMs: () => now,
    });
    await guard.tick();
    assertEquals(startCount(calls), 1);
    ps = JSON.stringify([{
      ID: "a",
      Name: "db-1",
      Service: "db",
      State: "running",
    }]);
    now += 1;
    await guard.tick();
    ps = EXITED_PS;
    now += 1;
    await guard.tick();
    // The engine ran in between, so the next stop is tried at once.
    assertEquals(startCount(calls), 2);
  });
});

test("a replica is not probed again while the wait is running", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const replica = { ...memberRecord(), role: "replica" as const };
    await saveManagedHaMember(layout, replica);
    const calls: string[][] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      let stdout = "";
      if (args[0] === "run") stdout = "present\n";
      if (args[0] === "compose" && args.includes("ps")) stdout = EXITED_PS;
      return Promise.resolve({ success: true, code: 0, stdout, stderr: "" });
    };
    let now = 1_000_000;
    const guard = new ManagedEngineExitGuard({
      layout,
      run,
      listMembers: () => Promise.resolve([replica]),
      nowMs: () => now,
    });
    await guard.tick();
    const probes = calls.filter((args) => args[0] === "run").length;
    now += 1_000;
    await guard.tick();
    assertEquals(calls.filter((args) => args[0] === "run").length, probes);
  });
});

test("the give-up warning is raised exactly once", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    const given: string[] = [];
    let now = 1_000_000;
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
      nowMs: () => now,
      onGiveUp: (id) => given.push(id),
    });
    await forEachSequential(Array.from({ length: 20 }), async () => {
      now += ENGINE_EXIT_GUARD_MAX_START_GAP_MS + 1;
      await guard.tick();
    });
    assertEquals(given, [MANAGED_ID]);
    assertEquals(startCount(fake.calls), ENGINE_EXIT_GUARD_MAX_ATTEMPTS);
  });
});

test("an unreadable intent marker blocks the start", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const path = managedIntentPath(layout.stateDir, MANAGED_ID);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, "{ not json");
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(startCount(fake.calls), 0);
  });
});

test("a stop that begins while the standby probe runs is not undone", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const replica = { ...memberRecord(), role: "replica" as const };
    await saveManagedHaMember(layout, replica);
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      let stdout = "";
      if (args[0] === "run") {
        stdout = "present\n";
        // The operator's stop lands while the probe is still running.
        await beginManagedIntent(layout.stateDir, MANAGED_ID, "stop");
      }
      if (args[0] === "compose" && args.includes("ps")) stdout = EXITED_PS;
      return { success: true, code: 0, stdout, stderr: "" };
    };
    const guard = new ManagedEngineExitGuard({
      layout,
      run,
      listMembers: () => Promise.resolve([replica]),
    });
    await guard.tick();
    assertEquals(calls.some((args) => args[0] === "run"), true);
    assertEquals(startCount(calls), 0);
  });
});

test("a stop that failed and whose timer ran out is not undone", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const token = await beginManagedIntent(layout.stateDir, MANAGED_ID, "stop");
    await endManagedIntent(layout.stateDir, token, false);
    const fake = docker();
    // Well past the 10 minute timer and its grace period.
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
      nowMs: () => Date.now() + 60 * 60_000,
    });
    await guard.tick();
    assertEquals(startCount(fake.calls), 0);
  });
});

test("an explicit start after a failed stop lets the guard act again", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const stop = await beginManagedIntent(layout.stateDir, MANAGED_ID, "stop");
    await endManagedIntent(layout.stateDir, stop, false);
    const start = await beginManagedIntent(
      layout.stateDir,
      MANAGED_ID,
      "start",
    );
    await endManagedIntent(layout.stateDir, start, true);
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
      nowMs: () => Date.now() + 60 * 60_000,
    });
    await guard.tick();
    assertEquals(startCount(fake.calls), 1);
  });
});

/** A `holdPrimary` seam that only counts its calls. */
function countingHold() {
  let calls = 0;
  return {
    fn: () => {
      calls += 1;
      return Promise.resolve();
    },
    count: () => calls,
  };
}

/** Docker fake whose `compose ps` answer can change between ticks. */
function switchableDocker(initialPs: string) {
  const calls: string[][] = [];
  const state = { ps: initialPs };
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    const stdout = args[0] === "compose" && args.includes("ps") ? state.ps : "";
    return Promise.resolve({ success: true, code: 0, stdout, stderr: "" });
  };
  return { run, calls, state };
}

test("a cluster primary found stopped at daemon start is held, not started", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    resetUnsettledBootHoldsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord(1)]),
    });
    await guard.tick();
    assertEquals(startCount(fake.calls), 0);
    // The hold the control plane is asked about: held stop marker + hold file.
    const holds = await listActiveBootHolds(layout);
    assertEquals(holds.map((h) => h.managedId), [MANAGED_ID]);
    const lookup = await lookupManagedIntent(layout.stateDir, MANAGED_ID);
    assertEquals(isHeldIntent(lookup), true);
    assertEquals(
      lookup.status === "found" ? lookup.intent.kind : undefined,
      "stop",
    );
    // Later ticks keep it stopped while the control plane has not answered.
    await guard.tick();
    assertEquals(startCount(fake.calls), 0);
  });
});

test("the guard may start a cluster primary once the control plane released its hold", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    resetUnsettledBootHoldsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord(1)]),
    });
    await guard.tick();
    assertEquals(startCount(fake.calls), 0);
    // A `managed.lifecycle start` from the control plane replaces the held
    // stop; if the engine still is not up, the guard starts it as before and
    // does not hold it a second time.
    await clearManagedIntent(layout.stateDir, MANAGED_ID, "confirmed");
    await guard.tick();
    assertEquals(startCount(fake.calls), 1);
  });
});

test("a single-member database found stopped at daemon start is started as before", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    const hold = countingHold();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord(0)]),
      holdPrimary: hold.fn,
    });
    await guard.tick();
    assertEquals(hold.count(), 0);
    assertEquals(startCount(fake.calls), 1);
    assertEquals(await listActiveBootHolds(layout), []);
  });
});

test("a cluster primary seen running that exits later is started as before", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = switchableDocker(RUNNING_PS);
    const hold = countingHold();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord(1)]),
      holdPrimary: hold.fn,
    });
    await guard.tick();
    assertEquals(startCount(fake.calls), 0);
    fake.state.ps = EXITED_PS;
    await guard.tick();
    assertEquals(hold.count(), 0);
    assertEquals(startCount(fake.calls), 1);
  });
});

test("a cluster primary left stopped by a command is neither held nor started", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    await recordManagedIntent(layout.stateDir, MANAGED_ID, "stop", {
      mode: "held",
    });
    const fake = docker();
    const hold = countingHold();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord(1)]),
      holdPrimary: hold.fn,
    });
    await guard.tick();
    assertEquals(hold.count(), 0);
    assertEquals(startCount(fake.calls), 0);
    // The operator starts it from the control plane; a later exit is the
    // ordinary case again.
    await clearManagedIntent(layout.stateDir, MANAGED_ID, "operator start");
    await guard.tick();
    assertEquals(hold.count(), 0);
    assertEquals(startCount(fake.calls), 1);
  });
});

test("a cluster primary whose hold could not be written stays stopped and is held again", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    let tries = 0;
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord(1)]),
      holdPrimary: () => {
        tries += 1;
        return tries === 1
          ? Promise.reject(new Error("disk full"))
          : Promise.resolve();
      },
    });
    await guard.tick();
    assertEquals(startCount(fake.calls), 0);
    await guard.tick();
    assertEquals(tries, 2);
    assertEquals(startCount(fake.calls), 0);
  });
});

test("an unreadable Docker listing never holds or starts a cluster primary", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const calls: string[][] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      return Promise.resolve({
        success: false,
        code: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
      });
    };
    const hold = countingHold();
    const guard = new ManagedEngineExitGuard({
      layout,
      run,
      listMembers: () => Promise.resolve([memberRecord(1)]),
      holdPrimary: hold.fn,
    });
    await guard.tick();
    assertEquals(hold.count(), 0);
    assertEquals(startCount(calls), 0);
  });
});

test("a command window that ends by the clock does not vouch for a stopped cluster primary", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    resetUnsettledBootHoldsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    // The window an earlier daemon run left after a finished apply.
    const token = await beginManagedIntent(
      layout.stateDir,
      MANAGED_ID,
      "apply",
    );
    await endManagedIntent(layout.stateDir, token, true);
    const fake = docker();
    const hold = countingHold();
    let now = Date.now();
    const guard = new ManagedEngineExitGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord(1)]),
      holdPrimary: hold.fn,
      nowMs: () => now,
    });
    await guard.tick();
    assertEquals(hold.count(), 0);
    assertEquals(startCount(fake.calls), 0);
    now += 24 * 60 * 60_000;
    await guard.tick();
    assertEquals(hold.count(), 1);
    assertEquals(startCount(fake.calls), 0);
  });
});

for (const engine of ["postgres", "mysql", "mariadb"] as const) {
  test(`a ${engine} cluster primary found stopped at daemon start is held, a lone one is started`, async () => {
    await withTempLayout(async ({ env }) => {
      resetManagedIntentsForTests();
      const layout = resolveLayout(env);
      await seedMember(layout);
      const fake = docker();
      const hold = countingHold();
      const guard = new ManagedEngineExitGuard({
        layout,
        run: fake.run,
        listMembers: () =>
          Promise.resolve([
            { ...memberRecord(2), engine },
          ]),
        holdPrimary: hold.fn,
      });
      await guard.tick();
      assertEquals(hold.count(), 1);
      assertEquals(startCount(fake.calls), 0);

      const lone = new ManagedEngineExitGuard({
        layout,
        run: fake.run,
        listMembers: () => Promise.resolve([{ ...memberRecord(0), engine }]),
        holdPrimary: hold.fn,
      });
      await lone.tick();
      assertEquals(hold.count(), 1);
      assertEquals(startCount(fake.calls), 1);
    });
  });
}
