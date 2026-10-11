import { assert, assertEquals } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { writeManagedDestroyedMarker } from "./destroyed-marker.ts";
import { DemotedMemberGuard } from "./demoted-guard.ts";
import {
  readManagedDemotedMarker,
  writeManagedDemotedMarker,
} from "./demoted-marker.ts";
import {
  lookupManagedIntent,
  resetManagedIntentsForTests,
} from "./ha-intent.ts";
import { saveManagedHaMember } from "./ha-member.ts";
import { withManagedLifecycleLock } from "./target-lock.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123",
    Name: "db-1",
    Service: "db",
    State: "running",
  },
]);

const POSTGRES_COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:18",
  "    volumes:",
  "      - guard_data:/var/lib/postgresql",
  "volumes:",
  "  guard_data:",
  "    name: guard_data",
  "",
].join("\n");

function memberRecord(managedId = MANAGED_ID) {
  return {
    managedId,
    memberId: MEMBER_ID,
    engine: "postgres" as const,
    role: "primary" as const,
    containerName: "db-1",
    replicaPeerCount: 1,
    peerCount: 1,
    updatedAt: "2026-10-08T12:00:00.000Z",
  };
}

type DockerFakeOptions = {
  psStdout?: string;
  /** Simulated `SELECT NOT pg_is_in_recovery()` row; default still writable. */
  writablePrimary?: boolean;
  stopFails?: boolean;
  psFails?: boolean;
  /** Every `docker ps` / `compose ps` listing fails. */
  allListingsFail?: boolean;
  /** Helper containers (fence plant / probe) fail. */
  runFails?: boolean;
  /** Writable answers for the first N probes, read-only after. */
  writableProbes?: number;
};

function docker(psStdoutOrOpts: string | DockerFakeOptions = RUNNING_PS) {
  const opts: DockerFakeOptions = typeof psStdoutOrOpts === "string"
    ? { psStdout: psStdoutOrOpts }
    : psStdoutOrOpts;
  const calls: string[][] = [];
  let stdout = opts.psStdout ?? RUNNING_PS;
  let composeStopSucceeded = false;
  const writablePrimary = opts.writablePrimary ?? true;
  let probes = 0;
  const fail = (stderr: string): Promise<DockerCliResult> =>
    Promise.resolve({ success: false, code: 1, stdout: "", stderr });
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    const listing = args[0] === "ps" ||
      (args[0] === "compose" && args.includes("ps"));
    if (opts.allListingsFail && listing) return fail("daemon busy");
    if (opts.runFails && args[0] === "run") return fail("helper failed");
    if (args[0] === "compose" && args.includes("ps")) {
      if (opts.psFails) {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "ps failed",
        });
      }
      return Promise.resolve({
        success: true,
        code: 0,
        stdout,
        stderr: "",
      });
    }
    if (args[0] === "compose" && args.at(-1) === "stop") {
      if (opts.stopFails) {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "stop failed",
        });
      }
      composeStopSucceeded = true;
      stdout = "[]";
    }
    if (args[0] === "ps" && args.includes("-aq")) {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "abc123def456\n",
        stderr: "",
      });
    }
    if (args[0] === "stop" && args.length > 1) {
      if (opts.stopFails) {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "docker stop failed",
        });
      }
      stdout = "[]";
    }
    if (args[0] === "kill" && !opts.stopFails) {
      stdout = "[]";
    }
    if (args[0] === "exec") {
      const joined = args.join(" ");
      const mysqlFamily = joined.includes("mysql") ||
        joined.includes("mariadb");
      probes++;
      const probeWritable = opts.writableProbes === undefined
        ? writablePrimary
        : probes <= opts.writableProbes;
      const stillWritable = composeStopSucceeded ? false : probeWritable;
      const stdout = mysqlFamily
        ? (stillWritable ? "0\t0\n" : "1\t1\n")
        : (stillWritable ? "t\n" : "f\n");
      return Promise.resolve({
        success: true,
        code: 0,
        stdout,
        stderr: "",
      });
    }
    return Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });
  };
  return { run, calls };
}

async function seedMember(
  layout: ReturnType<typeof resolveLayout>,
  managedId = MANAGED_ID,
): Promise<void> {
  const root = `${layout.stateDir}/managed/${managedId}`;
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(`${root}/docker-compose.yml`, POSTGRES_COMPOSE);
  await saveManagedHaMember(layout, memberRecord(managedId));
}

