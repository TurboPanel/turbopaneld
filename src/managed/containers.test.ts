import { assertEquals, assertThrows } from "@std/assert";
import type { EnvironmentDeployContainer } from "../instance/commands/contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  collectManagedContainers,
  collectManagedContainersForService,
  collectManagedMemberHealth,
  resolveEngineContainerId,
  resolveSoleEngineContainer,
} from "./containers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const UUID_SHAPED_NAME = "01936b3e-aaaa-bbbb-cccc-123456789abc-1";

function uuidNamedRunning(): EnvironmentDeployContainer[] {
  return [
    {
      composeServiceName: "postgres",
      containerId: "abc123def456",
      containerName: UUID_SHAPED_NAME,
      status: "running",
      role: "service",
    },
  ];
}

test("resolveEngineContainerId matches by Service when Name is UUID-shaped <uuid>-1", () => {
  const id = resolveEngineContainerId(uuidNamedRunning(), "postgres");
  assertEquals(id, "abc123def456");
});

test("resolveSoleEngineContainer ignores Name and returns the sole running engine", () => {
  const chosen = resolveSoleEngineContainer(uuidNamedRunning());
  assertEquals(chosen.containerId, "abc123def456");
  assertEquals(chosen.containerName, UUID_SHAPED_NAME);
  assertEquals(chosen.composeServiceName, "postgres");
});

test("resolveEngineContainerId still rejects non-running UUID-named containers", () => {
  assertThrows(
    () =>
      resolveEngineContainerId(
        [
          {
            composeServiceName: "postgres",
            containerId: "abc123def456",
            containerName: UUID_SHAPED_NAME,
            status: "exited",
            role: "service",
          },
        ],
        "postgres",
      ),
    Error,
    "not running",
  );
});

function dockerOk(stdout: string): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function dockerFail(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

test("collectManagedContainers parses array JSON and skips malformed rows", async () => {
  const stdout = JSON.stringify([
    {
      ID: "abc123",
      Name: UUID_SHAPED_NAME,
      Service: "postgres",
      State: "running",
    },
    { ID: "", Name: "bad", Service: "x", State: "running" },
  ]);
  const rows = await collectManagedContainers(
    "turbopanel-managed-test",
    (text) => text,
    () => Promise.resolve(dockerOk(stdout)),
  );
  assertEquals(rows?.length, 1);
  assertEquals(rows?.[0]?.containerId, "abc123");
  assertEquals(rows?.[0]?.composeServiceName, "postgres");
});

test("collectManagedContainers parses NDJSON compose ps output", async () => {
  const stdout = [
    JSON.stringify({
      ID: "row1",
      Name: "name-1",
      Service: "postgres",
      State: "running",
    }),
    JSON.stringify({
      ID: "row2",
      Name: "name-2",
      Service: "postgres",
      State: "exited",
    }),
  ].join("\n");
  const rows = await collectManagedContainers(
    "turbopanel-managed-ndjson",
    undefined,
    () => Promise.resolve(dockerOk(stdout)),
  );
  assertEquals(rows?.length, 2);
});

test("collectManagedContainers returns undefined when compose ps fails", async () => {
  const rows = await collectManagedContainers(
    "turbopanel-managed-fail",
    (text) => `redacted:${text}`,
    () => Promise.resolve(dockerFail("permission denied")),
  );
  assertEquals(rows, undefined);
});

test("collectManagedContainersForService stamps ingress role and serviceId", async () => {
  const serviceId = "00000000-0000-4000-8000-0000000000aa";
  const stdout = JSON.stringify([
    {
      ID: "abc123",
      Name: UUID_SHAPED_NAME,
      Service: "postgres",
      State: "running",
    },
  ]);
  const rows = await collectManagedContainersForService(
    "turbopanel-managed-ingress",
    serviceId,
    undefined,
    () => Promise.resolve(dockerOk(stdout)),
  );
  assertEquals(rows?.[0]?.serviceId, serviceId);
  assertEquals(rows?.[0]?.role, "ingress");
});

test("collectManagedMemberHealth returns containers without member when replication is absent", async () => {
  const stdout = JSON.stringify([
    {
      ID: "abc123",
      Name: UUID_SHAPED_NAME,
      Service: "postgres",
      State: "running",
    },
  ]);
  const result = await collectManagedMemberHealth(
    "turbopanel-managed-health",
    {
      rootUsername: "postgres",
      defaultDatabase: "postgres",
    },
    { memberId: "member-1", role: "primary" },
    () => Promise.resolve(dockerOk(stdout)),
  );
  assertEquals(result.containers?.length, 1);
  assertEquals(result.member, undefined);
});

test("collectManagedMemberHealth returns member replication when engine supports it", async () => {
  const stdout = JSON.stringify([
    {
      ID: "abc123",
      Name: UUID_SHAPED_NAME,
      Service: "postgres",
      State: "running",
    },
  ]);
  const observedAt = "2030-01-01T00:00:00.000Z";
  const result = await collectManagedMemberHealth(
    "turbopanel-managed-repl",
    {
      rootUsername: "postgres",
      defaultDatabase: "postgres",
      replication: {
        readHealth: () =>
          Promise.resolve({ state: "streaming", observedAt, lagBytes: 0 }),
      },
    },
    { memberId: "member-2", role: "replica" },
    (args) => {
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve(dockerOk(stdout));
      }
      return Promise.resolve(dockerOk("ok"));
    },
  );
  assertEquals(result.member?.memberId, "member-2");
  assertEquals(result.member?.role, "replica");
  assertEquals(result.member?.replication?.state, "streaming");
});

test("resolveSoleEngineContainer throws when no containers are present", () => {
  assertThrows(
    () => resolveSoleEngineContainer(undefined),
    Error,
    "not running",
  );
});
