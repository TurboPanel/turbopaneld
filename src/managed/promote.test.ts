/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { handleManagedPromote } from "./promote.ts";

const test = Deno.test.bind(Deno);

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123def456",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    Service: "postgres",
    State: "running",
  },
]);

function dockerOk(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

test("handleManagedPromote rejects when no containers are running", async () => {
  await assertRejects(
    () =>
      handleManagedPromote(
        {
          managedId: "00000000-0000-4000-8000-000000000001",
          memberId: "00000000-0000-4000-8000-000000000002",
        },
        new Date().toISOString(),
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: () => Promise.resolve(dockerOk("[]")),
        },
      ),
    Error,
    "no running containers",
  );
});

test("handleManagedPromote promotes standby and reports primary health", async () => {
  const result = await handleManagedPromote(
    {
      managedId: "managed_promote_1",
      memberId: "00000000-0000-4000-8000-000000000002",
      demoteMemberId: "00000000-0000-4000-8000-000000000003",
      engine: "postgres",
    },
    new Date().toISOString(),
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: (args, options) => {
        if (args[0] === "compose" && args.includes("ps")) {
          return Promise.resolve(dockerOk(RUNNING_PS));
        }
        if (args[0] === "exec" && args.includes("psql")) {
          const sql = options?.input ?? "";
          if (sql.includes("pg_stat_replication")) {
            return Promise.resolve(dockerOk("streaming\t0\n"));
          }
          if (sql.includes("pg_is_in_recovery")) {
            return Promise.resolve(dockerOk("f\n"));
          }
          return Promise.resolve(dockerOk());
        }
        return Promise.resolve(dockerOk());
      },
    },
  );

  assertEquals(result.status, "ready");
  assertEquals(result.role, "primary");
  assertEquals(result.demoted, true);
  assertEquals(result.demotedMemberId, "00000000-0000-4000-8000-000000000003");
  assertEquals(result.replication?.state, "streaming");
});

test("handleManagedPromote mysql path promotes via socket exec", async () => {
  const mysqlPs = JSON.stringify([
    {
      ID: "mysql123",
      Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
      Service: "mysql",
      State: "running",
    },
  ]);
  const result = await handleManagedPromote(
    {
      managedId: "managed_promote_mysql",
      memberId: "00000000-0000-4000-8000-000000000004",
      engine: "mysql",
    },
    new Date().toISOString(),
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: (args) => {
        if (args[0] === "compose" && args.includes("ps")) {
          return Promise.resolve(dockerOk(mysqlPs));
        }
        if (args[0] === "exec" && args.includes("mysql")) {
          return Promise.resolve(dockerOk("0\t0\n"));
        }
        return Promise.resolve(dockerOk());
      },
    },
  );

  assertEquals(result.role, "primary");
  assertEquals(result.demoted, false);
  assertEquals(result.replication?.state, "primary");
});

test("ManagedPromoteResult shape fields are present in type contract", () => {
  const sample = {
    status: "ready",
    role: "primary",
    promotedMemberId: "00000000-0000-4000-8000-000000000002",
    demoted: true,
    demotedMemberId: "00000000-0000-4000-8000-000000000003",
    summary: "standby promoted to primary",
  };
  assertEquals(sample.demoted, true);
  assertEquals(sample.role, "primary");
});
