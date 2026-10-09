import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  captureSwitchoverGtidBeforeStop,
  reactivatePrimaryAfterSwitchoverAbort,
} from "./lifecycle-switchover.ts";

const test = Deno.test.bind(Deno);

const RUNNING_MARIADB_PS = JSON.stringify([
  {
    ID: "maria1",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    Service: "mariadb",
    State: "running",
  },
]);

function dockerOk(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

test("captureSwitchoverGtidBeforeStop is a no-op without captureSwitchoverGtid", async () => {
  const out = await captureSwitchoverGtidBeforeStop(
    { managedId: "abc", action: "stop" },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
  assertEquals(out, undefined);
});

test("reactivatePrimaryAfterSwitchoverAbort is a no-op without the abort flag", async () => {
  await reactivatePrimaryAfterSwitchoverAbort(
    { managedId: "abc", action: "start" },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
});

test("captureSwitchoverGtidBeforeStop is a no-op for start even with captureSwitchoverGtid", async () => {
  const out = await captureSwitchoverGtidBeforeStop(
    {
      managedId: "abc",
      action: "start",
      captureSwitchoverGtid: true,
    },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
  assertEquals(out, undefined);
});

test("captureSwitchoverGtidBeforeStop rejects engines without quiesce support", async () => {
  await assertRejects(
    () =>
      captureSwitchoverGtidBeforeStop(
        {
          managedId: "managed_switchover_pg",
          action: "stop",
          captureSwitchoverGtid: true,
          engine: "postgres",
        },
        (args) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(
              dockerOk(
                JSON.stringify([
                  {
                    ID: "pg1",
                    Name: "pg-1",
                    Service: "postgres",
                    State: "running",
                  },
                ]),
              ),
            );
          }
          return Promise.resolve(dockerOk());
        },
        { ensureDocker: () => Promise.resolve() },
      ),
    Error,
    "captureSwitchoverGtid is not supported",
  );
});

test("reactivatePrimaryAfterSwitchoverAbort clears read_only on mariadb", async () => {
  let clearedReadOnly = false;
  await reactivatePrimaryAfterSwitchoverAbort(
    {
      managedId: "managed_switchover_maria",
      action: "start",
      reactivateAfterSwitchoverAbort: true,
      engine: "mariadb",
    },
    (args, options) => {
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve(dockerOk(RUNNING_MARIADB_PS));
      }
      if (args[0] === "exec") {
        const sql = String(options?.input ?? "");
        if (sql.includes("read_only") && sql.includes("OFF")) {
          clearedReadOnly = true;
        }
        if (args.includes("mariadb-admin")) {
          return Promise.resolve(dockerOk());
        }
        return Promise.resolve(dockerOk());
      }
      return Promise.resolve(dockerOk());
    },
    { ensureDocker: () => Promise.resolve() },
  );
  assertEquals(clearedReadOnly, true);
});
