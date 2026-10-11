import { assertEquals, assertRejects } from "@std/assert";
import {
  assertBoundedSwitchoverGtidSet,
  filterGtidSetForSwitchoverWait,
  gtidWaitTimedOutMessage,
  parseGtidWaitScalar,
  quiesceAndReadPrimaryGtid,
  waitForRequiredGtidSet,
} from "./switchover-gtid.ts";
import { switchoverPromoteErrorMessage } from "./switchover-promote-error.ts";
import { masterGtidWaitSql } from "./mariadb-sql.ts";

const test = Deno.test.bind(Deno);

test("parseGtidWaitScalar reads GTID wait result codes", () => {
  assertEquals(parseGtidWaitScalar("0"), "0");
  assertEquals(parseGtidWaitScalar("1\n"), "1");
  assertEquals(parseGtidWaitScalar("-1"), "-1");
  assertEquals(parseGtidWaitScalar("NULL"), null);
});

test("filterGtidSetForSwitchoverWait drops errant domains the target never received", () => {
  assertEquals(
    filterGtidSetForSwitchoverWait("0-1-50,2-2-1", "0-1-49"),
    "0-1-50",
  );
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
    "mariadb",
  );
});

test("waitForRequiredGtidSet throws gtid_wait_timeout on MariaDB -1", async () => {
  let message = "";
  try {
    await waitForRequiredGtidSet(
      () => Promise.resolve("-1"),
      masterGtidWaitSql,
      "0-1-10",
      5,
      "mariadb",
    );
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assertEquals(
    message,
    switchoverPromoteErrorMessage(
      "gtid_wait_timeout",
      gtidWaitTimedOutMessage(5),
    ),
  );
});

test("waitForRequiredGtidSet throws gtid_wait_timeout on MySQL 1", async () => {
  await assertRejects(
    () =>
      waitForRequiredGtidSet(
        () => Promise.resolve("1"),
        masterGtidWaitSql,
        "0-1-10",
        5,
        "mysql",
      ),
    Error,
    switchoverPromoteErrorMessage(
      "gtid_wait_timeout",
      gtidWaitTimedOutMessage(5),
    ),
  );
});

test("quiesceAndReadPrimaryGtid restores writable when GTID read fails", async () => {
  let restored = false;
  await assertRejects(
    () =>
      quiesceAndReadPrimaryGtid(
        () => Promise.resolve(),
        () => Promise.resolve(""),
        () => {
          restored = true;
          return Promise.resolve();
        },
      ),
    Error,
    "could not read primary GTID position",
  );
  assertEquals(restored, true);
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

test("waitForRequiredGtidSet throws gtid_wait_error on NULL", async () => {
  await assertRejects(
    () =>
      waitForRequiredGtidSet(
        () => Promise.resolve("NULL"),
        masterGtidWaitSql,
        "0-1-10",
        10,
        "mariadb",
      ),
    Error,
    switchoverPromoteErrorMessage(
      "gtid_wait_error",
      "switchover GTID wait failed",
    ),
  );
});