test("a running demoted member is stopped once and a held intent is written first", async () => {
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
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    const stopAt = fake.calls.findIndex((args) =>
      args[0] === "compose" && args.at(-1) === "stop"
    );
    assert(stopAt > 0);
    assertEquals(fake.calls[stopAt], ["compose", "-p", MANAGED_ID, "stop"]);
    const psBeforeStop = fake.calls.slice(0, stopAt).some((args) =>
      args[0] === "compose" && args.includes("ps")
    );
    assert(psBeforeStop);
    const marker = await lookupManagedIntent(layout.stateDir, MANAGED_ID);
    assert(marker.status === "found" && marker.intent.kind === "stop");
    assertEquals(marker.intent.untilMs, null);
    assertEquals(marker.intent.maxUntilMs, null);
    await guard.tick();
    const composeStops = fake.calls.filter((args) =>
      args[0] === "compose" && args.at(-1) === "stop"
    );
    assertEquals(composeStops.length, 1);
  });
});

test("a member without a demoted marker is not stopped", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await seedMember(layout);
    const fake = docker();
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), false);
  });
});

test("a destroyed member is not stopped even with a demoted marker", async () => {
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
    await writeManagedDestroyedMarker(
      layout.stateDir,
      MANAGED_ID,
      MEMBER_ID,
      new Date().toISOString(),
    );
    const fake = docker();
    const guard = new DemotedMemberGuard({ layout, run: fake.run });
    await guard.tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), false);
  });
});

test("a member under the lifecycle lock is skipped until the lock is free", async () => {
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
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await withManagedLifecycleLock(layout, MANAGED_ID, async () => {
      await guard.tick();
      assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), false);
    });
    await guard.tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), true);
  });
});

test("a read-only demoted member is not stopped again", async () => {
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
    const fake = docker({ writablePrimary: false });
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), false);
  });
});

test("start and stop wire the interval without throwing", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const fake = docker("[]");
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([]),
      intervalMs: 60_000,
    });
    guard.start();
    guard.stop();
    await guard.tick();
  });
});

test("docker ps -aq listing failure is retried before force stop", async () => {
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
    let psAqCalls = 0;
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "ps" && args.includes("-aq")) {
        psAqCalls++;
        if (psAqCalls === 1) {
          return Promise.resolve({
            success: false,
            code: 1,
            stdout: "",
            stderr: "ps failed",
          });
        }
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "abc123def456\n",
          stderr: "",
        });
      }
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: RUNNING_PS,
          stderr: "",
        });
      }
      if (args[0] === "compose" && args.at(-1) === "stop") {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "stop failed",
        });
      }
      if (args[0] === "stop" || args[0] === "kill") {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      }
      if (args[0] === "exec") {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "t\n",
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
    const calls: string[][] = [];
    const trackedRun = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      return run(args);
    };
    const guard = new DemotedMemberGuard({
      layout,
      run: trackedRun,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(psAqCalls >= 2, true);
    assert(calls.some((args) => args[0] === "stop" && args.length > 1));
  });
});

test("compose stop failure escalates to docker stop then kill and retries on the next tick", async () => {
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
    const fake = docker({ stopFails: true });
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    const composeStopsAfterFirstTick = fake.calls.filter((args) =>
      args[0] === "compose" && args.at(-1) === "stop"
    ).length;
    assert(composeStopsAfterFirstTick >= 1);
    assert(fake.calls.some((args) =>
      args[0] === "stop" && args.length > 1
    ));
    assert(fake.calls.some((args) => args[0] === "kill"));
    await guard.tick();
    assert(
      fake.calls.filter((args) =>
        args[0] === "compose" && args.at(-1) === "stop"
      ).length > composeStopsAfterFirstTick,
    );
  });
});

