import { assertEquals } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { ManagedEngineExitGuard } from "./engine-exit-guard.ts";
import { writeManagedDemotedMarker } from "./demoted-marker.ts";
import {
  recordManagedIntent,
  resetManagedIntentsForTests,
} from "./ha-intent.ts";
import { saveManagedHaMember } from "./ha-member.ts";

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

function memberRecord() {
  return {
    managedId: MANAGED_ID,
    memberId: MEMBER_ID,
    engine: "postgres" as const,
    role: "primary" as const,
    containerName: "db-1",
    replicaPeerCount: 1,
    peerCount: 1,
    updatedAt: "2026-10-08T12:00:00.000Z",
  };
}

function docker(psStdout = EXITED_PS) {
  const calls: string[][] = [];
  let stdout = psStdout;
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
