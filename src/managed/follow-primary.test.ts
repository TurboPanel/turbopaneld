/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { followLocalStandby } from "./follow-primary.ts";

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
      runDocker: (args, options) => {
        if (args[0] === "compose" && args.includes("ps")) {
          return Promise.resolve(dockerOk(RUNNING_PS));
        }
        if (args[0] === "exec" && args.includes("psql")) {
          const sql = options?.input ?? "";
          sqlBodies.push(sql);
          if (sql.includes("current_setting")) {
            return Promise.resolve(dockerOk(
              "user=tp_repl password=s3cret host=10.100.0.5 port=45001\n",
            ));
          }
          return Promise.resolve(dockerOk());
        }
        return Promise.resolve(dockerOk());
      },
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
          sqlBodies.push(options?.input ?? "");
          return Promise.resolve(dockerOk());
        }
        return Promise.resolve(dockerOk());
      },
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
          sqlBodies.push(options?.input ?? "");
          return Promise.resolve(dockerOk());
        }
        return Promise.resolve(dockerOk());
      },
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
