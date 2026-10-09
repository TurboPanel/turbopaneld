import { assertEquals, assertRejects } from "@std/assert";
import {
  assertBoundedSwitchoverGtidSet,
  gtidWaitTimedOutMessage,
  parseGtidWaitScalar,
  quiesceAndReadPrimaryGtid,
  waitForRequiredGtidSet,
} from "./switchover-gtid.ts";
import { masterGtidWaitSql } from "./mariadb-sql.ts";

const test = Deno.test.bind(Deno);

test("parseGtidWaitScalar reads MASTER_GTID_WAIT result codes", () => {
  assertEquals(parseGtidWaitScalar("0"), "0");
  assertEquals(parseGtidWaitScalar("1\n"), "1");
  assertEquals(parseGtidWaitScalar("NULL"), null);
});

test("waitForRequiredGtidSet succeeds on zero", async () => {
  await waitForRequiredGtidSet(
    (sql) => {
      assertEquals(sql.includes("MASTER_GTID_WAIT"), true);
      return Promise.resolve("0");
    },
    masterGtidWaitSql,
    "0-1-10",
    30,
  );
});

test("waitForRequiredGtidSet throws on timeout", async () => {
  let message = "";
  try {
    await waitForRequiredGtidSet(
      () => Promise.resolve("1"),
      masterGtidWaitSql,
      "0-1-10",
      5,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assertEquals(message, gtidWaitTimedOutMessage(5));
});

test("quiesceAndReadPrimaryGtid enforces read-only then returns bounded GTID", async () => {
  let enforced = false;
  const gtid = await quiesceAndReadPrimaryGtid(
    () => {
      enforced = true;
      return Promise.resolve();
    },
    () => Promise.resolve("0-1-99"),
  );
  assertEquals(enforced, true);
  assertEquals(gtid, "0-1-99");
});

test("assertBoundedSwitchoverGtidSet rejects empty input", () => {
  let threw = false;
  try {
    assertBoundedSwitchoverGtidSet("");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

test("waitForRequiredGtidSet throws when the wait returns an unexpected code", async () => {
  await assertRejects(
    () =>
      waitForRequiredGtidSet(
        () => Promise.resolve("NULL"),
        masterGtidWaitSql,
        "0-1-10",
        10,
      ),
    Error,
    "switchover gtid wait failed",
  );
});

test("quiesceAndReadPrimaryGtid fails when GTID read is empty", async () => {
  await assertRejects(
    () =>
      quiesceAndReadPrimaryGtid(
        () => Promise.resolve(),
        () => Promise.resolve(""),
      ),
    Error,
    "could not read primary GTID position",
  );
});