test("the guard discovers demoted clusters from markers without an injected member list", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${layout.stateDir}/managed/${MANAGED_ID}/docker-compose.yml`,
      [
        "services:",
        "  db:",
        "    image: postgres:18",
        "    volumes:",
        "      - guard_data:/var/lib/postgresql",
        "volumes:",
        "  guard_data:",
        "    name: guard_data",
        "",
      ].join("\n"),
    );
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "postgres",
    );
    const fake = docker();
    const guard = new DemotedMemberGuard({ layout, run: fake.run });
    await guard.tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), true);
  });
});

test("compose ps failure still enforces a demoted member (fail closed)", async () => {
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
    const fake = docker({ psFails: true });
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), true);
  });
});

const MYSQL_COMPOSE = [
  "services:",
  "  db:",
  "    image: mysql:8.4",
  "    volumes:",
  "      - guard_data:/var/lib/mysql",
  "volumes:",
  "  guard_data:",
  "    name: guard_data",
  "",
].join("\n");

async function assertGuardStopsHandStartedDemotedPrimary(
  engine: "mysql" | "mariadb",
): Promise<void> {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    const managedId = `managed_guard_${engine}_${crypto.randomUUID()}`;
    await Deno.mkdir(`${layout.stateDir}/managed/${managedId}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${layout.stateDir}/managed/${managedId}/docker-compose.yml`,
      MYSQL_COMPOSE.replace(
        "mysql:8.4",
        engine === "mariadb" ? "mariadb:11" : "mysql:8.4",
      ),
    );
    await saveManagedHaMember(layout, {
      ...memberRecord(managedId),
      engine,
    });
    await writeManagedDemotedMarker(
      layout,
      managedId,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      engine,
    );
    const fake = docker();
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () =>
        Promise.resolve([{ ...memberRecord(managedId), engine }]),
    });
    await guard.tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), true);
  });
}

test("guard tick stops a hand-started demoted mysql primary", () =>
  assertGuardStopsHandStartedDemotedPrimary("mysql"));
test("guard tick stops a hand-started demoted mariadb primary", () =>
  assertGuardStopsHandStartedDemotedPrimary("mariadb"));

test("docker ps -aq listing failure still attempts docker stop via label fallback", async () => {
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
    let psAqCalls = 0;
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "ps" && args.includes("-aq")) {
        psAqCalls++;
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "ps failed",
        });
      }
      if (args[0] === "ps" && args.includes("-q")) {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "abc123def456\n",
          stderr: "",
        });
      }
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: RUNNING_PS,
          stderr: "",
        });
      }
      if (args[0] === "compose" && args.at(-1) === "stop") {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "stop failed",
        });
      }
      if (args[0] === "stop" || args[0] === "kill") {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      }
      if (args[0] === "exec") {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "t\n",
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
    const calls: string[][] = [];
    const trackedRun = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      return run(args);
    };
    const guard = new DemotedMemberGuard({
      layout,
      run: trackedRun,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    assert(psAqCalls >= 2);
    assert(calls.some((args) => args[0] === "stop" && args.length > 1));
  });
});

test("a writable demoted primary records unsafe on the marker after stop passes", async () => {
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
    const fake = docker({ writablePrimary: true, stopFails: true });
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () => Promise.resolve([memberRecord()]),
    });
    await guard.tick();
    const marker = await readManagedDemotedMarker(layout, MANAGED_ID);
    assert(marker?.unsafe === true);
    assert(marker?.unsafeReason?.includes("writable"));
  });
});

test("a stopped demoted member is left alone", async () => {
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
    const fake = docker({ psStdout: "[]", writablePrimary: false });
    const guard = new DemotedMemberGuard({
      layout,
      run: fake.run,
      listMembers: () =>
        Promise.resolve([memberRecord(), memberRecord(OTHER_ID)]),
    });
    await guard.tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), false);
  });
});

async function demotedGuardFixture(
  layout: ReturnType<typeof resolveLayout>,
  markerMemberId = MEMBER_ID,
  engine: "postgres" | "mysql" = "postgres",
): Promise<void> {
  await seedMember(layout);
  if (engine === "mysql") {
    await Deno.writeTextFile(
      `${layout.stateDir}/managed/${MANAGED_ID}/docker-compose.yml`,
      MYSQL_COMPOSE,
    );
  }
  await writeManagedDemotedMarker(
    layout,
    MANAGED_ID,
    markerMemberId,
    "2026-10-08T12:00:00.000Z",
    engine,
  );
}

function guardFor(
  layout: ReturnType<typeof resolveLayout>,
  run: (args: string[]) => Promise<DockerCliResult>,
  engine: "postgres" | "mysql" = "postgres",
): DemotedMemberGuard {
  return new DemotedMemberGuard({
    layout,
    run,
    listMembers: () => Promise.resolve([{ ...memberRecord(), engine }]),
  });
}

function countCalls(calls: string[][], match: (args: string[]) => boolean) {
  return calls.filter(match).length;
}

const isComposeKill = (args: string[]) =>
  args[0] === "compose" && args.at(-1) === "kill";

test("every container listing failing still kills by project and stops by name", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await demotedGuardFixture(layout);
    const fake = docker({ allListingsFail: true, stopFails: true });
    await guardFor(layout, fake.run).tick();
    assert(countCalls(fake.calls, isComposeKill) > 0);
    const names = ["db-1", `${MANAGED_ID}-db-1`];
    assert(
      fake.calls.some((args) =>
        args[0] === "stop" && names.every((name) => args.includes(name))
      ),
    );
    assert(
      fake.calls.some((args) =>
        args[0] === "kill" && names.every((name) => args.includes(name))
      ),
    );
  });
});

test("a failing on-disk fence plant never skips the stop", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await demotedGuardFixture(layout);
    const fake = docker({ runFails: true });
    await guardFor(layout, fake.run).tick();
    assert(fake.calls.some((args) => args[0] === "run"));
    assert(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "stop"
      ),
    );
    const marker = await readManagedDemotedMarker(layout, MANAGED_ID);
    assert(marker?.enforceReadOnlyLastError?.includes("helper failed"));
  });
});

test("a writable demoted mysql primary is stopped even after SQL enforce made it read-only", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await demotedGuardFixture(layout, MEMBER_ID, "mysql");
    // First probe writable; enforce then answers read-only from then on.
    const fake = docker({ writableProbes: 1 });
    await guardFor(layout, fake.run, "mysql").tick();
    assert(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "stop"
      ),
    );
  });
});

test("a read-only demoted mysql engine is left running", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await demotedGuardFixture(layout, MEMBER_ID, "mysql");
    const fake = docker({ writablePrimary: false });
    await guardFor(layout, fake.run, "mysql").tick();
    assertEquals(fake.calls.some((args) => args.at(-1) === "stop"), false);
  });
});

test("a marker with an empty member id fences a member record with a real id", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await demotedGuardFixture(layout, "");
    const fake = docker();
    // Discovery path: ha-member.json names MEMBER_ID, the marker names "".
    await new DemotedMemberGuard({ layout, run: fake.run }).tick();
    assert(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "stop"
      ),
    );
  });
});

test("a demoted primary that stays writable escalates with kill on every tick", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await demotedGuardFixture(layout);
    const fake = docker({ stopFails: true });
    const guard = guardFor(layout, fake.run);
    await guard.tick();
    const afterFirst = countCalls(fake.calls, isComposeKill);
    assert(afterFirst > 0);
    assert(fake.calls.some((args) => args[0] === "kill"));
    await guard.tick();
    assert(countCalls(fake.calls, isComposeKill) > afterFirst);
    assert((await readManagedDemotedMarker(layout, MANAGED_ID))?.unsafe);
  });
});

test("an unwritable marker directory never skips the stop or the kill", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await demotedGuardFixture(layout);
    const dir = `${layout.stateDir}/managed/${MANAGED_ID}`;
    const fake = docker({ stopFails: true });
    await Deno.chmod(dir, 0o555);
    try {
      await guardFor(layout, fake.run).tick();
    } finally {
      await Deno.chmod(dir, 0o755);
    }
    assert(
      fake.calls.some((args) =>
        args[0] === "compose" && args.at(-1) === "stop"
      ),
    );
    assert(countCalls(fake.calls, isComposeKill) > 0);
  });
});

test("a docker call that throws neither skips the kill nor the next member", async () => {
  await withTempLayout(async ({ env }) => {
    resetManagedIntentsForTests();
    const layout = resolveLayout(env);
    await demotedGuardFixture(layout);
    await seedMember(layout, OTHER_ID);
    await writeManagedDemotedMarker(
      layout,
      OTHER_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "postgres",
    );
    const fake = docker();
    const calls: string[][] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      if (args[0] === "compose" && args.at(-1) === "stop") {
        return Promise.reject(new Error("docker socket vanished"));
      }
      return fake.run(args);
    };
    await new DemotedMemberGuard({
      layout,
      run,
      listMembers: () =>
        Promise.resolve([memberRecord(), memberRecord(OTHER_ID)]),
    }).tick();
    assert(
      calls.some((args) => isComposeKill(args) && args.includes(MANAGED_ID)),
    );
    // The shared fake now reports nothing running, but the second member was
    // still checked after the first one's docker call threw.
    assert(
      calls.some((args) =>
        args[0] === "compose" && args.includes("ps") && args.includes(OTHER_ID)
      ),
    );
  });
});
