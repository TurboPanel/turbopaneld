import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { proveSwitchoverGtidBeforePromote } from "./switchover-gtid-proof.ts";

const test = Deno.test.bind(Deno);

const MANAGED_ID = "managed_switchover_proof";
const RUNNING_MYSQL_PS = JSON.stringify([
  {
    ID: "mysql1",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    Service: "mysql",
    State: "running",
  },
]);

function dockerOk(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

test("proveSwitchoverGtidBeforePromote waits on WAIT_FOR_EXECUTED_GTID_SET for mysql", async () => {
  let sawWait = false;
  await proveSwitchoverGtidBeforePromote(
    {
      managedId: MANAGED_ID,
      engine: "mysql",
      requiredExecutedGtidSet: "uuid:1-50",
      gtidWaitTimeoutSeconds: 30,
    },
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: (args) => {
        if (args[0] === "compose" && args.includes("ps")) {
          return Promise.resolve(dockerOk(RUNNING_MYSQL_PS));
        }
        if (args[0] === "exec" && args.includes("mysql")) {
          const sql = args[args.indexOf("-e") + 1] ?? "";
          if (sql.includes("gtid_executed")) {
            return Promise.resolve(dockerOk("uuid:1-40\n"));
          }
          if (sql.includes("WAIT_FOR_EXECUTED_GTID_SET")) {
            sawWait = true;
            return Promise.resolve(dockerOk("0\n"));
          }
        }
        return Promise.resolve(dockerOk());
      },
    },
  );
  assertEquals(sawWait, true);
});

test("proveSwitchoverGtidBeforePromote rejects postgres engines", async () => {
  await assertRejects(
    () =>
      proveSwitchoverGtidBeforePromote({
        managedId: MANAGED_ID,
        engine: "postgres",
        requiredExecutedGtidSet: "0-1-1",
      }),
    Error,
    "only for MySQL-family",
  );
});
