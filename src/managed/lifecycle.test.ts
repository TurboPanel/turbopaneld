import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ManagedLifecyclePayload,
  parseManagedLifecycleResult,
} from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { isManagedMemberDemoted } from "./demoted-marker.ts";
import { handleManagedLifecycle } from "./lifecycle.ts";
import { managedDir } from "./engine-paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} so Sonar sees real tests.
 */
const test = Deno.test.bind(Deno);

const MEMBER_ID = "01936b3e-aaaa-bbbb-cccc-123456789abc";

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123",
    Name: `${MEMBER_ID}-1`,
    Service: "db",
    State: "running",
  },
]);

function composeYaml(image: string, target: string): string {
  return [
    "services:",
    "  db:",
    `    image: ${image}`,
    "    volumes:",
    "      - ./config/engine.conf:/etc/engine.conf:ro",
    `      - lifecycle_data:${target}`,
    "volumes:",
    "  lifecycle_data:",
    "    name: lifecycle_data",
    "",
  ].join("\n");
}

const POSTGRES_COMPOSE = composeYaml("postgres:18", "/var/lib/postgresql");
const MYSQL_COMPOSE = composeYaml("mysql:8.4", "/var/lib/mysql");

type Recorder = {
  calls: string[][];
  run: (args: string[]) => Promise<DockerCliResult>;
};

/** Fake docker: probes answer from `present`; compose ps reports running. */
function fakeDocker(present: Set<string>): Recorder {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push([...args]);
    let stdout = "";
    if (args[0] === "run") {
      const script = args.at(-1) ?? "";
      const path = script.split(" ")[2] ?? "";
      stdout = present.has(path) ? "present\n" : "absent\n";
    } else if (args[0] === "compose" && args.includes("ps")) {
      stdout = RUNNING_PS;
    }
    return Promise.resolve({ success: true, stdout, stderr: "", code: 0 });
  };
  return { calls, run };
}

function composeCalled(calls: string[][], action: string): boolean {
  return calls.some((args) => args[0] === "compose" && args.at(-1) === action);
}

function probeCalled(calls: string[][]): boolean {
  return calls.some((args) => args[0] === "run");
}

async function runLifecycle(
  compose: string | undefined,
  payload: Omit<ManagedLifecyclePayload, "managedId">,
  present: Set<string>,
) {
  const managedId = `managed_lifecycle_guard_${crypto.randomUUID()}`;
  let outcome:
    | { result: Awaited<ReturnType<typeof handleManagedLifecycle>> }
    | undefined;
  const docker = fakeDocker(present);
  await withTempLayout(async (fixture) => {
    const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
    for (const [key, value] of Object.entries(fixture.env)) {
      Deno.env.set(key, value);
    }
    try {
      const root = managedDir(
        { stateDir: fixture.dirs.stateDir } as Parameters<typeof managedDir>[0],
        managedId,
      );
      await Deno.mkdir(root, { recursive: true });
      if (compose !== undefined) {
        await Deno.writeTextFile(`${root}/docker-compose.yml`, compose);
      }
      const result = await handleManagedLifecycle(
        { managedId, ...payload },
        new Date().toISOString(),
        { runDocker: docker.run },
      );
      outcome = { result };
    } finally {
      if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
      else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    }
  });
  return { result: outcome!.result, calls: docker.calls };
}

const PG_DATA = "/var/lib/postgresql/data/PG_VERSION";
const PG_SIGNAL = "/var/lib/postgresql/data/standby.signal";
const MYSQL_DATA = "/var/lib/mysql/mysql";
const MYSQL_MARKER = "/var/lib/mysql/.turbopanel-standby";

for (const action of ["start", "restart"] as const) {
  test(`lifecycle ${action} refuses a postgres replica whose data has no standby.signal`, async () => {
    const { result, calls } = await runLifecycle(
      POSTGRES_COMPOSE,
      { action, memberId: MEMBER_ID, engine: "postgres", role: "replica" },
      new Set([PG_DATA]),
    );
    assertEquals(composeCalled(calls, action), false);
    assertEquals(composeCalled(calls, "stop"), true);
    assertEquals(result.status, "needs_resync");
    assertEquals(result.member?.status, "needs_resync");
    assertEquals(result.member?.role, "replica");
    assertEquals(result.member?.replication?.state, "needs_resync");
    // The control plane reads the result through the shared parser.
    const parsed = parseManagedLifecycleResult(
      JSON.parse(JSON.stringify(result)),
    );
    assertEquals(parsed.status, "needs_resync");
    assertEquals(parsed.member?.status, "needs_resync");
    assertEquals(parsed.member?.role, "replica");
    assertEquals(parsed.member?.replication?.state, "needs_resync");
  });
}

