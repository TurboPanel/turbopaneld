/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  ensureLocalPrimarySlots,
  followLocalStandby,
} from "./follow-primary.ts";

const test = Deno.test.bind(Deno);

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123def456",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-2",
    Service: "postgres",
    State: "running",
  },
]);

function dockerOk(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

const MYSQL_HEALTHY = `
*************************** 1. row ***************************
             Replica_IO_Running: Yes
            Replica_SQL_Running: Yes
          Seconds_Behind_Source: 0
`;

function postgresFollowDocker(
  sqlBodies: string[],
  options?: { recovery?: string; healthStates?: string[] },
): (args: string[], options?: { input?: string }) => Promise<DockerCliResult> {
  const healthStates = options?.healthStates ?? ["streaming"];
  let healthIndex = 0;
  return (args, execOptions) => {
    if (args[0] === "compose" && args.includes("ps")) {
      return Promise.resolve(dockerOk(RUNNING_PS));
    }
    if (args[0] === "exec" && args.includes("psql")) {
      const sql = execOptions?.input ?? "";
      sqlBodies.push(sql);
      if (sql.includes("current_setting")) {
        return Promise.resolve(dockerOk(
          "user=tp_repl password=s3cret host=10.100.0.5 port=45001\n",
        ));
      }
      if (sql.includes("pg_stat_wal_receiver")) {
        const idx = Math.min(healthIndex, healthStates.length - 1);
        const state = healthStates[idx]!;
        healthIndex += 1;
        return Promise.resolve(dockerOk(`${state}\t0\t0\n`));
      }
      if (sql.includes("pg_is_in_recovery")) {
        return Promise.resolve(dockerOk(`${options?.recovery ?? "t"}\n`));
      }
      return Promise.resolve(dockerOk());
    }
    return Promise.resolve(dockerOk());
  };
}

test("followLocalStandby rewrites postgres primary_conninfo via exec", async () => {
  const sqlBodies: string[] = [];
  await followLocalStandby(
    {
      managedId: "00000000-0000-4000-8000-000000000001",
      engine: "postgres",
      primary: { host: "10.100.0.4", port: 45001 },
    },
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: postgresFollowDocker(sqlBodies),
      sleep: () => Promise.resolve(),
    },
  );
  const apply = sqlBodies.find((sql) => sql.includes("ALTER SYSTEM"));
  if (!apply) throw new TypeError("expected ALTER SYSTEM");
  assertEquals(apply.includes("host=10.100.0.4"), true);
});

test("followLocalStandby mysql path issues CHANGE SOURCE host only", async () => {
  const mysqlPs = JSON.stringify([
    {
      ID: "mysql123",
      Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-2",
      Service: "mysql",
      State: "running",
    },
  ]);
  const sqlBodies: string[] = [];
  await followLocalStandby(
    {
      managedId: "00000000-0000-4000-8000-000000000009",
      engine: "mysql",
      primary: { host: "10.100.0.4", port: 45001 },
    },
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: (args, options) => {
        if (args[0] === "compose" && args.includes("ps")) {
          return Promise.resolve(dockerOk(mysqlPs));
        }
        if (args[0] === "exec" && args.includes("mysql")) {
          if (args.includes("-E") || args.includes("-N")) {
            return Promise.resolve(dockerOk(MYSQL_HEALTHY));
          }
          sqlBodies.push(options?.input ?? "");
          return Promise.resolve(dockerOk());
        }
        return Promise.resolve(dockerOk());
      },
      sleep: () => Promise.resolve(),
    },
  );
  const sql = sqlBodies.join("\n");
  assertEquals(sql.includes("SOURCE_HOST = '10.100.0.4'"), true);
  assertEquals(sql.includes("SOURCE_PASSWORD"), false);
});

