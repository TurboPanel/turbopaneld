import { assertEquals } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  checkLocalMemberPromoted,
  decidePromotion,
} from "./promotion-check.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "managed_promotion_check";

function runningPs(service: string): string {
  return JSON.stringify([
    {
      ID: `${service}1`,
      Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
      Service: service,
      State: "running",
    },
  ]);
}

function dockerOk(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

/** Fake engine container: answers replica status and the read-only row. */
function fakeEngine(
  service: string,
  answers: { replicaStatus: string; readOnly: string },
) {
  const seen: string[] = [];
  return {
    seen,
    deps: {
      ensureDocker: () => Promise.resolve(),
      runDocker: (args: string[]) => {
        if (args[0] === "compose" && args.includes("ps")) {
          return Promise.resolve(dockerOk(runningPs(service)));
        }
        if (args[0] === "exec") {
          const sql = args[args.indexOf("-e") + 1] ?? "";
          seen.push(sql);
          if (/SHOW (REPLICA|SLAVE) STATUS/i.test(sql)) {
            return Promise.resolve(dockerOk(answers.replicaStatus));
          }
          if (sql.includes("read_only")) {
            return Promise.resolve(dockerOk(answers.readOnly));
          }
        }
        return Promise.resolve(dockerOk());
      },
    },
  };
}

test("decidePromotion: a member still replicating is not promoted", () => {
  assertEquals(decidePromotion(true, "0\t0"), {
    promoted: false,
    reason: "still a replica",
  });
});

test("decidePromotion: mysql needs read_only and super_read_only both off", () => {
  assertEquals(decidePromotion(false, "0\t0\n").promoted, true);
  assertEquals(decidePromotion(false, "OFF\tOFF").promoted, true);
  assertEquals(decidePromotion(false, "1\t1").promoted, false);
  assertEquals(decidePromotion(false, "1\t0").promoted, false);
  assertEquals(decidePromotion(false, "0\t1").promoted, false);
});

test("decidePromotion: mariadb read_only alone decides", () => {
  assertEquals(decidePromotion(false, "0").promoted, true);
  assertEquals(decidePromotion(false, "1").promoted, false);
});

test("decidePromotion: an unreadable answer counts as still read-only", () => {
  assertEquals(decidePromotion(false, ""), {
    promoted: false,
    reason: "still read-only (no answer)",
  });
  assertEquals(decidePromotion(false, "NO_LOCK").promoted, false);
});

test("decidePromotion: engines without a read-only flag only need to stop replicating", () => {
  assertEquals(decidePromotion(false, undefined).promoted, true);
});

test("checkLocalMemberPromoted: mysql replica still pointing at the old source is not promoted", async () => {
  const engine = fakeEngine("mysql", {
    replicaStatus: "Source_Host: 10.100.0.5\nReplica_IO_Running: Connecting\n",
    readOnly: "1\t1",
  });
  const check = await checkLocalMemberPromoted(
    { managedId: MANAGED_ID, engine: "mysql" },
    engine.deps,
  );
  assertEquals(check, { promoted: false, reason: "still a replica" });
});

test("checkLocalMemberPromoted: mysql with no replica status but read-only is not promoted", async () => {
  const engine = fakeEngine("mysql", { replicaStatus: "", readOnly: "1\t1" });
  const check = await checkLocalMemberPromoted(
    { managedId: MANAGED_ID, engine: "mysql" },
    engine.deps,
  );
  assertEquals(check.promoted, false);
  assertEquals(
    engine.seen.some((sql) => sql.includes("super_read_only")),
    true,
  );
});

test("checkLocalMemberPromoted: writable mysql primary is promoted", async () => {
  const engine = fakeEngine("mysql", { replicaStatus: "", readOnly: "0\t0" });
  const check = await checkLocalMemberPromoted(
    { managedId: MANAGED_ID, engine: "mysql" },
    engine.deps,
  );
  assertEquals(check, { promoted: true });
});

test("checkLocalMemberPromoted: mariadb reads read_only and SHOW SLAVE STATUS", async () => {
  const promoted = fakeEngine("mariadb", { replicaStatus: "", readOnly: "0" });
  assertEquals(
    await checkLocalMemberPromoted(
      { managedId: MANAGED_ID, engine: "mariadb" },
      promoted.deps,
    ),
    { promoted: true },
  );
  assertEquals(promoted.seen.some((sql) => /SLAVE STATUS/.test(sql)), true);

  const readOnly = fakeEngine("mariadb", { replicaStatus: "", readOnly: "1" });
  assertEquals(
    (await checkLocalMemberPromoted(
      { managedId: MANAGED_ID, engine: "mariadb" },
      readOnly.deps,
    )).promoted,
    false,
  );
});