test("lifecycle start runs for a postgres replica that is still a standby", async () => {
  const { result, calls } = await runLifecycle(
    POSTGRES_COMPOSE,
    {
      action: "start",
      memberId: MEMBER_ID,
      engine: "postgres",
      role: "replica",
    },
    new Set([PG_DATA, PG_SIGNAL]),
  );
  assertEquals(composeCalled(calls, "start"), true);
  assertEquals(result.status, "ready");
});

test("lifecycle start runs for a postgres replica with an empty data volume", async () => {
  const { calls } = await runLifecycle(
    POSTGRES_COMPOSE,
    {
      action: "start",
      memberId: MEMBER_ID,
      engine: "postgres",
      role: "replica",
    },
    new Set(),
  );
  assertEquals(composeCalled(calls, "start"), true);
});

for (const role of ["primary", undefined] as const) {
  test(`lifecycle start skips the standby probe when role is ${role}`, async () => {
    const { result, calls } = await runLifecycle(
      POSTGRES_COMPOSE,
      {
        action: "start",
        memberId: MEMBER_ID,
        engine: "postgres",
        ...(role ? { role } : {}),
      },
      new Set([PG_DATA]),
    );
    assertEquals(probeCalled(calls), false);
    assertEquals(composeCalled(calls, "start"), true);
    assertEquals(result.status, "ready");
  });
}

test("lifecycle stop with demoted writes a marker; an ordinary stop does not", async () => {
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
      const layout = resolveLayout(fixture.env);
      const demotedId = `managed_lifecycle_demoted_${crypto.randomUUID()}`;
      const ordinaryId = `managed_lifecycle_ordinary_${crypto.randomUUID()}`;
      for (const id of [demotedId, ordinaryId]) {
        const root = managedDir(layout, id);
        await Deno.mkdir(root, { recursive: true });
        await Deno.writeTextFile(
          `${root}/docker-compose.yml`,
          POSTGRES_COMPOSE,
        );
      }
      const demotedDocker = fakeDocker(new Set());
      await handleManagedLifecycle(
        {
          managedId: demotedId,
          action: "stop",
          memberId: MEMBER_ID,
          demoted: true,
        },
        new Date().toISOString(),
        { runDocker: demotedDocker.run },
      );
      assertEquals(composeCalled(demotedDocker.calls, "stop"), true);
      assert(await isManagedMemberDemoted(layout, demotedId, MEMBER_ID));

      const ordinaryDocker = fakeDocker(new Set());
      await handleManagedLifecycle(
        {
          managedId: ordinaryId,
          action: "stop",
          memberId: MEMBER_ID,
        },
        new Date().toISOString(),
        { runDocker: ordinaryDocker.run },
      );
      assertEquals(composeCalled(ordinaryDocker.calls, "stop"), true);
      assertEquals(
        await isManagedMemberDemoted(layout, ordinaryId, MEMBER_ID),
        false,
      );
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});

test("lifecycle stop on a replica never probes", async () => {
  const { calls } = await runLifecycle(
    POSTGRES_COMPOSE,
    {
      action: "stop",
      memberId: MEMBER_ID,
      engine: "postgres",
      role: "replica",
    },
    new Set([PG_DATA]),
  );
  assertEquals(probeCalled(calls), false);
  assertEquals(composeCalled(calls, "stop"), true);
});

for (const engine of ["mysql", "mariadb"] as const) {
  test(`lifecycle start refuses a ${engine} replica whose data has no standby marker`, async () => {
    const { result, calls } = await runLifecycle(
      MYSQL_COMPOSE,
      { action: "start", memberId: MEMBER_ID, engine, role: "replica" },
      new Set([MYSQL_DATA]),
    );
    assertEquals(composeCalled(calls, "start"), false);
    assertEquals(composeCalled(calls, "stop"), true);
    assertEquals(result.status, "needs_resync");
  });

  test(`lifecycle start runs for a ${engine} replica carrying the standby marker`, async () => {
    const { calls } = await runLifecycle(
      MYSQL_COMPOSE,
      { action: "start", memberId: MEMBER_ID, engine, role: "replica" },
      new Set([MYSQL_DATA, MYSQL_MARKER]),
    );
    assertEquals(composeCalled(calls, "start"), true);
  });
}

test("lifecycle start of a replica fails closed without the compose file", async () => {
  await assertRejects(
    () =>
      runLifecycle(
        undefined,
        {
          action: "start",
          memberId: MEMBER_ID,
          engine: "postgres",
          role: "replica",
        },
        new Set(),
      ),
    Error,
    "standby",
  );
});