test("followLocalStandby mariadb path issues CHANGE MASTER host only", async () => {
  const mariadbPs = JSON.stringify([
    {
      ID: "maria123",
      Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-3",
      Service: "mariadb",
      State: "running",
    },
  ]);
  const sqlBodies: string[] = [];
  const mariaHealthy = `
*************************** 1. row ***************************
               Slave_IO_Running: Yes
              Slave_SQL_Running: Yes
        Seconds_Behind_Master: 0
`;
  await followLocalStandby(
    {
      managedId: "00000000-0000-4000-8000-00000000000a",
      engine: "mariadb",
      primary: { host: "10.100.0.4", port: 45001 },
    },
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: (args, options) => {
        if (args[0] === "compose" && args.includes("ps")) {
          return Promise.resolve(dockerOk(mariadbPs));
        }
        if (args[0] === "exec" && args.includes("mariadb")) {
          if (args.includes("-E") || args.includes("-N")) {
            return Promise.resolve(dockerOk(mariaHealthy));
          }
          sqlBodies.push(options?.input ?? "");
          return Promise.resolve(dockerOk());
        }
        return Promise.resolve(dockerOk());
      },
      sleep: () => Promise.resolve(),
    },
  );
  const sql = sqlBodies.join("\n");
  assertEquals(sql.includes("MASTER_HOST = '10.100.0.4'"), true);
  assertEquals(sql.includes("MASTER_PASSWORD"), false);
});

test("followLocalStandby rejects when no containers are running", async () => {
  await assertRejects(
    () =>
      followLocalStandby(
        {
          managedId: "00000000-0000-4000-8000-000000000001",
          primary: { host: "10.100.0.4", port: 45001 },
        },
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: () => Promise.resolve(dockerOk("[]")),
        },
      ),
    Error,
    "no running containers",
  );
});

test("followLocalStandby refuses to repoint a primary", async () => {
  const sqlBodies: string[] = [];
  await assertRejects(
    () =>
      followLocalStandby(
        {
          managedId: "00000000-0000-4000-8000-000000000001",
          engine: "postgres",
          primary: { host: "10.100.0.4", port: 45001 },
        },
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: postgresFollowDocker(sqlBodies, { recovery: "f" }),
        },
      ),
    Error,
    "refusing to repoint: this member is not a standby",
  );
  assertEquals(sqlBodies.some((sql) => sql.includes("ALTER SYSTEM")), false);
});

test("followLocalStandby waits until standby health is streaming", async () => {
  const sqlBodies: string[] = [];
  const slept: number[] = [];
  await followLocalStandby(
    {
      managedId: "00000000-0000-4000-8000-000000000001",
      engine: "postgres",
      primary: { host: "10.100.0.4", port: 45001 },
    },
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: postgresFollowDocker(sqlBodies, {
        healthStates: ["stopped", "streaming"],
      }),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    },
  );
  assertEquals(slept, [3000]);
});

test("followLocalStandby times out when standby never streams", async () => {
  await assertRejects(
    () =>
      followLocalStandby(
        {
          managedId: "00000000-0000-4000-8000-000000000001",
          engine: "postgres",
          primary: { host: "10.100.0.4", port: 45001 },
        },
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: postgresFollowDocker([], { healthStates: ["stopped"] }),
          sleep: () => Promise.resolve(),
          timeoutMs: 0,
        },
      ),
    Error,
    "standby did not reach streaming after repoint (last state: stopped)",
  );
});

test("ensureLocalPrimarySlots creates slots on a primary", async () => {
  const sqlBodies: string[] = [];
  await ensureLocalPrimarySlots(
    {
      managedId: "00000000-0000-4000-8000-000000000001",
      engine: "postgres",
      slots: ["tp_member_2", "tp_member_3"],
    },
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: postgresFollowDocker(sqlBodies, { recovery: "f" }),
    },
  );
  const create = sqlBodies.filter((sql) =>
    sql.includes("pg_create_physical_replication_slot")
  );
  assertEquals(create.length, 2);
});

test("ensureLocalPrimarySlots refuses a standby", async () => {
  const sqlBodies: string[] = [];
  await assertRejects(
    () =>
      ensureLocalPrimarySlots(
        {
          managedId: "00000000-0000-4000-8000-000000000001",
          engine: "postgres",
          slots: ["tp_member_2"],
        },
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: postgresFollowDocker(sqlBodies, { recovery: "t" }),
        },
      ),
    Error,
    "refusing to ensure slots: this member is a standby",
  );
  assertEquals(
    sqlBodies.some((sql) =>
      sql.includes("pg_create_physical_replication_slot")
    ),
    false,
  );
});
