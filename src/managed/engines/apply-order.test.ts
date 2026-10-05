/**
 * Managed-engine apply steps run one at a time, in order, and stop at the
 * first failure — the ordering the sequential helper must keep.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type {
  ManagedEngineContext,
  ManagedEngineExec,
  ManagedEngineRuntime,
} from "./types.ts";

const test = Deno.test.bind(Deno);

/** Fails the exec whose input contains `failOn`; records every input in order. */
function failingContext(failOn: string): {
  ctx: ManagedEngineContext;
  inputs: string[];
  maxInFlight: () => number;
} {
  const inputs: string[] = [];
  let inFlight = 0;
  let max = 0;
  const exec: ManagedEngineExec = async (_argv, input) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await Promise.resolve();
    inputs.push(input ?? "");
    inFlight -= 1;
    const fail = (input ?? "").includes(failOn);
    return { success: !fail, stdout: "", stderr: fail ? "boom" : "" };
  };
  return {
    ctx: {
      containerId: "c1",
      composeServiceName: "svc",
      rootUsername: "root",
      defaultDatabase: "appdb",
      exec,
    },
    inputs,
    maxInFlight: () => max,
  };
}

const engines: Array<[string, ManagedEngineRuntime]> = [
  ["mariadb", mariadbManagedEngineRuntime],
  ["mysql", mysqlManagedEngineRuntime],
  ["postgres", postgresManagedEngineRuntime],
];

// Postgres releases each role's objects before DROP ROLE (extra statements per
// user); its ordering is covered in postgres.test.ts.
for (
  const [name, engine] of engines.filter(([engineName]) =>
    engineName !== "postgres"
  )
) {
  test(`${name} dropUsers runs in order and stops at the first failure`, async () => {
    const { ctx, inputs, maxInFlight } = failingContext("user_b");
    await assertRejects(() =>
      engine.dropUsers!(ctx, ["user_a", "user_b", "user_c"])
    );
    assertEquals(inputs.length, 2);
    assertEquals(inputs[0]!.includes("user_a"), true);
    assertEquals(inputs[1]!.includes("user_b"), true);
    assertEquals(maxInFlight(), 1);
  });
}

test("postgres dropUsers handles users in order and stops at the first failure", async () => {
  // Per user: list databases (empty here, role "absent"), then DROP ROLE.
  const { ctx, inputs, maxInFlight } = failingContext("user_b");
  await assertRejects(() =>
    postgresManagedEngineRuntime.dropUsers!(ctx, [
      "user_a",
      "user_b",
      "user_c",
    ])
  );
  assertEquals(inputs.length, 3);
  assertEquals(inputs[0]!.includes("user_a"), true);
  assertEquals(inputs[1]!.includes("DROP ROLE"), true);
  assertEquals(inputs[2]!.includes("user_b"), true);
  assertEquals(inputs.some((input) => input.includes("user_c")), false);
  assertEquals(maxInFlight(), 1);
});

for (const [name, engine] of engines) {
  test(`${name} applyDatabases runs in order and stops at the first failure`, async () => {
    const { ctx, inputs, maxInFlight } = failingContext("db_b");
    await assertRejects(() =>
      engine.applyDatabases!(ctx, [
        { name: "db_a", action: "drop" },
        { name: "db_b", action: "drop" },
        { name: "db_c", action: "drop" },
      ])
    );
    assertEquals(inputs.length, 2);
    assertEquals(inputs[0]!.includes("db_a"), true);
    assertEquals(maxInFlight(), 1);
  });
}

for (const [name, engine] of engines) {
  test(`${name} applyCredentials grants database by database and stops at the first failure`, async () => {
    const { ctx, inputs, maxInFlight } = failingContext("db_b");
    await assertRejects(() =>
      engine.applyCredentials(ctx, [{
        principalId: "p1",
        username: "app_user",
        password: ["pw", crypto.randomUUID()].join("-"),
        role: "user",
        databases: ["db_a", "db_b", "db_c"],
        privileges: ["read-write"],
      } as ManagedApplyCredential])
    );
    const grants = inputs.filter((input) => /GRANT/i.test(input));
    assertEquals(grants.length, 2);
    assertEquals(grants[0]!.includes("db_a"), true);
    assertEquals(grants[1]!.includes("db_b"), true);
    assertEquals(maxInFlight(), 1);
  });
}
