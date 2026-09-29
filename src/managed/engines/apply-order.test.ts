/**
 * Managed-engine apply steps run one at a time, in order, and stop at the
 * first failure — the ordering the sequential helper must keep.
 */

import { assertEquals, assertRejects } from "@std/assert";
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

for (const [name, engine] of engines) {
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
